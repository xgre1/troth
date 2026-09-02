#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Code Map routes. The proxy says which project it indexes, takes another
// over POST /api/codelens/index, and remembers the choice across a restart
// that begins where an app bundle begins: in the home folder, which is not
// a project. Hermetic: a sandbox HOME, a free port, the real server.
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

console.log('\n=== Code Map routes ===\n');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-routes-'));
const PROJECT = path.join(ROOT, 'proxy', 'modules', 'codelens');

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
    try { last = await req(port, 'GET', '/api/codelens/status'); if (last.status === 200 && pred(last.json)) return last; } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('condition not met on ' + port + '; last ' + (last ? last.text.slice(0, 200) : 'no answer'));
}

function boot(port) {
  // A test proxy is a guest: it never closes the operator's own proxy as a stray.
  const env = Object.assign({}, process.env, { HOME, GF_PORT: String(port), TROTH_KEEP_SIBLINGS: "1" });
  delete env.GF_WATCH_DIR;
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy', 'server.js')], { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  child.logText = () => log;
  return child;
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 4000);
  });
}

function configWithRoot() {
  // Wherever the proxy keeps its config under this HOME, the choice is in it.
  const dir = path.join(HOME, '.troth');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && typeof j.codelens_root === 'string') return j.codelens_root;
    } catch (_) { /* not the one */ }
  }
  return null;
}

(async () => {
  const port = await freePort();
  let proxy = boot(port);
  try {
    await t('started in the home folder, the proxy reports no project rather than an empty map', async () => {
      const r = await waitFor(port, () => true, 60000);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.indexed, false, 'nothing indexed: ' + r.text.slice(0, 200));
    });

    await t('the home folder is refused as a project', async () => {
      const r = await req(port, 'POST', '/api/codelens/index', { dir: '~' });
      assert.ok(r.status >= 400 && r.status < 500, 'status ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(r.json && r.json.error, 'a reason is given');
    });

    await t('a folder that does not exist is refused', async () => {
      const r = await req(port, 'POST', '/api/codelens/index', { dir: path.join(HOME, 'no-such-project') });
      assert.ok(r.status >= 400 && r.status < 500, 'status ' + r.status);
    });

    await t('a project folder is indexed and becomes the map', async () => {
      const r = await req(port, 'POST', '/api/codelens/index', { dir: PROJECT });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(path.resolve(r.json.root), PROJECT);
      const s = await waitFor(port, (j) => j.indexed === true && j.entities > 0, 60000);
      assert.strictEqual(path.resolve(s.json.root), PROJECT);
      const g = await req(port, 'GET', '/api/codelens/graph');
      assert.strictEqual(g.status, 200);
      const nodes = (g.json && (g.json.nodes || g.json.entities)) || [];
      assert.ok(nodes.length > 0, 'the graph has nodes');
    });

    await t('the choice is written to the config', async () => {
      const root = configWithRoot();
      assert.ok(root, 'codelens_root in the config');
      assert.strictEqual(path.resolve(root), PROJECT);
    });

    await stop(proxy);

    await t('restarted from the home folder, the proxy indexes the remembered project', async () => {
      proxy = boot(port);
      const s = await waitFor(port, (j) => j.indexed === true && j.entities > 0, 90000);
      assert.strictEqual(path.resolve(s.json.root), PROJECT);
    });
  } finally {
    await stop(proxy);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  console.log('\ncodelens-routes: ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
