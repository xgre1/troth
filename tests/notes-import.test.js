#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A folder of notes on this machine becomes knowledge: the folder is checked
// (under home, a directory with notes, never the substrate), the vaults
// Obsidian knows are offered, and the import queues one row per file for the
// reader. Hermetic: a sandbox HOME, a free port, the real server.
require('./hermetic-db.js');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

console.log('\n=== notes on this machine become knowledge ===\n');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.HOME;
const ni = require(path.join(ROOT, 'shared-core', 'notes-import.js'));

const vault = path.join(HOME, 'Notes', 'my-vault');
fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
fs.mkdirSync(path.join(vault, 'daily'), { recursive: true });
fs.writeFileSync(path.join(vault, 'Marble suppliers.md'), '# Marble suppliers\n\nThe Carrara quarry answers within a week and ships in crates of twelve slabs.\n');
fs.writeFileSync(path.join(vault, 'daily', '2026-09-01.md'), 'Called the print shop about the tracker demo on Saturday; they want the QR labels on every job ticket and a role for the foreman.\n');
fs.writeFileSync(path.join(vault, 'daily', 'scratch.md'), 'todo\n');
fs.writeFileSync(path.join(vault, 'daily', 'photo.png'), 'not a note');
const registry = path.join(HOME, 'obsidian.json');
fs.writeFileSync(registry, JSON.stringify({ vaults: { abc: { path: vault, ts: 1, open: true }, gone: { path: path.join(HOME, 'missing-vault'), ts: 1 } } }));
process.env.TROTH_OBSIDIAN_REGISTRY = registry;

function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function req(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); r.setTimeout(120000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
async function waitFor(port, ms) {
  const until = Date.now() + ms; let last = null;
  while (Date.now() < until) { try { last = await req(port, 'GET', '/health'); if (last.status === 200) return last; } catch (_) {} await new Promise(r => setTimeout(r, 300)); }
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
  await t('the vaults Obsidian knows are offered, those that exist', async () => {
    const v = ni.detectVaults();
    assert.deepStrictEqual(v.map((x) => x.path), [vault]);
    assert.strictEqual(v[0].name, 'my-vault');
    assert.ok(v[0].notes >= 1, 'a vault carries its note count: ' + JSON.stringify(v[0]));
    assert.strictEqual(v[0].app, 'obsidian');
  });
  await t('a folder is checked before anything reads it', async () => {
    assert.strictEqual(ni.checkFolder('').ok, false);
    assert.strictEqual(ni.checkFolder('relative/notes').ok, false);
    assert.strictEqual(ni.checkFolder(path.join(os.tmpdir(), 'elsewhere-' + process.pid)).ok, false, 'outside home');
    assert.strictEqual(ni.checkFolder(path.join(HOME, '.troth')).ok, false, 'the substrate folder');
    assert.strictEqual(ni.checkFolder(path.join(HOME, 'nowhere')).ok, false, 'a missing folder');
    const empty = path.join(HOME, 'empty'); fs.mkdirSync(empty, { recursive: true });
    assert.strictEqual(ni.checkFolder(empty).ok, false, 'no notes');
    const ok = ni.checkFolder(vault);
    assert.ok(ok.ok && ok.notes === 2 && ok.obsidian === true, JSON.stringify(ok));
    assert.strictEqual(ni.checkFolder('~/Notes/my-vault').path, vault, 'a tilde path is the home path');
  });

  const port = await freePort();
  const child = boot(port);
  try {
    await waitFor(port, 30000);
    await t('the Memory page can offer the vault', async () => {
      const r = await req(port, 'GET', '/api/memory/notes-sources');
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.deepStrictEqual(r.json.vaults.map((v) => v.path), [vault]);
    });
    await t('a folder outside the home directory is refused', async () => {
      const r = await req(port, 'POST', '/api/memory/import-notes', { path: path.join(os.tmpdir(), 'elsewhere-' + process.pid) });
      assert.strictEqual(r.status, 400, r.text.slice(0, 200));
    });
    await t('the vault is queued for the reader, one row per note', async () => {
      const r = await req(port, 'POST', '/api/memory/import-notes', { path: vault });
      assert.strictEqual(r.status, 200, r.text.slice(0, 300));
      assert.ok(r.json.started && r.json.notes === 2 && r.json.obsidian === true, r.text.slice(0, 300));
      let rows = [];
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        const q = await req(port, 'GET', '/api/memory/queue?q=my-vault&limit=20');
        rows = (q.json && q.json.rows) || [];
        if (rows.length >= 2) break;
        await new Promise(res => setTimeout(res, 500));
      }
      assert.strictEqual(rows.length, 2, 'two notes queued: ' + JSON.stringify(rows).slice(0, 300));
      const refs = rows.map((x) => x.ref || x.path || JSON.stringify(x)).join(' | ');
      assert.ok(/Marble suppliers\.md/.test(refs) && /2026-09-01\.md/.test(refs), refs);
      assert.ok(!/photo\.png/.test(refs), 'the image is not a note');
      assert.ok(!/scratch\.md/.test(refs), 'a note under eighty bytes holds nothing the reader keeps');
    });
  } catch (e) {
    console.log('  ✗ the proxy came up: ' + e.message + '\n' + child.logText().slice(-600)); fail++;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  console.log('\nnotes-import: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
