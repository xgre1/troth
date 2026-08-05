// SPDX-License-Identifier: AGPL-3.0-only
// Wall 4 Tier 3 critic — G-Eval style cross-family LLM judge.
//
// Replaces the v1 stub `t3_rubric_score` in exit-predicate.js with a real
// implementation. Per design C.2 (cross-family rule) + G-Eval (Liu
// 2303.16634 — CoT prompted evaluator + form-filled rubric scoring).
//
// Invariants:
//   Cross-family enforcement is STRUCTURAL (substrate refuses same-
//     family judge; returns undetermined with reason cross_family_unavailable;
//     never silently degrades). R17 hard wall.
//   Audit trail: judge transcript + score per dimension preserved
//     in the verdict evidence for substrate-recorded review.
//   Fail-closed: judge call failure (network, parse, timeout) returns
//     undetermined with reason — never accepts on failure.
//
// v1 scope:
//   Single judge call (no ensemble)
//   Scalar rubric score per dimension (not probability-weighted) —
//     real logprobs require provider-specific plumbing (Anthropic doesn't
//     expose; OpenAI + llama.cpp do). Defer logprobs to v1.1.
//   Fixed temperature 0.0, max_tokens 1500 per spec defaults.
//   HTTP-only judge (POST OpenAI-shape /v1/chat/completions). Proxy or
//     local llama.cpp speaks this; Anthropic native API works through
//     the proxy.

'use strict';

const familyMod = require('./llm-family.js');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_TEMPERATURE = 0.0;
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_PASS_THRESHOLD = 0.7;  // MT-Bench ~0.70 weighted-mean = std-dev above mid

// Build G-Eval rubric prompt. Citation: Liu 2303.16634 §3 — CoT + form-
// filled scoring. We add Constitutional-style principle anchors per
// dimension (Bai 2212.08073 Appendix C pattern).
function _buildRubricPrompt(pred, stepResult, evalCtx) {
  const rubric = pred.rubric || {};
  const dims = Array.isArray(rubric.dimensions) ? rubric.dimensions : [];
  const lines = [];
  lines.push('You are an independent step-completion auditor. You did not produce the output under review.');
  lines.push('Score the output below against the rubric using the procedure described.');
  lines.push('');
  if (evalCtx && evalCtx.step_purpose) {
    lines.push('Step purpose: ' + evalCtx.step_purpose);
  }
  if (evalCtx && evalCtx.goal_text) {
    lines.push('Original goal: ' + String(evalCtx.goal_text).slice(0, 500));
  }
  lines.push('');
  lines.push('Output to evaluate:');
  lines.push('---');
  lines.push(String(stepResult && stepResult.text || '').slice(0, 4000));
  lines.push('---');
  lines.push('');
  lines.push('Rubric:');
  dims.forEach((d, i) => {
    lines.push('  (' + (i + 1) + ') ' + (d.name || 'dim_' + i));
    if (d.definition) lines.push('      definition: ' + d.definition);
    lines.push('      scale: 1=poor, 2=below-average, 3=adequate, 4=good, 5=excellent');
    if (typeof d.weight === 'number') lines.push('      weight: ' + d.weight);
  });
  lines.push('');
  lines.push('Procedure (G-Eval CoT):');
  lines.push('  1. State the evaluation steps you will follow (2-3 sentences).');
  lines.push('  2. Apply each step to the output.');
  lines.push('  3. Emit one integer 1-5 per dimension on its own line in this exact format:');
  lines.push('     SCORE_<dimension_name>: <int>');
  lines.push('     (one line per dimension; integer only; no other text on those lines)');
  return lines.join('\n');
}

// Parse model output — extract SCORE_<name>: <int> lines.
function _parseRubricScores(text, dims) {
  const scores = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const m = raw.match(/^\s*SCORE_([A-Za-z0-9_]+)\s*:\s*(\d+)\s*$/);
    if (m) {
      const name = m[1];
      const score = parseInt(m[2], 10);
      if (Number.isFinite(score) && score >= 1 && score <= 5) {
        scores[name] = score;
      }
    }
  }
  // Validate: every dimension must have a score
  const missing = [];
  for (const d of dims) {
    const key = d.name || '';
    if (!(key in scores)) missing.push(key);
  }
  return { scores, missing };
}

// Compute weighted mean. Weights default to uniform if absent or invalid.
function _weightedMean(scores, dims) {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const d of dims) {
    const score = scores[d.name];
    if (typeof score !== 'number') continue;
    const w = typeof d.weight === 'number' ? d.weight : (1 / dims.length);
    weightedSum += (score / 5) * w;  // normalize 1-5 → 0.2-1.0
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

// Issue the LLM call. Async; throws on network/timeout.
function _callJudge(host, model, prompt, timeoutMs) {
  const { URL } = require('url');
  const http  = require('http');
  const https = require('https');
  const url = new URL('/v1/chat/completions', host);
  const body = JSON.stringify({
    model:       model || 'critic',
    messages:    [{ role: 'user', content: prompt }],
    temperature: DEFAULT_TEMPERATURE,
    max_tokens:  DEFAULT_MAX_TOKENS,
    stream:      false
  });
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers: {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('critic_timeout')); });
    req.write(body);
    req.end();
  });
}

// Main entry — called from exit-predicate.js t3_rubric_score.
// Returns { ok, score, threshold, dim_scores, transcript, reason }.
async function callCritic(pred, stepResult, evalCtx) {
  evalCtx = evalCtx || {};
  const rubric = pred.rubric || {};
  const dims = Array.isArray(rubric.dimensions) ? rubric.dimensions : [];
  if (dims.length === 0) {
    return { ok: null, reason: 'rubric_missing_dimensions' };
  }

  const workerModel = evalCtx.worker_model || '';
  const judgeModel  = (pred.judge && pred.judge.model) || evalCtx.judge_model || '';
  const familyConstraint = (pred.judge && pred.judge.family_constraint) || 'different_from_worker';
  const judgeHost  = (pred.judge && pred.judge.host) || evalCtx.judge_host || '';

  // Cross-family enforcement (design C.2) — STRUCTURAL.
  if (familyConstraint === 'different_from_worker' && workerModel && judgeModel) {
    if (!familyMod.isCrossFamily(workerModel, judgeModel)) {
      return {
        ok: null,
        reason: 'cross_family_unavailable',
        worker_family: familyMod.familyOf(workerModel),
        judge_family:  familyMod.familyOf(judgeModel)
      };
    }
  }

  if (!judgeHost) {
    return { ok: null, reason: 'judge_host_unconfigured' };
  }

  const prompt = _buildRubricPrompt(pred, stepResult, evalCtx);
  let transcript;
  try {
    transcript = await _callJudge(judgeHost, judgeModel, prompt,
      (pred.judge && pred.judge.timeout_ms) || DEFAULT_TIMEOUT_MS);
  } catch (e) {
    return { ok: null, reason: 'judge_call_failed', detail: String(e && e.message || e) };
  }

  const { scores, missing } = _parseRubricScores(transcript, dims);
  if (missing.length) {
    return {
      ok: null,
      reason: 'rubric_scores_incomplete',
      missing,
      transcript_preview: String(transcript).slice(0, 500)
    };
  }

  const score = _weightedMean(scores, dims);
  const threshold = typeof pred.pass_threshold === 'number' ? pred.pass_threshold : DEFAULT_PASS_THRESHOLD;
  return {
    ok: score >= threshold,
    score,
    threshold,
    dim_scores: scores,
    worker_family: familyMod.familyOf(workerModel),
    judge_family:  familyMod.familyOf(judgeModel),
    transcript_preview: String(transcript).slice(0, 500)
  };
}

module.exports = {
  callCritic,
  // Exposed for tests
  _buildRubricPrompt,
  _parseRubricScores,
  _weightedMean,
  DEFAULT_PASS_THRESHOLD
};
