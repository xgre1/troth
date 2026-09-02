#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One door for the network: a request that did not arrive over loopback, or
// that a browser drove from elsewhere, carries the remote token or gets 401
// on every route but /health. Hermetic: sandbox HOME, a free port, the real
// server, a guest that never closes the operator's proxy.
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== proxy: one door for the network ===\n');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-gate-'));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function req(port, method, url, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: headers || {} }, (res) => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    r.on('error', reject); r.setTimeout(20000, () => r.destroy(new Error('timeout'))); r.end();
  });
}
async function waitUp(port) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try { const r = await req(port, 'GET', '/health'); if (r.status === 200) return; } catch (_) { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('proxy did not come up');
}
function remoteToken() {
  // Wherever the proxy keeps it under this HOME, the token is the one value
  // named like one in its config.
  const dir = path.join(HOME, '.troth');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const k of Object.keys(j)) if (/remote.?token/i.test(k) && typeof j[k] === 'string' && j[k].length >= 16) return j[k];
    } catch (_) { /* not it */ }
  }
  return null;
}

(async () => {
  const port = await freePort();
  const env = Object.assign({}, process.env, { HOME, GF_PORT: String(port), TROTH_KEEP_SIBLINGS: '1' });
  delete env.GF_WATCH_DIR;
  const proxy = spawn(process.execPath, [path.join(ROOT, 'proxy', 'server.js')], { cwd: HOME, env, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    await waitUp(port);
    // A browser page from elsewhere reaching loopback carries a foreign Host:
    // the guard reads that as not-the-operator, exactly like a LAN caller.
    const foreign = { Host: 'evil.example' };

    await t('/health answers anyone', async () => {
      assert.strictEqual((await req(port, 'GET', '/health', foreign)).status, 200);
    });
    await t('a stat, a page and an index route refuse a caller from elsewhere', async () => {
      for (const u of ['/api/stats', '/ui', '/api/codelens/status', '/api/codelens/graph']) {
        const r = await req(port, 'GET', u, foreign);
        assert.strictEqual(r.status, 401, u + ' -> ' + r.status);
      }
    });
    await t('the same routes answer the operator on loopback', async () => {
      for (const u of ['/api/stats', '/api/codelens/status']) {
        const r = await req(port, 'GET', u);
        assert.strictEqual(r.status, 200, u + ' -> ' + r.status);
      }
    });
    await t('the remote token opens the door from elsewhere', async () => {
      const tok = remoteToken();
      assert.ok(tok, 'a remote token exists under the sandbox HOME');
      const r = await req(port, 'GET', '/api/stats', Object.assign({ Authorization: 'Bearer ' + tok }, foreign));
      assert.strictEqual(r.status, 200, 'with token -> ' + r.status);
      const bad = await req(port, 'GET', '/api/stats', Object.assign({ Authorization: 'Bearer not-the-token' }, foreign));
      assert.strictEqual(bad.status, 401);
    });
  } finally {
    proxy.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 800));
    try { proxy.kill('SIGKILL'); } catch (_) { /* gone */ }
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  console.log('\nproxy-remote-gate: ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
