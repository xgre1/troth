// SPDX-License-Identifier: AGPL-3.0-only
// goal-status.js — track goal lifecycle (open → satisfied / abandoned) for
// autonomous pursuit.
//
// design goal-class bootstrap mentions status transitions but doesn't
// pick a storage mechanism. We use the existing engram + commitment_type
// pattern instead of adding a new table:
//
//   The user-written goal lands as `engram` scope='goal' (existing
//     /goal slash command, unchanged).
//   When the coordinator successfully pursues + reflects on a goal, we
//     write a SECOND commitment row with scope='system:goal-satisfied'
//     and an output.satisfies_goal_id pointing at the original engram.
//   unifiedGoalSource filters out goals that have an active satisfaction
//     record — partner stops re-pursuing.
//
// Why not mutate the original engram? The substrate is append-only by
// design (R23). Mutations are new rows that supersede prior ones via
// parent_id / supersedes edges. Same pattern as PLR reconsolidation.
//
// API:
//   markSatisfied({ goal_id, agent_id, cwd?, briefing? }) → id of marker row
//   markAbandoned({ goal_id, agent_id, cwd?, reason? }) → id of marker row
//   isSatisfied(goal_id) → boolean
//   isAbandoned(goal_id) → boolean
//   listSatisfactions({limit?}) → [{ marker_id, goal_id, ts, briefing }]
//   filterOpen(goals) → goals[] excluding satisfied / abandoned

const engram = require('./engram.js');
const state  = require('./state.js');

function markSatisfied(opts) {
  opts = opts || {};
  if (!opts.goal_id) throw new Error('goal-status.markSatisfied: goal_id required');
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'l4-coordinator',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || null,
    statement: 'GOAL SATISFIED: ' + (opts.summary || opts.briefing || opts.goal_id),
    salience:  1,
    scope:     'system:goal-satisfied',
    parent_id: opts.goal_id,  // chain to the original goal engram
    source:    opts.source || 'l4:coordinator:success',
    audience:  'substrate_internal',
    memory_class: 'operational'
  });
  return id;
}

function markAbandoned(opts) {
  opts = opts || {};
  if (!opts.goal_id) throw new Error('goal-status.markAbandoned: goal_id required');
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'l4-coordinator',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || null,
    statement: 'GOAL ABANDONED: ' + (opts.reason || opts.goal_id),
    salience:  1,
    scope:     'system:goal-abandoned',
    parent_id: opts.goal_id,
    source:    opts.source || 'l4:coordinator:abandon',
    audience:  'substrate_internal',
    memory_class: 'operational'
  });
  return id;
}

// SS15.4-lite — operator pause/resume. Same append-only marker pattern:
// the MOST RECENT paused/resumed marker wins. Paused goals stay OPEN
// (never satisfied/abandoned); idle-pursuit skips them and step-engine
// stops at the next step boundary.
function _writePauseMarker(opts, action, label) {
  if (!opts.goal_id) throw new Error('goal-status.' + label + ': goal_id required');
  // Deliberately a TOOL_CALL row, not a commitment: commitments pass the
  // STVC validation walls (sealed capabilities) and a lifecycle flag from
  // an operator surface has no business fighting them. tool_call is the
  // established pattern for operational transitions (_recordTransition in
  // step-engine) and works identically in app, CLI and the hermetic suite.
  const state2 = require('./state.js');
  const actionRec = require('./action-record.js');
  const id = actionRec.uuidv7();
  state2.recordAction({
    id,
    timestamp: Date.now(),
    type: 'tool_call',
    agent_id: opts.agent_id || 'l4-coordinator',
    user_id: opts.user_id || null,
    cwd: opts.cwd || null,
    parent_id: opts.goal_id,
    input: { tool_name: 'l4_goal_pause_marker', args: { action: action, reason: opts.reason || 'operator' } },
    output: { action: action, reason: opts.reason || 'operator' },
    audience: 'substrate_internal',
    memory_class: 'operational'
  }, 'goal ' + action + ' marker ' + opts.goal_id);
  return id;
}

function markPaused(opts) {
  return _writePauseMarker(opts || {}, 'pause', 'markPaused');
}

function markResumed(opts) {
  return _writePauseMarker(opts || {}, 'resume', 'markResumed');
}

function isPaused(goalId) {
  if (!goalId) return false;
  try {
    const rows = state.queryActions({
      type: 'tool_call',
      tool_name: 'l4_goal_pause_marker',
      parent_id: goalId,
      limit: 50
    }) || [];
    let best = null;
    for (const r of rows) {
      let out; try { out = typeof r.output === 'string' ? JSON.parse(r.output) : r.output; } catch (_) { continue; }
      const act = out && out.action;
      if (act === 'pause' || act === 'resume') {
        if (!best || r.timestamp > best.ts) best = { ts: r.timestamp, action: act };
      }
    }
    return !!(best && best.action === 'pause');
  } catch (_) { return false; }
}

// Returns the most recent satisfaction OR abandonment marker engram for a
// given goal_id, or null. Uses parent_id index — cheap point lookup.
function _statusMarkerFor(goalId) {
  if (!goalId) return null;
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: goalId, limit: 50 }) || [];
    // Prefer the most recent satisfied/abandoned marker; ignore other commitments.
    let best = null;
    for (const r of rows) {
      let out; try { out = JSON.parse(r.output); } catch (_) { continue; }
      const sc = out && out.scope;
      if (sc === 'system:goal-satisfied' || sc === 'system:goal-abandoned') {
        if (!best || r.timestamp > best.timestamp) best = { row: r, out };
      }
    }
    return best;
  } catch (_) { return null; }
}

function isSatisfied(goalId) {
  const m = _statusMarkerFor(goalId);
  return !!(m && m.out && m.out.scope === 'system:goal-satisfied');
}

function isAbandoned(goalId) {
  const m = _statusMarkerFor(goalId);
  return !!(m && m.out && m.out.scope === 'system:goal-abandoned');
}

// Filter a list of goal engrams (whatever shape unifiedGoalSource produces
// — {id, statement,...}) to those without a satisfaction / abandonment
// marker. Used by idle-pursuit so partner doesn't loop on completed goals.
function filterOpen(goals) {
  if (!Array.isArray(goals)) return [];
  const out = [];
  for (const g of goals) {
    if (!g || !g.id) continue;
    if (isSatisfied(g.id) || isAbandoned(g.id)) continue;
    out.push(g);
  }
  return out;
}

function listSatisfactions(opts) {
  opts = opts || {};
  const limit = Math.min(parseInt(opts.limit || 20), 200);
  try {
    const rows = state.queryActions({ type: 'commitment', limit: limit * 5 }) || [];
    const out = [];
    for (const r of rows) {
      let parsed; try { parsed = JSON.parse(r.output); } catch (_) { continue; }
      if (!parsed || parsed.scope !== 'system:goal-satisfied') continue;
      out.push({
        marker_id: r.id,
        goal_id:   r.parent_id,
        ts:        r.timestamp,
        statement: parsed.statement
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (_) { return []; }
}

// ── D1: in-progress continuity ────────────────────────────────────────
// A goal pursued across MULTIPLE heartbeat ticks gets an in-progress marker so
// the next tick keeps returning to it (continuity) instead of re-selecting a
// fresh goal each time. Satisfied/abandoned SUPERSEDE it (a done goal is not
// in-progress). Same append-only engram pattern as satisfied/abandoned.
function markInProgress(opts) {
  opts = opts || {};
  if (!opts.goal_id) throw new Error('goal-status.markInProgress: goal_id required');
  return engram.recordEngram({
    agent_id: opts.agent_id || 'l4-coordinator',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || null,
    statement: 'GOAL IN_PROGRESS: ' + (opts.briefing || opts.goal_id),
    salience:  1,
    scope:     'system:goal-in-progress',
    parent_id: opts.goal_id,
    source:    opts.source || 'l4:coordinator:in-progress',
    audience:  'substrate_internal',
    memory_class: 'operational',
    extra_output: { step_index: (typeof opts.step_index === 'number' ? opts.step_index : 0) }
  });
}

function getProgress(goalId) {
  const none = { in_progress: false, step_index: 0, started_ts: 0 };
  if (!goalId) return none;
  // Satisfied / abandoned supersede in-progress.
  if (isSatisfied(goalId) || isAbandoned(goalId)) return none;
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: goalId, limit: 50 }) || [];
    let best = null;
    for (const r of rows) {
      let out; try { out = JSON.parse(r.output); } catch (_) { continue; }
      if (out && out.scope === 'system:goal-in-progress') {
        if (!best || r.timestamp > best.timestamp) best = { row: r, out };
      }
    }
    if (!best) return none;
    return { in_progress: true, step_index: (best.out.step_index || 0), started_ts: best.row.timestamp };
  } catch (_) { return none; }
}

// ── D5: abandon / backoff for repeatedly-failing goals ─────────────────
// A never-satisfiable goal must NOT re-fire every heartbeat (the design's
// "re-fires every 30s forever" hole). Each failed pursuit records an
// attempt-failed marker; backoff grows exponentially from the last attempt;
// at MAX attempts the goal is abandoned (then filterOpen excludes it).
const MAX_GOAL_ATTEMPTS = 5;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000; // 6h ceiling

function recordFailedAttempt(opts) {
  opts = opts || {};
  if (!opts.goal_id) throw new Error('goal-status.recordFailedAttempt: goal_id required');
  return engram.recordEngram({
    agent_id: opts.agent_id || 'l4-coordinator',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || null,
    statement: 'GOAL ATTEMPT FAILED: ' + (opts.reason || opts.goal_id),
    salience:  1,
    scope:     'system:goal-attempt-failed',
    parent_id: opts.goal_id,
    source:    opts.source || 'l4:coordinator:attempt-failed',
    audience:  'substrate_internal',
    memory_class: 'operational'
  });
}

// Newest-first timestamps of attempt-failed markers for a goal.
function _attemptMarkers(goalId) {
  if (!goalId) return [];
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: goalId, limit: 100 }) || [];
    const out = [];
    for (const r of rows) {
      let o; try { o = JSON.parse(r.output); } catch (_) { continue; }
      if (o && o.scope === 'system:goal-attempt-failed') out.push(r.timestamp);
    }
    out.sort((a, b) => b - a);
    return out;
  } catch (_) { return []; }
}

function attemptCount(goalId) { return _attemptMarkers(goalId).length; }

function shouldAbandon(goalId) { return attemptCount(goalId) >= MAX_GOAL_ATTEMPTS; }

function attemptBackoff(goalId, opts) {
  opts = opts || {};
  const markers = _attemptMarkers(goalId);
  const count = markers.length;
  if (!count) return { attempt_count: 0, backoff_until_ts: 0 };
  const idleTick = (typeof opts.idle_tick_ms === 'number' && opts.idle_tick_ms > 0) ? opts.idle_tick_ms : 30000;
  const backoffMs = Math.min(BACKOFF_CAP_MS, Math.pow(2, count) * idleTick);
  return { attempt_count: count, backoff_until_ts: markers[0] + backoffMs };
}

// True if the goal failed recently and is still inside its exponential backoff
// window — idle-pursuit skips these so a failing goal doesn't re-fire each tick.
function isInBackoff(goalId, opts) {
  const b = attemptBackoff(goalId, opts);
  if (!b.attempt_count) return false;
  return Date.now() < b.backoff_until_ts;
}

// ── Findings ──────────────────────────────────────────────────────
// What the knowledge pass found for a goal: a fact read from a source that
// answers it. Same append-only marker pattern, chained to the goal; a goal
// with findings stays open until the operator or the pursuit closes it.
function markFinding(opts) {
  opts = opts || {};
  if (!opts.goal_id) throw new Error('goal-status.markFinding: goal_id required');
  if (opts.knowledge_id && listFindings(opts.goal_id).some((f) => f.knowledge_id === opts.knowledge_id)) return null;
  return engram.recordEngram({
    agent_id: opts.agent_id || 'background-worker',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || null,
    statement: 'GOAL FINDING: ' + String(opts.statement || '').slice(0, 400),
    salience:  1,
    scope:     'system:goal-finding',
    parent_id: opts.goal_id,
    source:    opts.source || 'background_worker.knowledge_understanding',
    source_authority: 'plr_evolved',
    audience:  'substrate_internal',
    memory_class: 'operational',
    auto_verify: false,
    extra_output: { payload: { knowledge_id: opts.knowledge_id || null, source_title: opts.source_title || null, source_ref: opts.source_ref || null } }
  });
}

function listFindings(goalId, opts) {
  if (!goalId) return [];
  const limit = Math.min(parseInt((opts && opts.limit) || 50), 500);
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: goalId, limit: limit * 2 }) || [];
    const out = [];
    for (const r of rows) {
      let parsed; try { parsed = JSON.parse(r.output); } catch (_) { continue; }
      if (!parsed || parsed.scope !== 'system:goal-finding') continue;
      const p = parsed.payload || {};
      out.push({ marker_id: r.id, goal_id: r.parent_id, ts: r.timestamp, statement: String(parsed.statement || '').replace(/^GOAL FINDING:\s*/, ''), knowledge_id: p.knowledge_id || null, source_title: p.source_title || null, source_ref: p.source_ref || null });
      if (out.length >= limit) break;
    }
    return out;
  } catch (_) { return []; }
}

function countFindings(goalId) { return listFindings(goalId, { limit: 500 }).length; }

module.exports = {
  markSatisfied,
  markFinding,
  listFindings,
  countFindings,
  markAbandoned,
  // SS15.4-lite — operator pause/resume
  markPaused,
  markResumed,
  isPaused,
  isSatisfied,
  isAbandoned,
  filterOpen,
  listSatisfactions,
  _statusMarkerFor,
  // D1 — in-progress continuity
  markInProgress,
  getProgress,
  // D5 — abandon / backoff
  recordFailedAttempt,
  attemptCount,
  shouldAbandon,
  attemptBackoff,
  isInBackoff,
  MAX_GOAL_ATTEMPTS
};
