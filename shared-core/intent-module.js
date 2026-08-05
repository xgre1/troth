// SPDX-License-Identifier: AGPL-3.0-only
// Intent Module — C3 of Substrate-as-Entity v0.1.
//
// Maintains the substrate's goal stack. Forms intents from incoming
// events + current state, plans coarse steps, tracks progress. Pure
// data layer — no LLM, no IO. The decision engine consults this module
// to decide what action to take next.
//
// Goal model (intentionally tiny for v0.1):
//   { id, statement, status, created_at, updated_at,
//     parent_id, steps: [{ description, status }],
//     evidence_refs: [...], priority }
//
// Status values: 'open' | 'in_progress' | 'satisfied' | 'abandoned'.
//
// State is held in-memory — the runtime owns persistence by writing
// goal-mutation events to L1. On restart, the runtime can rebuild
// the goal stack by replaying those events.

const DEFAULT_PRIORITY = 5;
const MAX_GOAL_STACK   = 16;

function makeIntentModule() {
  const goals = new Map();   // id → goal
  const order = [];          // priority ordering (most recent + highest first)

  function addGoal(spec) {
    spec = spec || {};
    if (goals.size >= MAX_GOAL_STACK) {
      // Drop the lowest-priority abandoned/satisfied goal to make room.
      // If everything is open, refuse — caller decides what to retire.
      const dropId = pickRetirable();
      if (dropId == null) return { ok: false, reason: 'stack_full' };
      removeGoal(dropId);
    }
    const id = spec.id || ('goal_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    const goal = {
      id,
      statement:  String(spec.statement || ''),
      status:     'open',
      created_at: Date.now(),
      updated_at: Date.now(),
      parent_id:  spec.parent_id || null,
      steps:      Array.isArray(spec.steps) ? spec.steps.map(normalizeStep) : [],
      evidence_refs: Array.isArray(spec.evidence_refs) ? spec.evidence_refs.slice() : [],
      priority:   typeof spec.priority === 'number' ? spec.priority : DEFAULT_PRIORITY
    };
    goals.set(id, goal);
    insertOrdered(id, goal.priority);
    return { ok: true, id, goal };
  }

  function updateGoal(id, patch) {
    const g = goals.get(id);
    if (!g) return { ok: false, reason: 'not_found' };
    if (patch && typeof patch === 'object') {
      for (const k of ['statement', 'status', 'parent_id', 'priority']) {
        if (k in patch) g[k] = patch[k];
      }
      if (Array.isArray(patch.steps)) g.steps = patch.steps.map(normalizeStep);
      if (Array.isArray(patch.evidence_refs)) g.evidence_refs = patch.evidence_refs.slice();
    }
    g.updated_at = Date.now();
    // Re-insert if priority changed
    if (patch && 'priority' in patch) {
      const idx = order.indexOf(id);
      if (idx >= 0) order.splice(idx, 1);
      insertOrdered(id, g.priority);
    }
    return { ok: true, id, goal: g };
  }

  function advanceStep(id, stepIndex, status) {
    const g = goals.get(id);
    if (!g) return { ok: false, reason: 'not_found' };
    if (stepIndex < 0 || stepIndex >= g.steps.length) return { ok: false, reason: 'bad_step_index' };
    g.steps[stepIndex] = { ...g.steps[stepIndex], status: status || 'satisfied' };
    g.updated_at = Date.now();
    // If all steps satisfied, mark the whole goal satisfied (caller can override).
    const remaining = g.steps.find((s) => s.status !== 'satisfied' && s.status !== 'abandoned');
    if (!remaining) g.status = 'satisfied';
    return { ok: true, id, step: g.steps[stepIndex], goal_status: g.status };
  }

  function removeGoal(id) {
    const g = goals.get(id);
    if (!g) return false;
    goals.delete(id);
    const idx = order.indexOf(id);
    if (idx >= 0) order.splice(idx, 1);
    return true;
  }

  function topGoal() {
    for (const id of order) {
      const g = goals.get(id);
      if (g && g.status === 'open') return g;
      if (g && g.status === 'in_progress') return g;
    }
    return null;
  }

  function listGoals(filter) {
    const out = [];
    filter = filter || {};
    for (const id of order) {
      const g = goals.get(id);
      if (!g) continue;
      if (filter.status && g.status !== filter.status) continue;
      if (filter.parent_id && g.parent_id !== filter.parent_id) continue;
      out.push(g);
    }
    return out;
  }

  function snapshot() {
    return {
      count:     goals.size,
      top:       topGoal(),
      open:      listGoals({ status: 'open' }).length,
      progress:  listGoals({ status: 'in_progress' }).length,
      satisfied: listGoals({ status: 'satisfied' }).length,
      abandoned: listGoals({ status: 'abandoned' }).length
    };
  }

  // Replay support: rebuild from a stream of mutation events. Used at
  // runtime startup so goal stack survives daemon restarts even though
  // the in-memory map vanishes.
  function replay(events) {
    if (!Array.isArray(events)) return { ok: false, reason: 'bad_events' };
    let n = 0;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (e.kind === 'add_goal')      addGoal(e.spec || {});
      else if (e.kind === 'update_goal')   updateGoal(e.id, e.patch || {});
      else if (e.kind === 'advance_step')  advanceStep(e.id, e.step_index, e.status);
      else if (e.kind === 'remove_goal')   removeGoal(e.id);
      n++;
    }
    return { ok: true, applied: n };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function normalizeStep(s) {
    return {
      description: String(s && s.description || ''),
      status:      (s && s.status) || 'open'
    };
  }

  function insertOrdered(id, priority) {
    // higher priority first; same priority, newer first
    let i = 0;
    for (; i < order.length; i++) {
      const otherId = order[i];
      const other = goals.get(otherId);
      if (!other) continue;
      if (priority > other.priority) break;
      if (priority === other.priority && goals.get(id).created_at >= other.created_at) break;
    }
    order.splice(i, 0, id);
  }

  function pickRetirable() {
    let lowestId = null;
    let lowestPri = Infinity;
    for (const id of order) {
      const g = goals.get(id);
      if (!g) continue;
      if (g.status === 'satisfied' || g.status === 'abandoned') {
        if (g.priority < lowestPri) {
          lowestPri = g.priority;
          lowestId = id;
        }
      }
    }
    return lowestId;
  }

  return {
    addGoal,
    updateGoal,
    advanceStep,
    removeGoal,
    topGoal,
    listGoals,
    snapshot,
    replay
  };
}

module.exports = { makeIntentModule };
