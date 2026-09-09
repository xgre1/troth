#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The proxy carries Identity: readiness names its road and settings, the
// config road keeps the identity block whole across partial saves, and the
// reader answers 409 while Identity is not open to the operator's engine, so
// a pass spends nothing by accident. Hermetic: a sandbox HOME, a free port,
// the real server.
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

console.log('\n=== identity rides the proxy ===\n');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-route-'));
fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });

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
    try { last = await req(port, 'GET', '/health'); if (last.status === 200 && pred(last)) return last; } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('condition not met on ' + port + '; last ' + (last ? last.text.slice(0, 200) : 'no answer'));
}
function boot(port) {
  const env = Object.assign({}, process.env, { HOME, GF_PORT: String(port), TROTH_KEEP_SIBLINGS: '1', TROTH_NO_MODEL_FETCH: '1' });
  delete env.GF_WATCH_DIR;
  delete env.TROTH_CONFIG_PATH;
  delete env.TROTH_IDENTITY_ENGINE;
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
    await t('readiness carries the identity block: local only, no model, 400 a day, no road yet', async () => {
      const r = await req(port, 'GET', '/api/memory/readiness');
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      const id = r.json && r.json.identity;
      assert.ok(id, 'identity missing: ' + r.text.slice(0, 300));
      assert.strictEqual(id.engine, 'auto');
      assert.strictEqual(id.model, '');
      assert.strictEqual(id.daily_turns, 400);
      assert.ok(id.budget && id.budget.limit === 400, JSON.stringify(id));
    });
    await t('the reader answers 409 while Identity is not open to the engine, and 400 to an empty prompt', async () => {
      const r = await req(port, 'POST', '/api/identity/read', { prompt: 'The person works two days a week at Northwind.' });
      assert.strictEqual(r.status, 409, r.text.slice(0, 200));
      assert.strictEqual(r.json.error, 'identity_engine_closed');
      const e = await req(port, 'POST', '/api/identity/read', { prompt: '' });
      assert.strictEqual(e.status, 400, e.text.slice(0, 200));
    });
    await t('a partial save keeps the rest of the identity block, and readiness follows it', async () => {
      let s = await req(port, 'POST', '/api/config', { identity: { engine: 'on', model: 'gpt-5.4-mini', daily_turns: 120 } });
      assert.strictEqual(s.status, 200, s.text.slice(0, 200));
      s = await req(port, 'POST', '/api/config', { identity: { daily_turns: 90 } });
      assert.strictEqual(s.status, 200, s.text.slice(0, 200));
      const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.troth', 'config.json'), 'utf8'));
      assert.deepStrictEqual(cfg.identity, { engine: 'on', model: 'gpt-5.4-mini', daily_turns: 90 });
      const g = await req(port, 'GET', '/api/config');
      assert.deepStrictEqual(g.json.identity, { engine: 'on', model: 'gpt-5.4-mini', daily_turns: 90 });
    });
    await t('open to the engine with no engine set up, the reader says no engine answered', async () => {
      const r = await req(port, 'POST', '/api/identity/read', { prompt: 'The person works two days a week at Northwind.' });
      assert.strictEqual(r.status, 503, r.text.slice(0, 200));
      assert.strictEqual(r.json.error, 'no_engine_answered');
    });
  } catch (e) {
    console.log('  ✗ the proxy came up: ' + e.message + '\n' + child.logText().slice(-600)); fail++;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  console.log('\nidentity-route: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
