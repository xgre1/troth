// SPDX-License-Identifier: AGPL-3.0-only
// Proactive compression buffer — Hermes Agent pattern.
//
// Rather than waiting for the upstream API to reject with a 400 "context too
// long" error and triggering retry-with-truncate, we compute the estimated
// token count against the known per-model cap and trigger compression when
// utilization crosses a safety threshold (default 80%).
//
// Trade-off: we compress slightly earlier than strictly necessary, paying a
// small fidelity cost for a guaranteed round-trip avoidance. The research
// reports this eliminates the failed-request round-trip latency that plagued
// naive proxy implementations.
//
// This module is a DECIDER, not a compressor — callers should invoke existing
// compressor.js / contextfilter.js when shouldCompress returns true.
//
//  Buffers (Hermes pattern)]

var DEFAULT_THRESHOLD = 0.80;  // 80% of cap triggers compression

var state = {
  checks: 0,
  triggered: 0,
  lastTriggerPct: 0,
  lastTriggerModel: null,
  lastTriggerAt: 0
};

// shouldCompress(estimatedTokens, cap, threshold?)
// Returns { compress, pctUsed, margin, threshold }.
// threshold defaults to 0.80 but can be overridden per call.
function shouldCompress(estimatedTokens, cap, threshold) {
  var thr = (typeof threshold === 'number' && threshold > 0 && threshold <= 1) ? threshold : DEFAULT_THRESHOLD;
  var est = (typeof estimatedTokens === 'number' && estimatedTokens >= 0) ? estimatedTokens : 0;
  var capVal = (typeof cap === 'number' && cap > 0) ? cap : 0;
  state.checks++;
  if (capVal === 0) {
    return { compress: false, pctUsed: 0, margin: 0, threshold: thr, reason: 'no-cap' };
  }
  var pctUsed = est / capVal;
  var triggered = pctUsed >= thr;
  if (triggered) {
    state.triggered++;
    state.lastTriggerPct = pctUsed;
    state.lastTriggerAt = Date.now();
  }
  return {
    compress: triggered,
    pctUsed: pctUsed,
    margin: capVal - est,
    threshold: thr,
    reason: triggered ? 'near-cap' : 'under-threshold'
  };
}

// Convenience: checkAndMark(model, estimatedTokens, cap) — runs shouldCompress
// and records the model if triggered (for diagnostics).
function checkAndMark(model, estimatedTokens, cap, threshold) {
  var r = shouldCompress(estimatedTokens, cap, threshold);
  if (r.compress) state.lastTriggerModel = model || 'unknown';
  return r;
}

function getStats() {
  return {
    module: 'compressionbuffer',
    checks: state.checks,
    triggered: state.triggered,
    triggerRate: state.checks > 0 ? (state.triggered / state.checks) : 0,
    lastTriggerPct: state.lastTriggerPct,
    lastTriggerModel: state.lastTriggerModel,
    lastTriggerAgo: state.lastTriggerAt ? Math.round((Date.now() - state.lastTriggerAt) / 1000) : null,
    threshold: DEFAULT_THRESHOLD
  };
}

module.exports = {
  shouldCompress: shouldCompress,
  checkAndMark: checkAndMark,
  getStats: getStats,
  DEFAULT_THRESHOLD: DEFAULT_THRESHOLD
};
