// SPDX-License-Identifier: AGPL-3.0-only
// read-worker.js — heavy read-only questions leave the event loop.
//
// A count over the whole substrate, a usage window, the memory readiness:
// each is seconds of synchronous SQLite on a large database, and on the
// proxy's own thread every one of them froze every request, every hook and
// every turn for as long as it ran. They run here on a worker thread with
// its own handle instead. memo() keeps the last answer and serves it while
// a fresh one is computed, so a route that is polled every few seconds
// never waits; peek() is the same for a caller that cannot await.
'use strict';

const path = require('path');

let _worker = null;
let _seq = 0;
const _pending = new Map();
const _memo = new Map();

function _failAll(err) {
  for (const p of _pending.values()) { clearTimeout(p.timer); p.reject(err); }
  _pending.clear();
}

function _ensure() {
  if (_worker) return _worker;
  const { Worker } = require('worker_threads');
  const w = new Worker(path.join(__dirname, 'read-worker-thread.js'), { env: process.env });
  w.on('message', (m) => {
    const p = m && _pending.get(m.id);
    if (!p) return;
    _pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  w.on('error', (e) => { _failAll(e); _worker = null; });
  w.on('exit', () => { _failAll(new Error('read worker exited')); _worker = null; });
  w.unref();
  _worker = w;
  return w;
}

function run(job, args, opts) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = _ensure(); } catch (e) { return reject(e); }
    const id = ++_seq;
    const timer = setTimeout(() => { _pending.delete(id); reject(new Error('read worker timeout: ' + job)); }, (opts && opts.timeout_ms) || 60000);
    _pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, job, args: args || {} });
  });
}

function _refresh(entry, job, args, opts) {
  entry.inflight = run(job, typeof args === 'function' ? args() : args, opts)
    .then((v) => { entry.value = v; entry.at = Date.now(); entry.inflight = null; return v; })
    .catch((e) => { entry.inflight = null; entry.error = e; throw e; });
  return entry.inflight;
}

// The last answer at once and a fresh one behind it when the old is past ttl;
// only the very first call waits for the worker.
function memo(key, ttlMs, job, args, opts) {
  let entry = _memo.get(key);
  if (!entry) { entry = { value: undefined, at: 0, inflight: null, error: null }; _memo.set(key, entry); }
  if (entry.value !== undefined) {
    if (Date.now() - entry.at > ttlMs && !entry.inflight) _refresh(entry, job, args, opts).catch(() => {});
    return Promise.resolve(entry.value);
  }
  return entry.inflight || _refresh(entry, job, args, opts);
}

// For a caller that cannot await: the last answer or null, with a refresh
// scheduled when none is held or the held one is past ttl.
function peek(key, ttlMs, job, args, opts) {
  let entry = _memo.get(key);
  if (!entry) { entry = { value: undefined, at: 0, inflight: null, error: null }; _memo.set(key, entry); }
  if ((entry.value === undefined || Date.now() - entry.at > ttlMs) && !entry.inflight) _refresh(entry, job, args, opts).catch(() => {});
  return entry.value === undefined ? null : entry.value;
}

function warm(key, ttlMs, job, args, opts) { return memo(key, ttlMs, job, args, opts).catch(() => null); }

function _resetForTests() { _memo.clear(); }

module.exports = { run, memo, peek, warm, _resetForTests };
