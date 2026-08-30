#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-bash — context-safe replacement for Claude Code's built-in Bash
// tool: output compression + archival, plus a REAL OS jail for workspace
// ground. Commands whose cwd is under ~/.troth/workspace/ run inside the
// seatbelt sandbox scoped to their project (see workspace-jail.mjs);
// everything else runs as the operator's own shell, untouched.
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
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { compressCommandOutput } from './compress.mjs';
import { jailFor, wrapFor, installWrapFor } from './workspace-jail.mjs';

const require = createRequire(import.meta.url);
const _greet = require(fileURLToPath(new URL('../../../shared-core/mcp-greeting.js', import.meta.url))).makeGreeter();

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
let safety = null;
let constraintLedger = null;
let redactor = null;
let seatbelt = null;
let envdoor = null;
try {
  const serverDir = fileURLToPath(new URL('.', import.meta.url));
  // plugin/mcp-servers/troth-bash/ → repo/shared-core/state.js
  state = require(serverDir + '../../../shared-core/state.js');
  constraintLedger = require(serverDir + '../../../shared-core/constraint-ledger.js');
  danger = require(serverDir + '../../../shared-core/danger.js');
  safety = require(serverDir + '../../../shared-core/tools/bash-safety.js');
  seatbelt = require(serverDir + '../../../shared-core/tools/sandbox-seatbelt.js');
  envdoor = require(serverDir + '../../../shared-core/tools/env-door.js');
  // The same harvest+redact store the outbound reply path uses. Raw stdout
  // used to flow to the model AND into tool_output_archive untouched, which
  // is how 550 credential literals ended up full-text searchable on disk:
  // one `cat .env` was archived verbatim, forever. Harvest secret-shaped
  // literals from every result and mask them BEFORE anything downstream
  // (compression, the model, the archive) sees the text.
  redactor = require(serverDir + '../../../shared-core/secret-redactor.js');
} catch (e) { /* fall back to no archival or danger check */ }

// The egress listener: an install jail's only network road leads here, and
// the allowlist lives in this process, where the jail cannot reach it. It
// binds loopback on an ephemeral port, starts with the server and dies with
// it. A failed start degrades the install jail to direct network with
// loopback denied — announced on each interception, never silent.
let egress = null;
try {
  const serverDir = fileURLToPath(new URL('.', import.meta.url));
  const eg = require(serverDir + '../../../shared-core/tools/egress-proxy.js');
  eg.startEgressProxy({}).then((p) => { egress = p; }).catch(() => {});
} catch (_) { /* module missing from this install: direct-network fallback */ }

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
// The directory the session started in is opened ground for this process
// only. Captured before any cd can move it, and never written anywhere: an
// in-memory grant has no expiry to get wrong, leaves nothing stale on disk,
// and gives the partner no road that writes to the operator's registry.
const SESSION_ROOT = cwd;

// Notes that would otherwise repeat on every command. A wall the agent has
// already been told about does not need saying again, and a line printed on
// every result is a line nobody reads.
const _noted = new Set();
function noteOnce(key, text) {
  if (_noted.has(key)) return '';
  _noted.add(key);
  return text;
}

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
  },
  {
    name: 'open_ground',
    description: 'Open a folder of the operator\'s own work as opened ground for THIS session: commands there run with the operator\'s environment instead of confined walls. Requires a one-line purpose (kept on record), and the tree is photographed for undo before the grant applies. Refused for partner project ground (the workspace) and for the tree holding the substrate. The grant dies with the session; the permanent registry stays the operator\'s own road (`troth open`).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The folder to open, absolute or ~-relative.' },
        purpose: { type: 'string', description: 'One line: why this ground opens.' }
      },
      required: ['path', 'purpose']
    }
  },
  {
    name: 'net_allow',
    description: 'Add a host to THIS project\'s install-egress allowlist (the registries an install jail may reach). Per-project only — the every-project list stays the operator\'s own road (`troth net-allow --everywhere`). Requires a one-line purpose (kept on record); the addition is announced and applies to the next install.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host to allow, e.g. npm.example.com or *.example.com.' },
        purpose: { type: 'string', description: 'One line: why this project needs the host.' }
      },
      required: ['host', 'purpose']
    }
  },
  {
    name: 'run_gate',
    description: 'Run the gate a guarded destination demands, from the partner\'s own hand: executes the operator-configured gate command for the given match (in the persistent cwd), and a green exit records a pass bound to the exact tree at HEAD — the guarded push then proceeds. Red returns the gate\'s tail so the failure is actionable. No operator involved.',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'The guarded destination entry to satisfy, exactly as listed (e.g. github.com/owner/repo).' }
      },
      required: ['match']
    }
  },
  {
    name: 'browse',
    description: 'Drive a real Chrome page over CDP: navigate, read the DOM, click and fill through eval JS, screenshot. Steps in order: goto url → wait_ms → eval JS (JSON result returned) → screenshot to a PNG path. With no port it uses the troth browser and starts it if needed (private profile, never your own session). With an explicit port it only attaches: port 9222 reaches a browser the operator started with --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Navigate here first (optional).' },
        eval: { type: 'string', description: 'JS expression evaluated in the page; JSON-serializable result returned.' },
        screenshot: { type: 'string', description: 'PNG file path (absolute or cwd-relative) to save a screenshot to.' },
        wait_ms: { type: 'integer', description: 'Settle time after navigation in ms (default 1200).' },
        host: { type: 'string', description: 'CDP host (default 127.0.0.1).' },
        port: { type: 'integer', description: 'CDP port. Omit to use the troth browser (started if needed on 18222). Explicit ports are attach-only; 9222 is the operator\'s own debug browser.' }
      }
    }
  },
  {
    name: 'env_set',
    description: 'Write keys into a dotenv file (.env, .env.*) WITHOUT the values transiting the conversation: secrets are named from the vault and resolved host-side; replies carry key NAMES only. Literals are for non-secret configuration — a credential-shaped literal is refused (put it in the vault first). Reading .env stays refused everywhere; verify configuration by running the app.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Target dotenv file, absolute or relative to the persistent cwd.' },
        entries: {
          type: 'array',
          description: 'Each entry sets one key: {key, from_vault: "<vault entry name>"} for secrets, {key, value: "<literal>"} for non-secret config. All-or-nothing: the whole batch is refused if any entry cannot resolve.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Env var name ([A-Za-z_][A-Za-z0-9_]*).' },
              value: { type: 'string', description: 'Literal value — non-secret configuration only.' },
              from_vault: { type: 'string', description: 'Vault entry name to resolve host-side; the value never enters the conversation.' }
            },
            required: ['key']
          }
        },
        overwrite: { type: 'boolean', description: 'Required true to replace keys that already exist — their current values are not readable from here, so replacing them is destructive.' }
      },
      required: ['file', 'entries']
    }
  },
  {
    name: 'env_keys',
    description: 'List the key NAMES present in a dotenv file and whether a vault entry of the same name is usable for this project. Never returns values.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Dotenv file, absolute or relative to the persistent cwd.' }
      },
      required: ['file']
    }
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

// Operator ground inherits the operator's environment — that is the point of
// operator ground — MINUS the switches that lower the substrate's own walls.
// TROTH_STVC_BYPASS is the operator's debugging escape hatch for THEIR shell
// (doctor reports it when set); inherited here it would ride silently under
// every partner command and turn the STVC gate off for writes the partner
// makes through any tool it shells out to. The jailed branch never inherits
// (sandbox-seatbelt builds its env from scratch), so this covers the one
// spawn that does. The inline spelling (`TROTH_STVC_BYPASS=1 cmd`) is refused
// by bash-safety for the same reason.
function partnerEnv() {
  const env = Object.assign({}, process.env);
  delete env.TROTH_STVC_BYPASS;
  return env;
}

// Undo shadow, reached lazily the same way the jail is: absent shared-core
// (a bridge-only install) leaves the shell exactly as it was.
let _undoMod;
function requireUndo() {
  if (_undoMod !== undefined) return _undoMod;
  try { _undoMod = require(fileURLToPath(new URL('../../../shared-core/tools/undo-shadow.js', import.meta.url))); }
  catch (e) { _undoMod = null; }
  return _undoMod;
}

// Session-open grants: ground the partner opened for itself, this process
// only. Reached lazily like the undo net; absent shared-core leaves the
// shell exactly as it was.
let _grantsMod;
function requireGrants() {
  if (_grantsMod !== undefined) return _grantsMod;
  try { _grantsMod = require(fileURLToPath(new URL('../../../shared-core/tools/session-grants.js', import.meta.url))); }
  catch (e) { _grantsMod = null; }
  return _grantsMod;
}

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
    // Which ground this command stands on decides which walls it runs
    // behind. The note keeps the agent oriented so a "permission denied"
    // reads as the wall rather than a bug.
    const _grants = requireGrants();
    const wrap = wrapFor(effectiveCwd, { sessionRoot: SESSION_ROOT,
                                         sessionOpens: _grants ? _grants.list() : [] });
    if (wrap && wrap.refuse) {
      // A cwd that claims one ground but resolves into another. Running it
      // bare would be the one fail-open the whole design exists to avoid.
      return resolve({
        stdout: '', stderr: '[troth-bash] REFUSED: ' + wrap.refuse + '\n',
        exitCode: 126, signal: null, timedOut: false
      });
    }
    if (wrap && wrap.off === 'operator') {
      // The operator set l4.sandbox.runtime to bare. Their machine, their
      // call — but say so, because walls that are off and walls that are on
      // look identical until something goes wrong.
      cwdNote += noteOnce('off:operator:' + wrap.ground,
        '[troth-bash] sandbox OFF by operator config (l4.sandbox.runtime=bare):'
        + ' ' + wrap.ground + ' ground runs unsandboxed\n');
    } else if (wrap && wrap.off) {
      // This host has no wall to give, or the kernel refuses to apply one —
      // which is the answer inside an existing sandbox. Announced for the
      // same reason as the operator's own switch: a promise that quietly is
      // not kept is worse than one never made.
      cwdNote += noteOnce('off:' + wrap.off + ':' + wrap.ground,
        '[troth-bash] sandbox UNAVAILABLE: ' + wrap.ground + ' ground runs'
        + ' unsandboxed (' + (wrap.why || 'no runtime') + ')\n');
    } else if (wrap && wrap.kind === 'jail') {
      cwdNote += '[troth-bash] workspace jail: writes+reads scoped to ' + wrap.root
        + (wrap.ground === 'workspace'
            ? ' (the workspace root: this command can see every project — cd into one for real work)'
            : '') + '\n';
    }
    // The second look: a package installation on thin or confined ground
    // moves into the OS jail, scoped to the nearest project. Announced every
    // time — it is a mode switch, and its failure modes differ from the
    // ground's — like the workspace jail above, not like the quiet walls.
    const iw = installWrapFor(command, wrap, effectiveCwd, { egress });
    if (iw) {
      cwdNote += '[troth-bash] install jail (' + iw.manager + '): writes scoped to '
        + iw.root + ', home invisible, '
        + (iw.egress === 'proxy'
            ? 'network reaches the package registries only'
            : 'direct network (egress proxy unavailable)')
        + '; global/user-target installs are not intercepted and keep their ground\n';
    }
    // A photograph of the ground before every command — no judgment about
    // the command, because deciding which actions deserve one is exactly
    // the judgment the undo net removes. Synchronous on purpose: the photo
    // must exist before the first byte can touch the tree. Never a gate —
    // a failed photo lands in undo stats and the command proceeds.
    try {
      const undo = requireUndo();
      if (undo) {
        const g = (wrap && wrap.ground) || 'operator';
        const sanctioned = (g === 'project' || g === 'workspace' || g === 'opened');
        const photoDir = sanctioned ? ((wrap && wrap.root) || effectiveCwd) : effectiveCwd;
        undo.snapshot(photoDir, 'shell:' + g, { allowShallow: sanctioned });
      }
    } catch (e) { /* the net never becomes a gate */ }
    const active = iw || wrap;
    // Confined ground and the substrate tree say nothing in advance. A
    // warning printed before anything has gone wrong is a line on every
    // result that the reader learns to skip, and it arrives when there is
    // nothing to act on. The explanation is attached to the refusal instead,
    // at the moment it explains something — see the exit handler below.
    // Opened ground says nothing: it is the operator's own machine behaving
    // as it always has, and a note on every command there means nothing.
    //
    // An off-by-config wrap carries no argv, so it spawns bare below.
    const wrapped = active && active.exec ? active : null;
    // detached puts the command in its OWN process group so a kill can take
    // the whole tree. Seatbelt scopes signals to one sandbox-exec
    // invocation, so a background server started inside a jail is
    // unreachable — and unkillable — from any later call; without the group
    // it survives the timeout that was supposed to end it.
    const proc = wrapped
      ? spawn(wrapped.exec, wrapped.args.concat(['/bin/bash', '-lc', command]),
              { cwd: effectiveCwd, env: wrapped.env, detached: true })
      : spawn('/bin/bash', ['-lc', command],
              { cwd: effectiveCwd, env: (wrap && wrap.env) || partnerEnv(), detached: true });
    // Signal the group (-pid), falling back to the leader if the group is
    // already gone, so a stray child can never outlive its command.
    const endTree = (sig) => {
      try { process.kill(-proc.pid, sig); }
      catch (e) { try { proc.kill(sig); } catch (e2) {} }
    };
    const outBuf = makeBoundedBuffer(STDOUT_HEAD, STDOUT_TAIL);
    const errBuf = makeBoundedBuffer(STDERR_HEAD, STDERR_TAIL);
    let killed = false;
    let killedByOverflow = false;
    const timer = setTimeout(() => {
      killed = true;
      endTree('SIGTERM');
      // A tree that ignores SIGTERM still has to go.
      setTimeout(() => endTree('SIGKILL'), 2000).unref?.();
    }, timeoutMs || 120000);

    function checkOverflow() {
      if (killed) return;
      if (outBuf.totalBytes() + errBuf.totalBytes() > HARD_KILL_BYTES) {
        killed = true;
        killedByOverflow = true;
        endTree('SIGKILL');
      }
    }

    proc.stdout.on('data', (c) => { outBuf.push(c.toString('utf8')); checkOverflow(); });
    proc.stderr.on('data', (c) => { errBuf.push(c.toString('utf8')); checkOverflow(); });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      // The leader is gone; anything it backgrounded goes with it.
      endTree('SIGKILL');
      let stderrOut = cwdNote + errBuf.get();
      if (killedByOverflow) {
        stderrOut += '\n[troth-bash] HARD KILL: output exceeded ' + HARD_KILL_BYTES + ' bytes total';
      }
      // A write refused by the ground wall reads as an unexplained permission
      // error, and the next thing tried is usually a workaround for a bug that
      // is not there. Explain it here, where it is the answer to something the
      // reader is looking at — and name the road that is actually open, which
      // differs by cause: a startup or tool-config file is refused on EVERY
      // ground, so pointing at `troth open` for one would promise a lift that
      // never comes.
      // Case-insensitive: the shell spells it "Operation not permitted", an
      // interpreter error spells it lower-case, and the kernel wall is the
      // only road an interpreter-carried write ever meets.
      if (active && active.kind && code !== 0 && /operation not permitted|permission denied/i.test(errBuf.get())) {
        const walled = seatbelt ? seatbelt._persistencePaths().find((p) => errBuf.get().includes(p)) : null;
        if (walled) {
          stderrOut += '\n[troth-bash] ' + walled + ' is a file this machine executes or obeys'
            + ' (shell startup, agent host, or the next git/ssh/npm/docker operation), so no'
            + ' ground writes it. Per-project configuration stays open: .git/config in the'
            + ' repo, a project-local .npmrc.\n';
        } else if (active.kind === 'install-jail') {
          stderrOut += '\n[troth-bash] the install ran jailed: writes land only in ' + active.root
            + ' and the home is not visible. A dependency that needs a path outside the'
            + ' project is the thing this jail exists to catch — check what asked for it.\n';
        } else if (active.kind === 'confine' || active.kind === 'home') {
          stderrOut += '\n[troth-bash] ' + (active.kind === 'home'
            ? 'this directory holds the substrate: writes land in scratch, not here.'
              + ' cd into a project to work.'
            : 'writes here are scoped to ' + active.root + ', so a path outside it is'
              + ' refused. If this folder is the operator\'s own work, open it yourself:'
              + ' call open_ground with the path and a one-line purpose (recorded,'
              + ' photographed for undo), then rerun. The permanent road stays the'
              + ' operator\'s own: `troth open ' + active.root + '`.') + '\n';
        }
      }
      // What the egress proxy turned away while this command ran, named on
      // the result it explains, and the token retired with it. Attribution
      // is exact: the token was issued for this command alone.
      if (iw && iw.token && egress) {
        const refused = Array.from(new Set(egress.refusalsFor(iw.token)));
        if (refused.length) {
          stderrOut += '\n[troth-bash] egress refused during this install: '
            + refused.slice(0, 8).join(', ')
            + ' — an install jail reaches the package registries only.'
            + ' If this project genuinely needs one of these, call net_allow with the'
            + ' host and a one-line purpose — it widens THIS project alone, on record.\n';
        }
        try { egress.revoke(iw.token); } catch (_) {}
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

// ── browse: look at a real page through the operator's own Chrome ────────
// Connects to an ALREADY-RUNNING Chrome (--remote-debugging-port=9222);
// never launches one. Steps run in order: goto → wait → eval → screenshot.
// This is the same road the journey tests drive (tests/journey/lib/browser.js),
// exposed as a tool so any agent with troth mounted can look at real pages.
async function handleBrowse(args) {
  let cdp;
  try {
    const serverDir = fileURLToPath(new URL('.', import.meta.url));
    cdp = require(serverDir + '../../../shared-core/perception/cdp-client.js');
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: 'cdp client unavailable: ' + (e && e.message || e) }] };
  }
  let host = args.host || '127.0.0.1';
  let port = Number(args.port) || 0;
  const explicit = port > 0;
  if (!explicit) {
    // No port asked: find or start the TROTH browser only — whatever a
    // body/daemon already exported, then the private daemon port, then
    // launch the daemon's Chrome. The operator's own debug browser (9222)
    // is NOT a candidate here: the description promises "never your own
    // session", and until this held, a no-port browse with a debug Chrome
    // open landed inside the operator's authenticated session with
    // arbitrary eval. 9222 is reachable only as an EXPLICIT port — the
    // operator's opt-in — and explicit ports stay attach-only.
    let daemon = null;
    try {
      const serverDir = fileURLToPath(new URL('.', import.meta.url));
      daemon = require(serverDir + '../../../shared-core/perception/chromium-daemon.js');
    } catch (_) {}
    if (daemon) {
      const candidates = [];
      const envPort = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '', 10);
      if (envPort) candidates.push(envPort);
      if (candidates.indexOf(daemon.DEFAULT_PORT) === -1) candidates.push(daemon.DEFAULT_PORT);
      for (const c of candidates) {
        const h = await daemon.aliveHost(c, 900);
        if (h) { host = h; port = c; break; }
      }
      if (!port) {
        const up = await daemon.ensure({});
        if (up && up.ok) { host = up.host || host; port = up.port; }
        else return { isError: true, content: [{ type: 'text', text:
          'no browser to attach and could not start one: ' + ((up && (up.detail || up.error)) || 'unknown') }] };
      }
    }
    // No daemon module on this install → there is no troth browser to use.
    // Falling back to 9222 here would silently do what the no-port contract
    // exists to prevent; say what is missing instead.
    if (!port) {
      return { isError: true, content: [{ type: 'text', text:
        'no troth browser available on this install. To drive your OWN debug Chrome, start it with --remote-debugging-port=9222 and call browse with port 9222 explicitly.' }] };
    }
  }
  let page;
  try { page = await cdp.connectFirstPage(host, port); }
  catch (e) {
    return { isError: true, content: [{ type: 'text', text:
      'no debuggable browser at ' + host + ':' + port + (explicit
        ? ' - explicit ports are attach-only; start that browser yourself with --remote-debugging-port=' + port
        : ' - and starting the troth browser did not yield a page') + '. Underlying: ' + (e && e.message || e) }] };
  }
  const out = {};
  try {
    await page.send('Page.enable', {});
    await page.send('Runtime.enable', {});
    if (args.url) {
      await page.send('Page.navigate', { url: String(args.url) });
      await new Promise((r) => setTimeout(r, Number(args.wait_ms) || 1200));
    } else if (args.wait_ms) {
      await new Promise((r) => setTimeout(r, Number(args.wait_ms)));
    }
    if (args.eval) {
      const r = await page.send('Runtime.evaluate', {
        expression: '(function(){ try { return JSON.stringify(' + args.eval + '); } catch (e) { return JSON.stringify({ __eval_error: String(e && e.message || e) }); } })()',
        returnByValue: true, awaitPromise: true,
      });
      const v = r && r.result && r.result.value;
      try { out.eval = JSON.parse(v); } catch (_) { out.eval = v; }
    }
    if (args.screenshot) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.data) {
        const file = pathResolve(cwd, String(args.screenshot));
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        out.screenshot = file;
      } else { out.screenshot = null; }
    }
  } catch (e) {
    try { page.close(); } catch (_) {}
    return { isError: true, content: [{ type: 'text', text: 'browse failed: ' + (e && e.message || e) }] };
  }
  try { page.close(); } catch (_) {}
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

async function handleTool(name, args) {
  if (name === 'browse') return handleBrowse(args);
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
  if (name === 'open_ground') {
    const grants = requireGrants();
    if (!grants) {
      return { isError: true, content: [{ type: 'text', text: 'open_ground unavailable: shared-core not found from this install' }] };
    }
    const r = grants.grant(args.path, args.purpose);
    if (!r.ok) {
      return { isError: true, content: [{ type: 'text', text: '[troth-bash] open refused: ' + r.error }] };
    }
    // The photograph precedes the grant taking effect: opened ground is safe
    // because it is reversible, so the tree is captured before the first
    // command can stand on it.
    let photo = 'no undo module on this install';
    const undo = requireUndo();
    if (undo) {
      try {
        const s = undo.snapshot(r.root, 'session-open', { allowShallow: true });
        photo = (s && s.skipped) ? 'photograph skipped: ' + s.skipped : 'photographed for undo';
      } catch (e) { photo = 'photograph failed: ' + (e && e.message || e); }
    }
    try {
      if (state && state.archiveToolOutput) {
        state.archiveToolOutput(process.env.CLAUDE_SESSION_ID || null, 'open_ground',
          'session-open ' + r.root + ' — ' + r.purpose, 'session-open ' + r.root);
      }
    } catch (_) { /* best-effort record; the grant text below is the loud part */ }
    return { content: [{ type: 'text', text:
      '[troth-bash] opened for this session: ' + r.root + ' (' + photo + '). '
      + 'Purpose on record: ' + r.purpose + '. Commands there now run with the '
      + 'operator\'s environment; the permanent registry is untouched.' }] };
  }
  if (name === 'net_allow') {
    const why = String(args.purpose === undefined || args.purpose === null ? '' : args.purpose)
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!why) {
      return { isError: true, content: [{ type: 'text', text: '[troth-bash] refused: a one-line purpose is required — it is the record of why this host opened' }] };
    }
    let net = null, gp = null;
    try {
      net = require(fileURLToPath(new URL('../../../shared-core/tools/net-allowlist.js', import.meta.url)));
      gp = require(fileURLToPath(new URL('../../../shared-core/tools/ground-policy.js', import.meta.url)));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'net_allow unavailable: shared-core not found from this install' }] };
    }
    // Per-project only, scoped by the same walk the install jail uses; the
    // every-project list stays the operator's own road.
    let project = null;
    try { project = gp.projectRoot(cwd); } catch (_) { project = null; }
    project = project || cwd;
    const r = net.addHost(args.host, project);
    if (!r.ok) {
      return { isError: true, content: [{ type: 'text', text: '[troth-bash] refused: ' + r.error }] };
    }
    try {
      if (state && state.archiveToolOutput) {
        state.archiveToolOutput(process.env.CLAUDE_SESSION_ID || null, 'net_allow',
          'net-allow ' + r.host + ' for ' + (r.project || project) + ' — ' + why, 'net-allow ' + r.host);
      }
    } catch (_) { /* best-effort record; the result below is the loud part */ }
    return { content: [{ type: 'text', text:
      '[troth-bash] ' + r.host + ' allowed for installs in ' + (r.project || project)
      + ' (this project alone). Purpose on record: ' + why + '.' }] };
  }
  if (name === 'run_gate') {
    let pub = null, spawnPurpose = null;
    try {
      pub = require(fileURLToPath(new URL('../../../shared-core/tools/publish-gate.js', import.meta.url)));
      spawnPurpose = require(fileURLToPath(new URL('../../../shared-core/tools/spawn-purpose.js', import.meta.url)));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'run_gate unavailable: shared-core not found from this install' }] };
    }
    const wanted = String(args.match || '').trim();
    const entry = pub.loadGuarded().find((g) => g.match === wanted);
    if (!entry) {
      const listed = pub.loadGuarded().map((g) => g.match).join(', ') || '(nothing guarded)';
      return { isError: true, content: [{ type: 'text', text: '[troth-bash] no guarded entry matches "' + wanted + '". Guarded: ' + listed }] };
    }
    const t0 = Date.now();
    const out = await new Promise((resolveGate) => {
      let child;
      try {
        child = spawnPurpose.spawn('release-gate', '/bin/bash', ['-lc', entry.gate],
          { cwd, env: partnerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { return resolveGate({ code: -1, tail: 'spawn failed: ' + (e && e.message || e) }); }
      const buf = makeBoundedBuffer(64 * 1024, 64 * 1024);
      child.stdout.on('data', (c) => buf.push(c.toString('utf8')));
      child.stderr.on('data', (c) => buf.push(c.toString('utf8')));
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 25 * 60 * 1000);
      child.on('exit', (code) => { clearTimeout(timer); resolveGate({ code, tail: buf.get() }); });
      child.on('error', (e) => { clearTimeout(timer); resolveGate({ code: -1, tail: 'spawn error: ' + (e && e.message || e) }); });
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    if (out.code !== 0) {
      return { isError: true, content: [{ type: 'text', text:
        '[troth-bash] gate RED for ' + entry.match + ' (exit ' + out.code + ', ' + secs + 's). Tail:\n'
        + String(out.tail || '').slice(-4000) }] };
    }
    const tree = pub.headTree(cwd);
    if (!tree) {
      return { isError: true, content: [{ type: 'text', text:
        '[troth-bash] gate was green but ' + cwd + ' is not a git repository — run it from the repo the push leaves from, so the pass binds to that tree.' }] };
    }
    const rec = pub.recordPass(entry.match, tree, entry.gate);
    return { content: [{ type: 'text', text:
      '[troth-bash] gate GREEN for ' + entry.match + ' (' + secs + 's) — pass recorded for tree '
      + tree.slice(0, 12) + '. The guarded push proceeds while HEAD stays this tree.'
      + (rec.ok ? '' : ' (pass write failed: ' + rec.error + ')') }] };
  }
  if (name === 'env_set' || name === 'env_keys') {
    if (!envdoor) {
      return { isError: true, content: [{ type: 'text', text: 'env door unavailable: shared-core not found from this install' }] };
    }
    if (name === 'env_keys') {
      const r = envdoor.envKeys({ file: args.file, cwd });
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: 'REFUSED ' + r.error + '. ' + (r.detail || '') }] };
      const names = r.keys.map((k) => k.name + (k.vault_usable ? ' (vault)' : '')).join(', ');
      return { content: [{ type: 'text', text: r.keys.length + ' key(s) in ' + r.file + (r.keys.length ? ': ' + names : '') + (r.vault === 'locked' ? ' — vault locked, vault-usable flags unavailable' : '') }] };
    }
    const r = envdoor.envSet({ file: args.file, entries: args.entries, overwrite: args.overwrite === true, cwd });
    if (!r.ok) {
      return { isError: true, content: [{ type: 'text', text: 'REFUSED ' + r.error + '. ' + (r.detail || '') }] };
    }
    return { content: [{ type: 'text', text: 'wrote ' + r.count + ' key(s) to ' + r.file + ': ' + r.written.join(', ') + (r.from_vault.length ? ' (' + r.from_vault.join(', ') + ' from vault)' : '') }] };
  }
  if (name === 'run') {
    // Two pre-flight gates, and the difference between them is whether an
    // ack can buy a way through.
    //
    // bash-safety is the WALL: irreversible or unbounded acts (raw-disk dd,
    // chmod 777 /, rewriting /etc, a fork bomb) and, via its resolved-path
    // layer, any command that writes to or ships out a protected
    // destination — credentials, the shell rc tree, the agent-host hooks,
    // either MCP registry. There is no correct partner reason to do those,
    // so acknowledge_danger does not reach it. An operator who genuinely
    // means it still has their own shell.
    //
    // danger.js is the SPEED BUMP: destructive but legitimate acts (rm -rf a
    // build dir, git reset --hard, DROP TABLE on a scratch db) where intent
    // is the whole question. Those stay ack-able, exactly as before.
    //
    // The wall was written long before this and was reachable only from
    // permission.js, on the l4_step path that does not ship — so the tool an
    // operator actually drives ran with the speed bump alone.
    if (safety) {
      const verdict = safety.isCommandSafe(args.command || '', {});
      if (!verdict.allowed) {
        return {
          content: [{
            type: 'text',
            text:
              '[troth-bash] REFUSED ' + verdict.reason
              + (verdict.pattern ? ' (' + verdict.pattern + ')' : '') + '. '
              + (verdict.detail || '')
              + (verdict.reason === 'egress_not_allowlisted' || verdict.reason === 'credential_in_command'
                  ? ''
                  : verdict.reason === 'dangerous_pattern'
                    ? ' This shape has no partner road; acknowledge_danger does not override it.'
                    : ' This destination is operator-only by policy; acknowledge_danger does not override it.')
          }],
          isError: true
        };
      }
    }

    // Guarded destinations: a push toward one passes only while a green gate
    // pass covers the exact tree at HEAD. Independent of every judgment
    // below and not ack-able — the road it names (run_gate) is the
    // partner's own hand, never the operator's.
    try {
      const pub = require(fileURLToPath(new URL('../../../shared-core/tools/publish-gate.js', import.meta.url)));
      const pg = pub.preflight(args.command || '', resolveDir(args.cwd) || cwd);
      if (pg && pg.blocked) {
        return { content: [{ type: 'text', text: '[troth-bash] GUARDED: ' + pg.message }], isError: true };
      }
    } catch (_) { /* absent shared-core leaves the shell as it was */ }

    // Operator-freeze gate. An active "don't" in the ledger blocks outward
    // commands (push / upload / notarize) HERE, at the one chokepoint both
    // lanes pass through (native Bash arrives via bash-steer). The freeze is
    // state written by constraint-capture, not a sentence in a window — a
    // freeze that exists only as text in a window is a wall a push can sail
    // straight through. Fail-open on a missing ledger
    // (bare clone), fail-CLOSED on an active freeze: no acknowledge flag
    // overrides the operator's standing word.
    if (constraintLedger) {
      try {
        const cg = constraintLedger.gate(args.command || '');
        if (cg.blocked) {
          return {
            content: [{
              type: 'text',
              text: '[troth-bash] FROZEN — ' + cg.message
            }],
            isError: true
          };
        }
      } catch (_) { /* a broken gate never blocks local work */ }
    }

    // Pre-flight danger check — if the command matches a known
    // destructive pattern AND the caller didn't explicitly ack with
    // acknowledge_danger=true, refuse with an isError + explicit
    // guidance. Cheap safety net below the LoopBreaker / VerifyFirst
    // hooks; those live in the agent loop, this lives in the tool
    // runtime so it catches direct `mcp__troth-bash__run` calls
    // that bypass hooks (e.g. via background agents).
    let caution = null;
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
      // Medium hits (git branch -D, --no-verify, killall…) run without an
      // ack — intent is plausibly legitimate — but their classification
      // travels with the result, so neither the model nor the archive can
      // say nobody knew.
      if (hit) caution = hit.kind + ' (' + hit.severity + '): matched ' + hit.pattern;
    }
    const res = await runCommand(args.command, Math.min(args.timeout_ms || 120000, MAX_CALL_TIMEOUT_MS), args.cwd);
    let combined = res.stdout + (res.stderr ? '\n---\n' + res.stderr : '');
    // Redact BEFORE compression so every downstream consumer — the model,
    // tool_output_archive, the FTS index, the savings label — sees the same
    // masked text. Harvest first: the store is what redact() masks, and the
    // command line itself can carry a secret worth remembering (a token
    // pasted into curl -H). Redaction failure must never break the run.
    if (redactor) {
      try {
        redactor.harvest(args.command || '');
        redactor.harvest(combined);
        combined = redactor.redact(combined);
      } catch (_) { /* fail-open: an unredacted run beats a dead shell — Layer 0 already refuses commands that CARRY credentials */ }
    }
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
          // Estimated tokens (bytes/4) — the ledger's unit, not raw bytes.
          Math.ceil(Math.max(0, comp.originalBytes - comp.compressedBytes) / 4),
          process.env.CLAUDE_SESSION_ID || null,
          'cmd: ' + (redactor ? redactor.redact(args.command || '') : (args.command || '')).slice(0, 80)
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
    if (caution) metaLines.push('caution: ' + caution);
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
// New design: line-by-line via readline; each line enqueued. tools/call
// requests run CONCURRENTLY (bounded): one long-running command must never
// block the requests behind it — a hung ssh or a legitimately long watcher
// at the queue head wedges every later call for its whole timeout, and a
// client that gives up on a call cannot cancel the server-side command, so
// serial draining turns one slow call into a dead lane. Lifecycle messages
// (initialize, tools/list) stay serial. stdin is paused while the queue is
// non-empty so the parent applies natural backpressure.
process.stdin.setEncoding('utf8');
const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
const msgQueue = [];
let draining = false;
// timeout_ms ceiling: without it an orphaned call (client aborted, server
// still running) can hold resources for hours — the cap bounds orphan life.
const MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_CALLS = 8;
let inflightCalls = 0;
let inflightWait = null;

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
    if (msg.method === 'tools/call') {
      while (inflightCalls >= MAX_CONCURRENT_CALLS) {
        await new Promise((r) => { inflightWait = r; });
      }
      inflightCalls++;
      handleUpstream(msg)
        .catch((e) => {
          process.stderr.write('[troth-bash] handler threw: ' + (e && (e.stack || e.message) || e) + '\n');
        })
        .finally(() => {
          inflightCalls--;
          if (inflightWait) { const w = inflightWait; inflightWait = null; w(); }
        });
    } else {
      try {
        await handleUpstream(msg);
      } catch (e) {
        process.stderr.write('[troth-bash] handler threw: ' + (e && (e.stack || e.message) || e) + '\n');
      }
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
        serverInfo: { name: 'troth-bash', version: '1.0.0' },
        // Protocol-level contract for clients that surface it. Short on purpose.
        instructions:
          'Run shell commands through the `run` tool instead of any native ' +
          'bash: output over 4KB is compressed and the raw text archived ' +
          'retrievably, and destructive commands (rm -rf, force-push, DROP) ' +
          'are refused unless explicitly acknowledged. `browse` drives a real ' +
          'Chrome over CDP — do not script your own browser automation around it.'
      });
    } else if (msg.method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      const result = await handleTool(msg.params.name, msg.params.arguments || {});
      reply(_greet(result));
    } else if (msg.method === 'ping') {
      reply({});
    } else {
      reply({});
    }
  } catch (e) { replyError(e); }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
