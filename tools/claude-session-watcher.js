#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// claude-session-watcher — keeps the substrate live on new Claude Code turns.
//
// Property #3 strengthening: every NEW Claude Code conversation
// lands in the substrate without manual backfill. The existing
// backfill bridge (tools/backfill-claude-sessions.js) handles
// historical sessions; this watcher keeps the substrate live.
//
// Operation:
//   1. Poll ~/.claude/projects/<encoded-$HOME>/ every 10s.
//   2. For each .jsonl file, track byte offset in marker file
//      (~/.troth/.session-watch-cursor.json keyed by session id).
//   3. On detected growth, read appended bytes only, parse line by
//      line, pair user→assistant turns, redact secrets, call
//      dialogueMemory.recordTurn under the active agent_id (resolved via
//      shared-core/agent-id.js — env TROTH_ENTITY_AGENT_ID).
//   4. The active session being written by the current Claude Code
//      conversation will be tail-followed naturally — each new turn
//      lands in substrate within one poll interval.
//
// Reuses processFile semantics from backfill-claude-sessions but
// keeps a per-session BYTE OFFSET (not timestamp) — appends to
// JSONL files always grow at the end, so byte tracking is precise
// and avoids re-parsing already-seen lines.
//
// Run via: node tools/claude-session-watcher.js
//   (or wire as service via launchd / systemd / pm2)

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const dialogueMemory = require('../shared-core/dialogue-memory.js');
const secrets        = require('../proxy/modules/secrets.js');
const backfill       = require('./backfill-claude-sessions.js');   // reuse stripUserNoise + extractAssistantText
const { resolveAgentId } = require('../shared-core/agent-id.js');

// Claude Code encodes the project's cwd as a directory under
// ~/.claude/projects/ by replacing every '/' with '-' in the absolute
// path. For cwd=$HOME the dir is '-Users-alice' on macOS, '-home-alice'
// on Linux, etc. Deriving the watch target from $HOME (rather than
// hardcoding one user's encoded path) is what makes this OSS-installable.
const HOME = process.env.HOME || require('os').homedir();
const ENCODED_HOME = HOME.replace(/\//g, '-');
const SESSIONS_DIR = path.join(HOME, '.claude/projects/' + ENCODED_HOME);
const CURSOR_PATH  = path.join(HOME, '.troth/.session-watch-cursor.json');
const DEFAULT_AGENT    = resolveAgentId();
const DEFAULT_POLL_MS  = 10 * 1000;
const MAX_TEXT_CHARS   = 8000;

function loadCursor() {
  try { return JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveCursor(c) {
  try {
    fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true, mode: 0o700 });
    const tmp = CURSOR_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, CURSOR_PATH);
  } catch (e) { console.error('[watcher] cursor save failed:', e.message); }
}

// Read appended bytes from `offset` to current EOF, parse + record
// as turns. Returns {written, redacted, skipped, newOffset}.
async function processAppend(filePath, offset, agent_id, pendingState) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return { written: 0, redacted: 0, skipped: 0, newOffset: offset }; }
  if (stat.size <= offset) return { written: 0, redacted: 0, skipped: 0, newOffset: offset };

  const stream = fs.createReadStream(filePath, { start: offset, end: stat.size - 1 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let written = 0, redacted = 0, skipped = 0;
  let pendingUser = pendingState.pendingUser || null;

  for await (const line of rl) {
    if (!line || !line.length) continue;
    let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.type === 'user' && obj.message && obj.message.role === 'user') {
      const raw = typeof obj.message.content === 'string' ? obj.message.content : '';
      const cleaned = backfill.stripUserNoise(raw);
      if (cleaned.length < 2) { skipped++; continue; }
      pendingUser = { text: cleaned, ts: obj.timestamp ? Date.parse(obj.timestamp) : 0, cwd: obj.cwd || null };
    } else if (obj.type === 'assistant' && obj.message) {
      const text = backfill.extractAssistantText(obj.message);
      if (text.length < 2) { skipped++; continue; }
      if (!pendingUser) { skipped++; continue; }
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      const redactedUser = secrets.redact(pendingUser.text);
      const redactedAsst = secrets.redact(text);
      if (redactedUser !== pendingUser.text || redactedAsst !== text) redacted++;
      const ok = dialogueMemory.recordTurn({
        agent_id, user_id: 'default',
        cwd:            pendingUser.cwd || obj.cwd || null,
        user_text:      redactedUser.slice(0, MAX_TEXT_CHARS),
        assistant_text: redactedAsst.slice(0, MAX_TEXT_CHARS),
        faculty:        'claude-code-live',
        elapsed_ms:     (pendingUser.ts && ts) ? (ts - pendingUser.ts) : null
      });
      if (ok) written++;
      pendingUser = null;
    }
  }
  pendingState.pendingUser = pendingUser;
  return { written, redacted, skipped, newOffset: stat.size };
}

async function tick(state) {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')); }
  catch (_) { return; }
  for (const f of files) {
    const filePath = path.join(SESSIONS_DIR, f);
    const sessionId = path.basename(f, '.jsonl');
    // First-sight policy: when we encounter a session we've never tracked
    // before AND `start_at_eof` mode is on (default true), initialize the
    // cursor to current file size. Old sessions are presumed already
    // backfilled via tools/backfill-claude-sessions.js — re-reading from
    // byte 0 would write thousands of duplicate dialogue rows. Forward-
    // capture only is the safe default; pass `--from-zero` to override.
    if (!(sessionId in state.cursor)) {
      if (state.start_at_eof) {
        try { state.cursor[sessionId] = fs.statSync(filePath).size; }
        catch (_) { state.cursor[sessionId] = 0; }
        saveCursor(state.cursor);
      } else {
        state.cursor[sessionId] = 0;
      }
    }
    const offset = state.cursor[sessionId];
    if (!state.pending[sessionId]) state.pending[sessionId] = {};
    try {
      const r = await processAppend(filePath, offset, state.agent_id, state.pending[sessionId]);
      if (r.written > 0 || r.redacted > 0) {
        console.error('[watcher] ' + sessionId.slice(0, 8) +
                      '  +' + r.written + ' turns' +
                      (r.redacted ? '  red=' + r.redacted : ''));
      }
      if (r.newOffset !== offset) {
        state.cursor[sessionId] = r.newOffset;
        saveCursor(state.cursor);
      }
    } catch (e) { console.error('[watcher] ' + sessionId.slice(0, 8) + '  err: ' + e.message); }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const argVal = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
  const agent  = argVal('--agent', DEFAULT_AGENT);
  const pollMs = parseInt(argVal('--poll', String(DEFAULT_POLL_MS))) || DEFAULT_POLL_MS;
  const startAtEof = !args.includes('--from-zero');

  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error('[watcher] sessions dir missing:', SESSIONS_DIR);
    process.exit(1);
  }
  console.error('[watcher] starting  agent=' + agent + '  poll=' + pollMs + 'ms  start_at_eof=' + startAtEof);
  console.error('[watcher] dir=' + SESSIONS_DIR);
  const state = {
    agent_id: agent,
    cursor:   loadCursor(),
    pending:  {},   // per-session pending half-pair (user without assistant yet)
    start_at_eof: startAtEof
  };

  let stopped = false;
  process.on('SIGINT',  () => { stopped = true; console.error('\n[watcher] stop'); process.exit(0); });
  process.on('SIGTERM', () => { stopped = true; console.error('\n[watcher] stop'); process.exit(0); });

  while (!stopped) {
    await tick(state);
    await new Promise(r => setTimeout(r, pollMs));
  }
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}

// Controllable runtime — used by proxy/server.js to embed the watcher
// as a start/stop-able task surfaceable from the dashboard. Same tick
// semantics as the standalone CLI; just lifts the control surface so
// callers can start/stop without a subprocess.
function makeRuntime(opts) {
  opts = opts || {};
  const agent  = opts.agent_id || DEFAULT_AGENT;
  const pollMs = typeof opts.poll_ms === 'number' ? opts.poll_ms : DEFAULT_POLL_MS;
  const startAtEof = opts.start_at_eof !== false;
  const state = {
    agent_id: agent, cursor: loadCursor(), pending: {}, start_at_eof: startAtEof
  };
  let timer = null;
  let running = false;
  const stats = { last_tick_at: 0, ticks: 0, ingested: 0, errors: 0, started_at: 0 };
  async function loop() {
    if (!running) return;
    try {
      // Reuse tick() from this module by inlining its logic — tick is not
      // exported as it relies on closure-style state. Replicate compactly.
      const fs2 = require('fs');
      let files = [];
      try { files = fs2.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')); }
      catch (_) { files = []; }
      let perTickIngested = 0;
      for (const f of files) {
        const filePath = require('path').join(SESSIONS_DIR, f);
        const sessionId = require('path').basename(f, '.jsonl');
        if (!(sessionId in state.cursor)) {
          if (state.start_at_eof) {
            try { state.cursor[sessionId] = fs2.statSync(filePath).size; }
            catch (_) { state.cursor[sessionId] = 0; }
            saveCursor(state.cursor);
          } else {
            state.cursor[sessionId] = 0;
          }
        }
        if (!state.pending[sessionId]) state.pending[sessionId] = {};
        try {
          const r = await processAppend(filePath, state.cursor[sessionId], state.agent_id, state.pending[sessionId]);
          perTickIngested += r.written;
          if (r.newOffset !== state.cursor[sessionId]) {
            state.cursor[sessionId] = r.newOffset;
            saveCursor(state.cursor);
          }
        } catch (e) { stats.errors++; }
      }
      stats.last_tick_at = Date.now();
      stats.ticks++;
      stats.ingested += perTickIngested;
    } catch (_) { stats.errors++; }
    if (running) timer = setTimeout(loop, pollMs);
  }
  return {
    start() {
      if (running) return { ok: true, already_running: true };
      running = true;
      stats.started_at = Date.now();
      timer = setTimeout(loop, 100); // fire fast on start so first tick lands immediately
      return { ok: true, started: true, agent_id: agent, poll_ms: pollMs };
    },
    stop() {
      if (!running) return { ok: true, already_stopped: true };
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      return { ok: true, stopped: true };
    },
    status() {
      return {
        running, agent_id: agent, poll_ms: pollMs,
        sessions_tracked: Object.keys(state.cursor).length,
        ticks: stats.ticks,
        ingested: stats.ingested,
        errors: stats.errors,
        started_at: stats.started_at,
        last_tick_at: stats.last_tick_at,
        uptime_ms: stats.started_at ? Date.now() - stats.started_at : 0
      };
    }
  };
}

module.exports = { processAppend, loadCursor, saveCursor, makeRuntime };
