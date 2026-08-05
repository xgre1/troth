#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-bash — sandboxed replacement for Claude Code's built-in Bash tool.
//
// Why: raw bash output (git log, grep -r, find /, cat-large-file) routinely
// dumps 10-100K tokens into the session, silently compacting the user's
// context. With the built-in Bash tool there's no hook to intercept that
// payload; we fix it by shipping this as an MCP server and asking users
// to add "Bash" to disallowedTools so the agent is forced to route
// through `mcp__troth-bash__run` instead.
//
// Features:
//   Persistent cwd across calls (matches built-in Bash semantics).
//   Per-call timeout with SIGTERM.
//   Command-aware output compression (compress.mjs).
//   Archives the raw full output to state.db so the agent can query it
//     later via a future `bash_recall(archive_id)` tool (bridge).
//   Returns both the compressed summary AND a footer with the size
//     ratio so the agent knows it can drill down if needed.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { compressCommandOutput } from './compress.mjs';

const require = createRequire(import.meta.url);

// ── Process-level error handlers ────────────────────────────────────────
// Without these, an uncaught throw inside `handleUpstream` (which is awaited
// inside a `'data'` callback) tears down the process with NO trace. Claude
// Code then silently sees the MCP transport drop. Surface diagnostics on
// stderr (Claude Code captures it into ~/Library/Logs/Claude/) before exit.
process.on('uncaughtException', (e) => {
  try { process.stderr.write('[troth-bash] uncaughtException: ' + (e && (e.stack || e.message) || e) + '\n'); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  try { process.stderr.write('[troth-bash] unhandledRejection: ' + (e && (e.stack || e.message) || e) + '\n'); } catch {}
  // Don't exit on unhandled rejection — let next message attempt recovery.
});

// Locate shared-core/state.js and danger.js relative to this MCP server's
// install path.
let state = null;
let danger = null;
try {
  const serverDir = fileURLToPath(new URL('.', import.meta.url));
  // plugin/mcp-servers/troth-bash/ → repo/shared-core/state.js
  state = require(serverDir + '../../../shared-core/state.js');
  danger = require(serverDir + '../../../shared-core/danger.js');
} catch (e) { /* fall back to no archival or danger check */ }

// Normalize + validate a directory: expand a leading ~, resolve, and require
// an EXISTING directory. Returns null otherwise. A stale cwd (deleted
// worktree, ~-prefixed input) used to surface as "spawn /bin/bash ENOENT" —
// blaming the shell instead of the cwd (portability audit  #3;
// hit live twice in one session).
function resolveDir(p) {
  if (!p || typeof p !== 'string') return null;
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p;
  const abs = pathResolve(expanded);
  try { return statSync(abs).isDirectory() ? abs : null; } catch (_) { return null; }
}

let cwd = resolveDir(process.env.TROTH_BASH_CWD) || process.cwd();
// Even process.cwd() can be a removed directory (spawned from a dead
// worktree); land somewhere that exists.
if (!existsSync(cwd)) cwd = homedir();

const TOOLS = [
  {
    name: 'run',
    description: 'USE INSTEAD OF Bash. Compresses output >4KB (git/grep/find-aware), archives raw to SQLite for recall. Persistent cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout_ms: { type: 'integer', description: 'Per-call timeout in ms (default 120000).' },
        cwd: { type: 'string', description: 'Override working directory (persistent unless overridden).' },
        acknowledge_danger: { type: 'boolean', description: 'Set to true ONLY when the caller has confirmed a destructive command (rm -rf, git push --force, DROP TABLE, etc.) is intentional.' }
      },
      required: ['command']
    }
  },
  {
    name: 'cd',
    description: 'Change the persistent working directory used by subsequent `run` calls.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'pwd',
    description: 'Return the current persistent working directory.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// Bounded ring buffer: keep first HEAD_BYTES + last TAIL_BYTES, drop middle.
// Prevents unbounded string concatenation that previously OOM'd / stalled the
// event loop on huge outputs (cat huge.bin, find /, accidental log tails),
// which then dropped the MCP heartbeat → silent disconnect.
function makeBoundedBuffer(headBytes, tailBytes) {
  let head = '';
  let tail = '';
  let total = 0;
  let dropped = 0;
  return {
    push(s) {
      total += s.length;
      if (head.length < headBytes) {
        const room = headBytes - head.length;
        if (s.length <= room) { head += s; return; }
        head += s.slice(0, room);
        s = s.slice(room);
      }
      tail += s;
      if (tail.length > tailBytes) {
        const overflow = tail.length - tailBytes;
        dropped += overflow;
        tail = tail.slice(overflow);
      }
    },
    get() {
      if (dropped === 0) return head + tail;
      return head + '\n... [TRUNCATED ' + dropped + ' bytes from middle] ...\n' + tail;
    },
    totalBytes() { return total; }
  };
}

const STDOUT_HEAD = 8 * 1024 * 1024;  // 8 MB head
const STDOUT_TAIL = 2 * 1024 * 1024;  // 2 MB tail
const STDERR_HEAD = 1 * 1024 * 1024;
const STDERR_TAIL = 256 * 1024;
// Hard kill threshold: if a single command emits >50 MB it is almost
// certainly a runaway log/dump that should not block the agent. Kill the
// child, return what we have, mark as truncated.
const HARD_KILL_BYTES = 50 * 1024 * 1024;

function runCommand(command, timeoutMs, overrideCwd) {
  return new Promise((resolve) => {
    let effectiveCwd = overrideCwd || cwd;
    let cwdNote = '';
    if (!existsSync(effectiveCwd)) {
      // Self-heal instead of the misleading "spawn /bin/bash ENOENT": the
      // shell is fine, the directory is gone (removed worktree, unmounted
      // volume). Run in HOME and SAY SO, so the agent fixes its cwd instead
      // of diagnosing a broken shell.
      cwdNote = '[troth-bash] cwd "' + effectiveCwd + '" no longer exists — ran in ' + homedir() + ' instead; use cd to set a valid cwd\n';
      effectiveCwd = homedir();
      if (!overrideCwd) cwd = effectiveCwd;
    }
    const proc = spawn('/bin/bash', ['-lc', command], { cwd: effectiveCwd });
    const outBuf = makeBoundedBuffer(STDOUT_HEAD, STDOUT_TAIL);
    const errBuf = makeBoundedBuffer(STDERR_HEAD, STDERR_TAIL);
    let killed = false;
    let killedByOverflow = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch (e) {}
    }, timeoutMs || 120000);

    function checkOverflow() {
      if (killed) return;
      if (outBuf.totalBytes() + errBuf.totalBytes() > HARD_KILL_BYTES) {
        killed = true;
        killedByOverflow = true;
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
    }

    proc.stdout.on('data', (c) => { outBuf.push(c.toString('utf8')); checkOverflow(); });
    proc.stderr.on('data', (c) => { errBuf.push(c.toString('utf8')); checkOverflow(); });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      let stderrOut = cwdNote + errBuf.get();
      if (killedByOverflow) {
        stderrOut += '\n[troth-bash] HARD KILL: output exceeded ' + HARD_KILL_BYTES + ' bytes total';
      }
      resolve({
        stdout: outBuf.get(),
        stderr: stderrOut,
        exitCode: code,
        signal: signal || (killed ? (killedByOverflow ? 'SIGKILL' : 'SIGTERM') : null),
        timedOut: killed && !killedByOverflow,
        overflowed: killedByOverflow
      });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: 'spawn failed: ' + e.message, exitCode: -1, signal: null, timedOut: false });
    });
  });
}

async function handleTool(name, args) {
  if (name === 'pwd') {
    return { content: [{ type: 'text', text: cwd }] };
  }
  if (name === 'cd') {
    const dir = resolveDir(args.path);
    if (!dir) {
      return { isError: true, content: [{ type: 'text', text: 'no such directory: ' + args.path + ' (cwd unchanged: ' + cwd + ')' }] };
    }
    cwd = dir;
    return { content: [{ type: 'text', text: 'cwd → ' + cwd }] };
  }
  if (name === 'run') {
    // Pre-flight danger check — if the command matches a known
    // destructive pattern AND the caller didn't explicitly ack with
    // acknowledge_danger=true, refuse with an isError + explicit
    // guidance. Cheap safety net below the LoopBreaker / VerifyFirst
    // hooks; those live in the agent loop, this lives in the tool
    // runtime so it catches direct `mcp__troth-bash__run` calls
    // that bypass hooks (e.g. via background agents).
    if (danger && !args.acknowledge_danger) {
      const hit = danger.classify(args.command || '');
      if (hit && hit.severity !== 'medium') {
        return {
          content: [{
            type: 'text',
            text:
              '[troth-bash] REFUSED ' + hit.kind + ' (' + hit.severity + '). ' +
              'Command matched destructive pattern: ' + hit.pattern + '. ' +
              'If this is intentional, re-call with acknowledge_danger=true in the arguments.'
          }],
          isError: true
        };
      }
    }
    const res = await runCommand(args.command, args.timeout_ms, args.cwd);
    const combined = res.stdout + (res.stderr ? '\n---\n' + res.stderr : '');
    const comp = compressCommandOutput(args.command, combined);

    let archiveId = null;
    if (state && comp.ratio < 1) {
      try {
        archiveId = state.archiveToolOutput(
          process.env.CLAUDE_SESSION_ID || null,
          'bash',
          combined,
          comp.summary
        );
        state.recordSavings(
          'bash_compression',
          Math.max(0, comp.originalBytes - comp.compressedBytes),
          process.env.CLAUDE_SESSION_ID || null,
          'cmd: ' + (args.command || '').slice(0, 80)
        );
      } catch (e) { /* archive optional */ }
    }

    const footer = comp.ratio < 1
      ? '\n\n[troth-bash] compressed ' + comp.originalBytes + ' → ' + comp.compressedBytes + ' bytes (' + Math.round((1 - comp.ratio) * 100) + '% saved)' + (archiveId ? ', archive_id=' + archiveId : '')
      : '';

    const metaLines = [];
    metaLines.push('exit: ' + (res.exitCode == null ? '?' : res.exitCode));
    if (res.timedOut) metaLines.push('status: TIMEOUT');
    if (res.signal && !res.timedOut) metaLines.push('signal: ' + res.signal);
    const meta = '[' + metaLines.join(' | ') + ']\n\n';

    return { content: [{ type: 'text', text: meta + comp.summary + footer }], isError: res.exitCode !== 0 };
  }
  throw new Error('unknown tool: ' + name);
}

// ── Upstream MCP loop ───────────────────────────────────────────────────
// Use readline + bounded queue + backpressure instead of raw 'data' listener.
// Old design: global string concat + sequential `await` inside `'data'` →
// during a slow bash call, new chunks pile up in node's internal stdin buffer
// AND in our `inputBuffer`; eventually MCP heartbeat times out → kill.
// New design: line-by-line via readline; each line enqueued; queue drained
// serially. stdin is paused while the queue is non-empty so the parent
// applies natural backpressure instead of accumulating in our memory.
process.stdin.setEncoding('utf8');
const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
const msgQueue = [];
let draining = false;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) {
    process.stderr.write('[troth-bash] malformed JSON line dropped\n');
    return;
  }
  msgQueue.push(msg);
  if (!draining) drainQueue();
});

rl.on('close', () => {
  // Parent closed stdin → graceful exit, but log so disconnects are visible.
  process.stderr.write('[troth-bash] stdin closed by parent, exiting\n');
  process.exit(0);
});
process.stdin.on('error', (e) => {
  process.stderr.write('[troth-bash] stdin error: ' + (e && e.message || e) + '\n');
  process.exit(1);
});

async function drainQueue() {
  if (draining) return;
  draining = true;
  // Pause stdin while we have backlog so parent buffers data instead of us.
  try { process.stdin.pause(); } catch {}
  while (msgQueue.length) {
    const msg = msgQueue.shift();
    try {
      await handleUpstream(msg);
    } catch (e) {
      process.stderr.write('[troth-bash] handler threw: ' + (e && (e.stack || e.message) || e) + '\n');
    }
  }
  draining = false;
  try { process.stdin.resume(); } catch {}
}

async function handleUpstream(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  };
  const replyError = (err) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: String(err && err.message || err) }
    }) + '\n');
  };

  try {
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'troth-bash', version: '1.0.0' }
      });
    } else if (msg.method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      const result = await handleTool(msg.params.name, msg.params.arguments || {});
      reply(result);
    } else if (msg.method === 'ping') {
      reply({});
    } else {
      reply({});
    }
  } catch (e) { replyError(e); }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
