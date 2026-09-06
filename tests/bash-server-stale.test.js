#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The shell server says once, on the first command, when the walls it loaded
// are older than the files in the checkout; a fresh server says nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');

function client(extraEnv) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stale-'));
  fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
  const env = Object.assign({}, process.env, { HOME: home, TROTH_CONFIG_DIR: path.join(home, '.troth'), TROTH_BASH_CWD: home }, extraEnv || {});
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
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
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    pending.set(myId, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const run = async (command) => {
    const m = await rpc('tools/call', { name: 'run', arguments: { command } });
    const text = ((m.result && m.result.content) || []).map((b) => b.text || '').join('\n');
    return { text, notes: (text.match(/\[troth-bash\][^\n]*/g) || []).join(' ') };
  };
  const init = () => rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return { run, init, kill: () => { try { proc.kill('SIGKILL'); } catch (_) {} fs.rmSync(home, { recursive: true, force: true }); } };
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== shell server: walls older than the checkout ===\n');

(async () => {
  await t('a server whose walls predate the checkout says so once, on the first command', async () => {
    const c = client({ TROTH_BASH_LOADED_AT: '1000' });
    try {
      await c.init();
      const first = await c.run('echo one');
      assert.ok(/loaded its walls at/.test(first.notes), 'the first command must carry the note: ' + first.text.slice(0, 200));
      assert.ok(/server\.mjs/.test(first.notes), 'the note names a changed file: ' + first.notes);
      assert.ok(/session restart/.test(first.notes), 'the note names the way through: ' + first.notes);
      const second = await c.run('echo two');
      assert.ok(!/loaded its walls/.test(second.notes), 'the note must not repeat: ' + second.notes);
    } finally { c.kill(); }
  });

  await t('a fresh server says nothing', async () => {
    const c = client({});
    try {
      await c.init();
      const r = await c.run('echo one');
      assert.ok(!/loaded its walls/.test(r.notes), 'a current server carried the note: ' + r.notes);
    } finally { c.kill(); }
  });

  console.log('\nbash-server-stale: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
