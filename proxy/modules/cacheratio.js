// SPDX-License-Identifier: AGPL-3.0-only
// Cache ratio tracker — per-model hit / miss / write telemetry.
//
// Anthropic surfaces cache usage via three fields in response.usage:
//   - input_tokens              (uncached input billed at full rate)
//   - cache_creation_input_tokens (new cache writes billed at ~1.25× full)
//   - cache_read_input_tokens    (cache hits billed at ~0.1× full — the win)
//
// A healthy cache hit ratio = reads / (reads + creates + uncached).
// Silent TTL regressions (like the March 2026 one that reverted 1h to 5m
// server-side) first manifest as a dropping hit ratio. Surfacing this
// per-model in /api/stats means we can detect the next regression in hours
// instead of discovering it weeks later from a billing statement.
//
var state = {
  perModel: Object.create(null)  // model → { writes, reads, uncached, requests, lastAt }
};

function init(model) {
  if (!state.perModel[model]) {
    state.perModel[model] = { writes: 0, reads: 0, uncached: 0, requests: 0, lastAt: 0 };
  }
  return state.perModel[model];
}

// Record one response's cache telemetry. Called after a successful Anthropic
// response; fields default to 0 if absent.
function record(model, usage) {
  if (!model || !usage || typeof usage !== 'object') return;
  var entry = init(model);
  var u = usage.input_tokens || 0;
  var w = usage.cache_creation_input_tokens || 0;
  var r = usage.cache_read_input_tokens || 0;
  entry.uncached += u;
  entry.writes   += w;
  entry.reads    += r;
  entry.requests += 1;
  entry.lastAt    = Date.now();
  // Persist a snapshot row for historical hit-ratio. Cheap: one INSERT
  // per Anthropic response, indexed on (model, ts).
  try {
    var s = require('../../shared-core/state.js');
    if (s && typeof s.recordCacheRatioEvent === 'function') {
      s.recordCacheRatioEvent({ model: model, reads: r, writes: w, uncached: u });
    }
  } catch (_) {}
}

// Hit ratio for a model: reads / (reads + writes + uncached).
// Returns null when insufficient data.
function hitRatio(model) {
  var e = state.perModel[model];
  if (!e) return null;
  var total = e.reads + e.writes + e.uncached;
  if (total === 0) return null;
  return e.reads / total;
}

function getStats() {
  var models = Object.keys(state.perModel).sort();
  var out = { module: 'cacheratio', perModel: {} };
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var e = state.perModel[m];
    var total = e.reads + e.writes + e.uncached;
    out.perModel[m] = {
      requests: e.requests,
      reads: e.reads,
      writes: e.writes,
      uncached: e.uncached,
      totalInputTokens: total,
      hitRatio: total > 0 ? e.reads / total : null,
      writeRatio: total > 0 ? e.writes / total : null,
      lastAt: e.lastAt
    };
  }
  return out;
}

function reset() { state.perModel = Object.create(null); }

module.exports = { record: record, hitRatio: hitRatio, getStats: getStats, reset: reset };
