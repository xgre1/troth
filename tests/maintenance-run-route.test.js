#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A maintenance task runs on request, by name, outside its cadence: the
// proxy answers with the task's own note and refuses a name it does not
// know with the list it does. Hermetic: a sandbox HOME, a free port, the
// real server.
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

console.log('\n=== a maintenance task runs on request ===\n');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-run-'));

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
    r.setTimeout(180000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function waitFor(port, pred, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    try { last = await req(port, 'GET', '/health'); if (last.status === 200 && pred(last.json)) return last; } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('condition not met on ' + port + '; last ' + (last ? last.text.slice(0, 200) : 'no answer'));
}

function boot(port) {
  // A test proxy is a guest: it never closes the operator's own proxy as a stray.
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
    await waitFor(port, () => true, 30000);
    await t('an unknown task is refused with the list of known ones', async () => {
      const r = await req(port, 'POST', '/api/maintenance/run', { task: 'nope' });
      assert.strictEqual(r.status, 404, r.text.slice(0, 200));
      assert.ok(r.json && Array.isArray(r.json.tasks) && r.json.tasks.includes('memory_hygiene'), r.text.slice(0, 300));
    });
    await t('the hygiene pass runs now and answers with its note', async () => {
      const r = await req(port, 'POST', '/api/maintenance/run', { task: 'memory_hygiene' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.ok(r.json.ok && r.json.task === 'memory_hygiene', r.text.slice(0, 300));
      assert.ok(r.json.notes.some((n) => /^memory_hygiene: scanned=/.test(n)), JSON.stringify(r.json.notes));
    });
  } catch (e) {
    console.log('  ✗ the proxy came up: ' + e.message + '\n' + child.logText().slice(-600)); fail++;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  console.log('\nmaintenance-run-route: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
