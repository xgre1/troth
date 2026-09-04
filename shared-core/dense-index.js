// SPDX-License-Identifier: AGPL-3.0-only
// dense-index.js — the recallable embeddings held in memory for the dense arm.
//
// Cosine over the whole corpus is the only road to a memory that shares no
// word with the question, and reading every vector out of SQLite on every
// recall is what made that road cost seconds. The vectors are read once,
// quantized to int8 with a per-row scale, and searched in a tight loop; new
// rows join through a created_at cursor, deleted rows fall out at the next
// rebuild, and a rebuild is assembled beside the live index and swapped in
// whole. Building yields to the event loop between chunks, so a long-lived
// process stays responsive while it warms.
'use strict';

const state = require('./state.js');

const REFRESH_MS = 60 * 1000;
const REBUILD_MS = 30 * 60 * 1000;
const CHUNK = 2000;

function _group(dim) {
  return { dim, ids: [], aud: [], q: null, scale: null, norm: null, count: 0, cap: 0 };
}
function _empty() {
  return { groups: new Map(), since: 0, rows: 0 };
}

let S = _empty();
let _ready = false;
let _building = null;
let _builtAt = 0;
let _lastRefreshAt = 0;

function _ensureCapacity(T, n) {
  if (n <= T.cap) return;
  const cap = Math.max(n, Math.ceil(T.cap * 1.5), 4096);
  const q = new Int8Array(cap * T.dim);
  const scale = new Float32Array(cap);
  const norm = new Float32Array(cap);
  if (T.q) { q.set(T.q.subarray(0, T.count * T.dim)); scale.set(T.scale.subarray(0, T.count)); norm.set(T.norm.subarray(0, T.count)); }
  T.q = q; T.scale = scale; T.norm = norm; T.cap = cap;
}

function _addRow(S0, row) {
  let vec;
  try { vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim); } catch (_) { return; }
  if (!(row.dim > 0)) return;
  let T = S0.groups.get(row.dim);
  if (!T) { T = _group(row.dim); S0.groups.set(row.dim, T); }
  S0.rows++;
  if (row.created_at > S0.since) S0.since = row.created_at;
  _ensureCapacity(T, T.count + 1);
  let maxAbs = 0, sq = 0;
  for (let i = 0; i < T.dim; i++) { const v = vec[i]; const a = v < 0 ? -v : v; if (a > maxAbs) maxAbs = a; sq += v * v; }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const base = T.count * T.dim;
  for (let i = 0; i < T.dim; i++) T.q[base + i] = Math.round(vec[i] / scale);
  T.scale[T.count] = scale;
  T.norm[T.count] = Math.sqrt(sq) || 1;
  T.ids[T.count] = row.id;
  T.aud[T.count] = row.audience || null;
  T.count++;
}

function _yield() { return new Promise((r) => setImmediate(r)); }

async function _load(T, since) {
  let iter;
  try { iter = state.streamRecallableEmbeddings(since ? { since_created_at: since } : {}); } catch (_) { return 0; }
  let n = 0;
  for (const row of iter) {
    _addRow(T, row); n++;
    if (n % CHUNK === 0) await _yield();
  }
  return n;
}

function build() {
  if (_building) return _building;
  _building = (async () => {
    const T = _empty();
    const t0 = Date.now();
    let n = 0;
    try { n = await _load(T, 0); }
    finally {
      S = T; _ready = true; _builtAt = Date.now(); _lastRefreshAt = _builtAt;
      _building = null;
    }
    return { rows: n, ms: Date.now() - t0 };
  })();
  return _building;
}

async function refresh() {
  if (!_ready) return build();
  const now = Date.now();
  if (now - _builtAt > REBUILD_MS) return build();
  if (now - _lastRefreshAt < REFRESH_MS) return { rows: 0, ms: 0 };
  _lastRefreshAt = now;
  const t0 = Date.now();
  const n = await _load(S, S.since);
  return { rows: n, ms: Date.now() - t0 };
}

function isReady() { return _ready; }

function search(qVec, k, audienceOk) {
  if (!_ready || !qVec || !qVec.length) return [];
  const T = S.groups.get(qVec.length);
  if (!T || !T.count) return [];
  const dim = T.dim, q = T.q, scale = T.scale, norm = T.norm;
  let qn = 0;
  for (let i = 0; i < dim; i++) qn += qVec[i] * qVec[i];
  qn = Math.sqrt(qn) || 1;
  const top = [];
  let minCos = Infinity, full = false;
  for (let r = 0; r < T.count; r++) {
    if (audienceOk && !audienceOk(T.aud[r])) continue;
    const base = r * dim;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += qVec[i] * q[base + i];
    const cos = (dot * scale[r]) / (qn * norm[r]);
    if (!full) {
      top.push({ id: T.ids[r], cos });
      if (top.length >= k) { top.sort((a, b) => a.cos - b.cos); minCos = top[0].cos; full = true; }
    } else if (cos > minCos) {
      top[0] = { id: T.ids[r], cos };
      top.sort((a, b) => a.cos - b.cos);
      minCos = top[0].cos;
    }
  }
  top.sort((a, b) => b.cos - a.cos);
  return top;
}

function stats() {
  const dims = {};
  let bytes = 0;
  for (const [dim, T] of S.groups) { dims[dim] = T.count; if (T.q) bytes += T.q.byteLength + T.scale.byteLength + T.norm.byteLength; }
  return { ready: _ready, building: !!_building, rows: S.rows, dims, bytes, built_at: _builtAt || null };
}

function _resetForTests() { S = _empty(); _ready = false; _building = null; _builtAt = 0; _lastRefreshAt = 0; }

module.exports = { build, refresh, isReady, search, stats, _resetForTests };
