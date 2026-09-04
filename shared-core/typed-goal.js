// SPDX-License-Identifier: AGPL-3.0-only Typed Goal projector. Projects
// engrams scope='goal' (+ their satisfaction / abandonment / decomposition
// markers) into a typed Goal shape the dashboard, app inbox, and idle-pursuit
// can consume without re-parsing engram blobs. Per design slice 2.2 the spec
// is a "table" — but we keep the substrate append-only and read goals as a
// PROJECTION over engrams + status markers (same pattern as goal-status.js).
// Typed Goal shape (design 2.2): { id, parent_id, status, percent_done,
// next_action, blocked_on, deadline, regime, project_id, ts } Field
// provenance: id — engram.id parent_id — engram.parent_id (set when goal was
// queued as a sub-goal by the ADaPT decomposer) status — derived: 'satisfied'
// / 'abandoned' / 'open' from goal-status markers (existing module)
// percent_done — operator-supplied TEXT ("30%", "drafted, untested"),
// nullable. Stored as engram.output.percent_done. next_action — operator or
// partner annotation, nullable. Stored as engram.output.next_action.
// blocked_on — string describing what is blocking, nullable. deadline —
// ISO-8601 string, nullable. regime — 'sandbox' | 'host' | null. Inherited
// from goal submission context. project_id — METADATA only. Substrate-as-mind
// keeps recall unified across projects (no partitioning). project_id is for UX
// filtering/grouping ONLY. design substrate-as-mind invariant — ONE brain
// across projects, project is a tag not a wall. ts — engram.timestamp
// (creation) - W3C PROV-O Activity/Entity — goal is Entity, satisfaction is
// Activity wasGeneratedBy partner. Projector reads both. - Cohen + Levesque
// 1990 "Intention is Choice with Commitment": intentions persist until
// satisfied, becomes-impossible, or irrelevant. Status enum maps directly. -
// Fowler Event Sourcing — append-only marker pattern. Read side is a
// projection; write side never mutates. - design R23 immutability. Out of
// scope for v1: - LLM-judged percent_done auto-update (operator/partner sets
// it). - Deadline overdue notification. - Cross-project view in dashboard (UX
// layer, separate slice).

'use strict';

const engram     = require('./engram.js');
const goalStatus = require('./goal-status.js');

// Project a single engram row (already hydrated by listEngrams) into
// the typed Goal shape. Pure function, no DB calls.
function _projectOne(row) {
  if (!row || !row.id) return null;
  const out = row.output || {};
  return {
    id:           row.id,
    parent_id:    row.parent_id || null,
    statement:    out.statement || row.statement || '',
    status:       _deriveStatus(row.id),
    percent_done: typeof out.percent_done === 'string' ? out.percent_done : null,
    next_action:  typeof out.next_action  === 'string' ? out.next_action  : null,
    blocked_on:   typeof out.blocked_on   === 'string' ? out.blocked_on   : null,
    deadline:     typeof out.deadline     === 'string' ? out.deadline     : null,
    regime:       (out.regime === 'sandbox' || out.regime === 'host') ? out.regime : null,
    project_id:   typeof out.project_id   === 'string' ? out.project_id   : null,
    ts:           row.timestamp || null,
    // What the knowledge pass found for this goal so far.
    findings:     goalStatus.countFindings ? goalStatus.countFindings(row.id) : 0
  };
}

function _deriveStatus(goalId) {
  if (goalStatus.isSatisfied(goalId)) return 'satisfied';
  if (goalStatus.isAbandoned(goalId)) return 'abandoned';
  return 'open';
}

// List goals matching optional filters. Reads engrams scope='goal',
// projects each, filters by status / project_id if requested.
//   opts.status     — 'open' | 'satisfied' | 'abandoned' | undefined (all)
//   opts.project_id — string | undefined (all)
//   opts.parent_id  — string | undefined (filter to sub-goals of)
//   opts.limit      — default 50, max 500
function listGoals(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(500, opts.limit || 50));
  const rows = engram.listEngrams({
    scope: 'goal',
    limit: limit * 4,           // overfetch — status filter drops some
    audience: 'all'
  }) || [];
  const out = [];
  for (const row of rows) {
    const g = _projectOne(row);
    if (!g) continue;
    if (opts.status && g.status !== opts.status) continue;
    if (opts.project_id && g.project_id !== opts.project_id) continue;
    if (opts.parent_id && g.parent_id !== opts.parent_id) continue;
    out.push(g);
    if (out.length >= limit) break;
  }
  return out;
}

// Get a single goal by id, or null.
function getGoal(goalId) {
  if (!goalId) return null;
  const rows = engram.listEngrams({ scope: 'goal', limit: 500, audience: 'all' }) || [];
  for (const row of rows) {
    if (row.id === goalId) return _projectOne(row);
  }
  return null;
}

// List child sub-goals (decomposer output) for a given parent goal.
function listChildren(parentGoalId) {
  if (!parentGoalId) return [];
  return listGoals({ parent_id: parentGoalId, limit: 50 });
}

module.exports = {
  listGoals,
  getGoal,
  listChildren,
  _projectOne,
  _deriveStatus
};
