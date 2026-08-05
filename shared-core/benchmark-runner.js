// SPDX-License-Identifier: AGPL-3.0-only
// Benchmark Runner — A/B harness for substrate quality lift.
//
// Question: does adding substrate-as-entity to a model run measurably
// improve task completion vs the same model without substrate? Until
// we measure this, every claim about "the substrate works" is unbacked.
//
// Test design:
//   - Each task is {id, category, prompt, setup, rubric}.
//   - For each task, run twice:
//       baseline: raw prompt → transport (no system prefix, no engram
//                 retrieval, no decode constraints, no agentic tools)
//       substrate: same prompt, but routed through orchestrator with
//                  substrate's prefix_provider (engram+dialogue) +
//                  decode_constraints (identity bias) + optional
//                  agentic tool surface
//   - Each response scored against the task's rubric:
//       must_contain   — boost when present (graded by count)
//       must_avoid     — penalty when present (graded by count)
//       structural     — caller-supplied function(text) → 0..1
//   - Per-task delta = substrate_score - baseline_score.
//   - Suite summary = mean delta per category, overall delta, win rate.
//
// Pure function: runner takes injected transport + injected substrate
// glue, no global state. Lets the suite run against any backend
// (llamacpp on a remote host, fake stub for unit tests).

const cfg            = require('./transport-config.js');
const engram         = require('./engram.js');
const dialogueMemory = require('./dialogue-memory.js');
const grammarFromSub = require('./grammar-from-substrate.js');

// ── Scoring ─────────────────────────────────────────────────────────────

function defaultScorer(text, rubric) {
  text = String(text || '');
  rubric = rubric || {};
  let score = 0.5; // neutral baseline so empty text scores below 0.5
  const detail = {};

  if (Array.isArray(rubric.must_contain)) {
    let hits = 0;
    for (const phrase of rubric.must_contain) {
      const re = new RegExp(escapeRegex(phrase), 'i');
      if (re.test(text)) hits++;
    }
    const cov = rubric.must_contain.length ? hits / rubric.must_contain.length : 0;
    score += cov * 0.4; // up to +0.4
    detail.must_contain_hits = hits;
    detail.must_contain_total = rubric.must_contain.length;
  }
  if (Array.isArray(rubric.must_avoid)) {
    let bad = 0;
    for (const phrase of rubric.must_avoid) {
      const re = new RegExp(escapeRegex(phrase), 'i');
      if (re.test(text)) bad++;
    }
    score -= bad * 0.15; // each banned occurrence -0.15
    detail.must_avoid_hits = bad;
  }
  if (typeof rubric.structural === 'function') {
    let s = 0;
    try { s = rubric.structural(text); } catch (_) { s = 0; }
    score += (Math.max(0, Math.min(1, s)) - 0.5) * 0.3; // ±0.15 around 0.5
    detail.structural = s;
  }
  if (rubric.min_length && text.length < rubric.min_length) score -= 0.1;
  if (rubric.max_length && text.length > rubric.max_length) score -= 0.05;

  return { score: Math.max(0, Math.min(1, score)), detail };
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Substrate glue ──────────────────────────────────────────────────────

// Compose the system prefix substrate would inject for a given task.
// Pulls active commitments + recent dialogue + relevant engrams.
async function composeSubstratePrefix(opts, task) {
  const agent_id = opts.agent_id;
  const cwd      = opts.cwd || null;
  const lines = [];
  // Identity envelope
  if (Array.isArray(opts.refusals) && opts.refusals.length) {
    lines.push('Active refusals:');
    for (const r of opts.refusals) lines.push('  - ' + r);
  }
  if (Array.isArray(opts.anchors) && opts.anchors.length) {
    lines.push('');
    lines.push('Anchors:');
    for (const a of opts.anchors) lines.push('  - ' + a);
  }
  // Recent dialogue (continuity)
  const turns = dialogueMemory.recentTurns({ agent_id, cwd, limit: 4 });
  if (turns.length) {
    lines.push('');
    lines.push('Recent dialogue:');
    for (const t of turns) {
      lines.push('  user: '    + (t.user_text || '').slice(0, 200));
      lines.push('  faculty: ' + (t.assistant_text || '').slice(0, 200));
    }
  }
  // Top-K relevant engrams
  try {
    const items = await engram.retrieveRelevant({
      agent_id, cwd,
      query: task.prompt,
      k: 5,
      embedding_host: opts.embedding_host || cfg.embeddingHost()
    });
    if (items.length) {
      lines.push('');
      lines.push('Relevant memories:');
      for (const it of items) lines.push('  - ' + it.statement);
    }
  } catch (_) { /* best-effort */ }
  return lines.join('\n');
}

// Build decode constraints (logit bias) from substrate identity.
function buildSubstrateConstraints(opts) {
  if (!Array.isArray(opts.refusals) || !opts.refusals.length) return null;
  const out = grammarFromSub.buildConstraints(
    { refusals: opts.refusals, anchors: opts.anchors || [] },
    { extra_bias_strings: opts.extra_bias_strings || [], cross_lingual: !!opts.cross_lingual }
  );
  return out;
}

// ── One-shot non-streaming chat helper ─────────────────────────────────

// We run benchmarks non-streaming for clean comparison — no fragment
// composition variance. Caller injects an `oneShot(prompt, opts)`
// function so the runner stays transport-agnostic.

// ── Runner ──────────────────────────────────────────────────────────────

async function runOneTask(task, opts) {
  const oneShot = opts.one_shot;
  if (typeof oneShot !== 'function') {
    throw new Error('benchmark-runner: opts.one_shot(prompt, mode_opts) → Promise<text> required');
  }
  const t0 = Date.now();
  let baselineText = '';
  let substrateText = '';
  let baselineErr = null, substrateErr = null;
  try {
    baselineText = await oneShot(task.prompt, { mode: 'baseline', system: '' });
  } catch (e) { baselineErr = String(e && e.message || e); }
  let prefix = '';
  try { prefix = await composeSubstratePrefix(opts, task); } catch (_) {}
  const constraints = buildSubstrateConstraints(opts);
  try {
    substrateText = await oneShot(task.prompt, { mode: 'substrate', system: prefix, decode_constraints: constraints });
  } catch (e) { substrateErr = String(e && e.message || e); }
  const baseline = defaultScorer(baselineText, task.rubric);
  const substrate = defaultScorer(substrateText, task.rubric);
  return {
    task_id: task.id,
    category: task.category || 'uncategorized',
    baseline:  { text: baselineText, score: baseline.score, detail: baseline.detail, error: baselineErr },
    substrate: { text: substrateText, score: substrate.score, detail: substrate.detail, error: substrateErr },
    delta: substrate.score - baseline.score,
    elapsed_ms: Date.now() - t0
  };
}

async function runSuite(opts) {
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  if (!tasks.length) return { ok: false, error: 'no tasks provided' };
  const results = [];
  for (const task of tasks) {
    const r = await runOneTask(task, opts);
    results.push(r);
    if (typeof opts.on_result === 'function') {
      try { opts.on_result(r); } catch (_) {}
    }
  }
  return { ok: true, results, summary: summarize(results) };
}

function summarize(results) {
  const overall = mean(results.map(r => r.delta));
  const baseline_mean = mean(results.map(r => r.baseline.score));
  const substrate_mean = mean(results.map(r => r.substrate.score));
  const wins   = results.filter(r => r.delta > 0.05).length;
  const losses = results.filter(r => r.delta < -0.05).length;
  const ties   = results.length - wins - losses;
  // Per-category breakdown
  const byCat = {};
  for (const r of results) {
    if (!byCat[r.category]) byCat[r.category] = { count: 0, delta_sum: 0 };
    byCat[r.category].count++;
    byCat[r.category].delta_sum += r.delta;
  }
  const per_category = Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, { mean_delta: v.delta_sum / v.count, count: v.count }]));
  return {
    n: results.length,
    baseline_mean,
    substrate_mean,
    mean_delta: overall,
    wins, losses, ties,
    win_rate: wins / results.length,
    per_category
  };
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

module.exports = {
  defaultScorer,
  composeSubstratePrefix,
  buildSubstrateConstraints,
  runOneTask,
  runSuite,
  summarize
};
