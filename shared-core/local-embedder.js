// SPDX-License-Identifier: AGPL-3.0-only
// local-embedder — in-process embedding faculty for the substrate.
//
// This is the mind's associative-recall faculty: it turns memory text into
// vectors so retrieveRelevant can rank by meaning, not just keywords. It is
// NOT RAG and NOT an external service — it runs in-process, in the same node
// the substrate runs in (CLI / plugin / proxy / app-spawned entity), and the
// vectors live inside the substrate (engram_embeddings). The language faculty
// (chat LLM) and this recall faculty are both swappable organs of one mind.
//
// Runtime: node-llama-cpp (optional dependency). Ships prebuilt darwin-arm64
// + Metal, no end-user compile, built-in GGUF downloader. If the dependency
// is absent (e.g. a minimal OSS install) every call returns null and callers
// fall back to lexical recall — degraded, never broken.
//
// Model: EmbeddingGemma-300M (default; see below) — 768-dim (measured from a
// live vector; the header claimed 1024 for a long time), multilingual incl.
// Greek, verified runnable here. contextSize is capped small ON PURPOSE: substrate memories
// are short atomic facts (measured: median 50 chars, p99 ~500 chars, 8/128K
// over 2000 chars), so 512 tokens covers >99% fully while keeping the model
// at ~1GB RSS instead of ~4.5GB at the model's native 32K (that KV cache is
// pure waste for our inputs). Measured on an M5 laptop, CPU-only: ~11ms/embed,
// ~90 texts/sec, ~1GB RAM.
//
// Threads are capped to half the cores so a background backfill never pins the
// machine. Metal acceleration (when the real runtime context allows it) makes
// everything faster; CPU is the floor and is already acceptable.

const os   = require('os');
const path = require('path');

// ── Config (env-overridable; sensible zero-config defaults) ──────────────

// EMBEDDING MODEL PROFILE. The model + its retrieval PROMPTS are a MATCHED pair —
// each model expects its own query/document prompt convention, and mixing them
// tanks retrieval quality. The `id` is stored alongside every vector so a model
// swap is DETECTED and the index re-embedded in the BACKGROUND, never touching
// the recorded memory (action_records). Embeddings are a disposable derived index.
//
// Default: EmbeddingGemma-300M (Google, 2025). Measured ~20x better retrieval
// discrimination than Qwen3-Embedding-0.6B on OUR corpus (a paraphrase target's
// rank went 5068→~246 of 58k) at HALF the size (318MB vs 640MB) + faster per-turn
// + multilingual incl. Greek. Runs in the vendored llama-server Metal (verified).
const EMBED_PROFILES = {
  'embeddinggemma-300m': {
    uri:   'hf:ggml-org/embeddinggemma-300M-GGUF:Q8_0',
    match: ['embeddinggemma'],                  // filename tokens for the server path
    // Official EmbeddingGemma retrieval prompts (Google model card).
    query: (t) => 'task: search result | query: ' + t,
    doc:   (t) => 'title: none | text: ' + t,
    ctx:   2048
  },
  'qwen3-embedding-0.6b': {                      // previous default — kept for override/fallback
    uri:   'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0',
    match: ['qwen3', 'embedding'],
    query: (t) => 'Instruct: Given a query, retrieve memories relevant to answering it\nQuery: ' + t,
    doc:   (t) => t,
    ctx:   2048
  }
};
const MODEL_ID  = process.env.TROTH_EMBED_MODEL_ID || 'embeddinggemma-300m';
const PROFILE   = EMBED_PROFILES[MODEL_ID] || EMBED_PROFILES['embeddinggemma-300m'];
// HF GGUF URI consumed by node-llama-cpp's resolveModelFile / createModelDownloader.
const MODEL_URI = process.env.TROTH_EMBED_MODEL || PROFILE.uri;
// Atomic memories are short, but ingested research/plan docs are CHUNKED into
// hundreds-to-couple-thousand-char pieces; 2048 covers chunks fully. The clamp is
// 1:1 chars→ctx (below) so dense scripts (Greek/code) can't overflow the context.
const CONTEXT_SIZE = parseInt(process.env.TROTH_EMBED_CTX || String(PROFILE.ctx), 10);
const MODELS_DIR = process.env.TROTH_EMBED_DIR
  || path.join(process.env.HOME || os.homedir(), '.troth', 'models');
// Leave headroom so the embedder is a good citizen next to a local chat model.
const MAX_THREADS = Math.max(1, Math.floor(os.cpus().length / 2));

// Retrieval prompts are model-specific and live in the PROFILE above: QUERIES and
// DOCUMENTS each get their model's prompt convention (mixing them tanks quality).
// Applied in _wrapForRole via PROFILE.query / PROFILE.doc.

// ── Lazy singleton state ─────────────────────────────────────────────────

let _initPromise = null;   // in-flight or completed init
let _ctx = null;           // LlamaEmbeddingContext
let _unavailable = false;  // node-llama-cpp missing / init failed → stay lexical
let _dim = null;
// One-time model download progress (surfaced as the "Getting your partner
// ready" setup UX). 0..1; 1 once present. _downloading guards re-entry.
let _dlPromise = null;
let _dlProgress = 0;
let _dlDone = false;

// Resolve once. Returns the embedding context, or null if unavailable.
async function ensureContext() {
  if (_ctx) return _ctx;
  if (_unavailable) return null;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    let nlc;
    try {
      nlc = await import('node-llama-cpp');
    } catch (_) {
      // Dependency not installed — degrade to lexical, quietly and once.
      _unavailable = true;
      return null;
    }
    try {
      const { getLlama, resolveModelFile } = nlc;
      // TROTH_NO_MODEL_FETCH=1 (hermetic tests / metered networks): only an
      // already-downloaded GGUF is acceptable — resolveModelFile would
      // otherwise pull ~333MB from HF. Missing file = degrade to lexical.
      let modelPath;
      if (process.env.TROTH_NO_MODEL_FETCH === '1') {
        modelPath = _resolveEmbedModelPath();
        if (!modelPath) { _unavailable = true; return null; }
      } else {
        modelPath = await resolveModelFile(MODEL_URI, MODELS_DIR);
      }
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      _ctx = await model.createEmbeddingContext({
        contextSize: CONTEXT_SIZE,
        threads: MAX_THREADS
      });
      return _ctx;
    } catch (e) {
      _unavailable = true;
      return null;
    }
  })();
  return _initPromise;
}

// prepareModel(onProgress?) — pre-download the model GGUF with PROGRESS, for
// the "Getting your partner ready" first-run setup UX. Idempotent; if the file
// already exists it resolves immediately at 100%. Downloads to the same dir +
// name ensureContext resolves, so loading afterward is instant (no re-fetch).
// Falls back silently if node-llama-cpp is missing (stays lexical).
async function prepareModel(onProgress) {
  if (_dlDone) { if (onProgress) onProgress(1); return true; }
  if (process.env.TROTH_NO_MODEL_FETCH === '1' && !_resolveEmbedModelPath()) return false;
  if (_dlPromise) return _dlPromise;
  _dlPromise = (async () => {
    let nlc;
    try { nlc = await import('node-llama-cpp'); }
    catch (_) { _unavailable = true; return false; }
    try {
      const { createModelDownloader } = nlc;
      const downloader = await createModelDownloader({
        modelUri: MODEL_URI,
        dirPath: MODELS_DIR,
        onProgress: (p) => {
          const total = p && (p.totalSize || p.totalBytes);
          const got   = p && (p.downloadedSize || p.downloadedBytes);
          if (total) {
            _dlProgress = Math.min(1, got / total);
            if (onProgress) onProgress(_dlProgress);
          }
        }
      });
      await downloader.download();
      _dlProgress = 1; _dlDone = true;
      if (onProgress) onProgress(1);
      return true;
    } catch (e) {
      // Network/disk failure — leave _dlDone false so a later call retries.
      _dlPromise = null;
      return false;
    }
  })();
  return _dlPromise;
}

// Truncate before embedding. The OLD `CONTEXT_SIZE * 4` assumed ~4 chars/token,
// but dense scripts (Greek, code, CJK) tokenize at ~1.2-2 chars/token, so a
// 2048-char clamp blew past a 512-token context → node-llama-cpp NATIVELY
// aborts (Abort trap 6, uncatchable) → the whole backfill chunk died. Tokens
// are ALWAYS ≤ chars (each token is ≥1 char), so clamping to CONTEXT_SIZE chars
// guarantees ≤ CONTEXT_SIZE tokens regardless of script — bulletproof. With
// CONTEXT_SIZE now 2048 we still embed a generous slice of each memory.
function clampToContext(text) {
  const maxChars = CONTEXT_SIZE;
  const s = String(text || '');
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

// ── Public API ───────────────────────────────────────────────────────────

// embed(text, { role, wait }) → Promise<number[] | null>
//   role: 'document' (default — stored memories) | 'query' (recall queries)
//   wait: false (default) — NON-BLOCKING. If the model isn't loaded yet
//         (first-run 639MB download, or still initializing), kick off init in
//         the background and return null immediately so the caller (recall)
//         degrades to lexical instead of stalling for minutes on a download.
//         true — await full init (used by the backfill, which is allowed to
//         take its time).
// Returns null when the embedder is unavailable/not-yet-ready. Never throws.
// ── Server-backed embedding (Metal-fast) ────────────────────────────────────
// node-llama-cpp's EMBEDDED Metal is broken on this build (b8390: "tensor API
// not supported" + Metal source-compile failure) → silent CPU fallback ~2/sec.
// The vendored standalone llama-server (b9664, ~/.troth/bin) has WORKING Metal —
// measured ~28 embeds/sec batched. So embedding now runs the SAME way as chat:
// a tiny local llama-server with the embedding model + --embeddings, POSTed to
// over HTTP. In-process node-llama-cpp stays as a last-resort fallback only.
const _http = require('http');
const { spawn: _spawn } = require('child_process');
const EMB_PORT = parseInt(process.env.TROTH_EMBED_PORT || '11437', 10);
// GPU offload is opt-in. llama.cpp keeps an offloaded model resident in VRAM
// for the process's whole life, and nothing stops an idle server, so a
// permanently-loaded 300M embedder means a permanently busy GPU and a hot
// laptop. This file's own measurement is ~11ms/embed on CPU, which is not
// worth that. TROTH_NGL=999 restores full offload.
const EMB_NGL = parseInt(process.env.TROTH_NGL || '0', 10) || 0;

function _embServerHealth(timeoutMs) {
  return new Promise((resolve) => {
    const req = _http.request({ hostname: '127.0.0.1', port: EMB_PORT, path: '/health', method: 'GET', timeout: timeoutMs || 1200 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve((JSON.parse(b) || {}).status === 'ok'); } catch (_) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.end();
  });
}

function _resolveEmbedModelPath() {
  try {
    const want = PROFILE.match;
    for (const f of require('fs').readdirSync(MODELS_DIR)) {
      const lc = f.toLowerCase(); if (!lc.endsWith('.gguf')) continue;
      const n = lc.replace(/[^a-z0-9]/g, '');
      if (want.every((t) => n.includes(t))) return path.join(MODELS_DIR, f);
    }
  } catch (_) {}
  return null;
}

let _embServerPromise = null;
let _embServerDead = false;       // ONLY for unrecoverable (no binary / spawn fail) — stops retrying
let _embModelDownloading = false; // transient: model GGUF being fetched in the background
let _embServerStderrTail = '';    // tail of the embed server's stderr (load/OOM errors live here)
let _embServerLastError = null;   // surfaced reason the embed server failed — for status() / GUI
let _embServerDeadAt = 0;         // ts of last death → backoff-retry instead of latching dead forever
const EMB_DEAD_RETRY_MS = 5 * 60 * 1000; // re-attempt a dead embed server after 5 min

// Mark the embed server unavailable WITH a surfaced reason (status() exposes it
// so a GUI/daemon with no console still sees why recall dropped to lexical-only).
function _markEmbServerDead(reason) {
  _embServerDead = true;
  _embServerDeadAt = Date.now();
  if (reason) _embServerLastError = String(reason).slice(0, 600);
  try { console.error('[local-embedder] embed server unavailable: ' + (_embServerLastError || 'unknown')); } catch (_) {}
}
// Read the tail of the per-spawn stderr log (GGUF-load / OOM errors) for diagnostics.
function _readEmbErrTail() {
  try {
    const fsE = require('fs'), osE = require('os'), pathE = require('path');
    const dir = process.env.TROTH_DATA_DIR || pathE.join(process.env.HOME || osE.homedir(), '.troth');
    return String(fsE.readFileSync(pathE.join(dir, 'embed-server.err.log'), 'utf8')).slice(-1200).trim();
  } catch (_) { return ''; }
}
// Ensure a local Metal llama-server serving the embedding model. Idempotent +
// concurrency-safe. Returns true when /health is ok.
async function _ensureEmbServer() {
  if (_embServerDead) {
    // Recoverable: a dead server (bad GGUF / OOM / spawn fail) may be transient
    // (model re-downloaded, memory freed). Re-attempt after a backoff window
    // instead of latching dead for the whole session.
    if (Date.now() - _embServerDeadAt < EMB_DEAD_RETRY_MS) return false;
    _embServerDead = false; _embServerLastError = null;
  }
  if (await _embServerHealth()) return true;
  if (_embServerPromise) return _embServerPromise;
  _embServerPromise = (async () => {
    let BIN = null;
    try {
      const ls = require('./local-server.js');
      await ls.ensureBinary();      // fetch llama-server if missing (shared with chat tier)
      BIN = ls.BIN;
    } catch (_) {}
    if (!BIN || !require('fs').existsSync(BIN)) { _markEmbServerDead('llama-server binary missing'); return false; }
    const modelPath = _resolveEmbedModelPath();
    if (!modelPath) {
      // Fresh user — embedding GGUF not downloaded yet. Kick the ~640MB download
      // in the BACKGROUND (non-blocking, like the in-process path) and bail THIS
      // call; a later embed finds it on disk and spawns the server. NOT marked
      // dead — it's transient (recall just stays lexical until the model lands).
      if (!_embModelDownloading) {
        _embModelDownloading = true;
        prepareModel().catch(() => {}).finally(() => { _embModelDownloading = false; });
      }
      return false;
    }
    try {
      try { require('child_process').execSync('pkill -f "llama-server.*' + EMB_PORT + '" || true', { stdio: 'ignore' }); } catch (_) {}
      // STDOUT stays ignored — llama-server's verbose per-slot INFO trace is what
      // ballooned the old embed-server.log to ~10GB. STDERR (GGUF-load / OOM errors,
      // tiny) goes to a per-spawn-TRUNCATED stderr-only file so a real failure is
      // diagnosable via status()/_readEmbErrTail without unbounded growth — and via
      // a FILE fd, NOT a parent pipe (a pipe would SIGPIPE-kill this detached server
      // when the parent exits; the file fd survives, preserving window-close survival).
      let _errFd = 'ignore';
      try {
        const fsE = require('fs'), osE = require('os'), pathE = require('path');
        const dir = process.env.TROTH_DATA_DIR || pathE.join(process.env.HOME || osE.homedir(), '.troth');
        try { fsE.mkdirSync(dir, { recursive: true }); } catch (_) {}
        _errFd = fsE.openSync(pathE.join(dir, 'embed-server.err.log'), 'w');
      } catch (_) { _errFd = 'ignore'; }
      const child = _spawn(BIN, [
        '-m', modelPath, '--embeddings', '--pooling', 'mean',
        '-lv', '0', // errors only: verbosity=3 flooded embed-server.err.log to 45GB (no rotation)
        '--port', String(EMB_PORT), '--host', '127.0.0.1',
        '-c', String(CONTEXT_SIZE), '-ngl', String(EMB_NGL),
        // Embeddings are non-causal: the WHOLE input must fit one physical batch.
        // Default ubatch is 512, so 2048-token doc chunks were REJECTED ("input
        // too large to process") → fell back to slow CPU. Match batch to context.
        '-b', String(CONTEXT_SIZE), '--ubatch-size', String(CONTEXT_SIZE)
        // LD_LIBRARY_PATH: Linux ships llama-server's shared objects beside it
        // and will not search the executable's own directory without this.
        // macOS resolves them via rpath, where the variable is inert.
      ], { detached: true, stdio: ['ignore', 'ignore', _errFd],
           env: Object.assign({}, process.env, {
             LD_LIBRARY_PATH: pathE.dirname(BIN) +
               (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '')
           }) });
      try { if (typeof _errFd === 'number') require('fs').closeSync(_errFd); } catch (_) {} // child holds its own dup
      child.on('error', (e) => _markEmbServerDead('spawn error: ' + (e && e.message || e)));
      child.on('exit', (code, signal) => {
        // code!=0 = crash (bad GGUF/OOM); code=null/signal = intentional kill (e.g. respawn) → ignore.
        if (code) _markEmbServerDead('embed server exited code=' + code + (signal ? '/' + signal : '') + (_readEmbErrTail() ? ' — ' + _readEmbErrTail() : ''));
      });
      child.unref();
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        if (await _embServerHealth()) return true;
        await new Promise((r) => setTimeout(r, 1000));
      }
      _markEmbServerDead('health check timed out after 40s' + (_readEmbErrTail() ? ' — stderr: ' + _readEmbErrTail() : ''));
      return false;
    } catch (e) {
      _markEmbServerDead('spawn failed: ' + (e && e.message || e));
      return false;
    }
  })().finally(() => { _embServerPromise = null; });
  return _embServerPromise;
}

// POST a batch to the embedding server's OpenAI-compatible endpoint. Inputs are
// pre-wrapped per role by the caller. Returns vectors aligned to inputs, or null
// on any failure (caller falls back to in-process).
function _serverEmbedBatch(inputs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ input: inputs });
    const req = _http.request({
      hostname: '127.0.0.1', port: EMB_PORT, path: '/v1/embeddings', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 120000
    }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(b);
          if (!d || !Array.isArray(d.data)) { resolve(null); return; }
          // Preserve request order via the `index` field when present.
          const out = new Array(inputs.length).fill(null);
          d.data.forEach((row, i) => {
            const idx = (typeof row.index === 'number') ? row.index : i;
            if (Array.isArray(row.embedding)) out[idx] = row.embedding;
          });
          resolve(out);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.write(body); req.end();
  });
}

function _wrapForRole(text, role) {
  const input = clampToContext(text);
  if (!input.trim()) return null;
  return role === 'query' ? PROFILE.query(input) : PROFILE.doc(input);
}

// last-use stamp — how a long-lived supervisor knows this server is idle.
//
// The llama-server children are spawned detached + unref'd (correct: they must
// survive a proxy restart, reloading a model costs seconds) but NOTHING ever
// stopped them: zero exit handlers, so once started they lived until reboot.
// The operator found the reranker still resident after 14 hours for work that
// takes seconds, holding RAM and a Metal context. Writing
// a timestamp on every real call lets proxy/server.js reap them when idle,
// without coupling their lifetime to any one parent process.
function _touchUse() {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const dir = path.join(os.homedir(), '.troth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lastuse-' + EMB_PORT + '.txt'), String(Date.now()));
  } catch (_) { /* stamping must never break a real call */ }
}

async function embed(text, opts) {
  _touchUse();
  const role = (opts && opts.role) || 'document';
  const wrapped = _wrapForRole(text, role);
  if (wrapped == null) return null;
  // Metal-fast server path first.
  if (await _ensureEmbServer()) {
    const out = await _serverEmbedBatch([wrapped]);
    if (out && Array.isArray(out[0])) { if (_dim == null) _dim = out[0].length; return out[0]; }
  }
  // Fallback: in-process node-llama-cpp (CPU on this build — slow but works).
  const wait = !!(opts && opts.wait);
  let ctx = _ctx;
  if (!ctx) {
    if (wait) ctx = await ensureContext();
    else { if (!_unavailable && !_initPromise) ensureContext().catch(() => {}); return null; }
  }
  if (!ctx) return null;
  try {
    const e = await ctx.getEmbeddingFor(wrapped);
    const vec = e && e.vector ? Array.from(e.vector) : null;
    if (vec && _dim == null) _dim = vec.length;
    return vec;
  } catch (_) {
    return null;
  }
}

// Batch helper. Prefers the Metal embedding server (true batch — ~28/sec vs the
// in-process CPU ~2/sec). Falls back to serial in-process if the server is down.
// Returns an array aligned to `texts`, with null where a text was empty/failed.
async function embedBatch(texts, opts) {
  _touchUse();
  const role = (opts && opts.role) || 'document';
  const wrapped = texts.map((t) => _wrapForRole(t, role)); // nulls for empty
  if (await _ensureEmbServer()) {
    const idxMap = [], nonNull = [];
    wrapped.forEach((w, i) => { if (w != null) { idxMap.push(i); nonNull.push(w); } });
    if (!nonNull.length) return new Array(texts.length).fill(null);
    const vecs = await _serverEmbedBatch(nonNull);
    if (vecs) {
      const out = new Array(texts.length).fill(null);
      idxMap.forEach((orig, j) => { if (Array.isArray(vecs[j])) out[orig] = vecs[j]; });
      if (_dim == null) { const f = out.find((v) => Array.isArray(v)); if (f) _dim = f.length; }
      return out;
    }
  }
  // Fallback: in-process serial (embed() will also skip the dead server fast).
  const o = Object.assign({ wait: true }, opts || {});
  const out = [];
  for (const t of texts) out.push(await embed(t, o));
  return out;
}

// isAvailable() — non-committal probe: true only if already initialized OK.
// Does NOT trigger a model download; use to branch UI/telemetry.
function isAvailable() { return !!_ctx; }

// status() — for the degraded-recall signal + the "getting your partner ready"
// download UX + diagnostics.
function status() {
  return {
    available: !!_ctx,
    unavailable: _unavailable,
    initializing: !!_initPromise && !_ctx && !_unavailable,
    download_progress: _dlProgress,   // 0..1 model download
    download_done: _dlDone,
    downloading: !!_dlPromise && !_dlDone,
    model_id: MODEL_ID,
    dim: _dim,
    context_size: CONTEXT_SIZE,
    threads: MAX_THREADS,
    // Embed-server health surfaced so a GUI/daemon (no console) can SEE when
    // recall has silently degraded to lexical-only, and why.
    emb_server_dead: _embServerDead,
    emb_server_last_error: _embServerLastError
  };
}

module.exports = {
  embed,
  embedBatch,
  ensureContext,
  prepareModel,
  isAvailable,
  status,
  MODEL_ID,
  CONTEXT_SIZE
};
