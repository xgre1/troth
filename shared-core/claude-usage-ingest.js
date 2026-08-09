// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code subscription usage → usage_ledger.
//
// The ledger only ever saw requests that passed through the proxy, and
// Claude Code speaks to Anthropic directly, so the operator's heaviest lane
// was invisible: Analytics valued what the plugin SAVED in those sessions
// while usage reported none of what they burned. Claude Code already writes
// exact per-message usage to ~/.claude/projects/*/*.jsonl; this tails those
// files into usage_ledger at each message's own timestamp.
//
// Three facts shape the implementation, all measured on real transcripts:
// - One assistant message appears as SEVERAL jsonl lines (one per content
//   block), each carrying the SAME usage object — 326 lines were 143
//   messages on the file this was built against. Rows are deduped by
//   message.id, and each batch's last id is persisted so a message split
//   across two ingest runs cannot count twice.
// - Transcripts hold multi-byte text, so line splitting happens on bytes
//   and only complete lines advance the byte watermark.
// - The model is stored as '<model> (plan)': those tokens are covered by
//   the operator's flat Claude plan and rateFor() prices the marker
//   flat/$0, while the unsuffixed names keep their API-rate entries for
//   the savings engine to value saved tokens with.
//
// A file that shrinks moves its watermark forward only (skip, never
// re-read): losing a tail is acceptable, double-counting is not.

const fs = require('fs');
const path = require('path');
const state = require('./state.js');

const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;

function projectsDirDefault() {
  return path.join(process.env.HOME || require('os').homedir(), '.claude', 'projects');
}

function listSessionFiles(projectsDir) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// Read every complete line in [from, size), returning deduped usage rows.
// skipMsgId is the last message id the previous run recorded for this file;
// leading lines that still belong to it are dropped.
function readNewRows(file, from, size, skipMsgId) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  const rows = [];
  const seen = new Set();
  let lastMsgId = skipMsgId || null;
  let pos = from;
  let carry = Buffer.alloc(0);
  try {
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const b = Buffer.allocUnsafe(want);
      const got = fs.readSync(fd, b, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      carry = carry.length ? Buffer.concat([carry, b.subarray(0, got)]) : b.subarray(0, got);
      let start = 0;
      for (let nl = carry.indexOf(0x0A, start); nl !== -1; nl = carry.indexOf(0x0A, start)) {
        const line = carry.subarray(start, nl);
        start = nl + 1;
        if (!line.includes('"type":"assistant"')) continue;
        let j; try { j = JSON.parse(line.toString('utf8')); } catch (_) { continue; }
        const m = j && j.message;
        const u = m && m.usage;
        if (!u || !m.model || m.model === '<synthetic>') continue;
        // Only models the Anthropic API itself returns. A non-claude name
        // in a transcript means the session rode the troth proxy (spoofed
        // model ids like 'k3', 'gpt-5.5', 'any') — the proxy already
        // records that lane in usage_ledger, and counting the transcript
        // too doubles it.
        if (!/^claude/i.test(String(m.model))) continue;
        const id = m.id || null;
        if (id) {
          if (id === skipMsgId || seen.has(id)) continue;
          seen.add(id);
          lastMsgId = id;
        }
        const cached = u.cache_read_input_tokens || 0;
        rows.push({
          ts: Date.parse(j.timestamp) || Date.now(),
          model: String(m.model) + ' (plan)',
          tokens_in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached,
          tokens_out: u.output_tokens || 0,
          cached_in: cached,
        });
      }
      carry = start ? carry.subarray(start) : carry;
      if (carry.length > MAX_LINE) carry = Buffer.alloc(0); // no transcript line is 64MB; drop it, don't hold it
    }
  } finally { try { fs.closeSync(fd); } catch (_) {} }
  return { rows, consumedTo: pos - carry.length, lastMsgId };
}

// One incremental pass over every session file. Batch per file commits
// rows and watermark inside one IMMEDIATE transaction, so the concurrent
// timers of parallel Claude sessions cannot double-count a line: whoever
// commits first advances the watermark, the loser's identical batch fails
// the id/byte checks on its next run.
function ingestOnce(opts) {
  opts = opts || {};
  const db = opts.db || state.db();
  db.exec('CREATE TABLE IF NOT EXISTS claude_usage_files (' +
    'path TEXT PRIMARY KEY, bytes INTEGER NOT NULL, last_msg_id TEXT, updated_at INTEGER NOT NULL)');
  const getWm = db.prepare('SELECT bytes, last_msg_id FROM claude_usage_files WHERE path = ?');
  const setWm = db.prepare('INSERT INTO claude_usage_files (path, bytes, last_msg_id, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, last_msg_id = excluded.last_msg_id, updated_at = excluded.updated_at');
  const insert = db.prepare('INSERT INTO usage_ledger (ts, model, tokens_in, tokens_out, cached_in) VALUES (?, ?, ?, ?, ?)');

  const summary = { files_scanned: 0, files_ingested: 0, messages: 0 };
  for (const file of listSessionFiles(opts.projectsDir || projectsDirDefault())) {
    summary.files_scanned++;
    let size;
    try { size = fs.statSync(file).size; } catch (_) { continue; }
    const wm = getWm.get(file) || { bytes: 0, last_msg_id: null };
    if (size < wm.bytes) { try { setWm.run(file, size, null, Date.now()); } catch (_) {} continue; }
    if (size === wm.bytes) continue;

    // Re-check the watermark inside the transaction: another session's
    // timer may have ingested this file between the read above and here.
    const batch = readNewRows(file, wm.bytes, size, wm.last_msg_id);
    if (!batch) continue;
    const apply = db.transaction(() => {
      const now = getWm.get(file) || { bytes: 0, last_msg_id: null };
      if (now.bytes !== wm.bytes) return false;
      for (const r of batch.rows) insert.run(r.ts, r.model, r.tokens_in, r.tokens_out, r.cached_in);
      setWm.run(file, batch.consumedTo, batch.lastMsgId, Date.now());
      return true;
    });
    try {
      if (apply.immediate() && batch.rows.length) {
        summary.files_ingested++;
        summary.messages += batch.rows.length;
      }
    } catch (_) { /* db busy — the watermark did not move, next run retries */ }
  }
  return summary;
}

// Plan-window consumption — the honest half of "show my 5h usage". Sums the
// subscription-marked rows (' (plan)') over a trailing window, grouped into
// the plan families a user actually links. CONSUMPTION ONLY, no percentage:
// the CLIs state no reliable plan limit, and a guessed denominator is a lie
// with a progress bar (same rule as the context meter). A real limit source,
// if one ever exists, adds the percent — nothing here has to change.
function planWindow(hours, opts) {
  const h = Math.max(1, Math.min(168, parseInt(hours || 5, 10) || 5));
  const since = Date.now() - h * 3600 * 1000;
  const out = { hours: h, families: {}, total: { tokens_in: 0, tokens_out: 0, cached_in: 0, requests: 0 } };
  try {
    const db = (opts && opts.db) || state.db();
    const rows = db.prepare(
      'SELECT model, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, ' +
      'COALESCE(SUM(cached_in),0) cin, COALESCE(SUM(requests),0) req ' +
      "FROM usage_ledger WHERE ts >= ? AND model LIKE '% (plan)' GROUP BY model").all(since);
    for (const r of rows) {
      const fam = /kimi|k3/i.test(r.model) ? 'kimi' : (/^claude/i.test(r.model) ? 'claude' : 'other');
      const f = out.families[fam] || (out.families[fam] = { tokens_in: 0, tokens_out: 0, cached_in: 0, requests: 0 });
      f.tokens_in += r.tin; f.tokens_out += r.tout; f.cached_in += r.cin; f.requests += r.req;
      out.total.tokens_in += r.tin; out.total.tokens_out += r.tout; out.total.cached_in += r.cin; out.total.requests += r.req;
    }
  } catch (_) { /* fresh substrate: zeros are the honest answer */ }
  return out;
}

module.exports = { ingestOnce, listSessionFiles, projectsDirDefault, planWindow };
