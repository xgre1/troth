#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A local model server that is busy is alive: the reranker and the embedder
// wait for a port that answers late or is still loading, go without it when
// it stays busy, and never start a second server over it. A port where
// nothing listens is started (or, with no binary, given up on quickly and
// remembered).
require('./hermetic-db.js');
const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');

const CORE = path.join(__dirname, '..', 'shared-core');
let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch((e) => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// A fake llama-server whose /health behaviour is decided per request.
function fakeServer(port, behaviour) {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    const b = behaviour(++calls);
    setTimeout(() => {
      res.writeHead(b.code || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: b.status }));
    }, b.delayMs || 0);
  });
  srv.calls = () => calls;
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}
function closed(srv) { return new Promise((r) => srv.close(r)); }

(async () => {
  console.log('\n=== a busy local server is waited for ===\n');
  process.env.TROTH_SERVER_BUSY_WAIT_MS = '4000';
  const rerankPort = await freePort();
  const embedPort = await freePort();
  process.env.TROTH_RERANK_PORT = String(rerankPort);
  process.env.TROTH_EMBED_PORT = String(embedPort);
  const reranker = require(path.join(CORE, 'local-reranker.js'));
  const embedder = require(path.join(CORE, 'local-embedder.js'));

  await t('a reranker that answers late is waited for and kept', async () => {
    const srv = await fakeServer(rerankPort, () => ({ delayMs: 2000, status: 'ok' }));
    try {
      const t0 = Date.now();
      assert.strictEqual(await reranker.ensureServer(), true, 'the late answer counts as alive');
      assert.ok(Date.now() - t0 >= 1500, 'it waited for the answer');
    } finally { await closed(srv); }
  });

  await t('a reranker still loading its model is waited for', async () => {
    const srv = await fakeServer(rerankPort, (n) => (n <= 3 ? { code: 503, status: 'loading model' } : { status: 'ok' }));
    try { assert.strictEqual(await reranker.ensureServer(), true, 'ready after loading'); }
    finally { await closed(srv); }
  });

  await t('a reranker that stays busy is left alone and this call goes without it', async () => {
    const srv = await fakeServer(rerankPort, () => ({ delayMs: 6000, status: 'ok' }));
    try {
      const t0 = Date.now();
      assert.strictEqual(await reranker.ensureServer(), false, 'no verdict this time');
      assert.ok(Date.now() - t0 < 9000, 'bounded wait: ' + (Date.now() - t0) + ' ms');
      // Still alive: a quick answer now is accepted, nothing was started over it.
      srv.removeAllListeners('request');
      srv.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); });
      assert.strictEqual(await reranker.ensureServer(), true, 'the same server serves the next call');
    } finally { await closed(srv); }
  });

  await t('an embedder that answers late is waited for and kept', async () => {
    const srv = await fakeServer(embedPort, () => ({ delayMs: 2000, status: 'ok' }));
    try { assert.strictEqual(await embedder.ensureServer(), true, 'the late answer counts as alive'); }
    finally { await closed(srv); }
  });

  await t('a port where nothing listens is given up on quickly without a binary', async () => {
    const t0 = Date.now();
    assert.strictEqual(await reranker.ensureServer(), false);
    assert.ok(Date.now() - t0 < 3000, 'no long wait: ' + (Date.now() - t0) + ' ms');
    const t1 = Date.now();
    assert.strictEqual(await reranker.ensureServer(), false);
    assert.ok(Date.now() - t1 < 500, 'remembered as down: ' + (Date.now() - t1) + ' ms');
  });

  console.log('\nlocal-server-busy: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
