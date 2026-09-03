#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A connector reports the state it is really in: a server that answers is
// connected with its tools, a bridge that asks for a sign-in names the
// address to visit and stays running, a server that answers nothing is
// unreachable and stopped, a name not in the registry is unknown.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-probe-'));
process.env.HOME = HOME;
const ROOT = path.join(__dirname, '..');
const registry = path.join(HOME, 'mcp-clients.json');
fs.writeFileSync(registry, JSON.stringify({ mcpServers: {
  'answers': { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-fake-ok.js')] },
  'asks-signin': { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-fake-signin.js')] },
  'asks-signin-two-lines': { command: process.execPath, args: ['-e', 'process.stderr.write("[123] Please authorize this client by visiting:\\nhttps://auth.example.test/oauth/authorize?client_id=k&state=s\\n[123] Could not open a browser automatically. Please copy and paste the URL above into your browser.\\n[123] Authentication required. Waiting for authorization...\\n"); setInterval(() => {}, 1000)'] },
  'dies': { command: process.execPath, args: ['-e', 'process.stderr.write("missing token\\n"); process.exit(3)'] },
  'silent': { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }
} }));
process.env.TROTH_MCP_CLIENTS_CONFIG = registry;
const client = require(path.join(ROOT, 'shared-core', 'tools', 'mcp-client.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== the state a connector is really in ===\n');

(async () => {
  await t('a server that answers is connected, with its tools', async () => {
    const r = await client.probe('answers');
    assert.strictEqual(r.state, 'connected', JSON.stringify(r));
    assert.deepStrictEqual(r.tools, ['list_tables']);
    const again = await client.probe('answers');
    assert.strictEqual(again.state, 'connected', 'the pooled server answers again');
  });
  await t('a bridge that asks for a sign-in names the address and stays running', async () => {
    const r = await client.probe('asks-signin');
    assert.strictEqual(r.state, 'sign_in_needed', JSON.stringify(r));
    assert.strictEqual(r.url, 'http://127.0.0.1:1/oauth/authorize?client_id=abc&state=xyz');
    assert.ok(r.ms < 12000, 'answered before the probe window closed: ' + r.ms);
  });
  await t('the address on the line after the request is found too', async () => {
    const r = await client.probe('asks-signin-two-lines');
    assert.strictEqual(r.state, 'sign_in_needed', JSON.stringify(r));
    assert.strictEqual(r.url, 'https://auth.example.test/oauth/authorize?client_id=k&state=s');
  });
  await t('a server that dies is unreachable, with its last words', async () => {
    const r = await client.probe('dies');
    assert.strictEqual(r.state, 'unreachable', JSON.stringify(r));
    assert.ok(/code 3/.test(r.error) && /missing token/.test(r.error), r.error);
  });
  await t('a name not in the registry is unknown', async () => {
    const r = await client.probe('nowhere');
    assert.strictEqual(r.state, 'unknown');
  });
  await t('the bridge jail lets a sign-in callback listen on loopback and keeps local services out of reach (source pin)', async () => {
    const sb = fs.readFileSync(path.join(ROOT, 'shared-core', 'tools', 'sandbox-seatbelt.js'), 'utf8');
    assert.ok(/network === 'full-listen'[\s\S]*?\(deny network-outbound \(remote ip "localhost:\*"\)\)/.test(sb), 'listen mode denies outbound loopback only');
    assert.ok(/loopbackListen \? 'full-listen' : 'full'/.test(sb), 'the option selects the mode');
    const mc = fs.readFileSync(path.join(ROOT, 'shared-core', 'tools', 'mcp-client.js'), 'utf8');
    assert.ok(/network: 'full', loopbackListen: true/.test(mc), 'the bridge asks for it');
  });
  try { client.shutdownAll(); } catch (_) {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  console.log('\nmcp-probe: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
