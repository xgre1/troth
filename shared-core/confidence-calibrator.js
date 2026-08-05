// SPDX-License-Identifier: AGPL-3.0-only
// confidence-calibrator.js — auto-calibrated empirical confidence per goal_class.
//
// design: confidence per class = success_count / attempt_count,
// weighted by recency. Replaces LLM self-reported confidence (post-hoc
// rationalization per Turpin 2023 + Lanham 2023) with substrate's own
// track record.
//
// API:
//   recordAttempt(goal_class, opts) →
//     opts = { success? boolean, ts? }
//     Increments attempt_count + optionally success_count. last_run_ts
//     updated to ts (default now). Variance updated via running mean.
//
//   getStats(goal_class) →
//     { goal_class, attempt_count, success_count, last_run_ts, variance,
//       confidence, days_since_last_run }
//
//   listAll({minAttempts?}) →
//     [stats] sorted by attempt_count DESC, optionally filtered to
//     classes with ≥ minAttempts attempts.
//
// Confidence formula (v1):
//   raw = success_count / attempt_count   (0 if no attempts)
//   recency_weight = 0.5 + 0.5 * exp(-days_since_last_run / 14)
//     (full weight at 0 days, half weight at infinity, 14-day half-life)
//   confidence = raw * recency_weight
//
// Why recency-weighted: a class with 10 successes 6 months ago doesn't
// give us the same calibration signal as 10 successes last week.
// Capabilities drift (model upgrades, library changes, task evolution).
//
// Variance: simple running estimate using Welford-style update so we can
// detect "this class has been flaky lately" — high variance even with
// reasonable mean means the autonomy promotion (the design)
// should stay conservative.

const path     = require('path');
const os       = require('os');
const Database = require('better-sqlite3');

function openDb(readonly) {
  const DB_PATH = process.env.STATE_DB_PATH ||
    path.join((process.env.HOME || os.homedir()), '.troth', 'state.db');
  return new Database(DB_PATH, readonly ? { readonly: true } : {});
}

function _confidenceFromRow(row) {
  if (!row || !row.attempt_count) {
    return { confidence: 0, days_since_last_run: null };
  }
  const raw = row.success_count / row.attempt_count;
  const ageDays = row.last_run_ts
    ? Math.max(0, (Date.now() - row.last_run_ts) / (1000 * 60 * 60 * 24))
    : 0;
  const recency = 0.5 + 0.5 * Math.exp(-ageDays / 14);
  return {
    confidence:           Number((raw * recency).toFixed(3)),
    days_since_last_run:  Number(ageDays.toFixed(2))
  };
}

function recordAttempt(goalClass, opts) {
  if (!goalClass) return null;
  opts = opts || {};
  const success = opts.success === true;
  const ts = opts.ts || Date.now();
  try {
    const db = openDb(false);
    // Read existing stats (for variance update) before writing.
    const prev = db.prepare(`
      SELECT goal_class, attempt_count, success_count, variance
      FROM goal_class_stats WHERE goal_class = ?
    `).get(goalClass);
    const prevAttempt = prev ? prev.attempt_count : 0;
    const prevSuccess = prev ? prev.success_count : 0;
    const prevVar     = prev ? prev.variance : 0;
    const newAttempt = prevAttempt + 1;
    const newSuccess = prevSuccess + (success ? 1 : 0);
    // Welford-ish: track variance of the 0/1 success signal as a running
    // estimate. Exact variance for Bernoulli is p(1-p); we recompute from
    // the new ratio after each update for simplicity (cheap, no streaming
    // accumulator needed for the small N we'll see in single-substrate).
    const newP = newSuccess / newAttempt;
    const newVar = newP * (1 - newP);
    // INSERT OR REPLACE: simpler than UPSERT for sqlite < 3.24. Slight
    // overhead of full-row write is fine for stats-update cadence.
    db.prepare(`
      INSERT OR REPLACE INTO goal_class_stats
      (goal_class, attempt_count, success_count, last_run_ts, variance, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(goalClass, newAttempt, newSuccess, ts, newVar, Date.now());
    db.close();
    return { goal_class: goalClass, attempt_count: newAttempt, success_count: newSuccess };
  } catch (_) { return null; }
}

function getStats(goalClass) {
  if (!goalClass) return null;
  try {
    const db = openDb(true);
    const row = db.prepare(`
      SELECT goal_class, attempt_count, success_count, last_run_ts, variance, updated_at
      FROM goal_class_stats WHERE goal_class = ?
    `).get(goalClass);
    db.close();
    if (!row) {
      return {
        goal_class:           goalClass,
        attempt_count:        0,
        success_count:        0,
        last_run_ts:          null,
        variance:             0,
        confidence:           0,
        days_since_last_run:  null
      };
    }
    return Object.assign({}, row, _confidenceFromRow(row));
  } catch (_) { return null; }
}

function listAll(opts) {
  opts = opts || {};
  const minAttempts = typeof opts.minAttempts === 'number' ? opts.minAttempts : 0;
  try {
    const db = openDb(true);
    const rows = db.prepare(`
      SELECT goal_class, attempt_count, success_count, last_run_ts, variance, updated_at
      FROM goal_class_stats
      WHERE attempt_count >= ?
      ORDER BY attempt_count DESC, last_run_ts DESC
    `).all(minAttempts);
    db.close();
    return rows.map(r => Object.assign({}, r, _confidenceFromRow(r)));
  } catch (_) { return []; }
}

module.exports = {
  recordAttempt,
  getStats,
  listAll
};
