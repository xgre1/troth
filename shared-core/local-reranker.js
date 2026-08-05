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
const DEAD_RETRY_MS = 10 * 60 * 1000;
function _isDead() { return _deadAt > 0 && (Date.now() - _deadAt) < DEAD_RETRY_MS; }
function _markDead() { _deadAt = Date.now(); }
let _modelDownloading = false;

function _health(timeoutMs) {
  return new Promise((resolve) => {
    const req = _http.request({ hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: timeoutMs || 1200 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve((JSON.parse(b) || {}).status === 'ok'); } catch (_) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.end();
  });
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
  if (await _health()) { _deadAt = 0; return true; }
  if (_serverPromise) return _serverPromise;
  _serverPromise = (async () => {
    let BIN = null;
    try { const ls = require('./local-server.js'); await ls.ensureBinary(); BIN = ls.BIN; } catch (_) {}
    if (!BIN || !require('fs').existsSync(BIN)) { _markDead(); return false; }
    const modelPath = _resolveModelPath();
    if (!modelPath) {
      // Reranker GGUF not present: kick the ONE-TIME background download
      // ( — shipped users previously never got this model by any
      // path, so recall silently lacked its final quality stage forever).
      // Source verified live on HF (gpustack/bge-reranker-v2-m3-GGUF, same
      // filename the operator's hand-placed working copy uses). Non-blocking:
      // THIS call stays disabled (lexical+dense order) and a later call finds
      // the file. TROTH_NO_MODEL_FETCH=1 (hermetic tests / metered networks)
      // suppresses the fetch entirely. .part + rename = never a half GGUF.
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
      try { require('child_process').execSync('pkill -f "llama-server.*' + PORT + '" || true', { stdio: 'ignore' }); } catch (_) {}
      // Truncate per spawn ('w', not 'a') + errors-only verbosity: append-mode
      // verbose llama-server logging ballooned this file to 21GB (exact same bug
      // as embed-server.err.log at 49GB). Mirrors local-embedder.js:287/291.
      const fd = require('fs').openSync(logPath, 'w');
      const child = _spawn(BIN, [
        '-m', modelPath, '--reranking', '--pooling', 'rank',
        '-lv', '0', // errors only (see log note above)
        '--port', String(PORT), '--host', '127.0.0.1',
        '-c', String(CONTEXT_SIZE), '-ngl', String(RERANK_NGL)
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

async function rerank(query, docs) {
  _touchUse();
  if (!query || !Array.isArray(docs) || !docs.length) return null;
  if (!(await ensureServer())) return null;
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: String(query), documents: docs.map(d => String(d || '')) });
    const req = _http.request({
      hostname: '127.0.0.1', port: PORT, path: '/rerank', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30000
    }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(b);
          const r = d && d.results;
          if (!Array.isArray(r)) { resolve(null); return; }
          const out = new Array(docs.length).fill(null);
          for (const row of r) {
            const idx = (typeof row.index === 'number') ? row.index : null;
            const sc  = (typeof row.relevance_score === 'number') ? row.relevance_score
                      : (typeof row.score === 'number') ? row.score : null;
            if (idx != null && idx >= 0 && idx < out.length) out[idx] = sc;
          }
          resolve(out);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.write(body); req.end();
  });
}

function isAvailable() { return !_isDead() && !!_resolveModelPath(); }

module.exports = { rerank, ensureServer, isAvailable, MODEL_ID, PORT };
