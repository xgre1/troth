#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-cache — MCP hard-serve for cacheable retrieval tools.
//
// Exposes `cached_read` and `cached_grep`. When the cache is warm (keyed on
// tool+args+cwd+file-content-hash), the server returns the cached output
// without running the underlying command. When cold, it executes the real
// tool (fs.readFileSync for reads, ripgrep/grep for searches), populates
// the cache, and returns the fresh result. The difference vs PostToolUse
// cache-populate.mjs + PreToolUse cache-probe.mjs is HARD short-circuit:
// here the underlying tool literally does not run on a hit.
//
// Scope intentionally narrow for v1:
//   • cached_read  — fs.readFileSync (handles utf8 + lines)
//   • cached_grep  — ripgrep preferred, grep fallback
// Glob and read-only Bash will land once we have observed usage data.
//
// Why an MCP server at all when the plugin hooks already exist?
//   • Hooks do SOFT serve — the tool still runs, we only inject context.
//   • MCP tools are hard-serve: the model calls cached_read, the
//     underlying Read never fires, the tool_result in the next request
//     history is literally our cached bytes. First-order token savings.
//
// Storage: shares the substrate DB at CLAUDE_PLUGIN_DATA/state.db via
// shared-core/state.js + proxy/modules/troth-cache.js. Same cache the
// hooks populate, so hook-warmed entries serve MCP and vice versa.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { homedir } from 'node:os';
import { createHash as createHashNode } from 'node:crypto';

const require = createRequire(import.meta.url);
const _greet = require(fileURLToPath(new URL('../../../shared-core/mcp-greeting.js', import.meta.url))).makeGreeter();
const serverDir = fileURLToPath(new URL('.', import.meta.url));
const gc = require(serverDir + '../../../proxy/modules/troth-cache.js');
// The read wall (Wall 6). A retrieval tool is a read tool: what the shell
// road refuses — key material, credential files, the substrate database — is
// refused here too, or the policy is only a policy on one road. Required
// unconditionally like every other dependency: an install missing the wall
// must fail to start, not start without it.
const pathPolicy = require(serverDir + '../../../shared-core/tools/path-policy.js');

// Verdicts are memoised per absolute path: a search result names the same
// file on every matching line, and the policy resolves symlinks to judge.
const _readable = new Map();
function readVerdict(abs) {
  let v = _readable.get(abs);
  if (v === undefined) {
    try { v = pathPolicy.isReadablePath(abs, {}); }
    catch (_) { v = { allowed: false, reason: 'policy_unavailable' }; }
    if (_readable.size > 4096) _readable.clear();
    _readable.set(abs, v);
  }
  return v;
}
function refusal(v, what) {
  return rpcError(-32602, 'refused: ' + what + ' is not readable (' + v.reason + ')' +
    (v.detail ? ' — ' + v.detail : ''));
}
// Every line of a search result names the file it came from. A file the
// policy refuses is dropped here even when the search root was allowed, so a
// wide search cannot become a credential read by another name.
const _MATCH_LINE_RE = /^(.*?):(\d+):/;
function withheldFiltered(out) {
  if (!out) return out;
  const kept = [];
  let withheld = 0;
  for (const line of String(out).split('\n')) {
    const m = _MATCH_LINE_RE.exec(line);
    if (!m) { kept.push(line); continue; }
    if (readVerdict(resolvePath(m[1])).allowed) kept.push(line);
    else withheld++;
  }
  if (withheld) kept.push('…(' + withheld + ' line(s) withheld: the read policy refuses those files)');
  return kept.join('\n');
}
// Substrate write path. Loaded lazily-ish; if it's missing (e.g. tests),
// instrumentation degrades to a no-op rather than failing the tool call.
let _state = null;
function state() {
  if (_state !== null) return _state;
  try { _state = require(serverDir + '../../../shared-core/state.js'); }
  catch (_) { _state = false; }
  return _state;
}
function sessionId() { return process.env.CLAUDE_SESSION_ID || null; }

// The read LEDGER, not just the call telemetry. A file served by this cache
// was read every bit as much as one served by the Read tool, but only the
// Read hook recorded it — so every "what has been read" answer (the code
// map's prior-reads context, and any future read-before-edit check) was blind
// to cache-served reads and told an incomplete truth. Same record shape as
// mark-read writes, with one improvement this road gets for free: the content
// is in hand, so the hash is real instead of 'unverified'. Telemetry never
// breaks serving.
function recordReadLedger(abs, content) {
  try {
    const s = state();
    if (!s || typeof s.recordAction !== 'function') return;
    const actionRecord = require(serverDir + '../../../shared-core/action-record.js');
    const rec = actionRecord.create({
      type: 'read',
      agent_id: 'claude-code',
      session_id: sessionId(),
      cwd: process.cwd(),
      input: { file_path: abs },
      output: {
        hash: createHashNode('sha256').update(content).digest('hex'),
        line_count: (String(content).match(/\n/g) || []).length + 1,
        bytes: Buffer.byteLength(String(content))
      }
    });
    if (actionRecord.validate(rec).ok) s.recordAction(rec, actionRecord.toSearchText(rec));
  } catch (_) { /* the ledger is telemetry; the read must serve regardless */ }
}
function recordCall(tool, hit, bytes, latencyMs, errMsg) {
  const s = state();
  if (!s || typeof s.recordMcpToolCall !== 'function') return;
  try {
    s.recordMcpToolCall({
      tool,
      cache_hit: !!hit,
      bytes: bytes | 0,
      latency_ms: latencyMs | 0,
      error_message: errMsg || null,
      session_id: sessionId()
    });
    // Hits are real token savings — also push to the unified ledger so the
    // analytics overview's "tokens_saved_by_kind" includes MCP cache hits
    // alongside proxy gemcache:hit. ~4 bytes/token rough approximation.
    if (hit && bytes > 0 && typeof s.recordSavings === 'function') {
      s.recordSavings('mcp_cache:hit', Math.ceil(bytes / 4), sessionId(), tool);
    }
  } catch (_) { /* telemetry must never break the tool */ }
}

const SERVER_NAME    = 'troth-cache';
const SERVER_VERSION = '0.1.0';

// Per-tool on/off via ~/.troth/config.json → mcp.{cached_read,cached_grep}.
// Read per-call so dashboard toggles apply without MCP restart. Default: on.
const CONFIG_PATH = joinPath(homedir(), '.troth', 'config.json');
function toolEnabled(name) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!cfg || !cfg.mcp || typeof cfg.mcp !== 'object') return true;
    return cfg.mcp[name] !== false;
  } catch (_) { return true; }
}

// Singleton cache handle, shared with the hooks + proxy.
const cache = gc.getDefault();

// ── MCP tool definitions ──────────────────────────────────────────────────
// Descriptions are prompt engineering — the model sees these when deciding
// which tool to call. We explicitly call out equivalence with Read/Grep so
// an agent that knows "Read" knows it can reach for cached_read.

const TOOLS = [
  {
    name: 'cached_read',
    description: 'USE INSTEAD OF Read. Drop-in replacement, content-hash-keyed cache; 0 backend tokens on hit, identical correctness.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or cwd-relative path' },
        cwd:       { type: 'string', description: 'Working directory for relative paths' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'cached_grep',
    description: 'USE INSTEAD OF Grep. Drop-in replacement; cross-turn memoized; 0 backend tokens on hit.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path:    { type: 'string', description: 'Directory to search (defaults to cwd)' },
        glob:    { type: 'string', description: 'Optional file-glob filter' },
        cwd:     { type: 'string' }
      },
      required: ['pattern']
    }
  }
];

// ── Tool implementations ──────────────────────────────────────────────────

function resolveCwd(args) {
  return (args && args.cwd) || process.cwd();
}

function doCachedRead(args) {
  const cwd = resolveCwd(args);
  const rel = args.file_path;
  if (!rel) return rpcError(-32602, 'missing file_path');
  const abs = resolvePath(cwd, rel);
  // Judged before the file is touched, before the cache is consulted, and
  // before existence is confirmed: a refusal must not report whether a
  // credential file is there.
  const v = readVerdict(abs);
  if (!v.allowed) return refusal(v, abs);

  if (!existsSync(abs)) return rpcError(-32602, 'file not found: ' + abs);
  const st = statSync(abs);
  if (!st.isFile()) return rpcError(-32602, 'not a regular file: ' + abs);

  // Compute cache key against CURRENT file content hash, so an edit to the
  // file since last read produces a new key and misses.
  const file_hashes = gc.hashReferencedFiles([abs]);
  if (file_hashes.some(h => h === null)) return rpcError(-32603, 'file unreadable: ' + abs);

  const cacheInput = { tool_name: 'Read', args: { file_path: abs }, cwd, file_hashes };
  const r = cache.lookup(cacheInput);
  if (r.hit) {
    const cachedContent = typeof r.value === 'string' ? r.value : r.value.content;
    recordReadLedger(abs, cachedContent);   // a hit is still a read
    return wrapContent({
      cached: true,
      key_prefix: r.key.slice(0, 8),
      content: cachedContent,
      source: 'troth-cache',
    });
  }

  // Cold — read for real, populate, return.
  const content = readFileSync(abs, 'utf8');
  const key = gc.computeKey(cacheInput);
  cache.store({ key, tool_name: 'Read', cwd, value: content });
  recordReadLedger(abs, content);
  return wrapContent({
    cached: false,
    key_prefix: key.slice(0, 8),
    content,
    source: 'fs',
  });
}

function doCachedGrep(args) {
  const pattern = args && args.pattern;
  if (!pattern) return rpcError(-32602, 'missing pattern');
  const cwd = resolveCwd(args);
  const searchPath = args.path ? resolvePath(cwd, args.path) : cwd;
  // A search is a read of every file it matches. The root is judged here;
  // each matching file is judged again on the way out, because a permitted
  // root can still contain a credential file.
  const rootV = readVerdict(searchPath);
  if (!rootV.allowed) return refusal(rootV, searchPath);

  // For grep, we do NOT hash every file in the tree — too expensive. Rely
  // on TTL (30 min per design §4). Key includes pattern+path+glob.
  const cacheInput = {
    tool_name: 'Grep',
    args: { pattern, path: searchPath, glob: args.glob || null },
    cwd,
    file_hashes: []
  };
  const r = cache.lookup(cacheInput);
  if (r.hit) {
    return wrapContent({
      cached: true,
      key_prefix: r.key.slice(0, 8),
      // Filtered on the way out as well as on the way in: an entry stored
      // before the wall stood must not serve past it now.
      output: withheldFiltered(typeof r.value === 'string' ? r.value : (r.value.output || '')),
      source: 'troth-cache',
    });
  }

  // Cold — shell out. Prefer ripgrep (Claude Code bundles it OFF-PATH, so a
  // fresh user machine often lacks `rg`); fall back to system grep with an
  // EXPLICIT semantics note (BRE regex, no .gitignore filtering) instead of
  // silently swapping dialects. Exit 1 from either tool is the LEGITIMATE
  // "no matches" result, not a failure (portability audit  #4:
  // every zero-match search returned rpcError, and a no-match rg run fell
  // through to a redundant system-grep scan). Hard cap output to 512 KB so
  // we don't pathologically cache huge dumps.
  let output = '';
  let source = 'ripgrep';
  let res = runSearch('rg', rgArgs(pattern, searchPath, args.glob));
  if (res.missing) {
    source = 'grep (ripgrep unavailable — BRE regex, no .gitignore filtering)';
    res = runSearch('grep', grepArgs(pattern, searchPath, args.glob));
    if (res.missing) return rpcError(-32603, 'neither ripgrep nor grep is available on PATH');
  }
  if (res.error) return rpcError(-32603, 'search failed (exit ' + res.status + '): ' + res.error.trim().slice(0, 400));
  output = withheldFiltered(res.output);
  if (output.length > 512 * 1024) output = output.slice(0, 512 * 1024) + '\n…(truncated at 512 KB)';

  const key = gc.computeKey(cacheInput);
  cache.store({ key, tool_name: 'Grep', cwd, value: { output } });
  return wrapContent({
    cached: false,
    key_prefix: key.slice(0, 8),
    output,
    matches: output.length > 0,
    source,
  });
}

function rgArgs(pattern, searchPath, glob) {
  const a = ['--no-heading', '--line-number', '--color', 'never'];
  if (glob) a.push('--glob', glob);
  a.push('--', pattern, searchPath);
  return a;
}

function grepArgs(pattern, searchPath, glob) {
  const a = ['-rn'];
  if (glob) a.push('--include=' + glob);
  a.push('-e', pattern, searchPath);
  return a;
}

// Run a search binary. Exit 0 = matches, exit 1 = ZERO matches (a valid,
// cacheable empty result for both rg and grep), ENOENT = binary absent
// (caller falls back explicitly), exit >= 2 = real failure (bad pattern /
// unreadable path) surfaced with the tool's stderr — NOT silently retried
// under a different regex dialect.
function runSearch(bin, args) {
  try {
    return { output: execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true };
    if (e && e.status === 1) return { output: typeof e.stdout === 'string' ? e.stdout : '' };
    return { error: (e && (e.stderr || e.message)) || String(e), status: e && e.status };
  }
}

function wrapContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// Time a tool call and record telemetry. Looks at the wrapped result to
// infer cache_hit + bytes (we control the response shape via wrapContent
// so this is a stable contract). Errors are recorded with a non-empty
// error_message and cache_hit=false.
function instrument(toolName, fn) {
  const t0 = Date.now();
  let result, errMsg = null;
  try { result = fn(); }
  catch (e) {
    errMsg = (e && e.message) || String(e);
    recordCall(toolName, false, 0, Date.now() - t0, errMsg);
    throw e;
  }
  const latency = Date.now() - t0;
  // RPC error path: result.__error is set by rpcError().
  if (result && result.__error) {
    recordCall(toolName, false, 0, latency, result.__error.message || 'rpc_error');
    return result;
  }
  // Happy path: parse the JSON we just stringified to read cached + payload size.
  let hit = false, bytes = 0;
  try {
    const text = result && result.content && result.content[0] && result.content[0].text;
    if (text) {
      const parsed = JSON.parse(text);
      hit = !!parsed.cached;
      bytes = (parsed.content || parsed.output || '').length;
    }
  } catch (_) {}
  recordCall(toolName, hit, bytes, latency, null);
  return result;
}

function rpcError(code, message, data) {
  return { __error: { code, message, data } };
}

// ── JSON-RPC handlers ─────────────────────────────────────────────────────

async function handleMethod(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities:    { tools: {} },
      serverInfo:      { name: SERVER_NAME, version: SERVER_VERSION },
      // Protocol-level contract for clients that surface it. Short on purpose.
      instructions:
        'Prefer cached_read over Read and cached_grep over Grep when content ' +
        'may be retrieved again this session or later: hits cost zero backend ' +
        'tokens, misses fall through to a real read and populate the cache, ' +
        'and every cached_read is recorded in the substrate\'s read ledger ' +
        'exactly like a native Read.'
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') {
    // Hide disabled tools from the listing so the model doesn't see them
    // at all. This is the primary way a user disables a tool — by making
    // it not appear in Claude Code's tool catalog.
    return { tools: TOOLS.filter(t => toolEnabled(t.name)) };
  }
  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args     = (params && params.arguments) || {};
    // Defensive: if somehow invoked while disabled, surface a clear error.
    if (!toolEnabled(toolName)) {
      recordCall(toolName, false, 0, 0, 'tool_disabled');
      return rpcError(-32601, 'tool disabled in troth config: ' + toolName);
    }
    if (toolName === 'cached_read') return _greet(instrument(toolName, () => doCachedRead(args)));
    if (toolName === 'cached_grep') return _greet(instrument(toolName, () => doCachedGrep(args)));
    recordCall(toolName, false, 0, 0, 'unknown_tool');
    return rpcError(-32601, 'unknown tool: ' + toolName);
  }
  return rpcError(-32601, 'method not found: ' + method);
}

// ── stdio loop (lifted from troth-memory for protocol consistency) ─────

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  inputBuffer += chunk;
  let idx;
  while ((idx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, idx);
    inputBuffer = inputBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    await respond(msg);
  }
});

async function respond(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const send = (payload) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }) + '\n');
  };
  try {
    const out = await handleMethod(msg.method, msg.params);
    if (out && out.__error) send({ error: out.__error });
    else send({ result: out });
  } catch (e) {
    send({ error: { code: -32603, message: String(e && e.message || e) } });
  }
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
