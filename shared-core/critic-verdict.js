// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Layer-3 fidelity verdict logger. Every critic run that actually ran (clean or
// flagged) is written as a type='decision' / input.kind='critic_verdict' ActionRecord
// so we can measure false-positive / false-negative rate from real data BEFORE
// granting block authority. UNGATED on purpose (capture everything for measurement).
// audience:'substrate_internal' + memory_class:'operational' = never mounts into the
// LLM prefix, never trips audience invariants. Append-only; never blocks; never throws.

const actionRecord = require('./action-record.js');
let _state = null;
function state() { if (!_state) _state = require('./state.js'); return _state; }

// opts: { result, model_used, cwd, session_id, agent_id, parent_id, turn_fingerprint }
// result = { clean, violations:[{rule_id, evidence, confidence}], skipped? } from
// fidelity-critic.runFidelityCritic. Returns the row id or null (fail-open).
function recordVerdict(opts) {
  opts = opts || {};
  try {
    const result = opts.result || {};
    const violations = Array.isArray(result.violations) ? result.violations : [];
    const violated = !result.clean && violations.length > 0;
    const decision = result.skipped ? 'skip' : (violated ? 'warn' : 'allow');
    const rec = actionRecord.create({
      type: 'decision',
      agent_id: opts.agent_id || 'troth-fidelity',
      session_id: opts.session_id || null,
      cwd: opts.cwd || null,
      parent_id: (typeof opts.parent_id === 'string' && opts.parent_id.length === 36) ? opts.parent_id : null,
      input: {
        kind: 'critic_verdict',
        model_used: opts.model_used || null,
        rule_ids: violations.map(function (v) { return v.rule_id; }),
        turn_fingerprint: opts.turn_fingerprint || null,
        skipped: result.skipped || null,
        signals: violations.map(function (v) {
          return { rule_id: v.rule_id, confidence: v.confidence, evidence: v.evidence };
        })
      },
      output: {
        decision: decision,
        reason: violated
          ? violations.map(function (v) { return '[' + v.rule_id + '] ' + v.evidence; }).join(' | ')
          : (result.skipped ? 'skipped:' + result.skipped : 'clean'),
        confidence: violations.length
          ? Math.max.apply(null, violations.map(function (v) { return v.confidence; }))
          : null,
        n_violations: violations.length,
        // ground-truth label, filled post-hoc when the operator confirms/refutes a
        // flagged verdict; null = unlabeled. FPR/FNR computed over labeled rows only.
        label: null
      },
      audience: 'substrate_internal',
      memory_class: 'operational'
    });
    return state().recordAction(rec, actionRecord.toSearchText(rec));
  } catch (_) {
    return null;   // fail-open: verdict logging must never break the turn
  }
}

// Read verdicts for FPR/FNR measurement. Returns parsed records (newest first).
function getVerdicts(opts) {
  opts = opts || {};
  try {
    const q = { type: 'decision', kind: 'critic_verdict', limit: opts.limit || 500 };
    if (opts.cwd) q.cwd = opts.cwd;
    if (opts.session_id) q.session_id = opts.session_id;
    if (opts.since) q.since = opts.since;
    const rows = state().queryActions(q);
    return (rows || []).map(function (row) {
      let input = {}, output = {};
      try { input = JSON.parse(row.input || '{}'); } catch (_) {}
      try { output = JSON.parse(row.output || '{}'); } catch (_) {}
      return { id: row.id, timestamp: row.timestamp, cwd: row.cwd, session_id: row.session_id, input: input, output: output };
    });
  } catch (_) {
    return [];
  }
}

// Recent flagged (warn) verdicts for a cwd/session, newest first. Used by the app
// entity to surface a <fidelity_check> reminder on the turn after a violation.
function getRecentWarnings(opts) {
  opts = opts || {};
  const since = opts.since || (Date.now() - 5 * 60 * 1000);
  const q = { cwd: opts.cwd, session_id: opts.session_id, since: since, limit: opts.limit || 5 };
  return getVerdicts(q).filter(function (v) { return v.output && v.output.decision === 'warn'; });
}

// #51 — per-rule flag rate over a window, the FPR proxy (labels are unset;
// how-often-a-rule-fires is the calibration signal — see tools/fidelity-fpr.js).
// judged = non-skip verdicts; flags = verdicts whose signals include ruleId.
function ruleFlagRate(ruleId, opts) {
  opts = opts || {};
  const days  = (typeof opts.days === 'number') ? opts.days : 7;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const q = { since: since, limit: opts.limit || 1000 };
  if (opts.cwd) q.cwd = opts.cwd;
  const verdicts = getVerdicts(q);
  let judged = 0, flags = 0;
  verdicts.forEach(function (v) {
    const d = v.output && v.output.decision;
    if (d !== 'warn' && d !== 'allow') return; // non-skip judgments only
    judged++;
    const sig = (v.input && v.input.signals) || [];
    if (sig.some(function (x) { return x && x.rule_id === ruleId; })) flags++;
  });
  return { judged: judged, flags: flags, rate: judged ? (flags / judged) : 0 };
}

// #51 — is the verify-evidence rule's FP-clean window satisfied? True only with
// ENOUGH judged turns (rate is meaningful) AND a LOW flag-rate (not over-firing).
// Returns false when there is no measurement yet (fidelity Layer 3 not run) — so
// blocking never arms until precision is demonstrated. Fail-closed on error.
function verifyEvidenceFpClean(opts) {
  opts = opts || {};
  const MIN_JUDGED = (typeof opts.minJudged === 'number') ? opts.minJudged : 25;
  const MAX_RATE   = (typeof opts.maxRate === 'number') ? opts.maxRate : 0.15;
  try {
    const r = ruleFlagRate('verify-evidence', opts);
    return r.judged >= MIN_JUDGED && r.rate <= MAX_RATE;
  } catch (_) { return false; }
}

module.exports = { recordVerdict, getVerdicts, getRecentWarnings, ruleFlagRate, verifyEvidenceFpClean };
