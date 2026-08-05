// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic query API over the ActionRecord substrate.
//
// This is the layer that lets an agent ask "have I read this file?" and get
// certainty instead of a guess. It is the emergent-property-producing
// difference between "retrieval" (semantic, approximate, hallucination-prone)
// and "query" (deterministic, exact, trustworthy).
//
// Everything here returns boolean or structured rows, NEVER natural-language
// summaries. A consumer that wants summaries composes them on top; the query
// layer itself answers yes/no/what with certainty.
//
// Design rule: every function takes `state` as first arg (dependency
// injection) so tests can wire an isolated data dir. No global SQLite handle.
//
// See the substrate design notes "Layer 2 — DecisionGraph" and
// the substrate design notes.

const actionRecord = require('./action-record');

// ── Basic presence checks ─────────────────────────────────────────────────

// Has a read action for this file been recorded in this session? Falls back
// to session-wide when session_id not provided. Certain yes/no — no retrieval.
function hasBeenRead(state, opts) {
  if (!state || !opts || !opts.file_path) return false;
  const where = ['type = @type', "json_extract(input, '$.file_path') = @path"];
  const bind = { type: 'read', path: opts.file_path };
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.since)      { where.push('timestamp >= @since');      bind.since = opts.since; }
  const row = state._dbForQuery
    ? state._dbForQuery().prepare(`
        SELECT 1 FROM action_records WHERE ${where.join(' AND ')} LIMIT 1
      `).get(bind)
    : fallbackCount(state, 'read', bind);
  return !!row;
}

// Count any records matching a filter — thin wrapper over state.countActions
// but shaped so callers can query by file_path (which lives inside input
// JSON, not as a column). Returns a number.
function countReads(state, opts) {
  if (!state || !opts) return 0;
  const bind = {};
  const where = ['type = @type'];
  bind.type = 'read';
  if (opts.file_path)  { where.push("json_extract(input, '$.file_path') = @path"); bind.path = opts.file_path; }
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.cwd)        { where.push('cwd = @cwd'); bind.cwd = opts.cwd; }
  if (opts.since)      { where.push('timestamp >= @since'); bind.since = opts.since; }
  try {
    return state._dbForQuery().prepare(`
      SELECT COUNT(*) AS n FROM action_records WHERE ${where.join(' AND ')}
    `).get(bind).n;
  } catch { return 0; }
}

// ── Edit history ──────────────────────────────────────────────────────────

// All edits to a file in chronological order. Returns parsed ActionRecord
// objects (fromRow), not raw rows. Callers can cheaply walk verification +
// outcome fields without re-parsing JSON.
function getEditHistory(state, opts) {
  if (!state || !opts || !opts.file_path) return [];
  const bind = { path: opts.file_path };
  const where = ["type = 'edit'", "json_extract(input, '$.file_path') = @path"];
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.cwd)        { where.push('cwd = @cwd'); bind.cwd = opts.cwd; }
  if (opts.since)      { where.push('timestamp >= @since'); bind.since = opts.since; }
  if (opts.until)      { where.push('timestamp <= @until'); bind.until = opts.until; }
  const limit = Math.min(parseInt(opts.limit || 100), 1000);
  try {
    const rows = state._dbForQuery().prepare(`
      SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
             parent_id, context_hash, input, output, verification, outcome
      FROM action_records
      WHERE ${where.join(' AND ')}
      ORDER BY timestamp ASC
      LIMIT ${limit}
    `).all(bind);
    return rows.map(actionRecord.fromRow);
  } catch { return []; }
}

// ── Verification-filtered queries ─────────────────────────────────────────

// Actions whose verification.verdict is 'pass' (i.e., AST ok, tests green,
// no failures). Useful for "give me examples of successful edits in this
// repo" without re-running verification.
function getVerifiedActions(state, opts) {
  if (!state || !opts) return [];
  const bind = {};
  const where = [];
  if (opts.type)       { where.push('type = @type'); bind.type = opts.type; }
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.cwd)        { where.push('cwd = @cwd'); bind.cwd = opts.cwd; }
  if (opts.since)      { where.push('timestamp >= @since'); bind.since = opts.since; }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(parseInt(opts.limit || 100), 1000);
  try {
    const rows = state._dbForQuery().prepare(`
      SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
             parent_id, context_hash, input, output, verification, outcome
      FROM action_records
      ${whereSQL}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `).all(bind);
    return rows
      .map(actionRecord.fromRow)
      .filter(r => isVerifiedPass(r.verification));
  } catch { return []; }
}

// Actions whose verification contains any ok:false slot (explicit failure).
// Distinct from "no verification" which is partial/unknown.
function findFailedAttempts(state, opts) {
  if (!state || !opts) return [];
  const bind = {};
  const where = [];
  if (opts.type)       { where.push('type = @type'); bind.type = opts.type; }
  if (opts.file_path)  { where.push("json_extract(input, '$.file_path') = @path"); bind.path = opts.file_path; }
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.cwd)        { where.push('cwd = @cwd'); bind.cwd = opts.cwd; }
  if (opts.since)      { where.push('timestamp >= @since'); bind.since = opts.since; }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(parseInt(opts.limit || 100), 1000);
  try {
    const rows = state._dbForQuery().prepare(`
      SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
             parent_id, context_hash, input, output, verification, outcome
      FROM action_records
      ${whereSQL}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `).all(bind);
    return rows
      .map(actionRecord.fromRow)
      .filter(r => hasFailedSlot(r.verification));
  } catch { return []; }
}

// ── Generic typed lookup ──────────────────────────────────────────────────

// Get recent actions of a given type matching filters. Thin convenience
// around state.queryActions but returns parsed ActionRecord objects.
function getActionsByType(state, type, opts) {
  if (!state || !type) return [];
  opts = opts || {};
  const rows = state.queryActions ? state.queryActions({ ...opts, type }) : [];
  return rows.map(actionRecord.fromRow);
}

// ── Lesson surface ────────────────────────────────────────────────────────

// Distinct lessons recorded for a given scope, deduped by fingerprint.
// Used by injector to decide what to re-surface; unlike semantic retrieval,
// this gives an exact list, newest first.
function getLessons(state, opts) {
  if (!state) return [];
  opts = opts || {};
  const bind = {};
  const where = ["type = 'lesson'"];
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.cwd)        { where.push('cwd = @cwd'); bind.cwd = opts.cwd; }
  if (opts.since)      { where.push('timestamp >= @since'); bind.since = opts.since; }
  const limit = Math.min(parseInt(opts.limit || 50), 200);
  try {
    const rows = state._dbForQuery().prepare(`
      SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
             parent_id, context_hash, input, output, verification, outcome,
             principal_id, audience, memory_class
      FROM action_records
      WHERE ${where.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `).all(bind);
    const parsed = rows.map(actionRecord.fromRow);
    // Dedup by fingerprint (input.fingerprint).
    const seen = new Set();
    const out = [];
    for (const r of parsed) {
      const fp = r.input && r.input.fingerprint;
      if (fp && seen.has(fp)) continue;
      if (fp) seen.add(fp);
      out.push(r);
    }
    return out;
  } catch { return []; }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isVerifiedPass(verification) {
  if (!verification || typeof verification !== 'object') return false;
  let anyOk = false;
  for (const k of Object.keys(verification)) {
    const v = verification[k];
    if (!v || typeof v !== 'object') continue;
    if (v.skipped) continue;
    if (v.ok === false) return false;  // any explicit fail → not a pass
    if (v.ok === true) anyOk = true;
  }
  return anyOk;
}

function hasFailedSlot(verification) {
  if (!verification || typeof verification !== 'object') return false;
  for (const k of Object.keys(verification)) {
    const v = verification[k];
    if (v && v.ok === false) return true;
  }
  return false;
}

// Fallback path when state hasn't exposed _dbForQuery (tests may mock).
// Uses the public countActions API where possible.
function fallbackCount(state, type, bind) {
  if (!state.countActions) return false;
  return state.countActions({ type, session_id: bind.session_id, since: bind.since }) > 0;
}

// ── P16 Tier 1 — DecisionGraph path queries ────────────────────────────────

// Walk typed edges from a starting record up to depth_limit hops. Returns
// rows: { node_id, depth, path }. Implemented as a single recursive CTE
// (no JS-side loop) so SQLite's query planner can use the indexed edge
// columns. Per research G16.F, depth limit is capped at 25 — performance
// degrades sharply past 10–15 hops on large graphs.
//
// opts:
//   start_id     (required) — UUID of the starting record
//   depth_limit  (optional, default 10, max 25)
//   direction    (optional, default 'out') — 'out' follows from_id→to_id,
//                'in' follows to_id→from_id (ancestry)
//   label        (optional) — restrict traversal to a single edge label
function traceCausalPath(state, opts) {
  if (!state || !opts || !opts.start_id) return [];
  const depth = Math.min(parseInt(opts.depth_limit || 10), 25);
  const direction = opts.direction === 'in' ? 'in' : 'out';
  const labelFilter = opts.label ? 'AND e.label = @label' : '';
  const bind = { start: opts.start_id };
  if (opts.label) bind.label = opts.label;
  // CTE uses UNION (not UNION ALL) so each (node_id, depth, path) tuple is
  // deduplicated — without this, a graph with fan-in produces every distinct
  // path through it, which explodes combinatorially in dense graphs (and was
  // observed to hang on a 50k-edge fixture during P16-T1 perf smoke). The
  // outer GROUP BY then collapses to the shortest depth per node.
  const sql = direction === 'out'
    ? `
      WITH RECURSIVE walk(node_id, depth, path) AS (
        SELECT @start, 0, ''
        UNION
        SELECT e.to_id, w.depth + 1, w.path || '>' || e.label
        FROM action_record_edges e
        JOIN walk w ON e.from_id = w.node_id
        WHERE w.depth < ${depth} ${labelFilter}
      )
      SELECT node_id, MIN(depth) AS depth, MIN(path) AS path
      FROM walk WHERE depth > 0 GROUP BY node_id
    `
    : `
      WITH RECURSIVE walk(node_id, depth, path) AS (
        SELECT @start, 0, ''
        UNION
        SELECT e.from_id, w.depth + 1, w.path || '<' || e.label
        FROM action_record_edges e
        JOIN walk w ON e.to_id = w.node_id
        WHERE w.depth < ${depth} ${labelFilter}
      )
      SELECT node_id, MIN(depth) AS depth, MIN(path) AS path
      FROM walk WHERE depth > 0 GROUP BY node_id
    `;
  try { return state._dbForQuery().prepare(sql).all(bind); }
  catch { return []; }
}

// Convenience: list edges by filter. Proxies to state.queryEdges so the
// query layer's API shape stays uniform (state-as-DI).
function queryEdges(state, opts) {
  if (!state || !state.queryEdges) return [];
  return state.queryEdges(opts || {});
}

module.exports = {
  // Presence
  hasBeenRead,
  countReads,
  // Edit lineage
  getEditHistory,
  // Verification-filtered
  getVerifiedActions,
  findFailedAttempts,
  // Generic
  getActionsByType,
  // Lessons
  getLessons,
  // P16 Tier 1 — DecisionGraph
  traceCausalPath,
  queryEdges,
  // Helpers (exported for tests and downstream reuse)
  isVerifiedPass,
  hasFailedSlot
};
