// SPDX-License-Identifier: AGPL-3.0-only
// local-reranker.js — cross-encoder RERANK faculty over the local Metal
// llama-server, mirroring local-embedder.js's server lifecycle.
//
// WHY: a bi-encoder embedder ranks query↔memory by cosine over independently-
// computed vectors; it buries a conceptually-correct memory that shares no
// surface keywords. A CROSS-ENCODER scores the (query, memory) pair JOINTLY and
// can rescue it. Per the published evidence (MTEB/arXiv), the evidence-
// backed fix for the conceptual-recall gap is hybrid candidate generation +
// a cross-encoder reranker — NOT a bigger embedder and NOT HyDE (which
// hallucinates on private short-memory recall).
//
// Model: bge-reranker-v2-m3 (BAAI, Apache-2.0, multilingual incl. Greek),
// SELF-CONVERTED from the official weights with llama.cpp's own converter
// (gold-standard provenance — no third-party GGUF binary trusted). Q8_0 ~606MB.
// Runs on the vendored llama-server (b9664: `--reranking` + `--pooling rank`,
// /rerank endpoint), same as the embedder.
//
// Graceful-degrade: if the reranker model/binary is absent or the server is
// down, rerank() returns null and recall keeps its hybrid (lexical+dense) order
// recall NEVER blocks or errors on the reranker.

const _http = require('http');
const { spawn: _spawn } = require('child_process');
const path = require('path');
const os = require('os');

const MODEL_ID = process.env.TROTH_RERANK_MODEL_ID || 'bge-reranker-v2-m3';
const MODELS_DIR = process.env.TROTH_EMBED_DIR
  || path.join(process.env.HOME || os.homedir(), '.troth', 'models');
const PORT = parseInt(process.env.TROTH_RERANK_PORT || '11438', 10);
const CONTEXT_SIZE = parseInt(process.env.TROTH_RERANK_CTX || '2048', 10);
// Opt-in GPU offload, same reasoning as local-embedder: an offloaded model
// holds VRAM until its process dies, and reranking is bursty, not continuous.
const RERANK_NGL = parseInt(process.env.TROTH_NGL || '0', 10) || 0;
// filename tokens identifying the reranker GGUF in MODELS_DIR
const MATCH = ['bge-reranker'];

let _serverPromise = null;

// Recoverable-dead with backoff (mirrors local-embedder's
// EMB_DEAD_RETRY_MS): the old permanent `_dead = true` latched on TRANSIENT
// failures — a 40s health timeout while the chat+embed servers hog Metal on
// first load, or one network miss fetching llama-server — and recall stayed
// degraded (lexical+dense only) for the entire daemon lifetime.
let _deadAt = 0;             // 0 = healthy; else ts of last failure
// Set once if a spawn WITH accelerator offload never answered its health
// check. Process-lifetime, so a machine whose backend cannot start pays the
// failed attempt once rather than on every respawn.
let _offloadFailed = false;
const DEAD_RETRY_MS = 10 * 60 * 1000;
function _isDead() { return _deadAt > 0 && (Date.now() - _deadAt) < DEAD_RETRY_MS; }
function _markDead() { _deadAt = Date.now(); }
let _modelDownloading = false;

// What the port says: 'ok' (a healthy answer), 'busy' (something listens but
// did not answer in time — a server mid-rerank, or one still loading its
// model), 'down' (nothing listens). A busy server is alive; it is waited
// for and never replaced.
function _probe(timeoutMs) {
  return new Promise((resolve) => {
    const req = _http.request({ hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: timeoutMs || 1200 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve((JSON.parse(b) || {}).status === 'ok' ? 'ok' : 'busy'); } catch (_) { resolve('busy'); } });
    });
    req.on('error', (e) => resolve(e && (e.code === 'ECONNREFUSED' || e.code === 'ENOENT' || e.code === 'EHOSTUNREACH') ? 'down' : 'busy'));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve('busy'); });
    req.end();
  });
}
function _health(timeoutMs) { return _probe(timeoutMs).then((s) => s === 'ok'); }
// How long one call waits for a busy server before going without it, and
// how long a port may stay busy without ever answering before it is treated
// as wedged and replaced.
const BUSY_WAIT_MS = Math.max(0, Number(process.env.TROTH_SERVER_BUSY_WAIT_MS) || 5000);
const WEDGED_MS = 90 * 1000;
let _busySince = 0;
async function _waitWhileBusy() {
  const until = Date.now() + BUSY_WAIT_MS;
  let s = 'busy';
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    // Patient while waiting: a server mid-rerank answers its health check
    // when the request in flight completes, a second or two later.
    s = await _probe(2500);
    if (s !== 'busy') break;
  }
  return s;
}

function _resolveModelPath() {
  try {
    for (const f of require('fs').readdirSync(MODELS_DIR)) {
      const lc = f.toLowerCase(); if (!lc.endsWith('.gguf')) continue;
      const n = lc.replace(/[^a-z0-9]/g, '');
      if (MATCH.every((t) => n.includes(t.replace(/[^a-z0-9]/g, '')))) return path.join(MODELS_DIR, f);
    }
  } catch (_) {}
  return null;
}

// Ensure a local Metal llama-server in RERANKING mode. Idempotent + concurrency-safe.
async function ensureServer() {
  if (_isDead()) return false;
  const first = await _probe();
  if (first === 'ok') { _deadAt = 0; _busySince = 0; return true; }
  if (first === 'busy') {
    // Alive and working: wait a little, and go without a verdict rather
    // than replace it. Only a port that stays busy for minutes without one
    // healthy answer is treated as wedged and started again.
    if (!_busySince) _busySince = Date.now();
    if (Date.now() - _busySince < WEDGED_MS) {
      const s = await _waitWhileBusy();
      if (s === 'ok') { _deadAt = 0; _busySince = 0; return true; }
      if (s === 'busy') return false;
    }
  }
  _busySince = 0;
  if (_serverPromise) return _serverPromise;
  _serverPromise = (async () => {
    let BIN = null;
    try { const ls = require('./local-server.js'); await ls.ensureBinary(); BIN = ls.BIN; } catch (_) {}
    if (!BIN || !require('fs').existsSync(BIN)) { _markDead(); return false; }
    const modelPath = _resolveModelPath();
    if (!modelPath) {
      // Source verified live on HF (gpustack/bge-reranker-v2-m3-GGUF, same filename
      // the operator's hand-placed working copy uses). Non-blocking: THIS call stays
      // disabled (lexical+dense order) and a later call finds the file.
      // TROTH_NO_MODEL_FETCH=1 (hermetic tests / metered networks) suppresses the
      // fetch entirely. .part + rename = never a half GGUF.
      if (process.env.TROTH_NO_MODEL_FETCH !== '1' && !_modelDownloading) {
        _modelDownloading = true;
        (async () => {
          const fsL = require('fs');
          const dest = path.join(MODELS_DIR, 'bge-reranker-v2-m3-Q8_0.gguf');
          const part = dest + '.part';
          try {
            fsL.mkdirSync(MODELS_DIR, { recursive: true });
            const ls = require('./local-server.js');
            try { console.error('[local-reranker] fetching reranker GGUF (~600MB, one time)…'); } catch (_) {}
            await ls.downloadFollow(
              'https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf',
              part
            );
            fsL.renameSync(part, dest);
            try { console.error('[local-reranker] reranker GGUF ready'); } catch (_) {}
          } catch (e) {
            try { fsL.unlinkSync(part); } catch (_) {}
            try { console.error('[local-reranker] GGUF download failed: ' + (e && e.message || e)); } catch (_) {}
          } finally { _modelDownloading = false; }
        })();
      }
      return false;
    }
    try {
      const logPath = path.join(process.env.HOME || os.homedir(), '.troth', 'desktop', 'rerank-server.log');
      try { require('fs').mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}
      // What this server may spend, answered in one place for every local
      // model. Pinned to the CPU with no thread bound,
      // llama.cpp takes every core it can see: one rerank of fifty
      // candidates costs ~6.7 CPU-seconds where offload costs ~440ms and
      // four threads beat sixteen even without it.
      const _dc = require('./device-capabilities.js');

      // Offload is attempted, not assumed. What llama.cpp does when a backend
      // is present but cannot start is the one thing here that was never
      // measured — simulating it means breaking an installation — so the
      // server is started, checked, and started again without offload if it
      // never answered. The second failure is remembered for this process so
      // every later spawn goes straight to the working configuration.
      const attempts = _offloadFailed ? [true] : [false, true];
      for (const noOffload of attempts) {
        const flags = _dc.inferenceFlags({ bin: BIN, noOffload });
        try { require('child_process').execSync('pkill -f "llama-server.*' + PORT + '" || true', { stdio: 'ignore' }); } catch (_) {}
        // Truncate per spawn ('w', not 'a') + errors-only verbosity: append-mode
        // verbose llama-server logging ballooned this file to 21GB (exact same bug
        // as embed-server.err.log at 49GB). Mirrors local-embedder.js:287/291.
        const fd = require('fs').openSync(logPath, 'w');
        const child = _spawn(BIN, [
          '-m', modelPath, '--reranking', '--pooling', 'rank',
          '-lv', '0', // errors only (see log note above)
          '--port', String(PORT), '--host', '127.0.0.1',
          '-c', String(CONTEXT_SIZE),
          '-b', String(CONTEXT_SIZE), '-ub', String(CONTEXT_SIZE),
          '-ngl', String(flags.ngl),
          '--threads', String(flags.threads)
          // Same as the embedder: Linux needs the loader pointed at the
          // directory holding llama-server's shared objects.
        ], { detached: true, stdio: ['ignore', fd, fd],
             env: Object.assign({}, process.env, {
               LD_LIBRARY_PATH: path.dirname(BIN) +
                 (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '')
             }) });
        child.unref();
        const deadline = Date.now() + 40000;
        while (Date.now() < deadline) {
          if (await _health()) return true;
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (flags.ngl > 0 && !noOffload) {
          _offloadFailed = true;
          try { console.error('[local-reranker] offload did not come up — retrying on cpu'); } catch (_) {}
          continue;
        }
        break;
      }
      _markDead();
      try { console.error('[local-reranker] server health timeout'); } catch (_) {}
      return false;
    } catch (e) {
      _markDead();
      try { console.error('[local-reranker] spawn failed: ' + (e && e.message || e)); } catch (_) {}
      return false;
    }
  })().finally(() => { _serverPromise = null; });
  return _serverPromise;
}

// rerank(query, docs) → Promise<number[] | null>
//   docs: array of candidate texts. Returns relevance scores aligned to docs
//   (higher = more relevant), or null if the reranker is unavailable (caller
//   keeps its existing order). Never throws.
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
    fs.writeFileSync(path.join(dir, 'lastuse-' + PORT + '.txt'), String(Date.now()));
  } catch (_) { /* stamping must never break a real call */ }
}

// A document longer than the server's batch fails the whole request, and
// one long memory would cost every other its verdict. Each document is cut to
// a budget, and a batch the server still calls too large is retried shorter.
const DOC_CHARS = Math.max(200, parseInt(process.env.TROTH_RERANK_DOC_CHARS || '600', 10) || 600);

function _post(query, docs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: String(query), documents: docs });
    const req = _http.request({
      hostname: '127.0.0.1', port: PORT, path: '/rerank', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30000
    }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { let d = null; try { d = JSON.parse(b); } catch (_) { d = null; } resolve({ status: res.statusCode, data: d }); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.write(body); req.end();
  });
}

async function rerank(query, docs) {
  _touchUse();
  if (!query || !Array.isArray(docs) || !docs.length) return null;
  if (!(await ensureServer())) return null;
  let cap = DOC_CHARS;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await _post(String(query), docs.map((d) => String(d || '').slice(0, cap)));
    if (!r) return null;
    const rows = r.data && r.data.results;
    if (Array.isArray(rows)) {
      const out = new Array(docs.length).fill(null);
      for (const row of rows) {
        const idx = (typeof row.index === 'number') ? row.index : null;
        const sc  = (typeof row.relevance_score === 'number') ? row.relevance_score
                  : (typeof row.score === 'number') ? row.score : null;
        if (idx != null && idx >= 0 && idx < out.length) out[idx] = sc;
      }
      return out;
    }
    const msg = String((r.data && r.data.error && r.data.error.message) || '');
    if (r.status === 500 && /too large/i.test(msg) && cap > 300) { cap = Math.max(300, Math.floor(cap / 2)); continue; }
    return null;
  }
  return null;
}

function isAvailable() { return !_isDead() && !!_resolveModelPath(); }

module.exports = { rerank, ensureServer, isAvailable, MODEL_ID, PORT };
