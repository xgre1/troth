#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A host without hooks asks the proxy for the context a prompt gets and the
// context a session starts with; the answer is what the hooks build.
// Hermetic: a sandbox HOME, a free port, the real server.
require('./hermetic-db.js');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== the context a prompt gets, over the proxy ===\n');

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
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject);
    r.setTimeout(120000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
async function waitFor(port, ms) {
  const until = Date.now() + ms; let last = null;
  while (Date.now() < until) {
    try { last = await req(port, 'GET', '/health'); if (last.status === 200) return last; } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('the proxy did not come up on ' + port + '; last ' + (last ? last.text.slice(0, 200) : 'no answer'));
}
function boot(port) {
  const env = Object.assign({}, process.env, { HOME, GF_PORT: String(port), TROTH_KEEP_SIBLINGS: '1', TROTH_NO_MODEL_FETCH: '1', TROTH_EMBED_PORT: '9', TROTH_EMBEDDING_HOST: 'http://127.0.0.1:9', TROTH_RERANK_PORT: '9' });
  delete env.GF_WATCH_DIR;
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy', 'server.js')], { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', c => { log += c; }); child.stderr.on('data', c => { log += c; });
  child.logText = () => log;
  return child;
}

(async () => {
  const port = await freePort();
  const child = boot(port);
  try {
    await waitFor(port, 30000);
    const anchor = 'The operator runs the whole test suite before every commit';
    await t('an anchor the operator stated comes back in the context of a prompt about it', async () => {
      const w = await req(port, 'POST', '/api/substrate/identity', { agent_id: 'hermes', anchors: [anchor] });
      assert.strictEqual(w.status, 200, w.text.slice(0, 200));
      const r = await req(port, 'POST', '/api/context/prompt', { prompt: 'what do I do before every commit?', session_id: 'hermes-1', cwd: HOME });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.ok(typeof r.json.context === 'string', 'a context string');
      assert.ok(/\[troth\//.test(r.json.context), 'the hooks\' blocks are there: ' + r.json.context.slice(0, 200));
      assert.ok(r.json.context.indexOf('whole test suite before every commit') !== -1, 'the anchor is served: ' + r.json.context.slice(0, 400));
    });
    await t('a session context comes back for a session start', async () => {
      const r = await req(port, 'POST', '/api/context/session', { session_id: 'hermes-1', cwd: HOME });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.ok(typeof r.json.context === 'string' && Number.isFinite(r.json.ms), r.text.slice(0, 200));
    });
    await t('a prompt is required', async () => {
      const r = await req(port, 'POST', '/api/context/prompt', { session_id: 'hermes-1' });
      assert.strictEqual(r.status, 400, r.text.slice(0, 200));
    });
    await t('a turn recorded by the provider is a turn in the substrate', async () => {
      const r = await req(port, 'POST', '/api/substrate/dialogue/record-turn', { conv_id: 'hermes-1', agent_id: 'hermes', role: 'user', content: 'ship the release tomorrow morning', cwd: HOME });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    });
    await t('the provider module compiles', async () => {
      let py = null;
      try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); py = 'python3'; } catch (_) { py = null; }
      if (!py) { console.log('    (no python3 here; compile check skipped)'); return; }
      execFileSync(py, ['-m', 'py_compile', path.join(ROOT, 'integrations', 'hermes', 'memory', 'troth', '__init__.py')], { stdio: 'pipe' });
      assert.ok(fs.existsSync(path.join(ROOT, 'integrations', 'hermes', 'memory', 'troth', 'plugin.yaml')));
    });
  } catch (e) {
    console.log('  ✗ the proxy came up: ' + e.message + '\n' + child.logText().slice(-600)); fail++;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  console.log('\ncontext-routes: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
