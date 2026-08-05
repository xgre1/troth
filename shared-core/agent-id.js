// SPDX-License-Identifier: AGPL-3.0-only
// Resolve the active agent_id for substrate writes/reads.
//
// === SEMANTIC CONTRACT ===
// `agent_id` encodes PROVENANCE (who/which-pipeline wrote this row) or
// L3 BOUNDARY (which team/dept owns it). It is NOT a category tag.
// Categorizing engrams ("identity facts", "goal", "research:legal")
// belongs in `output.scope`, not in agent_id.
//
// Earlier code used `agent_id='identity'` as a synthetic pool for identity
// engrams. That convention abused the
// provenance slot for categorization and was the same shape of bug
// that caused the substrate-as-mind fragmentation crisis (per-surface
// agent_id silos). Migration: identity engrams now write with the
// SURFACE agent_id (resolveAgentId()) + `scope='identity'`. Old rows
// backfilled with output.scope='identity' so scope-filtered reads
// still surface them (see scripts/backfill-identity-scope.js).
//
// Single source of truth: TROTH_ENTITY_AGENT_ID env var, with a stable
// neutral fallback when unset. Used by the claude-session-watcher (writes
// dialogue turns), the proxy's substrate dialogue endpoint (reads them
// back), the plugin's session-start/pre-compact hooks, and bin/troth.js
// (propagates the value to spawned child processes).
//
// Before this helper existed a developer's personal agent_id literal
// was hard-coded across the codebase. That made the install single-user
// writes and reads agreed on the literal, but the literal carried a
// name. The helper preserves the behavior (default still resolves to a
// stable value the watcher and reader both agree on) while letting any
// user set their own identity via env without touching code.
//
// Migration note: if you have existing data under a legacy literal, set
// `TROTH_ENTITY_AGENT_ID=<that-literal>` in your shell to continue
// reading it. Otherwise fresh writes go under the new default and prior
// data stays in the substrate but is not surfaced by default. A separate
// migration script can rekey old rows to the new default in a single
// transaction if you'd rather not carry the env var forever.

const DEFAULT_AGENT_ID = 'local-agent';

function resolveAgentId() {
  const raw = (process.env.TROTH_ENTITY_AGENT_ID || '').trim();
  return raw || DEFAULT_AGENT_ID;
}

// principal_id is the READ-side brain identity (substrate-as-mind invariant,
//). agent_id stays as WRITE-time provenance ('claude-code',
// 'cli', 'voice', 'subagent:role'). principal_id says which BRAIN owns
// these rows: 'partner' for personal use (all surfaces share one mind),
// 'team:<slug>' for enterprise teams, 'deployed:<id>' for extended-mode deployed
// agents. Override via TROTH_PRINCIPAL env. Default is the well-known
// constant 'partner' so a fresh install Just Works as a single unified
// personal brain across every pipeline that writes to its state.db.
const DEFAULT_PRINCIPAL = 'partner';

function resolvePrincipal() {
  const raw = (process.env.TROTH_PRINCIPAL || '').trim();
  return raw || DEFAULT_PRINCIPAL;
}

module.exports = { resolveAgentId, DEFAULT_AGENT_ID, resolvePrincipal, DEFAULT_PRINCIPAL };
