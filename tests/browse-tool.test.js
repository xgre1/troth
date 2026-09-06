#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// browse for the CLI agent: one shared road for the plugin and the core
// tool; explicit ports stay attach-only with the same words; a call with url
// alone is a read, eval or screenshot a write. No browser is ever started
// here: the live case attaches only to a troth browser already alive.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const browse = require('../shared-core/tools/browse.js');
const permission = require('../shared-core/tools/permission.js');
const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');

let pass = 0, fail = 0, skipped = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { if (e && e.skip) { console.log('  ○ SKIP ' + name + ' (' + e.skip + ')'); skipped++; return; } console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const skip = (why) => { const e = new Error(why); e.skip = why; throw e; };

// A port nothing listens on.
function deadPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function mcpClient(env) {
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
  return { rpc, close: () => { try { proc.kill('SIGTERM'); } catch (_) {} } };
}

(async () => {
  console.log('browse-tool');

  await t('registered; url alone is a read, eval or screenshot a write, and the gate asks per call', async () => {
    const reg = require('../shared-core/tools/index.js');
    assert.ok((reg.REGISTRY && reg.REGISTRY.browse) || (reg.unifiedRegistry && reg.unifiedRegistry().browse), 'in the registry');
    assert.strictEqual(permission.classifyCall('browse', { url: 'https://example.com' }), 'read');
    assert.strictEqual(permission.classifyCall('browse', { url: 'https://example.com', eval: 'document.title' }), 'write');
    assert.strictEqual(permission.classifyCall('browse', { screenshot: 'shot.png' }), 'write');
    assert.strictEqual(permission.classifyCall('Read', {}), 'read', 'other tools keep the name-level answer');
    let ran = 0;
    const gated = permission.wrapRunner(async () => { ran++; return 'ran'; });
    const call = (args) => ({ function: { name: 'browse', arguments: JSON.stringify(args) } });
    const w = JSON.parse(await gated(call({ url: 'https://example.com', eval: '1' }), { auto_write: false }));
    assert.ok(w.error, 'eval without auto_write is refused: ' + JSON.stringify(w));
    assert.strictEqual(ran, 0);
    const r = await gated(call({ url: 'https://example.com' }), { auto_write: false });
    assert.strictEqual(r, 'ran', 'url alone passes as a read');
  });

  await t('an explicit port that nothing answers on is attach-only: the core tool says so', async () => {
    const port = await deadPort();
    const r = await browse.run({ port, url: 'about:blank' }, { cwd: os.tmpdir() });
    assert.strictEqual(r.error, 'browse_failed');
    assert.ok(r.detail.startsWith('no debuggable browser at 127.0.0.1:' + port + ' - explicit ports are attach-only'), r.detail);
    assert.ok(r.detail.includes('--remote-debugging-port=' + port), 'the hint names the port');
  });

  await t('the plugin\'s browse rides the same road and keeps its words', async () => {
    const port = await deadPort();
    const c = mcpClient({ TROTH_BASH_CWD: os.tmpdir() });
    try {
      await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      const list = await c.rpc('tools/list', {});
      const tool = ((list.result && list.result.tools) || []).find((x) => x.name === 'browse');
      assert.ok(tool, 'browse is offered');
      assert.ok(/Explicit ports are attach-only/.test(JSON.stringify(tool.inputSchema)), 'the schema keeps its port contract');
      const m = await c.rpc('tools/call', { name: 'browse', arguments: { port, url: 'about:blank' } });
      const text = ((m.result && m.result.content) || []).map((b) => b.text).join('\n');
      assert.strictEqual(!!(m.result && m.result.isError), true, 'an error reply: ' + text);
      assert.ok(text.includes('no debuggable browser at 127.0.0.1:' + port + ' - explicit ports are attach-only'), text);
    } finally { c.close(); }
  });

  await t('live: a troth browser already alive answers a data: page title through the core tool (never started here)', async () => {
    // Opt-in only: a test road must not take over a browser the operator is
    // looking at. TROTH_BROWSE_LIVE=1 runs it against the troth browser.
    if (process.env.TROTH_BROWSE_LIVE !== '1') skip('opt in with TROTH_BROWSE_LIVE=1');
    let daemon;
    try { daemon = require('../shared-core/perception/chromium-daemon.js'); } catch (_) { skip('no chromium daemon module'); }
    const envPort = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '', 10);
    const ports = [];
    if (envPort) ports.push(envPort);
    if (ports.indexOf(daemon.DEFAULT_PORT) === -1) ports.push(daemon.DEFAULT_PORT);
    let alive = null;
    for (const p of ports) { const h = await daemon.aliveHost(p, 900); if (h) { alive = { host: h, port: p }; break; } }
    if (!alive) skip('no troth browser alive; this case never starts one');
    const r = await browse.run({ port: alive.port, host: alive.host, url: 'data:text/html,<title>troth-browse-probe</title><p>hi</p>', wait_ms: 600, eval: 'document.title' }, { cwd: os.tmpdir() });
    assert.strictEqual(r.eval, 'troth-browse-probe', JSON.stringify(r));
  });

  console.log('\nbrowse-tool: ' + pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exit(fail ? 1 : 0);
})();
