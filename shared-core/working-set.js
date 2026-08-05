// SPDX-License-Identifier: AGPL-3.0-only
// Working-set management — the data structure that turns the substrate
// into a virtual memory system for agents.
//
// An agent session holds a working_set: an ordered list of ActionRecord
// pointers (ids + summaries). Full content lives in the substrate; the
// agent's context holds only this small manifest plus query tools.
//
// Compaction does NOT summarize-and-drop (the lossy thing every other
// tool does). It swaps the working set: evicted pointers remain fully
// intact in the substrate, just not "resident" for the next turn. A
// later fetch_action(id) brings them back into the working set.
//
// This module is pure memory state; it persists to SQLite as
// type='compact' ActionRecords whenever the working set changes (so
// working-set history itself becomes an audit-able part of the
// DecisionGraph).
//
// See the substrate design notes "Layer 5 — Virtual Agent
// Runtime" and the substrate design notes.

const actionRecord = require('./action-record');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Default token budgets. Working set size is opinionated but tunable;
// real agents in real deployments override via openSession options.
const DEFAULT_BUDGET_TOKENS = 1500;   // working-set manifest target size
const MAX_WORKING_SET_SIZE  = 24;     // hard cap on pointer count (regardless of tokens)

// In-process working sets, keyed by session_id. This is a cache for the
// current process; the canonical state is persisted under
// $CLAUDE_PLUGIN_DATA/sessions/<session_id>.json so subprocess hooks
// (every Claude Code hook runs as a fresh `node`) can hydrate the state
// their PreToolUse/PostToolUse siblings populated.
const _sessions = new Map();

function _sessionsDir() {
  let root = process.env.CLAUDE_PLUGIN_DATA || '';
  if (root.includes('/.claude/plugins/data/')) root = '';
  if (!root) root = path.join((process.env.HOME || os.homedir()), '.troth');
  const dir = path.join(root, 'sessions');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function _sessionPath(session_id) { return path.join(_sessionsDir(), session_id + '.json'); }

function _toDisk(sess) {
  return {
    session_id: sess.session_id,
    agent_id:   sess.agent_id,
    cwd:        sess.cwd,
    budget:     sess.budget,
    max_size:   sess.max_size,
    opened_at:  sess.opened_at,
    pointers:   sess.pointers,
    pin_ids:    Array.from(sess.pin_ids)
  };
}
function _fromDisk(obj) {
  return {
    session_id: obj.session_id,
    agent_id:   obj.agent_id,
    cwd:        obj.cwd,
    budget:     obj.budget || DEFAULT_BUDGET_TOKENS,
    max_size:   obj.max_size || MAX_WORKING_SET_SIZE,
    opened_at:  obj.opened_at || Date.now(),
    pointers:   Array.isArray(obj.pointers) ? obj.pointers : [],
    pin_ids:    new Set(Array.isArray(obj.pin_ids) ? obj.pin_ids : [])
  };
}
function _persist(sess) {
  if (!sess || !sess.session_id) return;
  const p = _sessionPath(sess.session_id);
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(_toDisk(sess)));
    fs.renameSync(tmp, p);
  } catch (e) {
    process.stderr.write('[troth working-set persist] ' + e.message + '\n');
  }
}
function _hydrate(session_id) {
  try {
    const raw = fs.readFileSync(_sessionPath(session_id), 'utf8');
    const obj = JSON.parse(raw);
    const sess = _fromDisk(obj);
    _sessions.set(session_id, sess);
    return sess;
  } catch { return null; }
}

function now() { return Date.now(); }

// Estimate tokens for a pointer + summary payload. ~4 chars per token is
// industry-standard heuristic; we err on the high side to avoid budget
// overruns.
function estimatePointerTokens(entry) {
  if (!entry) return 0;
  const s = (entry.summary || '') + (entry.id || '');
  return Math.ceil(s.length / 3.5);
}

// ── Session lifecycle ────────────────────────────────────────────────────

function openSession(state, opts) {
  opts = opts || {};
  const session_id = opts.session_id;
  if (!session_id) return null;
  const inMem = _sessions.get(session_id);
  if (inMem) return inMem;
  const fromDisk = _hydrate(session_id);
  if (fromDisk) return fromDisk;
  const sess = {
    session_id,
    agent_id: opts.agent_id || 'claude-code',
    cwd:       opts.cwd || null,
    budget:    opts.budget_tokens || DEFAULT_BUDGET_TOKENS,
    max_size:  opts.max_size || MAX_WORKING_SET_SIZE,
    opened_at: now(),
    pointers:  [],   // [{ id, type, summary, pinned, added_at }]
    pin_ids:   new Set()
  };
  _sessions.set(session_id, sess);
  _persist(sess);
  return sess;
}

function closeSession(session_id) {
  _sessions.delete(session_id);
  // Leave the on-disk file so an interrupted/resumed session recovers.
  // A separate purgeSession() could delete it for hygiene jobs.
}

function getSession(session_id) {
  if (!session_id) return null;
  const inMem = _sessions.get(session_id);
  if (inMem) return inMem;
  return _hydrate(session_id);
}

// ── Page operations ──────────────────────────────────────────────────────

// Internal accessor: in-memory first, disk second. Every mutation
// function uses this so cross-process hooks (all Claude Code hooks run as
// fresh node subprocesses) see state populated by their siblings.
function _get(session_id) {
  if (!session_id) return null;
  const inMem = _sessions.get(session_id);
  if (inMem) return inMem;
  return _hydrate(session_id);
}

// Add a pointer to the working set. If already present, it's moved to the
// front (most-recently-used). If budget or max_size is exceeded, evict the
// least-recently-used non-pinned pointer. Returns {added, evicted}.
function load(state, session_id, action_id, opts) {
  opts = opts || {};
  const sess = _get(session_id);
  if (!sess) return { added: false, reason: 'no_session' };
  const row = state.getAction(action_id);
  if (!row) return { added: false, reason: 'not_found', id: action_id };

  // Move-to-front if already resident.
  const existingIdx = sess.pointers.findIndex(p => p.id === action_id);
  if (existingIdx !== -1) {
    const [existing] = sess.pointers.splice(existingIdx, 1);
    sess.pointers.unshift(existing);
    _persist(sess);
    return { added: true, already_resident: true, id: action_id };
  }

  // Build the manifest entry. Summary is derived from the record's type
  // and input/output — short enough to sit in the context without bloat.
  const parsed = actionRecord.fromRow(row);
  const summary = buildSummary(parsed);
  const entry = {
    id: action_id,
    type: parsed.type,
    summary,
    pinned: !!opts.pinned,
    added_at: now(),
    size_tokens: estimatePointerTokens({ id: action_id, summary })
  };
  if (opts.pinned) sess.pin_ids.add(action_id);
  sess.pointers.unshift(entry);

  // Enforce caps — evict LRU non-pinned. Evictions are recorded as
  // type='compact' events so we have an audit trail ("when did we lose
  // visibility into this record?").
  const evicted = [];
  while ((sess.pointers.length > sess.max_size ||
          currentTokens(sess) > sess.budget) &&
         sess.pointers.length > 0) {
    const victim = pickEvictionCandidate(sess);
    if (!victim) break;
    const i = sess.pointers.indexOf(victim);
    if (i === -1) break;
    sess.pointers.splice(i, 1);
    evicted.push(victim.id);
  }

  if (evicted.length) recordCompact(state, sess, 'load_eviction', evicted, sess.pointers.map(p => p.id));
  _persist(sess);
  return { added: true, evicted };
}

// Remove a pointer. Content stays in substrate; just no longer resident.
function unload(state, session_id, action_id) {
  const sess = _get(session_id);
  if (!sess) return false;
  const i = sess.pointers.findIndex(p => p.id === action_id);
  if (i === -1) return false;
  sess.pointers.splice(i, 1);
  sess.pin_ids.delete(action_id);
  recordCompact(state, sess, 'explicit_unload', [action_id], sess.pointers.map(p => p.id));
  _persist(sess);
  return true;
}

function pin(session_id, action_id) {
  const sess = _get(session_id);
  if (!sess) return false;
  const entry = sess.pointers.find(p => p.id === action_id);
  if (!entry) return false;
  entry.pinned = true;
  sess.pin_ids.add(action_id);
  _persist(sess);
  return true;
}

function unpin(session_id, action_id) {
  const sess = _get(session_id);
  if (!sess) return false;
  const entry = sess.pointers.find(p => p.id === action_id);
  if (!entry) return false;
  entry.pinned = false;
  sess.pin_ids.delete(action_id);
  _persist(sess);
  return true;
}

// Atomic swap — add a batch, remove a batch. Critical for the compact
// lifecycle: one operation that changes working set, one audit record.
function swap(state, session_id, opts) {
  opts = opts || {};
  const sess = _get(session_id);
  if (!sess) return { ok: false, reason: 'no_session' };

  const add = Array.isArray(opts.add) ? opts.add : [];
  const remove = Array.isArray(opts.remove) ? opts.remove : [];

  // Integrity guard: pinned pages MUST survive. Reject the swap if any
  // remove-target is pinned (callers must explicitly unpin first).
  const violatedPin = remove.find(id => sess.pin_ids.has(id));
  if (violatedPin) {
    return {
      ok: false,
      reason: 'pinned_page_cannot_be_removed',
      violating_id: violatedPin
    };
  }

  // Apply removals first.
  const actuallyRemoved = [];
  for (const id of remove) {
    const i = sess.pointers.findIndex(p => p.id === id);
    if (i !== -1) {
      sess.pointers.splice(i, 1);
      actuallyRemoved.push(id);
    }
  }

  // Apply additions.
  const actuallyAdded = [];
  for (const id of add) {
    const row = state.getAction(id);
    if (!row) continue;
    if (sess.pointers.some(p => p.id === id)) continue;
    const parsed = actionRecord.fromRow(row);
    const summary = buildSummary(parsed);
    sess.pointers.unshift({
      id,
      type: parsed.type,
      summary,
      pinned: false,
      added_at: now(),
      size_tokens: estimatePointerTokens({ id, summary })
    });
    actuallyAdded.push(id);
  }

  // One audit record for the whole swap (not one per page).
  recordCompact(state, sess, opts.trigger || 'explicit_swap', actuallyRemoved, sess.pointers.map(p => p.id));
  _persist(sess);

  return { ok: true, added: actuallyAdded, removed: actuallyRemoved };
}

// ── Inspection ───────────────────────────────────────────────────────────

function currentTokens(sess) {
  let n = 0;
  for (const p of sess.pointers) n += p.size_tokens || estimatePointerTokens(p);
  return n;
}

function size(session_id) {
  const sess = _get(session_id);
  return sess ? sess.pointers.length : 0;
}

function isResident(session_id, action_id) {
  const sess = _get(session_id);
  if (!sess) return false;
  return sess.pointers.some(p => p.id === action_id);
}

function manifest(session_id) {
  const sess = _get(session_id);
  if (!sess) return null;
  return {
    session_id: sess.session_id,
    budget:     sess.budget,
    max_size:   sess.max_size,
    resident:   sess.pointers.length,
    tokens:     currentTokens(sess),
    pinned:     Array.from(sess.pin_ids),
    entries:    sess.pointers.map(p => ({
      id:       p.id,
      type:     p.type,
      summary:  p.summary,
      pinned:   p.pinned,
      added_at: p.added_at
    }))
  };
}

// ── Internals ────────────────────────────────────────────────────────────

function buildSummary(rec) {
  // 80-140 char summary that captures what the record is about. We keep
  // it deterministic (no LLM call) so the substrate has zero inference
  // cost at manifest time.
  if (!rec) return '';
  const t = rec.type;
  const inp = rec.input || {};
  const out = rec.output || {};
  if (t === 'edit') {
    return 'edit ' + (inp.file_path || '?') + ' via ' + (inp.format || '?') +
           (rec.verification && rec.verification.ast && rec.verification.ast.ok ? ' (ast ok)' : '') +
           (out.lines_changed ? ' [' + out.lines_changed + ' lines]' : '');
  }
  if (t === 'read') {
    return 'read ' + (inp.file_path || '?') +
           (out.line_count ? ' [' + out.line_count + ' lines]' : '');
  }
  if (t === 'search') {
    return 'search:' + (inp.kind || '?') + ' "' + String(inp.query || '').slice(0, 60) + '"' +
           (out.result_count ? ' → ' + out.result_count + ' hits' : '');
  }
  if (t === 'tool_call') {
    return 'tool ' + (inp.tool_name || '?') + ' → ' + (out.status || '?');
  }
  if (t === 'decision') {
    return 'decision[' + (inp.kind || '?') + '] → ' + (out.decision || '?') +
           (out.reason ? ' (' + out.reason + ')' : '');
  }
  if (t === 'lesson') {
    const txt = String(out.text || '');
    return 'lesson: ' + (txt.length > 100 ? txt.slice(0, 100) + '…' : txt);
  }
  if (t === 'compact') {
    return 'compact(' + (inp.trigger || '?') + ') −' + (out.removed_count || 0) + ' +' + (out.kept_count || 0);
  }
  // Fallback
  return t + ' ' + JSON.stringify(inp).slice(0, 80);
}

function pickEvictionCandidate(sess) {
  // LRU among non-pinned. pointers[] is MRU-first so walk from the end.
  for (let i = sess.pointers.length - 1; i >= 0; i--) {
    if (!sess.pointers[i].pinned) return sess.pointers[i];
  }
  return null;
}

function recordCompact(state, sess, trigger, removedIds, keptIds) {
  try {
    const rec = actionRecord.create({
      type: 'compact',
      agent_id: sess.agent_id,
      session_id: sess.session_id,
      cwd: sess.cwd,
      input:  { trigger, budget: sess.budget, max_size: sess.max_size },
      output: {
        removed_count: removedIds.length,
        kept_count:    keptIds.length,
        removed_ids:   removedIds,
        kept_ids:      keptIds.slice(0, 40)  // cap for storage; full kept list isn't semantic
      }
    });
    state.recordAction(rec, actionRecord.toSearchText(rec));
  } catch (_) { /* never break working-set ops on telemetry */ }
}

module.exports = {
  // Session lifecycle
  openSession,
  closeSession,
  getSession,
  // Page ops
  load,
  unload,
  pin,
  unpin,
  swap,
  // Inspection
  size,
  isResident,
  manifest,
  // Constants (exported for tests + tuning)
  DEFAULT_BUDGET_TOKENS,
  MAX_WORKING_SET_SIZE
};
