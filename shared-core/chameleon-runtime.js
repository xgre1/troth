// SPDX-License-Identifier: AGPL-3.0-only
// Chameleon Protocol v0.1 — substrate-side runtime engine.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio between the substrate
// and external knowledge adapters.
// "spec §" comments below cite sections of that protocol.
//
// THIS module is the missing wire between `troth knowledge import` and the
// three reference adapters under `adapters/chameleon-*.mjs`. Today the CLI
// short-circuits the protocol by calling `chameleon.ingestDocument()` with
// raw text. With this module, the CLI (and tests, and the future supervisor)
// can drive a real handshake: spawn → initialize → describe → read → ingest.
//
// What's in scope for v1 (this file):
//   • stdio transport with newline-delimited JSON-RPC 2.0 framing (spec §2.1)
//   • initialize → initialized notification → method dispatch (spec §2.2)
//   • per-request 30s timeout (60s for /read because page batches are bigger)
//   • adapter stderr surfacing via `console.warn('[chameleon-rt]')`
//   • runIngestionFlow for `data_shape: text` + `refresh: static` adapters
//     (the filesystem reference adapter is exactly this shape)
//
// What's intentionally deferred (flagged inline below):
//   • discovery dialog driver (spec §3.3) — deferred design track
//   • schema URI registry caching (spec §1) — needed once non-text shapes
//     route through this runtime; fine to skip for the static+text path
//   • adapter sandboxing / attestation_hash recompute (spec §1, Threat
//     Model Layer 2) — the supervisor is the right home
//   • WebSocket transport (spec §2.1, second row) — only stdio for v1
//   • exponential-backoff restart (spec §2.3 D5.1) — supervisor's job
//   • polled / streamed / on_demand refresh (spec §6) — needs scheduler
//   • multi-page /read with pagination cursor — adapters return a single
//     records array today; switch to streaming once /event lands
//
// Hard constraints honored:
//   • No new npm deps. Only Node stdlib (`child_process`, `readline`).
//   • The 3 reference adapters are NOT modified; this runtime conforms
//     to whatever they already declare.
//   • `chameleon.js` exports stay intact; runtime calls `ingestDocument()`
//     unchanged.

'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const chameleon = require('./chameleon.js');

// ── Constants ─────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '0.1';
const DEFAULT_TIMEOUT_MS = 30_000;       // most JSON-RPC calls
const READ_TIMEOUT_MS    = 60_000;       // /read can be slow on big roots
const MAX_LINE_BYTES     = 16 * 1024 * 1024; // spec §2.1 message_too_large

// Substrate's advertised capabilities during initialize handshake. Adapters
// only act on intersection of (their declared) ∩ (these). v0.1 substrate
// simply consumes records — we are not yet asking adapters to write back.
const SUBSTRATE_CAPS = ['read', 'static', 'polled', 'streamed', 'on_demand',
                        'schema_introspect', 'seed_examples'];

// ── AdapterClient ─────────────────────────────────────────────────────────

// One AdapterClient per spawned adapter subprocess. Owns the JSON-RPC id
// counter, pending-request map, and the lifecycle of the child. Methods
// map 1:1 onto spec §2.4 method names; param shapes per spec §1/§3/§4.
class AdapterClient {
  constructor(child, opts) {
    this.child = child;
    this.opts = opts || {};
    this._nextId = 1;
    this._pending = new Map();           // id → { resolve, reject, timer }
    this._buf = '';
    this._closed = false;
    this._initialized = false;           // gate post-handshake methods
    this._exitInfo = null;

    // stdout: parse newline-delimited JSON-RPC. Line-by-line via manual
    // buffering instead of readline so we can enforce MAX_LINE_BYTES
    // without it being silently dropped by readline's internal limits.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onStdout(d));

    // stderr: surface but don't crash. Adapter authors print debug here;
    // a failing adapter's traceback comes here too.
    child.stderr.setEncoding('utf8');
    const stderrLines = readline.createInterface({ input: child.stderr });
    stderrLines.on('line', (line) => {
      if (!line) return;
      console.warn('[chameleon-rt][' + (opts.label || 'adapter') + '][stderr] ' + line);
    });

    child.on('exit', (code, signal) => {
      this._closed = true;
      this._exitInfo = { code, signal };
      // Reject every still-pending RPC so callers don't hang forever.
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error('adapter exited (code=' + code + ', signal=' + signal + ') with pending RPC'));
      }
      this._pending.clear();
    });

    child.on('error', (err) => {
      // spawn-time error (ENOENT, EACCES). Reject any in-flight callers.
      this._closed = true;
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this._pending.clear();
    });

    // stdin EPIPE handler: when the child exits before we finish writing,
    // the socket emits 'error' asynchronously. Without a listener Node
    // crashes the parent. Treat it the same as a child exit — mark closed
    // and reject in-flight callers.
    if (child.stdin) {
      child.stdin.on('error', (err) => {
        this._closed = true;
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this._pending.clear();
      });
    }
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.length > MAX_LINE_BYTES) {
        // spec §2.1 — message_too_large severs the connection.
        console.warn('[chameleon-rt] adapter sent line >16MB; killing');
        try { this.child.kill('SIGTERM'); } catch (_) {}
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); }
      catch (_) {
        console.warn('[chameleon-rt] non-JSON line from adapter: ' + trimmed.slice(0, 200));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // We're a JSON-RPC client. We expect responses (with `id`) and the
    // optional server-initiated `chameleon/event` notification (no `id`).
    // v1 just logs notifications; once streamed-refresh lands the
    // supervisor will route them into the substrate event bus.
    if (msg.id === undefined || msg.id === null) {
      // Notification — typically chameleon/event for streamed refresh.
      // FOLLOWUP: route this into the substrate event bus once §6
      // streamed-refresh lands. For v1 we just surface for visibility.
      if (msg.method) {
        console.warn('[chameleon-rt] notification: ' + msg.method);
      }
      return;
    }
    const pending = this._pending.get(msg.id);
    if (!pending) {
      console.warn('[chameleon-rt] response for unknown id ' + msg.id);
      return;
    }
    this._pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(_rpcErrorToJsError(msg.error, pending.method));
    else           pending.resolve(msg.result);
  }

  // Send a request, await response. `timeoutMs` overrides default per-call.
  _request(method, params, timeoutMs) {
    if (this._closed) {
      return Promise.reject(new Error('adapter closed; cannot call ' + method));
    }
    const id = String(this._nextId++);
    const payload = { jsonrpc: '2.0', id, method, params: params === undefined ? {} : params };
    const line = JSON.stringify(payload);
    if (line.length > MAX_LINE_BYTES) {
      return Promise.reject(new Error('outbound message exceeds 16MB; refused'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('rpc timeout (' + (timeoutMs || DEFAULT_TIMEOUT_MS) + 'ms): ' + method));
        }
      }, timeoutMs || DEFAULT_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(line + '\n');
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  // Send a notification (no id, no response expected). Used for the
  // post-initialize `initialized` per spec §2.2.
  _notify(method, params) {
    if (this._closed) return;
    const payload = { jsonrpc: '2.0', method, params: params === undefined ? {} : params };
    try {
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    } catch (e) {
      console.warn('[chameleon-rt] notify failed: ' + e.message);
    }
  }

  // ── Spec §2.4 method surface ──────────────────────────────────────────
  // Each method below takes the params shape declared in the spec and
  // returns the adapter's `result` object.

  async initialize(params) {
    // Spec §2.2: substrate sends initialize, server returns
    // { protocol_version, server_capabilities, source_manifest }, then
    // substrate sends `initialized` notification before any other call.
    const merged = Object.assign({
      protocol_version: PROTOCOL_VERSION,
      client_capabilities: SUBSTRATE_CAPS
    }, params || {});
    const result = await this._request('chameleon/initialize', merged);
    if (!result || result.protocol_version === undefined) {
      throw new Error('initialize response missing protocol_version');
    }
    if (!String(result.protocol_version).startsWith('0.1')) {
      throw new Error('unsupported adapter protocol_version: ' + result.protocol_version);
    }
    this._notify('chameleon/initialized', {});
    this._initialized = true;
    return result;
  }

  describe()        { this._assertInit(); return this._request('chameleon/describe', {}); }
  getSchema()       { this._assertInit(); return this._request('chameleon/get_schema', {}); }
  health()          { this._assertInit(); return this._request('chameleon/health', {}); }

  // Discovery dialog (spec §3.3). FOLLOWUP: the runIngestionFlow currently
  // skips discovery entirely for the static+text shape per spec §1 ("schema
  // optional for text"). Wiring an interactive dialog driver is deferred;
  // see cold-start priors + manifest-hash discovery notes. The
  // method surface is exposed here so a future driver can call it.
  discoverBegin(params)    { this._assertInit(); return this._request('chameleon/discover/begin', params || {}); }
  discoverQuestion(params) { this._assertInit(); return this._request('chameleon/discover/question', params || {}); }
  discoverAnswer(params)   { this._assertInit(); return this._request('chameleon/discover/answer', params || {}); }
  discoverComplete(params) { this._assertInit(); return this._request('chameleon/discover/complete', params || {}); }

  // /read may return many records; allow longer timeout. Adapters today
  // return a single page; FOLLOWUP: switch to cursor pagination once any
  // adapter declares more records than fit in one 16MB frame.
  read(params)      { this._assertInit(); return this._request('chameleon/read', params || {}, READ_TIMEOUT_MS); }

  async shutdown(opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 2000;
    if (this._closed) return { code: this._exitInfo && this._exitInfo.code, signal: null };
    return new Promise((resolve) => {
      const onExit = (code, signal) => {
        clearTimeout(killTimer);
        resolve({ code, signal });
      };
      this.child.once('exit', onExit);
      try { this.child.stdin.end(); } catch (_) {}
      const killTimer = setTimeout(() => {
        try { this.child.kill('SIGTERM'); } catch (_) {}
      }, timeoutMs);
    });
  }

  _assertInit() {
    if (!this._initialized) throw new Error('adapter not initialized; call initialize() first');
  }
}

function _rpcErrorToJsError(rpcErr, method) {
  const e = new Error('rpc ' + method + ' failed: ' + (rpcErr.message || 'unknown') +
                      ' (code=' + rpcErr.code + ')');
  e.code = rpcErr.code;
  e.data = rpcErr.data;
  return e;
}

// ── spawnAdapter ──────────────────────────────────────────────────────────

// Spawn a stdio adapter as a child process and wrap it in an AdapterClient.
// Caller must `await client.initialize(...)` before any other method.
//
// `cmd` is the executable, `args` is the argv array. `opts.label` shows up
// in stderr-passthrough log lines for multi-adapter runs.
async function spawnAdapter(cmd, args, opts) {
  opts = opts || {};
  const child = spawn(cmd, args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, opts.env || {}),
    cwd: opts.cwd || process.cwd(),
    // FOLLOWUP: sandbox per Threat Model Layer 1 (process isolation,
    // resource caps). v1 runs the child with full inherited env minus
    // explicit overrides; the supervisor is the right
    // place to add cgroups / launchd resource limits / setuid drops.
  });
  return new AdapterClient(child, opts);
}

// ── runIngestionFlow ──────────────────────────────────────────────────────

// End-to-end driver for a static + text adapter:
//   1. spawn the adapter subprocess
//   2. initialize handshake (verify protocol_version)
//   3. describe (validates capabilities + data_shape="text")
//   4. read (collect all records)
//   5. for each chunk, route into chameleon.ingestDocument()
//   6. shut the adapter down
//
// `ingestOpts` carries the substrate-side knobs:
//   • agent_id (required) — propagated to the engram store
//   • cwd                 — substrate context
//   • scope               — corpus name; if omitted, derived as
//                           'chameleon:<source_id>'
//   • chunk_chars / chunk_overlap — overrides for chameleon.chunkText
//
// FOLLOWUP for non-static / non-text shapes:
//   • If manifest.refresh.strategy === 'polled', register a setInterval
//     timer at runtime/ supervisor level — not here.
//   • If manifest.refresh.strategy === 'streamed', subscribe to the
//     adapter's chameleon/event notifications (already routed in
//     _dispatch above).
//   • If manifest.data_shape === 'structured', validate each record
//     against the L2 JSON Schema fetched via getSchema() before ingest
//     (spec §4.1 + Threat Model Layer 3).
//   • If manifest.capabilities includes 'schema_introspect' AND we are
//     about to ingest, call getSchema() and cache by
//     (source_id, manifest_hash) per spec §1.
//   • Discovery dialog: if the manifest declares ambiguous schema or
//     the operator wants to refine the L3 prior, call the discover/*
//     methods between describe and read.

async function runIngestionFlow(adapterCmd, adapterArgs, ingestOpts) {
  ingestOpts = ingestOpts || {};
  if (!ingestOpts.agent_id) {
    throw new Error('runIngestionFlow: agent_id is required');
  }

  const client = await spawnAdapter(adapterCmd, adapterArgs, {
    label: ingestOpts.label || 'rt'
  });

  let init, manifest, readResult;
  try {
    init = await client.initialize({});
    manifest = init.source_manifest || await client.describe();
    if (!manifest) throw new Error('adapter returned no source_manifest');

    // v1 runs only the static + text path. Anything else is rejected
    // loudly so callers can't accidentally run a structured adapter
    // through the wrong pipeline.
    const shape    = manifest.data_shape;
    const strategy = (manifest.refresh && manifest.refresh.strategy) || 'static';
    if (shape !== 'text') {
      throw new Error('runIngestionFlow v1 supports data_shape=text only; got: ' + shape +
                      '. FOLLOWUP: structured + event_stream pipelines.');
    }
    if (strategy !== 'static') {
      throw new Error('runIngestionFlow v1 supports refresh.static only; got: ' + strategy +
                      '. FOLLOWUP: polled/streamed/on_demand via supervisor.');
    }

    // FOLLOWUP — discovery dialog (spec §3.3). For static text the L1+L2+L3
    // priors normally cover ambiguity; running the dialog is
    // optional and expensive. Skip for v1.

    readResult = await client.read({});
    if (!readResult || !Array.isArray(readResult.records)) {
      throw new Error('adapter /read returned no records array');
    }
  } catch (e) {
    try { await client.shutdown({ timeoutMs: 1000 }); } catch (_) {}
    throw e;
  }

  // Derive scope: caller wins, else 'chameleon:<source_id>' per spec §C8.
  const sourceId = manifest.source_id || 'unknown';
  const scope    = ingestOpts.scope || ('chameleon:' + sourceId);
  const source   = 'chameleon:' + sourceId;

  // Collect all chunk text into the substrate. Adapters return records
  // with at least { text, source_path?, chunk_index?, chunk_total? };
  // we forward each record as one ingestDocument() call so the engram
  // layer chunks it according to its own budget. (For the filesystem
  // adapter individual records are already chunk-sized; the substrate
  // chunker will pass them through as a single chunk each.)
  let ingested = 0;
  const failures = [];
  for (const rec of readResult.records) {
    if (!rec || typeof rec.text !== 'string' || !rec.text.trim()) continue;
    const title = rec.source_path || rec.id || null;
    const r = await chameleon.ingestDocument({
      agent_id:      ingestOpts.agent_id,
      user_id:       ingestOpts.user_id,
      cwd:           ingestOpts.cwd,
      scope,
      source,
      title,
      text:          rec.text,
      chunk_chars:   ingestOpts.chunk_chars,
      chunk_overlap: ingestOpts.chunk_overlap,
      embedding_host: ingestOpts.embedding_host,
      salience:      ingestOpts.salience
    });
    if (r && r.ok) ingested += (r.recorded || 0);
    else failures.push({ rec_id: rec.id, error: r && r.error });
  }

  await client.shutdown({ timeoutMs: 2000 });

  return {
    ingested,
    scopes: [scope],
    source_id: sourceId,
    record_count: readResult.records.length,
    failures
  };
}

// ── Adapter registry ──────────────────────────────────────────────────────
// `~/.troth/adapters.json` declares the adapters this substrate knows
// about. Each entry: { name, cmd, args, source_id?, default_scope? }.
// Operator-managed for v0.1 (no marketplace, no auto-discovery — that's
// CG-3 / runtime sandbox work). The MCP tools + `troth chameleon` CLI
// read/write this file so any agent can list, register, run.

const fs = require('fs');
const path = require('path');
const os = require('os');

const REGISTRY_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.troth',
  'adapters.json'
);

function _loadRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.adapters)) return parsed.adapters;
    return [];
  } catch (_) {
    return [];
  }
}

function _saveRegistry(adapters) {
  const dir = path.dirname(REGISTRY_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ adapters }, null, 2));
  // 0600 — same convention as ~/.troth/config.json
  try { fs.chmodSync(REGISTRY_PATH, 0o600); } catch (_) {}
}

function listAdapters() {
  return _loadRegistry().map((a) => ({
    name: a.name,
    cmd: a.cmd,
    args: a.args || [],
    source_id: a.source_id || null,
    default_scope: a.default_scope || null,
  }));
}

function getAdapter(name) {
  return _loadRegistry().find((a) => a.name === name) || null;
}

function registerAdapter(spec) {
  if (!spec || !spec.name || !spec.cmd) {
    throw new Error('registerAdapter requires {name, cmd, args?}');
  }
  const reg = _loadRegistry();
  const existingIdx = reg.findIndex((a) => a.name === spec.name);
  const entry = {
    name: spec.name,
    cmd: spec.cmd,
    args: spec.args || [],
    source_id: spec.source_id || null,
    default_scope: spec.default_scope || null,
  };
  if (existingIdx >= 0) {
    reg[existingIdx] = entry; // upsert
  } else {
    reg.push(entry);
  }
  _saveRegistry(reg);
  return entry;
}

function unregisterAdapter(name) {
  const reg = _loadRegistry();
  const before = reg.length;
  const after = reg.filter((a) => a.name !== name);
  _saveRegistry(after);
  return { removed: before - after.length };
}

/// Drive a registered adapter end-to-end. Looks up `name` in the registry,
/// resolves cmd+args, calls runIngestionFlow with the caller's ingest opts.
/// Throws if the named adapter is not registered.
async function runRegisteredAdapter(name, ingestOpts) {
  const spec = getAdapter(name);
  if (!spec) {
    throw new Error(
      'no adapter named "' + name + '" — register first via ' +
      'registerAdapter() / `troth chameleon register`'
    );
  }
  const opts = Object.assign({}, ingestOpts || {});
  if (!opts.scope && spec.default_scope) opts.scope = spec.default_scope;
  return runIngestionFlow(spec.cmd, spec.args || [], opts);
}

module.exports = {
  spawnAdapter,
  AdapterClient,
  runIngestionFlow,
  // Registry + dispatch (v0.1 ergonomic surface)
  REGISTRY_PATH,
  listAdapters,
  getAdapter,
  registerAdapter,
  unregisterAdapter,
  runRegisteredAdapter,
  // Exposed for tests + future supervisor:
  PROTOCOL_VERSION,
  SUBSTRATE_CAPS
};
