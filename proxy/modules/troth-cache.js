// SPDX-License-Identifier: AGPL-3.0-only
// troth Cache — proxy-side, backend-agnostic semantic tool-output cache.
//
//
// What this is
// ────────────
// A SQLite-backed cache that short-circuits idempotent retrieval tool calls
// (Read, Grep, Glob, safe Bash, Web*) before they reach the backend. Keys
// are derived from (tool_name + canonical args + cwd + hashes of every
// referenced file's current content), so the cache self-invalidates the
// instant any referenced file changes — no TTL needed for correctness on
// that axis. TTL is the safety net for everything else (WebFetch, LS, …).
//
// Why it exists
// ─────────────
// Open-source backends (Ollama, llama.cpp, MLX) have no prefix cache reuse
// between requests — empirically confirmed: three identical-prefix calls
// against Ollama all show identical prompt_eval_count. Anthropic has a 5-
// minute ephemeral cache, but any cosmetic drift above a tool_result block
// invalidates it. A cache that lives IN the proxy, keyed on agent-semantic
// content, hits for both flavours.
//
// What it is not
// ──────────────
//   • Not a prompt/prefix cache — that's cachestable.js (shipped).
//   • Not KV-reuse — impossible without backend cooperation (confirmed
//     by Research #1).
//   • Not an HTTP-hash cache like LiteLLM's — ours is agent-aware.
//
// Public API (design §12)
// ───────────────────────
//   lookup({ tool_name, args, cwd, file_hashes }) → { hit, value?, reason, key }
//   store({ key, tool_name, cwd, value, ttl_s })    → boolean
//   invalidate({ file_path?, cwd?, bulk_pattern? }) → number (rows affected)
//   acquireWriteLock(key)                           → boolean
//   releaseWriteLock(key)                           → boolean
//   hasWriteLock(key)                               → boolean
//   stats()                                         → { hits, misses, entries, … }
//   computeKey({ tool_name, args, cwd, file_hashes })
//
// Construction
// ────────────
// Default: createCache() uses the shared shared-core/state.js SQLite handle.
// For tests: createCache({ db: new Database(':memory:') }) or
//            createCache({ dbPath: '/tmp/something.db' }).
//
// Concurrency
// ───────────
// SQLite's single-writer + INSERT OR IGNORE gives us race-free stampede
// protection without Redis (design §6). The proxy layer is the only
// writer on a single machine.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { canonicalStringify } = require('./cachestable');
// Telemetry: emit savings_ledger rows so the dashboard can show
// populate/hit/invalidate volume over time. Optional: a missing
// state module (e.g. in standalone test runs with a fake db) is not
// fatal. Resolved once and cached.
let _state = null;
let _stateResolveTried = false;
function resolveState() {
  if (_stateResolveTried) return _state;
  _stateResolveTried = true;
  try { _state = require('../../shared-core/state'); } catch (_) { _state = null; }
  return _state;
}

// ── Tool policy ────────────────────────────────────────────────────────────

// TTL per tool (seconds). Values from design §4.
const TTL_BY_TOOL = {
  LS: 5 * 60,
  list_files: 5 * 60,
  Glob: 5 * 60,
  Read: 10 * 60,
  Grep: 30 * 60,
  grep_search: 30 * 60,
  Bash: 60,
  WebSearch: 90 * 60,
  WebFetch: 90 * 60,
  _default: 5 * 60,
};

// Tools that mutate state and must NEVER be cached (design §14).
const UNCACHEABLE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Bash commands we'll cache. Allow-list is safer than deny-list: anything
// not on the list is skipped. Matches the first token(s) of the command.
// Shell meta-characters disqualify in all cases (see isBashCacheable).
const BASH_READONLY_ALLOW = [
  /^\s*ls(\s|$)/,
  /^\s*pwd(\s|$)/,
  /^\s*cat\s/,
  /^\s*head\s/,
  /^\s*tail\s/,
  /^\s*wc\s/,
  /^\s*find\s/,
  /^\s*file\s/,
  /^\s*stat\s/,
  /^\s*du(\s|$)/,
  /^\s*df(\s|$)/,
  /^\s*which\s/,
  /^\s*whereis\s/,
  /^\s*ps(\s|$)/,
  /^\s*uname(\s|$)/,
  /^\s*git\s+(status|log|diff|show|branch|blame|ls-files|ls-tree|rev-parse|config\s+--get)\b/,
  /^\s*node\s+(-v|--version)/,
  /^\s*npm\s+(ls|list|view|outdated)/,
  /^\s*python3?\s+(--version|-V)/,
];

function isBashCacheable(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  // Any shell meta-char: give up. Pipelines / subshells / redirects /
  // command substitution can all be side-effecting.
  if (/[|;&<>`$()]/.test(cmd)) return false;
  for (let i = 0; i < BASH_READONLY_ALLOW.length; i++) {
    if (BASH_READONLY_ALLOW[i].test(cmd)) return true;
  }
  return false;
}

function isCacheable(tool_name, args) {
  if (!tool_name) return false;
  if (UNCACHEABLE_TOOLS.has(tool_name)) return false;
  if (tool_name === 'Bash') {
    const cmd = (args && (args.command || args.cmd)) || '';
    return isBashCacheable(cmd);
  }
  return true;
}

function ttlFor(tool_name) {
  return TTL_BY_TOOL[tool_name] || TTL_BY_TOOL._default;
}

// ── Key computation (design §2) ────────────────────────────────────────────

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function cwdHash(cwd) {
  return sha256Hex(String(cwd || '')).slice(0, 16);
}

// Path-bearing arg fields. When these appear in a tool's args, we resolve
// them to absolute paths before hashing so that "foo.js" (relative) and
// "/abs/foo.js" (absolute) key identically. Without this normalization, a
// PostToolUse hook that sees the raw payload ("foo.js") and an MCP server
// that resolves to absolute before storing would write to different keys
// and the intended cross-callsite sharing would silently fail.
const PATH_ARG_FIELDS = ['file_path', 'path', 'notebook_path'];

function canonicalizeArgsForKey(args, cwd) {
  if (!args || typeof args !== 'object') return args;
  // Shallow clone and resolve any path field.
  const out = {};
  const base = cwd || process.cwd();
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (PATH_ARG_FIELDS.indexOf(k) !== -1 && typeof v === 'string' && v.length > 0) {
      out[k] = path.isAbsolute(v) ? v : path.resolve(base, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// key = sha256( JCS(tool + canonicalized_args) + cwd_hash + sha256(sorted file hashes) )
// Path fields in args are resolved to absolute before hashing so every call
// site (proxy, hook, MCP server) produces the same key for the same logical
// retrieval. file_hashes is an array of content hashes for every file path
// referenced by the tool args — caller is responsible for producing it via
// hashReferencedFiles(). Sorting makes order-of-args in MultiEdit-style
// tools irrelevant.
function computeKey({ tool_name, args, cwd, file_hashes }) {
  const canonArgs = canonicalizeArgsForKey(args, cwd);
  const toolCanon = canonicalStringify({ tool: tool_name || '', args: canonArgs || {} });
  const cwdH = cwdHash(cwd);
  const hashes = Array.isArray(file_hashes) ? file_hashes.slice().sort().join('|') : '';
  const fileH = sha256Hex(hashes);
  return sha256Hex(toolCanon + '|' + cwdH + '|' + fileH);
}

// ── Bulk-invalidation detection (design §5) ────────────────────────────────
// Scans a Bash command for patterns that imply many cached entries are
// now stale. Returns one of:
//   'all_cwd'  — git checkout/pull/rebase/merge/reset: whole workspace purge
//   'package'  — npm/pip/cargo/yarn/pnpm install: Read/Glob purge only
//   null       — not a bulk trigger
//
// Intentionally conservative: anything ambiguous returns null (over-serve
// is less wrong than over-invalidate). The real correctness net is the
// file-hash in the cache key — an Edit that mutates a file will already
// produce a different key on next lookup.
function detectBashBulkInvalidation(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const c = cmd.trim();
  if (/^git\s+(checkout|pull|rebase|merge|reset|stash\s+pop|switch)\b/.test(c)) return 'all_cwd';
  if (/^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|rm|uninstall|update|upgrade)\b/.test(c)) return 'package';
  if (/^(pip|pip3)\s+(install|uninstall|upgrade)\b/.test(c)) return 'package';
  if (/^cargo\s+(build|install|update|add|remove)\b/.test(c)) return 'package';
  if (/^go\s+(get|mod\s+tidy|install|build)\b/.test(c)) return 'package';
  return null;
}

// ── Referenced-file extraction ─────────────────────────────────────────────
// For file-hash invalidation (design §2) we need the content hashes of every
// file the tool args name. Different tools name files in different shapes:
//
//   Read({ file_path })             → [file_path]
//   Write/Edit/MultiEdit/NotebookEdit — not cacheable, skip.
//   Grep({ path, glob })            → [] (searches many files; rely on TTL)
//   Glob({ path, pattern })         → [] (same)
//   LS({ path })                    → [] (directory listing, rely on TTL)
//   Bash({ command })               → [] (unpredictable, rely on TTL)
//   WebFetch/WebSearch              → [] (no local files)
//
// If cwd is provided, relative paths are resolved against it. Returns a
// plain array of absolute path strings (may be empty).
function referencedFiles(tool_name, args, cwd) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  const push = (p) => {
    if (!p || typeof p !== 'string') return;
    out.push(path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p));
  };
  switch (tool_name) {
    case 'Read':
      push(args.file_path || args.path);
      break;
    case 'NotebookRead':
      push(args.notebook_path || args.path);
      break;
    // Other tools don't name a specific file pre-execution.
    default:
      break;
  }
  return out;
}

// Files a mutation tool TOUCHES — used by invalidation, not keying. Distinct
// from referencedFiles() which is for read-tool cache keys only.
function mutatedFiles(tool_name, args, cwd) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  const push = (p) => {
    if (!p || typeof p !== 'string') return;
    out.push(path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p));
  };
  switch (tool_name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      push(args.file_path || args.path);
      break;
    case 'NotebookEdit':
      push(args.notebook_path || args.path);
      break;
    default:
      break;
  }
  return out;
}

// Resolve referenced files to content hashes. Reads fresh from disk every
// call — we deliberately do NOT share hotcache.js's in-memory Map, because
// that map only self-updates through fs.watch (which may not fire reliably
// across network volumes or inside test harnesses that bypass init). A
// stale hash here would let the cache serve content that no longer matches
// disk, which is exactly the correctness property we're trying to buy.
//
// Cost is a stat + SHA-256 per lookup: micro-milliseconds compared to the
// backend roundtrip we're trying to avoid.
//
// Returns an array of hashes parallel to paths. Any unreadable file yields
// null — callers should treat 'any null' as "cannot cache" so we don't key
// against ghost content.
function hashReferencedFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const out = new Array(paths.length);
  for (let i = 0; i < paths.length; i++) {
    try {
      const content = fs.readFileSync(paths[i]);
      out[i] = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    } catch (_) {
      out[i] = null;
    }
  }
  return out;
}

// ── Schema (design §3) ─────────────────────────────────────────────────────

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tool_response_cache (
      key            TEXT PRIMARY KEY,
      tool_name      TEXT NOT NULL,
      cwd_hash       TEXT NOT NULL,
      payload        BLOB NOT NULL,
      bytes          INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      hit_count      INTEGER NOT NULL DEFAULT 0,
      last_hit_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_trc_expires ON tool_response_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_trc_cwd     ON tool_response_cache(cwd_hash);
    CREATE INDEX IF NOT EXISTS idx_trc_tool    ON tool_response_cache(tool_name);

    CREATE TABLE IF NOT EXISTS tool_cache_dirty (
      key            TEXT PRIMARY KEY,
      invalidated_at INTEGER NOT NULL
    );
  `);
}

// ── Instance factory ───────────────────────────────────────────────────────

// How long a non-pending dirty marker remains authoritative. After this
// window the next lookup/store auto-clears it, so a stale marker can't
// block the cache forever. Design §5: "in-flight write that finishes
// during the dirty window sees the marker and aborts."
const DIRTY_WINDOW_MS = 30 * 1000;

// Pending-write lock TTL. If a holder crashes without releasing, this is
// the longest we'll block competing writers. Design §6: max 10 s total
// poll for stampede.
const PENDING_LOCK_TTL_MS = 15 * 1000;

function createCache(opts) {
  opts = opts || {};
  let dbHandle;
  let ownsHandle = false;
  let telemetryEnabled;
  if (opts.db) {
    dbHandle = opts.db;
    telemetryEnabled = opts.telemetry === true;  // off unless explicit
  } else if (opts.dbPath) {
    dbHandle = new Database(opts.dbPath);
    dbHandle.pragma('journal_mode = WAL');
    ownsHandle = true;
    telemetryEnabled = opts.telemetry !== false;  // on by default
  } else {
    // Reuse the shared substrate DB so everything lives in one file.
    const state = require('../../shared-core/state');
    dbHandle = state.db();
    telemetryEnabled = opts.telemetry !== false;
  }
  migrate(dbHandle);

  const counters = { hits: 0, misses: 0, bytes_written: 0, evictions: 0, bypasses: 0 };

  // Telemetry helper. Writes to savings_ledger so the dashboard can plot
  // cache activity over time. Failures are swallowed — telemetry must
  // never break a cache operation.
  function emit(kind, tokens, note) {
    if (!telemetryEnabled) return;
    const s = resolveState();
    if (!s || typeof s.recordSavings !== 'function') return;
    try { s.recordSavings(kind, tokens | 0, null, note || null); } catch (_) {}
  }

  const sel = {
    dirty:   dbHandle.prepare('SELECT invalidated_at FROM tool_cache_dirty WHERE key = ?'),
    get:     dbHandle.prepare('SELECT payload, expires_at, tool_name FROM tool_response_cache WHERE key = ?'),
    bump:    dbHandle.prepare('UPDATE tool_response_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE key = ?'),
    delKey:  dbHandle.prepare('DELETE FROM tool_response_cache WHERE key = ?'),
    delDirty:dbHandle.prepare('DELETE FROM tool_cache_dirty WHERE key = ?'),
    upsert:  dbHandle.prepare(`
      INSERT OR REPLACE INTO tool_response_cache
      (key, tool_name, cwd_hash, payload, bytes, created_at, expires_at, hit_count, last_hit_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
    `),
    markDirty: dbHandle.prepare(`
      INSERT OR REPLACE INTO tool_cache_dirty (key, invalidated_at) VALUES (?, ?)
    `),
    lockTry: dbHandle.prepare(`
      INSERT OR IGNORE INTO tool_cache_dirty (key, invalidated_at) VALUES (?, ?)
    `),
    count:   dbHandle.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS total_bytes FROM tool_response_cache'),
    purgeCwd: dbHandle.prepare('DELETE FROM tool_response_cache WHERE cwd_hash = ?'),
    purgeCwdTools: dbHandle.prepare(`
      DELETE FROM tool_response_cache
      WHERE cwd_hash = ? AND tool_name IN ('Read','Grep','grep_search','Glob','LS','list_files')
    `),
    sweepExpired: dbHandle.prepare('DELETE FROM tool_response_cache WHERE expires_at <= ?'),
  };

  // Resolve a possibly-stale dirty marker. Returns true if the marker is
  // still authoritative, false (and deletes it) if it has expired.
  function isDirtyActive(key) {
    const row = sel.dirty.get(key);
    if (!row) return false;
    const isPending = key.indexOf('pending:') === 0;
    const ttl = isPending ? PENDING_LOCK_TTL_MS : DIRTY_WINDOW_MS;
    if (Date.now() - row.invalidated_at > ttl) {
      sel.delDirty.run(key);
      return false;
    }
    return true;
  }

  function lookup({ tool_name, args, cwd, file_hashes }) {
    if (!isCacheable(tool_name, args)) {
      counters.bypasses++;
      return { hit: false, reason: 'uncacheable_tool' };
    }
    const key = computeKey({ tool_name, args, cwd, file_hashes });

    // Dirty-marker guard (design §5).
    if (isDirtyActive(key)) {
      counters.misses++;
      return { hit: false, reason: 'dirty_marker', key };
    }

    const row = sel.get.get(key);
    if (!row) {
      counters.misses++;
      return { hit: false, reason: 'not_found', key };
    }
    if (row.expires_at <= Date.now()) {
      sel.delKey.run(key);
      counters.misses++;
      counters.evictions++;
      return { hit: false, reason: 'expired', key };
    }
    sel.bump.run(Date.now(), key);
    counters.hits++;
    let value;
    try { value = JSON.parse(row.payload.toString('utf8')); }
    catch (e) { value = null; }
    // Telemetry: 1 cached byte ≈ 0.25 tokens for JSON tool_results (rough
    // heuristic matching the proxy's Buffer.byteLength/4 estimator).
    emit('gemcache:hit', Math.ceil((row.payload ? row.payload.length : 0) / 4), tool_name);
    return { hit: true, value, key };
  }

  function store({ key, tool_name, cwd, value, ttl_s }) {
    if (!key || !tool_name) return false;
    if (!isCacheable(tool_name)) return false;
    // Cache-resurrection guard (design §5): abort writes that finish inside
    // a dirty window.
    if (isDirtyActive(key)) return false;

    const ttl = (typeof ttl_s === 'number' && ttl_s > 0) ? ttl_s : ttlFor(tool_name);
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const bytes = payload.length;

    sel.upsert.run(key, tool_name, cwdHash(cwd), payload, bytes, now, now + ttl * 1000);
    counters.bytes_written += bytes;
    emit('gemcache:populate', Math.ceil(bytes / 4), tool_name);
    return true;
  }

  function invalidate(opts) {
    opts = opts || {};
    let affected = 0;
    const now = Date.now();

    // Bulk cwd purge (e.g. git checkout) — design §5.
    if (opts.cwd && (opts.bulk_pattern === 'git' || opts.bulk_pattern === 'all_cwd')) {
      const h = cwdHash(opts.cwd);
      affected += sel.purgeCwd.run(h).changes;
    } else if (opts.cwd && opts.bulk_pattern === 'package') {
      // Package-install purge: Read/Glob only (per design).
      const h = cwdHash(opts.cwd);
      affected += sel.purgeCwdTools.run(h).changes;
    } else if (opts.cwd && !opts.file_path) {
      // Bare cwd invalidation — full purge for that workspace.
      const h = cwdHash(opts.cwd);
      affected += sel.purgeCwd.run(h).changes;
    }

    // File-path invalidation: design §5 says "invalidate cached entries
    // whose referenced_file_hashes included that file path". Since we
    // don't store the raw paths, we over-invalidate the cwd's read-class
    // tools. Correctness > efficiency for v1.
    if (opts.file_path) {
      if (opts.cwd) {
        const h = cwdHash(opts.cwd);
        affected += sel.purgeCwdTools.run(h).changes;
      }
      // Also leave a dirty marker at a file-path-derived key so any
      // in-flight store() for this file aborts.
      const fileKey = 'file:' + sha256Hex(opts.file_path);
      sel.markDirty.run(fileKey, now);
    }

    counters.evictions += affected;
    if (affected > 0) emit('gemcache:invalidate', 0, opts.bulk_pattern || (opts.file_path ? 'file' : 'cwd'));
    return affected;
  }

  // Acquire a stampede lock (design §6). INSERT OR IGNORE gives us atomic
  // test-and-set. Returns true iff THIS caller got the lock.
  function acquireWriteLock(key) {
    if (!key) return false;
    const pending = 'pending:' + key;
    // Auto-clear stale pending locks (crashed holders).
    isDirtyActive(pending);
    const info = sel.lockTry.run(pending, Date.now());
    return info.changes === 1;
  }

  function releaseWriteLock(key) {
    if (!key) return false;
    const pending = 'pending:' + key;
    return sel.delDirty.run(pending).changes > 0;
  }

  function hasWriteLock(key) {
    if (!key) return false;
    return isDirtyActive('pending:' + key);
  }

  function stats() {
    const row = sel.count.get();
    return {
      hits: counters.hits,
      misses: counters.misses,
      bypasses: counters.bypasses,
      evictions: counters.evictions,
      bytes_written: counters.bytes_written,
      entries: row.n,
      total_bytes: row.total_bytes,
      hit_rate: (counters.hits + counters.misses) > 0
        ? counters.hits / (counters.hits + counters.misses)
        : 0,
    };
  }

  // Maintenance: drop expired rows. Safe to call periodically.
  function sweepExpired() {
    const info = sel.sweepExpired.run(Date.now());
    counters.evictions += info.changes;
    return info.changes;
  }

  function close() {
    if (ownsHandle && dbHandle && dbHandle.open) {
      try { dbHandle.close(); } catch (_) {}
    }
  }

  // ── INVALIDATE path (Phase C) ────────────────────────────────────────────
  // Walk the message history and, for every mutation tool_use (Edit/Write/
  // MultiEdit/NotebookEdit, plus Bash commands matching bulk triggers),
  // purge affected cache entries. Called BEFORE populateFromRequestBody()
  // so stale entries can't survive a turn that modified their source.
  //
  // Dedupes within one call: multiple Edits on the same file invalidate
  // that file's entries exactly once.
  //
  // Returns { mutations, bulk, evicted } for logging.
  function invalidateFromRequestBody(body, opts) {
    opts = opts || {};
    const cwd = opts.cwd || process.cwd();
    const outcome = { mutations: 0, bulk: 0, evicted: 0 };
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return outcome;

    const seenFiles = new Set();
    let didCwdPurge = false;
    let didPackagePurge = false;

    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i];
      if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;

      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j];
        if (!b || b.type !== 'tool_use' || !b.name) continue;

        // File-level mutations.
        if (UNCACHEABLE_TOOLS.has(b.name)) {
          const files = mutatedFiles(b.name, b.input || {}, cwd);
          for (const f of files) {
            if (seenFiles.has(f)) continue;
            seenFiles.add(f);
            outcome.mutations++;
            outcome.evicted += invalidate({ cwd, file_path: f });
          }
        }

        // Bulk triggers via Bash.
        if (b.name === 'Bash') {
          const cmd = (b.input && (b.input.command || b.input.cmd)) || '';
          const scope = detectBashBulkInvalidation(cmd);
          if (scope === 'all_cwd' && !didCwdPurge) {
            didCwdPurge = true;
            outcome.bulk++;
            outcome.evicted += invalidate({ cwd, bulk_pattern: 'all_cwd' });
          } else if (scope === 'package' && !didPackagePurge) {
            didPackagePurge = true;
            outcome.bulk++;
            outcome.evicted += invalidate({ cwd, bulk_pattern: 'package' });
          }
        }
      }
    }
    return outcome;
  }

  // ── POPULATE path (Phase B) ──────────────────────────────────────────────
  // Given a parsed Anthropic-shape request body, walk the message history
  // looking for assistant tool_use blocks immediately followed by user
  // tool_result blocks. Each matching pair becomes a cache entry if the
  // tool is cacheable and the tool_result is not an error.
  //
  // Returns { scanned, stored, skipped } for logging.
  //
  // Safe to call on malformed bodies — never throws.
  function populateFromRequestBody(body, opts) {
    opts = opts || {};
    const cwd = opts.cwd || process.cwd();
    const outcome = { scanned: 0, stored: 0, skipped: 0 };
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return outcome;

    // Build a map from tool_use id → { name, input, asstIdx, blockIdx }.
    const pending = new Map();
    const msgs = body.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || !Array.isArray(m.content)) continue;

      if (m.role === 'assistant') {
        for (let j = 0; j < m.content.length; j++) {
          const b = m.content[j];
          if (b && b.type === 'tool_use' && b.id && b.name) {
            pending.set(b.id, { name: b.name, input: b.input || {} });
          }
        }
      } else if (m.role === 'user') {
        for (let j = 0; j < m.content.length; j++) {
          const b = m.content[j];
          if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
          const use = pending.get(b.tool_use_id);
          if (!use) continue;
          pending.delete(b.tool_use_id);
          outcome.scanned++;

          if (!isCacheable(use.name, use.input)) { outcome.skipped++; continue; }
          if (b.is_error) { outcome.skipped++; continue; }

          // file_hashes: hash each named file's current content. If any
          // referenced file is unreadable, we skip caching (null hash
          // would poison the key).
          const paths = referencedFiles(use.name, use.input, cwd);
          const hashes = hashReferencedFiles(paths);
          if (hashes.some(h => h === null)) { outcome.skipped++; continue; }

          const key = computeKey({
            tool_name: use.name, args: use.input, cwd, file_hashes: hashes
          });
          const ok = store({ key, tool_name: use.name, cwd, value: b.content, ttl_s: ttlFor(use.name) });
          if (ok) outcome.stored++; else outcome.skipped++;
        }
      }
    }
    return outcome;
  }

  // Test-only helpers (prefixed _).
  function _clearAll() {
    dbHandle.exec('DELETE FROM tool_response_cache; DELETE FROM tool_cache_dirty;');
    counters.hits = 0;
    counters.misses = 0;
    counters.bypasses = 0;
    counters.evictions = 0;
    counters.bytes_written = 0;
  }

  return {
    lookup,
    store,
    invalidate,
    acquireWriteLock,
    releaseWriteLock,
    hasWriteLock,
    stats,
    sweepExpired,
    close,
    computeKey,
    populateFromRequestBody,
    invalidateFromRequestBody,
    _db: dbHandle,
    _clearAll,
  };
}

// ── Singleton for the proxy ───────────────────────────────────────────────
// proxy/server.js calls getDefault() once on startup. Tests create
// isolated instances via createCache({ db: ':memory:' }).
let _singleton = null;
function getDefault() {
  if (!_singleton) _singleton = createCache();
  return _singleton;
}

module.exports = {
  createCache,
  getDefault,
  computeKey,
  ttlFor,
  isCacheable,
  isBashCacheable,
  detectBashBulkInvalidation,
  referencedFiles,
  mutatedFiles,
  hashReferencedFiles,
  TTL_BY_TOOL,
  UNCACHEABLE_TOOLS,
  BASH_READONLY_ALLOW,
  DIRTY_WINDOW_MS,
  PENDING_LOCK_TTL_MS,
};
