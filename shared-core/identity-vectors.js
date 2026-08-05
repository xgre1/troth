// SPDX-License-Identifier: AGPL-3.0-only
// Identity Vectors — substrate-side activation steering primitive.
//
// True per-layer activation steering (the K-Steering / control-vector
// path the core design note sketches) requires internal hidden-state access
// that llama-server's HTTP API does not expose. What the API DOES
// expose is the pooled embedding endpoint — and substrate can use that
// to compute semantic direction vectors via Mean of Differences (MoD)
// over contrastive prompt pairs. The result is one vector per
// commitment, not per layer, but it is enough for:
//
//   1. Re-ranking engram retrieval — favor memories whose embeddings
//      align with currently-active anchor directions, demote those
//      pulling toward forbidden ones.
//   2. Drift detection — score the substrate's output (or the user's
//      input) for similarity to each commitment's direction.
//   3. Identity audit — surface which commitments most strongly shape
//      the current conversational pull.
//
// When per-layer activation steering becomes available (custom inference
// engine, llama.cpp control-vector GGUF written by substrate), the same
// `computeMoD` machinery extends — just generate the contrastive pairs
// per layer and aggregate. The data path is the same; only the
// destination changes.

const cfg    = require('./transport-config.js');
const engram = require('./engram.js');

// ── Math primitives ─────────────────────────────────────────────────────

function vecMean(vectors) {
  if (!Array.isArray(vectors) || !vectors.length) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i] || 0;
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

function vecSub(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] || 0) - (b[i] || 0);
  return out;
}

function vecNorm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function vecNormalize(v) {
  const n = vecNorm(v);
  if (!n) return v.slice();
  return v.map(x => x / n);
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Direction-vector computation ────────────────────────────────────────

// Given a label + paired arrays of "positive" and "negative" prompts,
// embed each prompt, mean-pool by class, subtract, normalize. Returns
// { label, direction, magnitude, sample_count } where `direction` is
// the unit vector pointing from negative-class centroid to positive-
// class centroid in embedding space.
async function computeMoD(opts) {
  opts = opts || {};
  const host = opts.host || cfg.embeddingHost();
  const label = String(opts.label || 'unnamed');
  const positives = Array.isArray(opts.positives) ? opts.positives : [];
  const negatives = Array.isArray(opts.negatives) ? opts.negatives : [];
  if (!positives.length || !negatives.length) {
    return { label, direction: [], magnitude: 0, sample_count: 0, error: 'need at least one positive and one negative' };
  }
  const posVecs = [];
  const negVecs = [];
  for (const p of positives) {
    const v = await engram.embedRequest(host, String(p));
    if (Array.isArray(v) && v.length) posVecs.push(v);
  }
  for (const n of negatives) {
    const v = await engram.embedRequest(host, String(n));
    if (Array.isArray(v) && v.length) negVecs.push(v);
  }
  if (!posVecs.length || !negVecs.length) {
    return { label, direction: [], magnitude: 0, sample_count: 0, error: 'embedding endpoint returned nothing' };
  }
  const posMean = vecMean(posVecs);
  const negMean = vecMean(negVecs);
  const diff = vecSub(posMean, negMean);
  const magnitude = vecNorm(diff);
  return {
    label,
    direction:    vecNormalize(diff),
    magnitude,
    sample_count: posVecs.length + negVecs.length,
    pos_count:    posVecs.length,
    neg_count:    negVecs.length
  };
}

// Convenience: derive direction vectors for every active substrate
// commitment by synthesising a small contrastive prompt set from each
// statement. Used at substrate boot or commitment-update time.
async function computeIdentityDirections(opts) {
  opts = opts || {};
  const refusals = Array.isArray(opts.refusals) ? opts.refusals : [];
  const anchors  = Array.isArray(opts.anchors)  ? opts.anchors  : [];
  const host = opts.host || cfg.embeddingHost();
  const out = [];
  for (const r of refusals) {
    const r1 = await computeMoD({
      host,
      label:     'refusal:' + r.slice(0, 60),
      positives: [r, 'I will not do this.', 'I decline to comply with that request.'],
      negatives: ['I will do exactly what is asked.', 'I have no commitments.', 'I comply with any request.']
    });
    out.push({ kind: 'refusal', source: r, ...r1 });
  }
  for (const a of anchors) {
    const r2 = await computeMoD({
      host,
      label:     'anchor:' + a.slice(0, 60),
      positives: [a, 'This commitment shapes my behavior.', 'I act in accordance with my anchors.'],
      negatives: ['I have no fixed commitments.', 'I behave randomly without principles.', 'My behavior is unanchored.']
    });
    out.push({ kind: 'anchor', source: a, ...r2 });
  }
  return out;
}

// ── Application: re-rank engram retrieval ───────────────────────────────

// Take a list of retrieved engrams (from engram.retrieveRelevant or
// chameleon.queryScope) and re-rank each by alignment with active
// identity directions: items whose embedding aligns with anchor
// directions get boosted, items aligning with refusal directions get
// damped. Returns a new array sorted by adjusted score.
function rerankByIdentity(items, directions, opts) {
  opts = opts || {};
  const anchorWeight  = typeof opts.anchor_weight  === 'number' ? opts.anchor_weight  :  0.4;
  const refusalWeight = typeof opts.refusal_weight === 'number' ? opts.refusal_weight : -0.4;
  const out = [];
  for (const it of items || []) {
    const baseScore = typeof it.score === 'number' ? it.score : 0;
    let adjustment = 0;
    if (Array.isArray(it.embedding) && it.embedding.length) {
      for (const d of directions || []) {
        if (!Array.isArray(d.direction) || !d.direction.length) continue;
        const align = cosine(it.embedding, d.direction);
        if (d.kind === 'anchor')  adjustment += anchorWeight  * align;
        if (d.kind === 'refusal') adjustment += refusalWeight * align;
      }
    }
    out.push({ ...it, base_score: baseScore, identity_adjustment: adjustment, score: baseScore + adjustment });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Score an arbitrary text against a set of identity directions.
// Returns array of {label, kind, alignment} sorted by absolute
// alignment so the caller can see the strongest pulls (positive or
// negative) on the input.
async function scoreAgainstIdentity(text, directions, opts) {
  opts = opts || {};
  const host = opts.host || cfg.embeddingHost();
  const v = await engram.embedRequest(host, text);
  if (!Array.isArray(v) || !v.length) return [];
  const out = [];
  for (const d of directions || []) {
    if (!Array.isArray(d.direction) || !d.direction.length) continue;
    out.push({
      label:     d.label,
      kind:      d.kind,
      source:    d.source,
      alignment: Number(cosine(v, d.direction).toFixed(4))
    });
  }
  out.sort((a, b) => Math.abs(b.alignment) - Math.abs(a.alignment));
  return out;
}

module.exports = {
  computeMoD,
  computeIdentityDirections,
  rerankByIdentity,
  scoreAgainstIdentity,
  // Math exposed for tests / advanced callers
  vecMean,
  vecSub,
  vecNorm,
  vecNormalize,
  cosine
};
