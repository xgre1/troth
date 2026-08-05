// SPDX-License-Identifier: AGPL-3.0-only
// Lesson Library — the entity design primitive.
//
// "Procedural knowledge accumulation with quality framework."
//
// Lessons (type='lesson') already accumulate in L1 via:
//   errortax.mjs hook (writes lesson on tool failure → fix sequence)
//   revision-protocol.js (writes lesson on rejected revision proposal)
//   critic.js (writes lesson on quality-gate trip)
//
// What was MISSING: a quality framework that ranks which lessons should
// actually be RE-SURFACED into prefix on similar future situations. Without
// ranking, retrieval is purely chronological — recent noise drowns out
// older durable patterns. The dream property is "learns genuinely" which
// requires both accumulation AND surfacing-by-quality.
//
// Quality is a 0..1 score from a weighted sum of five dimensions:
//
//   1. recurrence_match (0.30) — lesson's `fingerprint` has matched
//      multiple distinct sessions. A lesson seen 5× across 5 days is
//      higher signal than a lesson seen 5× in one session.
//   2. usefulness_feedback (0.25) — explicit `useful=true` from
//      user-feedback edges (`marks_useful`) divided by total surfacings.
//      Substrate trains itself on what survived contact with the user.
//   3. recency_decay (0.15) — exp(-age_days / 30). Old lessons that no
//      longer recur drift out; old lessons that still recur stay because
//      recurrence_match dominates.
//   4. structural_anchor (0.15) — lesson references a real file_path /
//      symbol that still exists in the codebase. Lessons about deleted
//      files lose this dimension.
//   5. specificity (0.15) — lesson statement length in [50..400] chars.
//      Short = vague; very long = unstructured rambling. Structured
//      lessons (postmortems with cause/fix/avoid sections) score in
//      the sweet spot.
//
// All fields are optional in the lesson record; missing dimensions
// contribute 0 (not 0.5) so absent evidence never inflates score.
//
// API:
//   scoreLesson(rec, ctx?) → { quality, dimensions }
//   rankLessons(records, ctx?) → records sorted desc, top-N
//
// `ctx.fileExists(path)` — optional callback for dimension #4. If the
// caller doesn't provide one, structural_anchor scores 0 (substrate
// stays honest).

const W = {
  recurrence_match:    0.30,
  usefulness_feedback: 0.25,
  recency_decay:       0.15,
  structural_anchor:   0.15,
  specificity:         0.15
};

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Recurrence: count how many DISTINCT sessions touched this fingerprint.
// Caller passes the full lesson set; we count fingerprint multiplicity
// across distinct session_ids. A lesson recurring across 5 sessions
// scores 1.0; single-session matches score 0.
function dimRecurrence(rec, allLessons) {
  if (!rec || !rec.input || !rec.input.fingerprint) return 0;
  const fp = rec.input.fingerprint;
  const sessions = new Set();
  for (const l of allLessons) {
    if (l && l.input && l.input.fingerprint === fp && l.session_id) {
      sessions.add(l.session_id);
    }
  }
  // 1 session = 0; 2 = 0.4; 3 = 0.7; 5+ = 1.0
  const n = sessions.size;
  if (n <= 1) return 0;
  if (n === 2) return 0.4;
  if (n === 3) return 0.7;
  if (n === 4) return 0.9;
  return 1.0;
}

function dimUsefulness(rec) {
  if (!rec || !rec.output) return 0;
  const useful = Number(rec.output.useful_count || 0);
  const surfaced = Number(rec.output.surfaced_count || 0);
  if (surfaced <= 0) return 0;
  return clamp01(useful / surfaced);
}

function dimRecency(rec, nowMs) {
  if (!rec || !rec.timestamp) return 0;
  const ageDays = Math.max(0, ((nowMs || Date.now()) - rec.timestamp) / (1000 * 60 * 60 * 24));
  return clamp01(Math.exp(-ageDays / 30));
}

function dimStructuralAnchor(rec, ctx) {
  if (!rec || !rec.input) return 0;
  const path = rec.input.file_path || (rec.output && rec.output.file_path);
  if (!path) return 0;
  if (!ctx || typeof ctx.fileExists !== 'function') return 0;
  try { return ctx.fileExists(path) ? 1 : 0; } catch (_) { return 0; }
}

function dimSpecificity(rec) {
  if (!rec || !rec.output) return 0;
  const stmt = String(rec.output.lesson_text || rec.output.statement || rec.output.summary || '');
  const len = stmt.length;
  if (len < 30)  return 0;
  if (len < 50)  return 0.4;
  if (len <= 400) return 1.0;
  if (len <= 800) return 0.6;
  return 0.3;  // > 800 chars = unstructured rambling penalty
}

function scoreLesson(rec, ctx) {
  ctx = ctx || {};
  const allLessons = ctx.allLessons || [rec];
  const dims = {
    recurrence_match:    dimRecurrence(rec, allLessons),
    usefulness_feedback: dimUsefulness(rec),
    recency_decay:       dimRecency(rec, ctx.now),
    structural_anchor:   dimStructuralAnchor(rec, ctx),
    specificity:         dimSpecificity(rec)
  };
  let q = 0;
  for (const k of Object.keys(W)) q += W[k] * dims[k];
  return { quality: clamp01(q), dimensions: dims };
}

function rankLessons(records, ctx) {
  if (!Array.isArray(records) || !records.length) return [];
  ctx = ctx || {};
  // Pass the full set so dimRecurrence sees all sessions.
  const ctxWithAll = Object.assign({}, ctx, { allLessons: records });
  const limit = Math.max(1, Math.min(50, ctx.limit || 10));
  const scored = records.map(r => Object.assign({}, r, { _quality: scoreLesson(r, ctxWithAll) }));
  scored.sort((a, b) => (b._quality.quality || 0) - (a._quality.quality || 0));
  return scored.slice(0, limit);
}

module.exports = {
  scoreLesson,
  rankLessons,
  WEIGHTS: W
};
