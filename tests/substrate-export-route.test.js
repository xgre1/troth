#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A copy of the substrate is written to a folder the operator names: the
// bundle lands under the home directory and outside the substrate's own
// folder, and a folder elsewhere is refused. Hermetic: a sandbox HOME, a free
// port, the real server.
require('./hermetic-db.js');
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

console.log('\n=== a copy of the substrate goes where the operator says ===\n');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.HOME;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function req(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* not json */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject);
    r.setTimeout(120000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function waitFor(port, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    try { last = await req(port, 'GET', '/health'); if (last.status === 200) return last; } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('the proxy did not come up on ' + port + '; last ' + (last ? last.text.slice(0, 200) : 'no answer'));
}

function boot(port) {
  const env = Object.assign({}, process.env, { HOME, GF_PORT: String(port), TROTH_KEEP_SIBLINGS: '1', TROTH_NO_MODEL_FETCH: '1' });
  delete env.GF_WATCH_DIR;
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy', 'server.js')], { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  child.logText = () => log;
  return child;
}

(async () => {
  const port = await freePort();
  const child = boot(port);
  try {
    await waitFor(port, 30000);
    await t('a folder under the home directory receives the bundle', async () => {
      const outDir = path.join(HOME, 'copies');
      const r = await req(port, 'POST', '/api/repair/export', { out_dir: outDir });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.ok(r.json.ok && r.json.db && r.json.db.startsWith(outDir), r.text.slice(0, 300));
      assert.ok(fs.existsSync(r.json.db), 'state.db at ' + r.json.db);
      assert.ok(fs.statSync(r.json.db).size > 0, 'the copy holds the database');
    });
    await t('the substrate folder itself is refused', async () => {
      const r = await req(port, 'POST', '/api/repair/export', { out_dir: path.join(HOME, '.troth', 'copies') });
      assert.strictEqual(r.status, 400, r.text.slice(0, 300));
    });
    await t('a folder outside the home directory is refused', async () => {
      const r = await req(port, 'POST', '/api/repair/export', { out_dir: path.join(os.tmpdir(), 'elsewhere-' + process.pid) });
      assert.strictEqual(r.status, 400, r.text.slice(0, 300));
      const none = await req(port, 'POST', '/api/repair/export', {});
      assert.strictEqual(none.status, 400, none.text.slice(0, 300));
    });
  } catch (e) {
    console.log('  ✗ the proxy came up: ' + e.message + '\n' + child.logText().slice(-600)); fail++;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  console.log('\nsubstrate-export-route: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
