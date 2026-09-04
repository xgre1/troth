// SPDX-License-Identifier: AGPL-3.0-only Cost forecasting. Before pursuing a
// goal, surface an empirical estimate: "this class historically costs P50 \$X
// / P90 \$Y; takes P50 N min / P90 M min". Operator approval surfaces
// (dashboard, app, CLI) read this to gate expensive runs. Without it, every
// goal is a blind commit. Design principle: the mind knows what its own
// actions cost. Forecasting is the substrate predicting its own future spend
// from its own history — no external model, no third-party telemetry. v1
// algorithm: empirical quantiles per goal_class. v2 (deferred) adds
// quantile-regression conditioning on prompt_size_features per the design spec
// — but we need enough per-class data first to justify it, and JS-native
// quantile regression (without sklearn) is non-trivial. - Hyndman+Fan 1996
// "Sample quantiles in statistical packages" (type-7 empirical quantile —
// linear interpolation; numpy default) - Koenker+Bassett 1978 (quantile
// regression — v2 target) - forecasts read-only over existing ledgers Data
// sources (existing — no new tables): l4_briefings: success, spent_usd, ts,
// goal_class l4_cost_events: usd, ts, goal_class (per-charge granularity) v1
// limitations: - Per-class only (no prompt-size conditioning) - Time inference
// from briefing.ts deltas — approximate (run duration not directly recorded;
// we use median spacing within class as a noisy proxy for run length) - 30-day
// default window; falls back to all-time when undersampled

'use strict';

const state = require('./state.js');

const DEFAULT_WINDOW_MS  = 30 * 24 * 60 * 60 * 1000;
const MIN_SAMPLES_GOOD   = 10;          // confident estimate
const MIN_SAMPLES_USABLE = 3;           // very wide bands, still better than null
const ABSOLUTE_FALLBACK_USD_P50 = 0.05; // priors for cold-start
const ABSOLUTE_FALLBACK_USD_P90 = 0.40;

// Linear-interpolation quantile (Hyndman+Fan 1996 type-7 / numpy default).
function _quantile(sortedNums, q) {
  if (!sortedNums.length) return null;
  if (sortedNums.length === 1) return sortedNums[0];
  const pos = (sortedNums.length - 1) * q;
  const lo  = Math.floor(pos);
  const hi  = Math.ceil(pos);
  if (lo === hi) return sortedNums[lo];
  const frac = pos - lo;
  return sortedNums[lo] + (sortedNums[hi] - sortedNums[lo]) * frac;
}

// Pull historical briefing rows for a goal class.
function _briefingsForClass(goalClass, sinceMs) {
  try {
    if (typeof state.listBriefings !== 'function') return [];
    const all = state.listBriefings({ limit: 2000 }) || [];
    const cutoff = Date.now() - sinceMs;
    return all.filter(b => b.goal_class === goalClass && b.ts >= cutoff);
  } catch (_) { return []; }
}

// Returns
//   { ok, goal_class, sample_size, since_ms,
//     usd: { p50, p90, p99? },
//     time_ms: { p50, p90 },
//     confidence: 'good' | 'usable' | 'cold_start',
//     fallback_used?: bool }
function forecast(opts) {
  opts = opts || {};
  const goalClass = opts.goal_class;
  if (!goalClass) return { ok: false, reason: 'goal_class_required' };
  const since = typeof opts.since_ms === 'number' ? opts.since_ms : DEFAULT_WINDOW_MS;

  let rows = _briefingsForClass(goalClass, since);
  // Widen window if undersampled
  let widened = false;
  if (rows.length < MIN_SAMPLES_USABLE && since < (180 * 24 * 60 * 60 * 1000)) {
    rows = _briefingsForClass(goalClass, 180 * 24 * 60 * 60 * 1000);
    widened = true;
  }

  if (rows.length < MIN_SAMPLES_USABLE) {
    // Cold start — return absolute priors (Niculescu-Mizil-style
    // empirical Bayes fallback: when class-specific is undersampled,
    // fall back to overall-population priors).
    return {
      ok:             true,
      goal_class:     goalClass,
      sample_size:    rows.length,
      since_ms:       since,
      usd:            { p50: ABSOLUTE_FALLBACK_USD_P50, p90: ABSOLUTE_FALLBACK_USD_P90 },
      time_ms:        { p50: null, p90: null },
      confidence:     'cold_start',
      fallback_used:  true,
      widened
    };
  }

  // Cost quantiles
  const costs = rows.map(b => b.spent_usd || 0).filter(c => c >= 0).sort((a, b) => a - b);
  const p50 = _quantile(costs, 0.5);
  const p90 = _quantile(costs, 0.9);
  const p99 = costs.length >= MIN_SAMPLES_GOOD ? _quantile(costs, 0.99) : null;

  // Time approx — use distinct goal_id durations if available.
  // (Briefings store ONE row per goal-attempt result; consecutive
  // briefings for the SAME goal_id can bracket attempt duration. We
  // can't recover full traces here, so we use an interquartile sample
  // over briefing spacing within the class as a noisy proxy.)
  const sortedByTs = rows.slice().sort((a, b) => a.ts - b.ts);
  const gaps = [];
  for (let i = 1; i < sortedByTs.length; i++) {
    const g = sortedByTs[i].ts - sortedByTs[i - 1].ts;
    if (g > 1000 && g < 60 * 60 * 1000) gaps.push(g);  // 1s to 1h plausible
  }
  gaps.sort((a, b) => a - b);
  const t_p50 = gaps.length ? _quantile(gaps, 0.5) : null;
  const t_p90 = gaps.length ? _quantile(gaps, 0.9) : null;

  const confidence = rows.length >= MIN_SAMPLES_GOOD ? 'good' : 'usable';
  return {
    ok:           true,
    goal_class:   goalClass,
    sample_size:  rows.length,
    since_ms:     since,
    usd:          { p50, p90, p99 },
    time_ms:      { p50: t_p50, p90: t_p90 },
    confidence,
    widened
  };
}

// Cross-class forecast surface (operator dashboard heat map).
//   opts.classes — array; defaults to whatever appears in window
function forecastAll(opts) {
  opts = opts || {};
  const since = typeof opts.since_ms === 'number' ? opts.since_ms : DEFAULT_WINDOW_MS;
  let classes = opts.classes;
  if (!Array.isArray(classes) || !classes.length) {
    try {
      const all = state.listBriefings({ limit: 2000 }) || [];
      const cutoff = Date.now() - since;
      const set = new Set();
      for (const b of all) if (b.ts >= cutoff && b.goal_class) set.add(b.goal_class);
      classes = Array.from(set);
    } catch (_) { classes = []; }
  }
  return classes.map(cls => forecast({ goal_class: cls, since_ms: since }));
}

module.exports = {
  forecast,
  forecastAll,
  DEFAULT_WINDOW_MS,
  MIN_SAMPLES_GOOD,
  MIN_SAMPLES_USABLE,
  ABSOLUTE_FALLBACK_USD_P50,
  ABSOLUTE_FALLBACK_USD_P90,
  // exposed for tests
  _quantile,
  _briefingsForClass
};
