// SPDX-License-Identifier: AGPL-3.0-only
// Virtual Agent Runtime — turns the working-set data structure into the
// surface an agent actually sees.
//
// Two faces:
//
//   1. Context builder. Given a session_id, returns a string the agent
//      framework can inject into the prompt. Small — pointers + summaries,
//      not full content. Size budgeted to working_set.budget tokens.
//
//   2. Page-fault handler. When the agent calls fetch_action(id), this
//      returns the full ActionRecord. Unknown id returns a STRUCTURED
//      FAULT (not a fake / empty content), forcing the agent to reason
//      about the miss instead of hallucinating.
//
// This is the layer that gives the agent the illusion of infinite memory
// without paying infinite context. See the substrate design notes
// "Layer 5 — Virtual Agent Runtime".

const actionRecord = require('./action-record');
const workingSet   = require('./working-set');
const wireFormat   = require('./wire-format');

// ── Context manifest (what the agent sees) ───────────────────────────────

// Build the short textual manifest injected into the agent's context.
// Pichay-style page handles. Each evicted/paged-out record appears as
// `<troth:page:UUID>` so the model has a clear, parseable marker to fault on.
// The handle itself is the canonical retrieval token: pass it to
// troth_fault_in (or troth_fetch_action with the same id) and the substrate
// returns the byte-equal record. This format is the same as the working-set
// state-of-the-art (Pichay arXiv:2603.09023): minimal text marker,
// model-recognizable, no hallucination risk. buildManifest accepts a `format`
// option: 'json' (default, human-readable) — line-oriented manifest with
// verbose footer. 'toon' (compact wire) — a TOON-encoded manifest block.
// Header is still JSON (small, parseable); rows are pipe-delimited. Returns
// the same { text, manifest, tokens_used } shape so callers don't branch.
// Capability flag negotiation is the GMP v0.2 contract; this function trusts
// the caller (MCP server / hook) has already negotiated.
function buildManifest(session_id, opts) {
  opts = opts || {};
  const format = opts.format === 'toon' ? 'toon' : 'json';
  const m = workingSet.manifest(session_id);
  if (!m) return null;

  if (format === 'toon') {
    const text = wireFormat.encodeManifest(m);
    return {
      text,
      manifest: m,
      tokens_used: wireFormat.estimateTokens(text),
      format: 'toon'
    };
  }

  const header =
    '[troth/working-set] ' + m.resident + '/' + m.max_size + ' resident, ' +
    m.tokens + '/' + m.budget + ' tokens, ' + m.pinned.length + ' pinned';

  const lines = m.entries.map(e => {
    const pin = e.pinned ? ' ★' : '';
    // intent records use a distinct marker prefix so the
    // model can tell at a glance "this is the why for downstream actions"
    // vs "this is a generic evicted action". Both prefixes resolve via
    // the same troth_fault_in MCP tool.
    const prefix = e.type === 'intent' ? 'intent' : 'page';
    return '  <troth:' + prefix + ':' + e.id + '> ' + e.type + ' — ' + e.summary + pin;
  });

  const footer =
    'When you see a `<troth:page:UUID>` or `<troth:intent:UUID>` marker ' +
    'above (or anywhere in your context), call ' +
    'troth_fault_in({handle:"<troth:page:UUID>"}) — or equivalently ' +
    'troth_fetch_action({id:"UUID"}) — to load the full record. Evicted ' +
    'records are not lost; the substrate retains everything.';

  return {
    text:     header + '\n' + lines.join('\n') + '\n' + footer,
    manifest: m,
    tokens_used: m.tokens,
    format: 'json'
  };
}

// ── Page fault — explicit, structured, never silent ───────────────────────

// The agent calls this (via the MCP tool surface) when it needs full
// content for a pointer it sees in the manifest OR for a record it
// discovered via query_actions. We then auto-load into the working set
// so subsequent mentions in the same turn don't refault.
function handleFetch(state, session_id, action_id) {
  if (!action_id) {
    return { ok: false, fault: 'missing_id' };
  }
  const row = state.getAction(action_id);
  if (!row) {
    // Unknown id → structured fault. Do NOT fabricate content.
    return {
      ok: false,
      fault: 'not_found',
      id: action_id,
      hint: 'This id does not exist in the substrate. Either it was never written, it was purged, or the id is malformed. Do not proceed as if the content exists.'
    };
  }
  const rec = actionRecord.fromRow(row);

  // Auto-load into the working set so subsequent references don't
  // re-fault. If the session doesn't exist yet, we open one lazily —
  // this makes the runtime usable even in sessions that haven't
  // explicitly called openSession.
  if (!workingSet.getSession(session_id)) {
    workingSet.openSession(state, { session_id, agent_id: rec.agent_id, cwd: rec.cwd });
  }
  workingSet.load(state, session_id, action_id);

  return { ok: true, action: rec };
}

// ── Lifecycle hooks ──────────────────────────────────────────────────────

// Called by the plugin's compact hook when Claude Code signals context
// pressure. We choose what to keep (pinned + MRU within budget) and
// what to shed; shed records remain in the substrate. One compact
// ActionRecord logs the decision for audit.
function onBeforeCompact(state, session_id, opts) {
  opts = opts || {};
  const sess = workingSet.getSession(session_id);
  if (!sess) return { ok: true, note: 'no_session' };

  const keepBudget = (opts.budget_tokens || sess.budget) * 0.7;  // leave headroom
  const keep = [];
  const drop = [];
  let running = 0;

  // Pinned first, then MRU. Walk the pointers array (already MRU-first).
  for (const p of sess.pointers) {
    if (p.pinned) { keep.push(p.id); running += p.size_tokens || 0; continue; }
    if (running + (p.size_tokens || 0) <= keepBudget) {
      keep.push(p.id);
      running += p.size_tokens || 0;
    } else {
      drop.push(p.id);
    }
  }

  if (drop.length === 0) return { ok: true, dropped: 0, kept: keep.length };
  const swapResult = workingSet.swap(state, session_id, {
    remove: drop,
    trigger: 'before_compact'
  });
  return {
    ok:     !!(swapResult && swapResult.ok),
    kept:   keep.length,
    dropped: drop.length,
    swap:   swapResult
  };
}

// Session reset: clear in-memory working set. Substrate data is
// untouched (that's the whole point — reset in the agent harness does
// not imply data loss in the substrate).
function onReset(state, session_id) {
  const sess = workingSet.getSession(session_id);
  if (!sess) return { ok: true };
  // Record the reset as a compact event for audit trail.
  workingSet.swap(state, session_id, {
    remove: sess.pointers.filter(p => !p.pinned).map(p => p.id),
    trigger: 'reset'
  });
  // Don't close the session — the session id is stable; we just drop
  // non-pinned content.
  return { ok: true, kept_pinned: sess.pin_ids.size };
}

// ── Integrity checks ─────────────────────────────────────────────────────

// Returns structured report on whether a session satisfies the integrity
// contract (pinned pages present, no orphaned pointers, working set
// fits in budget). Used by tests and diagnostics.
function checkIntegrity(state, session_id) {
  const sess = workingSet.getSession(session_id);
  if (!sess) return { ok: true, note: 'no_session' };
  const issues = [];
  // Every pinned id must still be resident.
  for (const id of sess.pin_ids) {
    if (!sess.pointers.find(p => p.id === id)) {
      issues.push({ kind: 'missing_pinned', id });
    }
  }
  // Every resident pointer must resolve in the substrate.
  for (const p of sess.pointers) {
    if (!state.getAction(p.id)) {
      issues.push({ kind: 'orphan_pointer', id: p.id });
    }
  }
  // Budget check.
  const m = workingSet.manifest(session_id);
  if (m.tokens > sess.budget * 1.5) {
    issues.push({ kind: 'budget_exceeded', tokens: m.tokens, budget: sess.budget });
  }
  return { ok: issues.length === 0, issues };
}

module.exports = {
  buildManifest,
  handleFetch,
  onBeforeCompact,
  onReset,
  checkIntegrity
};
