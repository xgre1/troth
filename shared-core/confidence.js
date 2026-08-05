// SPDX-License-Identifier: AGPL-3.0-only
// Calibrated confidence.
//
// Every claim the substrate produces should carry a confidence score
// AND an actual track-record-fitted scaler that says "when this
// substrate says 0.8, the empirical truth-rate has been 0.7". The
// operator surfaces (sphere green/amber/red, chat bubble borders) read
// the CALIBRATED score, not the raw one.
//
// Design principle: confidence is part of the mind's self-expression, not a
// UI feature. The mind knows what it knows AND knows how reliable its
// knowing is — and updates that self-model from observed outcomes.
//
// Architecture:
//   tierFor(c)            → 'high' | 'medium' | 'low' (display bands)
//   recordClaim(opts)     → logs (predicted, kind, claim_engram_id);
//                            returns calibration_point_id
//   recordOutcome(id, ok) → fills in actual outcome on a prior point
//   fitPlattScaler(opts)  → fits Platt 1999 logistic (a, b) from
//                            ledger window; null if < MIN_SAMPLES
//   applyScaler(raw, fit) → calibrated = 1 / (1 + exp(a * raw + b))
//
// Platt scaling: 2-parameter sigmoid that maps raw model scores to
// probabilities calibrated against actual outcomes (Platt 1999 NIPS:
// "Probabilistic outputs for SVMs"). Standard for binary classifier
// calibration. Fit via Newton iteration here (no scipy dep).
//
// Calibration kinds tracked:
//   'critic'        — step-critic.verifyStep verdicts (verified ↔ actual)
//   'reflection'    — reflector concerns (clean ↔ no future failure)
//   'anticipation'  — anticipator predictions (matched future activity ↔ not)
//
// v1 limitations:
//   Per-kind scaler only (no per-class scaler — needs more data)
//   Newton iteration without regularization (Platt's method
//     bias-correction omitted — empirical sufficient for v1)
//   No automatic refit cadence (caller runs monthly via cron / CLI)
//
// design grounding:
//   Platt 1999 NIPS (logistic calibration)
//   Niculescu-Mizil + Caruana 2005 (calibration comparison)
//   design R23 append-only (calibration points immutable;
//     outcome UPDATE is permitted as it's filling, not changing, a
//     prior assertion)

'use strict';

const state = require('./state.js');

const TIER_HIGH = 0.8;
const TIER_LOW  = 0.5;
const MIN_SAMPLES_FOR_FIT = 50;       // Platt's recommended floor
const FIT_MAX_ITERS       = 100;
const FIT_EPS             = 1e-6;

function tierFor(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 'unknown';
  if (c >= TIER_HIGH) return 'high';
  if (c >= TIER_LOW)  return 'medium';
  return 'low';
}

// Log a claim's predicted confidence at production time.
//   opts.predicted          — required, 0..1
//   opts.kind               — required, e.g. 'critic'/'reflection'
//   opts.claim_engram_id    — optional, link to the engram carrying claim
//   opts.notes              — optional, short context
function recordClaim(opts) {
  opts = opts || {};
  if (typeof opts.predicted !== 'number' || !Number.isFinite(opts.predicted)) {
    return null;
  }
  return state.recordCalibrationPoint({
    ts:               opts.ts || Date.now(),
    predicted:        opts.predicted,
    kind:             opts.kind || 'unknown',
    claim_engram_id:  opts.claim_engram_id || null,
    actual:           null,    // outcome filled later
    notes:            opts.notes || null
  });
}

// Fill in outcome later (when truth becomes observable).
//   ok = true  → confirmed true
//   ok = false → falsified
//   ok = null  → outcome unknowable (leave NULL; excluded from fits)
function recordOutcome(calibrationPointId, ok, notes) {
  return state.updateCalibrationOutcome(calibrationPointId, ok, notes || null);
}

// Newton-Raphson fit of Platt's 2-parameter sigmoid:
//   P(y=1 | f) = 1 / (1 + exp(A*f + B))
// from labeled points {(f_i, y_i)} where y_i ∈ {0,1}.
// Implementation follows Platt 1999 §3 + Lin/Lin/Weng 2007 numerical
// stability fixes.
function _fitPlatt(points) {
  // points: [{ predicted: 0..1, actual: 0|1 }]
  const N1 = points.filter(p => p.actual === 1).length;
  const N0 = points.filter(p => p.actual === 0).length;
  if (N1 === 0 || N0 === 0) return null;   // degenerate — no signal

  // Targets per Platt §3: t = (N1+1)/(N1+2) for positives, 1/(N0+2) for negatives
  const tPos = (N1 + 1) / (N1 + 2);
  const tNeg = 1       / (N0 + 2);

  let A = 0;
  let B = Math.log((N0 + 1) / (N1 + 1));

  // Negative log-likelihood + Newton iteration.
  let fval = 0;
  for (const p of points) {
    const fApB = p.predicted * A + B;
    const t = p.actual === 1 ? tPos : tNeg;
    fval += (fApB >= 0)
      ? (t * fApB + Math.log(1 + Math.exp(-fApB)))
      : ((t - 1) * fApB + Math.log(1 + Math.exp(fApB)));
  }

  for (let iter = 0; iter < FIT_MAX_ITERS; iter++) {
    // Gradient + Hessian
    let h11 = 1e-10, h22 = 1e-10, h21 = 0;
    let g1 = 0, g2 = 0;
    for (const p of points) {
      const fApB = p.predicted * A + B;
      const t = p.actual === 1 ? tPos : tNeg;
      const p1 = fApB >= 0
        ? Math.exp(-fApB) / (1 + Math.exp(-fApB))
        :        1       / (1 + Math.exp(fApB));
      const p2 = 1 - p1;
      const d2 = p1 * p2;
      h11 += p.predicted * p.predicted * d2;
      h22 += d2;
      h21 += p.predicted * d2;
      const d1 = (t - p1);
      g1 += p.predicted * d1;
      g2 += d1;
    }
    // Stop if gradient small
    if (Math.abs(g1) < FIT_EPS && Math.abs(g2) < FIT_EPS) break;

    // Newton step (Cramer's rule on 2x2)
    const det = h11 * h22 - h21 * h21;
    const dA  = -(h22 * g1 - h21 * g2) / det;
    const dB  = -(-h21 * g1 + h11 * g2) / det;
    const gd  = g1 * dA + g2 * dB;

    // Line search
    let stepsize = 1;
    while (stepsize >= FIT_EPS) {
      const newA = A + stepsize * dA;
      const newB = B + stepsize * dB;
      let newF = 0;
      for (const p of points) {
        const fApB = p.predicted * newA + newB;
        const t = p.actual === 1 ? tPos : tNeg;
        newF += (fApB >= 0)
          ? (t * fApB + Math.log(1 + Math.exp(-fApB)))
          : ((t - 1) * fApB + Math.log(1 + Math.exp(fApB)));
      }
      if (newF < fval + 0.0001 * stepsize * gd) {
        A = newA; B = newB; fval = newF;
        break;
      }
      stepsize /= 2;
    }
    if (stepsize < FIT_EPS) break;
  }

  return { a: A, b: B, samples: points.length, n_pos: N1, n_neg: N0 };
}

// Fit a Platt scaler from the ledger. Returns null if insufficient data.
//   opts.kind     — required (one of critic/reflection/anticipation/...)
//   opts.since_ms — default 30d window
//   opts.min_samples — override (default MIN_SAMPLES_FOR_FIT=50)
function fitPlattScaler(opts) {
  opts = opts || {};
  const min = opts.min_samples || MIN_SAMPLES_FOR_FIT;
  const rows = state.listCalibrationPoints({
    kind:     opts.kind,
    since_ms: opts.since_ms || (30 * 24 * 60 * 60 * 1000),
    limit:    2000
  });
  const points = rows.filter(r => r.actual === 0 || r.actual === 1)
                     .map(r => ({ predicted: r.predicted, actual: r.actual }));
  if (points.length < min) {
    return { ok: false, reason: 'insufficient_samples', samples: points.length, min };
  }
  const fit = _fitPlatt(points);
  if (!fit) return { ok: false, reason: 'degenerate_labels', samples: points.length };
  return Object.assign({ ok: true, kind: opts.kind, window_ms: opts.since_ms || (30 * 24 * 60 * 60 * 1000) }, fit);
}

// Apply a fitted scaler to a raw confidence. If scaler is invalid /
// null, returns the raw value (identity).
function applyScaler(raw, fit) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (!fit || !fit.ok || typeof fit.a !== 'number' || typeof fit.b !== 'number') return raw;
  const fApB = raw * fit.a + fit.b;
  // Stable sigmoid
  return fApB >= 0
    ? Math.exp(-fApB) / (1 + Math.exp(-fApB))
    :        1        / (1 + Math.exp(fApB));
}

// Convenience: produce a structured claim object the surface layers
// can render directly.
//   { claim, confidence, calibrated_confidence?, tier, basis, source_refs? }
function structureClaim(opts) {
  opts = opts || {};
  const raw = typeof opts.confidence === 'number' ? opts.confidence : null;
  const calibrated = (opts.scaler && opts.scaler.ok)
    ? applyScaler(raw, opts.scaler)
    : null;
  const used = calibrated !== null ? calibrated : raw;
  return {
    claim:                  String(opts.claim || ''),
    confidence:             raw,
    calibrated_confidence:  calibrated,
    tier:                   tierFor(used),
    basis:                  opts.basis || null,
    source_refs:            Array.isArray(opts.source_refs) ? opts.source_refs : null
  };
}

module.exports = {
  tierFor,
  recordClaim,
  recordOutcome,
  fitPlattScaler,
  applyScaler,
  structureClaim,
  TIER_HIGH,
  TIER_LOW,
  MIN_SAMPLES_FOR_FIT,
  // exposed for tests
  _fitPlatt
};
