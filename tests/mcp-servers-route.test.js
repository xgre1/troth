#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The dashboard's Integrations card reads the same registry files the CLI
// and the desktop app read: GET /api/mcp/servers lists the active servers
// (name, transport, command) and the staged ones (name, note), and
// POST /api/mcp/reject drops a staged entry. Approval stays on the CLI
// road, where the operator key and passphrase are.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-mcp-servers-'));
const ACTIVE = path.join(TMP, 'mcp-clients.json');
const PENDING = path.join(TMP, 'mcp-pending.json');
process.env.TROTH_MCP_CLIENTS_CONFIG = ACTIVE;
process.env.TROTH_MCP_PENDING_CONFIG = PENDING;
process.env.STATE_DB_PATH = path.join(TMP, 'state.db');
const routes = require(path.join(REPO, 'proxy', 'modules', 'mcp-routes.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

function get(url, auth) {
  return new Promise((resolve) => {
    const req = { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    routes.handle(req, {}, url, { jsonResponse: (r, code, data) => resolve({ code, data }), checkRemoteAuth: () => auth !== false });
  });
}
function post(url, body, auth) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = 'POST'; req.url = url; req.socket = { remoteAddress: '127.0.0.1' }; req.headers = {};
    const claimed = routes.handle(req, {}, url, { jsonResponse: (r, code, data) => resolve({ code, data }), checkRemoteAuth: () => auth !== false });
    assert.strictEqual(claimed, true, 'route claimed');
    setImmediate(() => { if (body !== undefined) req.emit('data', body); req.emit('end'); });
  });
}

console.log('\n=== /api/mcp/servers and /api/mcp/reject ===\n');

(async () => {
  await t('owns() claims the two endpoints and nothing near them', async () => {
    assert(routes.owns('/api/mcp/servers'));
    assert(routes.owns('/api/mcp/reject'));
    assert(!routes.owns('/api/mcp/servers-all'));
    assert(!routes.owns('/api/mcp/rejected'));
  });

  await t('no registry files at all reads as nothing active, nothing staged', async () => {
    const r = await get('/api/mcp/servers');
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.data.active, []);
    assert.deepStrictEqual(r.data.pending, []);
    assert.strictEqual(r.data.error, undefined);
  });

  await t('active servers list sorted with transport and command, staged ones with their note', async () => {
    fs.writeFileSync(ACTIVE, JSON.stringify({ mcpServers: {
      zeta: { command: 'npx', args: ['-y', 'zeta-mcp'] },
      alpha: { type: 'http', url: 'https://alpha.example/mcp' }
    } }));
    fs.writeFileSync(PENDING, JSON.stringify({ mcpServers: { staged: { command: 'x', args: ['--y'] } }, notes: { staged: { note: 'for the calendar', requested_at: 1700000000000 } } }));
    const r = await get('/api/mcp/servers');
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.data.active.map((a) => a.name), ['alpha', 'zeta']);
    assert.deepStrictEqual(r.data.active[0], { name: 'alpha', transport: 'http', command: 'https://alpha.example/mcp' });
    assert.deepStrictEqual(r.data.active[1], { name: 'zeta', transport: 'stdio', command: 'npx -y zeta-mcp' });
    assert.strictEqual(r.data.pending.length, 1);
    assert.strictEqual(r.data.pending[0].name, 'staged');
    assert.strictEqual(r.data.pending[0].note, 'for the calendar');
    assert.strictEqual(r.data.pending[0].requested_at, 1700000000000);
  });

  await t('a malformed staging file is named, the active list still answers', async () => {
    fs.writeFileSync(PENDING, '{ not json');
    const r = await get('/api/mcp/servers');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.data.active.length, 2);
    assert.ok(/cannot parse/.test(r.data.pending_error || ''), JSON.stringify(r.data));
    fs.writeFileSync(PENDING, JSON.stringify({ mcpServers: { staged: { command: 'x' } }, notes: { staged: { note: 'why', requested_at: 1 } } }));
  });

  await t('remote without the key is refused on both routes', async () => {
    const g = await get('/api/mcp/servers', false);
    assert.strictEqual(g.code, 401);
    const p = await post('/api/mcp/reject', JSON.stringify({ name: 'staged' }), false);
    assert.strictEqual(p.code, 401);
    assert.strictEqual(require(path.join(REPO, 'shared-core', 'tools', 'mcp-client.js')).listPendingServers().length, 1, 'the staged entry survives a refused reject');
  });

  await t('reject needs a name and valid JSON', async () => {
    const bad = await post('/api/mcp/reject', '{ nope');
    assert.strictEqual(bad.code, 400);
    const empty = await post('/api/mcp/reject', JSON.stringify({}));
    assert.strictEqual(empty.code, 400);
  });

  await t('reject drops the staged entry and says not_pending the second time', async () => {
    const r = await post('/api/mcp/reject', JSON.stringify({ name: 'staged' }));
    assert.strictEqual(r.code, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.ok, true);
    const again = await post('/api/mcp/reject', JSON.stringify({ name: 'staged' }));
    assert.strictEqual(again.code, 409);
    assert.strictEqual(again.data.reason, 'not_pending');
    const list = await get('/api/mcp/servers');
    assert.deepStrictEqual(list.data.pending, []);
    assert.strictEqual(list.data.active.length, 2, 'reject never touches the active registry');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\nmcp-servers-route: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
