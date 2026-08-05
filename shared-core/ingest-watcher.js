// SPDX-License-Identifier: AGPL-3.0-only
// Ingest Watcher — substrate auto-watches external sources and
// folds deltas into a named chameleon corpus.
//
// "Trained on your business" requires that when the user adds a
// file to a watched directory (notes, docs, transcripts, code), the
// substrate notices and ingests it without being asked. This module
// is the polling watcher that produces those automated ingests.
//
// MVP scope: filesystem watcher (directory or single file). Polls
// every N seconds, computes a per-file mtime+size signature, ingests
// any new/changed file as a chameleon document under the configured
// scope. Each ingest is fire-and-forget against the embedding host.
//
// Out of scope (logged for follow-up): HTTP/URL watchers (etag-aware
// polling), git-aware watchers (on commit), Notion / Slack /
// transcript-feed watchers.
//
// Substrate stores the watcher's state (last-seen signatures per
// source) under a `tool_call` action with tool_name='ingest_watcher.cursor'
// so the watcher resumes across daemon restarts without re-ingesting
// everything.

const fs   = require('fs');
const path = require('path');

const cfg       = require('./transport-config.js');
const chameleon = require('./chameleon.js');
const state     = require('./state.js');
const actionRec = require('./action-record.js');

const DEFAULT_POLL_MS = 60 * 1000; // 1 min
const CURSOR_TOOL_NAME = 'ingest_watcher.cursor';

// Compute a stable signature for one file path. mtime + size is enough
// to detect any meaningful change without reading the body.
function fileSignature(p) {
  try {
    const st = fs.statSync(p);
    return st.mtimeMs + ':' + st.size;
  } catch (_) { return null; }
}

// Walk a directory (non-recursive by default; opts.recursive=true to
// recurse). Returns { path: signature } map for ingestable files.
function walkSources(rootPath, opts) {
  opts = opts || {};
  const include = opts.include || /\.(md|txt|markdown|adoc|rst|html|json)$/i;
  const out = {};
  function visit(p) {
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    if (st.isFile()) {
      if (!include.test(p)) return;
      const sig = fileSignature(p);
      if (sig) out[p] = sig;
      return;
    }
    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(p); } catch (_) { return; }
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const full = path.join(p, e);
        if (opts.recursive) visit(full);
        else {
          let est;
          try { est = fs.statSync(full); } catch (_) { continue; }
          if (est.isFile()) visit(full);
        }
      }
    }
  }
  visit(rootPath);
  return out;
}

// Persist the last-seen cursor (per-source signatures) to L1 so we
// can resume across restarts without re-ingesting unchanged files.
function saveCursor(opts, cursor) {
  try {
    const id = actionRec.uuidv7();
    const rec = {
      id,
      timestamp: Date.now(),
      type: 'tool_call',
      agent_id: opts.agent_id,
      cwd:      opts.cwd || null,
      user_id:  opts.user_id || 'default',
      parent_id: null,
      input:  { tool_name: CURSOR_TOOL_NAME, args: { scope: opts.scope, source_root: opts.source_root } },
      output: { status: 'recorded', cursor_size: Object.keys(cursor).length, cursor }
    };
    const v = actionRec.validate(rec);
    if (v.ok) state.recordAction(rec, actionRec.toSearchText(rec));
  } catch (_) { /* best-effort */ }
}

// Latest persisted cursor for the (agent, scope, source_root) tuple.
function loadCursor(opts) {
  try {
    const rows = state.queryActions({
      type: 'tool_call',
      agent_id: opts.agent_id,
      cwd:      opts.cwd || null,
      limit: 200,
      order: 'desc'
    }) || [];
    for (const row of rows) {
      const rec = actionRec.fromRow(row);
      if (!rec || !rec.input || rec.input.tool_name !== CURSOR_TOOL_NAME) continue;
      const args = rec.input.args || {};
      if (args.scope !== opts.scope) continue;
      if (args.source_root !== opts.source_root) continue;
      const out = rec.output && rec.output.cursor;
      if (out && typeof out === 'object') return out;
    }
  } catch (_) {}
  return {};
}

// Diff two signature maps. Returns {added, changed, removed} as path arrays.
function diffSignatures(prev, current) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const p of Object.keys(current)) {
    if (!(p in prev)) added.push(p);
    else if (prev[p] !== current[p]) changed.push(p);
  }
  for (const p of Object.keys(prev)) {
    if (!(p in current)) removed.push(p);
  }
  return { added, changed, removed };
}

// Start a polling watcher. Returns { stop, tickNow, scope }.
//
// Each tick:
//   1. Walks the source root, computes per-file signatures.
//   2. Diffs against the last-seen cursor.
//   3. For added + changed files: ingests via chameleon.ingestDocument.
//   4. (Removed files are not deleted from chameleon today —
//      logged for follow-up; would require scope-keyed delete API.)
//   5. Saves the new cursor to L1.
//
// notify({kind, ...}) callback fires per-event so hosts can render
// "watcher just ingested 3 files" in real time.
function startWatcher(opts) {
  opts = opts || {};
  const agent_id    = opts.agent_id;
  const scope       = opts.scope;
  const source_root = opts.source_root;
  if (!agent_id)    throw new Error('ingest-watcher: agent_id required');
  if (!scope)       throw new Error('ingest-watcher: scope required');
  if (!source_root) throw new Error('ingest-watcher: source_root required');

  const cwd      = opts.cwd || null;
  const user_id  = opts.user_id || 'default';
  const pollMs   = opts.poll_ms != null ? opts.poll_ms : DEFAULT_POLL_MS;
  const recursive = !!opts.recursive;
  const include  = opts.include || /\.(md|txt|markdown|adoc|rst|html|json)$/i;
  const notify   = typeof opts.notify === 'function' ? opts.notify : null;
  const embeddingHost = opts.embedding_host || cfg.embeddingHost();

  let cursor = loadCursor({ agent_id, cwd, scope, source_root });
  let running = true;
  let timer = null;

  function emit(kind, payload) {
    if (notify) {
      try { notify({ kind, scope, source_root, ...(payload || {}), ts: Date.now() }); } catch (_) {}
    }
  }

  async function tick() {
    if (!running) return;
    let current;
    try { current = walkSources(source_root, { recursive, include }); }
    catch (e) {
      emit('watcher_walk_failed', { error: String(e && e.message || e) });
      if (running) timer = setTimeout(tick, pollMs);
      return;
    }
    const diff = diffSignatures(cursor, current);
    if (!diff.added.length && !diff.changed.length && !diff.removed.length) {
      emit('watcher_no_change', { tracked_files: Object.keys(current).length });
      if (running) timer = setTimeout(tick, pollMs);
      return;
    }
    emit('watcher_diff', { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length });
    let ingested = 0;
    for (const p of [...diff.added, ...diff.changed]) {
      let body = '';
      try { body = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (!body.trim()) continue;
      try {
        const r = await chameleon.ingestDocument({
          agent_id, user_id, cwd,
          scope,
          text:  body,
          title: path.basename(p),
          source: 'watcher:' + p,
          embedding_host: embeddingHost
        });
        if (r && r.ok) {
          ingested++;
          emit('watcher_ingested', { file: p, chunks: r.chunks, recorded: r.recorded });
        } else {
          emit('watcher_ingest_failed', { file: p, error: r && r.error });
        }
      } catch (e) {
        emit('watcher_ingest_threw', { file: p, error: String(e && e.message || e) });
      }
    }
    cursor = current;
    saveCursor({ agent_id, cwd, user_id, scope, source_root }, cursor);
    emit('watcher_tick_done', { ingested, tracked_files: Object.keys(cursor).length });
    if (running) timer = setTimeout(tick, pollMs);
  }

  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  // First tick after one pollMs so we don't fire on boot before the
  // host has a chance to subscribe to notify events.
  timer = setTimeout(tick, Math.min(pollMs, 5000));

  return { stop, tickNow: tick, scope, source_root };
}

module.exports = {
  startWatcher,
  walkSources,
  diffSignatures,
  fileSignature,
  loadCursor,
  saveCursor,
  CURSOR_TOOL_NAME
};
