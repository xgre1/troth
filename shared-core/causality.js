// SPDX-License-Identifier: AGPL-3.0-only
// DecisionGraph causality API over the ActionRecord substrate.
//
// Every ActionRecord has an optional `parent_id` edge pointing at the action
// that caused it. Follow those edges and you have a causal graph: "why is
// line 42 of auth.ts written this way?" → walk back to the edit, which
// points to the lesson, which points to the error that triggered the fix,
// which points to the original tool call.
//
// Git commits are crude (blob + message). This is commits with provenance +
// verification + context. "Why" questions become answerable at the agent
// level, not just the diff level.
//
// All functions take `state` as first arg (same DI discipline as query.js).
//
// See the substrate design notes "Layer 2 — DecisionGraph".

const actionRecord = require('./action-record');

// ── Ancestor chain ────────────────────────────────────────────────────────
// Walk parent_id edges from `action_id` back toward the root. Cycle-guarded
// (malformed parent chains can't hang the caller). Returns parsed records
// in child→parent order; last element is the root.
function traceCausalChain(state, action_id, opts) {
  if (!state || !action_id) return [];
  opts = opts || {};
  const maxDepth = opts.maxDepth || 64;
  const chain = [];
  const seen = new Set();
  let current = action_id;
  for (let i = 0; i < maxDepth; i++) {
    if (!current || seen.has(current)) break;
    seen.add(current);
    const row = state.getAction(current);
    if (!row) break;
    const rec = actionRecord.fromRow(row);
    chain.push(rec);
    current = rec.parent_id;
  }
  return chain;
}

// ── Descendants ───────────────────────────────────────────────────────────
// All actions caused (transitively) by `action_id`. Breadth-first; each
// level's children added in timestamp order. Cycle-guarded.
function getDescendants(state, action_id, opts) {
  if (!state || !action_id) return [];
  opts = opts || {};
  const maxNodes = opts.maxNodes || 500;
  const seen = new Set([action_id]);
  const out = [];
  const queue = [action_id];
  while (queue.length && out.length < maxNodes) {
    const parent = queue.shift();
    const children = state.queryActions
      ? state.queryActions({ parent_id: parent, order: 'asc' }) || []
      : [];
    for (const row of children) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const rec = actionRecord.fromRow(row);
      out.push(rec);
      queue.push(row.id);
      if (out.length >= maxNodes) break;
    }
  }
  return out;
}

// ── Siblings ──────────────────────────────────────────────────────────────
// Other actions that share the same parent as `action_id`. Useful for "what
// else happened when this decision was made?" — e.g., during a compaction
// event, every page-swap and lesson-pull shares the compact's parent.
function getSiblings(state, action_id) {
  if (!state || !action_id) return [];
  const row = state.getAction(action_id);
  if (!row || !row.parent_id) return [];
  const siblings = state.queryActions({ parent_id: row.parent_id, order: 'asc' }) || [];
  return siblings
    .filter(r => r.id !== action_id)
    .map(actionRecord.fromRow);
}

// ── Time-travel: reconstruct state at timestamp T ─────────────────────────
// For a file, walk its edit history and replay up to the given timestamp.
// Returns the reconstructed content (if edits carry enough info) or a
// descriptor of the latest known state. Pragmatic v1: returns the sequence
// of edits up to T; content reconstruction requires the edit to carry the
// full post-state hash or diff (which hashline+editmatcher do provide).
function getStateAt(state, opts) {
  if (!state || !opts || !opts.file_path) return null;
  const until = opts.timestamp || Date.now();
  const edits = (state.queryActions
    ? state.queryActions({ type: 'edit', cwd: opts.cwd, until, order: 'asc' })
    : []) || [];
  const parsed = edits
    .map(actionRecord.fromRow)
    .filter(r => r.input && r.input.file_path === opts.file_path);
  if (!parsed.length) return { file_path: opts.file_path, at: until, edits: [], hash: null };
  const latest = parsed[parsed.length - 1];
  return {
    file_path: opts.file_path,
    at: until,
    edits: parsed,
    last_edit_id: latest.id,
    last_edit_ts: latest.timestamp,
    hash: (latest.output && latest.output.hash_after) || null
  };
}

// ── Find similar causal patterns ──────────────────────────────────────────
// Given an action, find other actions whose ancestor chain has similar
// structure: same sequence of types + similar input kinds. Approximate
// similarity based on chain shape (type sequence) rather than content.
// Useful for "have we seen this kind of problem before?" queries.
function findSimilarCausalPatterns(state, action_id, opts) {
  if (!state || !action_id) return [];
  opts = opts || {};
  const maxMatches = opts.limit || 10;
  const targetChain = traceCausalChain(state, action_id, { maxDepth: 8 });
  if (targetChain.length < 2) return [];  // pattern requires depth

  const targetSignature = targetChain.map(r => r.type + ':' + (r.input && r.input.kind ? r.input.kind : '')).join('->');

  // Sample recent actions of the same tip-type, compare ancestor signatures.
  const candidates = (state.queryActions
    ? state.queryActions({ type: targetChain[0].type, limit: 500 })
    : []) || [];

  const matches = [];
  for (const row of candidates) {
    if (row.id === action_id) continue;
    const chain = traceCausalChain(state, row.id, { maxDepth: 8 });
    if (chain.length < 2) continue;
    const sig = chain.map(r => r.type + ':' + (r.input && r.input.kind ? r.input.kind : '')).join('->');
    if (sig === targetSignature) {
      matches.push({ action_id: row.id, signature: sig, chain });
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

// ── Summary for a single action's causality ───────────────────────────────
// One-shot lookup that answers: "where does this action come from, and what
// came of it?" Useful for UI/debug views.
function summarize(state, action_id) {
  if (!state || !action_id) return null;
  const row = state.getAction(action_id);
  if (!row) return null;
  const self = actionRecord.fromRow(row);
  return {
    self,
    ancestors: traceCausalChain(state, action_id).slice(1),   // skip self
    descendants: getDescendants(state, action_id, { maxNodes: 50 }),
    siblings: getSiblings(state, action_id)
  };
}

// ── Edge-aware causal walk ─────────────────────────────────── Same intent as
// traceCausalChain (parent_id only) but also follows typed edges in
// action_record_edges. Returns records in BFS-by-depth order. Cycle-guarded.
// opts: maxNodes (default 64) — hard cap on returned records labels (default
// ['refines_intent','produces_edit','satisfies','supersedes']) typed in-edges
// to follow (records on the FROM side of these edges are pulled in as
// ancestors of the current node)
function traceCausalChainTyped(state, action_id, opts) {
  if (!state || !action_id) return [];
  opts = opts || {};
  const maxNodes = opts.maxNodes || 64;
  const labels = opts.labels || ['refines_intent', 'produces_edit', 'satisfies', 'supersedes'];
  const seen = new Set([action_id]);
  const out = [];
  const queue = [action_id];
  while (queue.length && out.length < maxNodes) {
    const cur = queue.shift();
    const row = state.getAction(cur);
    if (!row) continue;
    out.push(actionRecord.fromRow(row));
    if (row.parent_id && !seen.has(row.parent_id)) {
      seen.add(row.parent_id); queue.push(row.parent_id);
    }
    if (state.queryEdges) {
      for (const lbl of labels) {
        const edges = state.queryEdges({ to_id: cur, label: lbl, limit: 50 });
        for (const e of edges) {
          if (seen.has(e.from_id)) continue;
          seen.add(e.from_id); queue.push(e.from_id);
        }
      }
    }
  }
  return out;
}

module.exports = {
  traceCausalChain,
  traceCausalChainTyped,
  getDescendants,
  getSiblings,
  getStateAt,
  findSimilarCausalPatterns,
  summarize
};
