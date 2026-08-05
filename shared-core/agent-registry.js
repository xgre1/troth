// SPDX-License-Identifier: AGPL-3.0-only
// Agent registry — first-class sub-brain metadata layer.
//
// agent_id is and remains the substrate's atomic isolation key:
// engrams, dialogue turns, action_records all filter on it. This
// module adds the metadata that turns an opaque agent_id into a
// named, navigable sub-brain — parent pointer (main brain umbrella
// fallback), specialization tag, system stance, persona, last-active
// timestamp.
//
// Two callers in mind:
//   - /create slash skill — provisions a new sub-brain on operator request
//   - /agent slash skill — looks up a sub-brain by name and emits a
//     switch_agent control event so the entity flips its active
//     agent_id mid-session
//
// Behavior is deliberately thin: pure CRUD over the `agents` table
// (defined in state.js). The runtime decisions — when to fall back to
// parent, when to retire, whether to spawn — live with the entity /
// dispatch layer, not here.

const state = require('./state.js');

// Lazy bootstrap. The first lookup of an agent_id that has no row in
// the registry creates one with name=agent_id, parent=null. Lets old
// installs operate without an explicit migration step — anything that
// existed pre-registry shows up as a top-level entity the moment it's
// asked about.
function ensureBootstrap(agent_id) {
  if (!agent_id) return null;
  const existing = getAgent(agent_id);
  if (existing) return existing;
  return createAgent({
    id:   agent_id,
    name: agent_id,
    tag:  null,
    parent_agent_id: null,
    system_stance:   null,
    persona:         null
  });
}

function createAgent(opts) {
  opts = opts || {};
  const id = String(opts.id || opts.agent_id || '').trim();
  const name = String(opts.name || id).trim();
  if (!id || !name) return null;
  const now = Date.now();
  try {
    state.db().prepare(`
      INSERT INTO agents (id, name, tag, parent_agent_id, system_stance, persona, created_at, last_active_at, active)
      VALUES (@id, @name, @tag, @parent, @stance, @persona, @created, @last, 1)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        tag  = COALESCE(excluded.tag,  agents.tag),
        parent_agent_id = COALESCE(excluded.parent_agent_id, agents.parent_agent_id),
        system_stance   = COALESCE(excluded.system_stance,   agents.system_stance),
        persona         = COALESCE(excluded.persona,         agents.persona),
        last_active_at  = excluded.last_active_at,
        active          = 1
    `).run({
      id, name,
      tag:     opts.tag           || null,
      parent:  opts.parent_agent_id || null,
      stance:  opts.system_stance || null,
      persona: opts.persona       || null,
      created: now,
      last:    now
    });
    return getAgent(id);
  } catch (_) { return null; }
}

function getAgent(id) {
  if (!id) return null;
  try {
    return state.db().prepare(
      `SELECT * FROM agents WHERE id = ?`
    ).get(id) || null;
  } catch (_) { return null; }
}

function getAgentByName(name, parent_agent_id) {
  if (!name) return null;
  try {
    if (parent_agent_id != null) {
      return state.db().prepare(
        `SELECT * FROM agents WHERE name = ? AND parent_agent_id = ? AND active = 1 LIMIT 1`
      ).get(name, parent_agent_id) || null;
    }
    return state.db().prepare(
      `SELECT * FROM agents WHERE name = ? AND active = 1 LIMIT 1`
    ).get(name) || null;
  } catch (_) { return null; }
}

function listAgents(opts) {
  opts = opts || {};
  const parts = ['SELECT * FROM agents WHERE 1=1'];
  const bind = {};
  if (opts.parent_agent_id !== undefined) {
    if (opts.parent_agent_id === null) {
      parts.push('AND parent_agent_id IS NULL');
    } else {
      parts.push('AND parent_agent_id = @parent');
      bind.parent = opts.parent_agent_id;
    }
  }
  if (opts.tag) { parts.push('AND tag = @tag'); bind.tag = opts.tag; }
  if (!opts.include_retired) parts.push('AND active = 1');
  parts.push('ORDER BY last_active_at DESC NULLS LAST, created_at DESC');
  if (opts.limit) parts.push('LIMIT ' + Math.min(parseInt(opts.limit, 10) || 50, 500));
  try {
    return state.db().prepare(parts.join(' ')).all(bind);
  } catch (_) { return []; }
}

function touchActive(id) {
  if (!id) return;
  try {
    state.db().prepare(
      `UPDATE agents SET last_active_at = ? WHERE id = ?`
    ).run(Date.now(), id);
  } catch (_) {}
}

function retireAgent(id) {
  if (!id) return false;
  try {
    state.db().prepare(
      `UPDATE agents SET active = 0 WHERE id = ?`
    ).run(id);
    return true;
  } catch (_) { return false; }
}

module.exports = {
  ensureBootstrap,
  createAgent,
  getAgent,
  getAgentByName,
  listAgents,
  touchActive,
  retireAgent
};
