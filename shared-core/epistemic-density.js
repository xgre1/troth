// SPDX-License-Identifier: AGPL-3.0-only
// epistemic-density — Epistemic Void Detector from
// the substrate design work.
//
// What it does: substrate calculates "epistemic density" per file
// path mentioned in a user prompt — the count of action_records this
// substrate has accumulated involving that path. When the count is
// near zero, the substrate KNOWS it doesn't know — it has no
// validated history with that file. The injector surfaces a compact
// `[troth/epistemic-void]` warning so the LLM sees the gap before
// confabulating.
//
// Falsifiability spec from the paper:
//   High-density file (heavily edited): score ≈ 1.0
//   Untouched legacy file: score < 0.10
//   Latency: < 50ms with NO LLM call
//   The intercept happens BEFORE the LLM gets to hallucinate
//
// Ground in Nelson & Narens 1990 metacognitive monitoring framework
// (the design work): the substrate maintains a calibrated map of what
// it knows, attaches uncertainty to retrievals, and generates
// "cognitive friction" before high-stakes actions in low-density
// zones.
//
// What we DO:
//   1. extractTargetPaths(prompt) — pull file paths out of prompt text
//   2. densityForPath(state, cwd, path) — direct SQL count of
//      action_records mentioning that path (input.file_path,
//      input.path, or substring match in input/output JSON)
//   3. epistemicScore(density, opts) — convert raw count to a
//      0..1 confidence score with diminishing returns
//   4. assessPaths({state, cwd, prompt}) — full pipeline, returns
//      [{path, density, score, void}] for each extracted path
//
// What we DO NOT do:
//   Build a directory-level density rollup (the paper mentions
//     directory-rolling, but per-path is the immediate need; rollup
//     is the next iteration if directory-level injectors emerge)
//   Distinguish "verified" from "unverified" records. Per the
//     paper, validated schema records are the strong signal — but
//     in our action_record schema "verification" is sparse, so we
//     count everything. False-positive risk is low: a path with 50
//     action_records but no verification.ast.ok=true is still
//     not an epistemic void.
//   Train a real classifier. 's prototype scope is explicit:
//     "rolling density score per directory" + "interception
//     middleware modifies the system prompt." Anything more is
//     premature.

const FILE_PATH = /[\w./-]+\.[\w]{1,6}\b/g;

// Score curve: density → confidence. log-saturating so the first
// few records move the score a lot, later records add diminishing
// returns. score(0) = 0.0, score(1) ≈ 0.16, score(5) ≈ 0.50,
// score(20) ≈ 0.86, score(100) ≈ 1.0.
const DEFAULT_SCALE = 5;

// Default void threshold (paper spec: "< 10% triggers warning")
const DEFAULT_VOID_THRESHOLD = 0.10;

// ── Path extraction ────────────────────────────────────────────────────

// Pull file-path-shaped tokens out of arbitrary prompt text. Returns
// a deduped array preserving order of first appearance. The same
// regex as procedure-matcher / entity-axis to keep extraction
// consistent across substrate surfaces.
function extractTargetPaths(prompt) {
  const text = String(prompt || '');
  if (!text) return [];
  const matches = text.match(FILE_PATH);
  if (!matches) return [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// ── Density measurement ────────────────────────────────────────────────

// Direct SQL count via state's underlying DB connection. Matches
// records where this path appears in input.file_path, input.path,
// or anywhere in the JSON input/output blob. cwd-scoped so cross-
// project paths don't pollute. Returns 0 on any failure (treated
// as "no signal" by the score curve, which is conservative —
// produces a void warning on uncertainty rather than hiding it).
function densityForPath(state, cwd, path) {
  if (!state || !path) return 0;
  const db = state._dbForQuery && state._dbForQuery();
  if (!db) return 0;
  try {
    // Three-pronged match. The first two hit the canonical
    // input.file_path / input.path slots used by Read/Edit/Write/
    // Glob. The third LIKE clause is a substring fallback — slow
    // for huge stores, but the cwd filter bounds the scan.
    const sql = `
      SELECT COUNT(*) AS n
      FROM action_records
      WHERE cwd = @cwd AND (
        json_extract(input, '$.file_path') = @path
        OR json_extract(input, '$.path') = @path
        OR (input LIKE @needle)
      )
    `;
    const needle = '%' + path.replace(/[\\%_]/g, '') + '%';
    const row = db.prepare(sql).get({ cwd, path, needle });
    return (row && row.n) || 0;
  } catch (_) {
    return 0;
  }
}

// ── Score curve ────────────────────────────────────────────────────────

function epistemicScore(density, opts) {
  opts = opts || {};
  const scale = typeof opts.scale === 'number' ? opts.scale : DEFAULT_SCALE;
  if (density <= 0) return 0;
  // 1 - exp(-density / scale): saturating curve.
  return 1 - Math.exp(-density / scale);
}

// ── Full pipeline ──────────────────────────────────────────────────────

function assessPaths(opts) {
  opts = opts || {};
  const state = opts.state;
  const cwd = opts.cwd || null;
  const prompt = opts.prompt || '';
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_VOID_THRESHOLD;
  const scale = typeof opts.scale === 'number' ? opts.scale : DEFAULT_SCALE;

  const paths = extractTargetPaths(prompt);
  const out = [];
  for (const p of paths) {
    const density = densityForPath(state, cwd, p);
    const score = epistemicScore(density, { scale });
    out.push({
      path: p,
      density,
      score,
      void: score < threshold
    });
  }
  return out;
}

module.exports = {
  extractTargetPaths,
  densityForPath,
  epistemicScore,
  assessPaths,
  DEFAULT_SCALE,
  DEFAULT_VOID_THRESHOLD
};
