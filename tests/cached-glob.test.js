#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// cached_glob in the troth-cache plugin server: a cold listing walks the
// tree, a warm one serves from the cache with the same names, the read
// policy withholds what it refuses, and a missing pattern is refused.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-cache', 'server.mjs');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

function client(env) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, env || {}) });
  let buf = ''; const pending = new Map(); let id = 1;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m && m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  proc.stderr.on('data', () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const myId = id++;
    const timer = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    pending.set(myId, (m) => { clearTimeout(timer); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args });
    if (m.error) return { error: m.error };
    const text = ((m.result && m.result.content) || []).filter((b) => b && b.text && !/^\[troth\] Substrate active/.test(b.text)).map((b) => b.text).join('\n');
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { text, json: j, isError: !!(m.result && m.result.isError) };
  };
  return { rpc, call, close: () => { try { proc.kill('SIGTERM'); } catch (_) {} } };
}

(async () => {
  console.log('cached-glob');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-cglob-'));
  fs.mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(ws, 'src', 'deep', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(ws, 'src', 'c.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=nope\n');
  const c = client({ TROTH_CACHE_CWD: ws });
  try {
    await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });

    await t('the tool is listed and the instructions name it', async () => {
      const init = await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      assert.ok(/cached_glob over Glob/.test(String(init.result && init.result.instructions)), 'instructions: ' + (init.result && init.result.instructions));
      const list = await c.rpc('tools/list', {});
      const tool = ((list.result && list.result.tools) || []).find((x) => x.name === 'cached_glob');
      assert.ok(tool, 'cached_glob is offered');
      assert.deepStrictEqual(tool.inputSchema.required, ['pattern']);
    });

    await t('cold: the listing walks the tree, newest first; warm: the same names from the cache', async () => {
      const cold = await c.call('cached_glob', { pattern: 'src/**/*.ts', cwd: ws });
      assert.ok(cold.json, 'json reply: ' + cold.text);
      assert.strictEqual(cold.json.cached, false);
      assert.strictEqual(cold.json.source, 'fs');
      const names = cold.json.filenames.map((f) => path.relative(ws, f)).sort();
      assert.deepStrictEqual(names, ['src/a.ts', 'src/deep/b.ts']);
      assert.strictEqual(cold.json.numFiles, 2);
      assert.strictEqual(cold.json.output.split('\n').length, 2, 'output is one path per line');
      const warm = await c.call('cached_glob', { pattern: 'src/**/*.ts', cwd: ws });
      assert.strictEqual(warm.json.cached, true, 'served from the cache: ' + warm.text);
      assert.strictEqual(warm.json.source, 'troth-cache');
      assert.strictEqual(warm.json.key_prefix, cold.json.key_prefix);
      assert.deepStrictEqual(warm.json.filenames.map((f) => path.relative(ws, f)).sort(), names);
      const other = await c.call('cached_glob', { pattern: '**/*.js', cwd: ws });
      assert.strictEqual(other.json.cached, false, 'another pattern is another key');
      assert.deepStrictEqual(other.json.filenames.map((f) => path.relative(ws, f)), ['src/c.js']);
    });

    await t('the read policy withholds what it refuses; a missing pattern is refused', async () => {
      const wide = await c.call('cached_glob', { pattern: '**/*', cwd: ws });
      assert.ok(wide.json, 'json reply: ' + wide.text);
      const rel = wide.json.filenames.map((f) => path.relative(ws, f));
      assert.ok(!rel.includes('.env'), 'the credential file is not named: ' + JSON.stringify(rel));
      assert.ok(wide.json.withheld >= 1, 'the withholding is counted: ' + wide.text);
      const bad = await c.call('cached_glob', { cwd: ws });
      assert.ok(bad.error && /missing pattern/.test(bad.error.message), 'refused: ' + JSON.stringify(bad));
      const nodir = await c.call('cached_glob', { pattern: '*.ts', path: 'nowhere-here', cwd: ws });
      assert.ok(nodir.error && /not_found/.test(nodir.error.message), 'a missing folder is named: ' + JSON.stringify(nodir));
    });
  } finally {
    c.close();
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\ncached-glob: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
