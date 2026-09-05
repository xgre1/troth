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
// The project files troth knows come from its own directory: the workspace
// root's projects and the opened folders, both under this throwaway one.
const CFG = path.join(TMP, 'troth');
fs.mkdirSync(path.join(CFG, 'workspace'), { recursive: true });
process.env.TROTH_CONFIG_DIR = CFG;
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
    assert.deepStrictEqual(r.data.active[0], { name: 'alpha', transport: 'http', command: 'https://alpha.example/mcp', scope: 'general', project: null, path: null, note: null, disabled: false });
    assert.deepStrictEqual(r.data.active[1], { name: 'zeta', transport: 'stdio', command: 'npx -y zeta-mcp', scope: 'general', project: null, path: null, note: null, disabled: false });
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

  await t('a project file lists as a project row, an opened folder too, next to the general one it shadows', async () => {
    const proj = path.join(CFG, 'workspace', 'proj-a');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'proj-alpha' } } }));
    const opened = path.join(TMP, 'elsewhere');
    fs.mkdirSync(opened, { recursive: true });
    fs.writeFileSync(path.join(opened, '.mcp.json'), JSON.stringify({ mcpServers: { beta: { command: 'b', args: ['--x'] } }, notes: { beta: { note: 'for beta' } } }));
    fs.writeFileSync(path.join(CFG, 'opened-folders.json'), JSON.stringify([opened]));
    const r = await get('/api/mcp/servers');
    assert.strictEqual(r.code, 200, JSON.stringify(r.data));
    const rows = r.data.active;
    assert.deepStrictEqual(rows.filter((x) => x.scope === 'general').map((x) => x.name), ['alpha', 'zeta']);
    const pa = rows.find((x) => x.scope === 'project' && x.name === 'alpha');
    assert.ok(pa, JSON.stringify(rows));
    assert.strictEqual(pa.project, 'proj-a');
    assert.strictEqual(pa.path, proj);
    assert.strictEqual(pa.command, 'proj-alpha');
    const pb = rows.find((x) => x.scope === 'project' && x.name === 'beta');
    assert.ok(pb, JSON.stringify(rows));
    assert.strictEqual(pb.project, 'elsewhere');
    assert.strictEqual(pb.note, 'for beta');
    assert.strictEqual(pb.command, 'b --x');
  });

  await t('approve carries the staged note into the active file and leaves the spec untouched', async () => {
    const client = require(path.join(REPO, 'shared-core', 'tools', 'mcp-client.js'));
    fs.writeFileSync(PENDING, JSON.stringify({ mcpServers: { staged: { command: 'x', args: ['--y'] } }, notes: { staged: { note: 'for the calendar', requested_at: 7 } } }));
    const ap = client.approvePendingServer('staged');
    assert.strictEqual(ap.ok, true, JSON.stringify(ap));
    const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    assert.deepStrictEqual(active.mcpServers.staged, { command: 'x', args: ['--y'] });
    assert.strictEqual(active.notes.staged.note, 'for the calendar');
    assert.strictEqual(active.notes.staged.requested_at, 7);
    assert.ok(active.notes.staged.approved_at > 0);
    const r = await get('/api/mcp/servers');
    const row = r.data.active.find((x) => x.name === 'staged');
    assert.deepStrictEqual(row, { name: 'staged', transport: 'stdio', command: 'x --y', scope: 'general', project: null, path: null, note: 'for the calendar', disabled: false });
    assert.deepStrictEqual(r.data.pending, []);
  });

  await t('the dashboard shows the card under its own Integrations tab', async () => {
    const html = fs.readFileSync(path.join(REPO, 'proxy', 'ui', 'dashboard.html'), 'utf8');
    assert.ok(/data-stab="integrations"[^>]*onclick="setSettingsTab\('integrations'\)">Integrations</.test(html), 'the tab button');
    assert.ok(/integrations: 'integrations'/.test(html), 'the tab group');
    assert.ok(/\(machine\|behaviour\|connections\|integrations\|security\)/.test(html), 'the tab is a known group');
    assert.ok(/data-settings-tab="integrations">\s*<div class="card-title">MCP servers troth reaches</.test(html), 'the card sits under the tab');
    assert.ok(/group === 'integrations' && typeof loadMcpServers === 'function'\) loadMcpServers\(\)/.test(html), 'opening the tab loads the list');
    assert.ok(!/function loadMcpStatus\(includeTccId\) \{\s*try \{ loadMcpServers\(\)/.test(html), 'the Connections loader does not fetch the list');
  });

  await t('owns() claims the operator actions too', async () => {
    assert(routes.owns('/api/mcp/add'));
    assert(routes.owns('/api/mcp/enable'));
    assert(routes.owns('/api/mcp/remove'));
    assert(!routes.owns('/api/mcp/added'));
  });

  await t('add stages a server with the agent\'s own checks and it waits for approval', async () => {
    const bad = await post('/api/mcp/add', JSON.stringify({ name: 'Bad Name', config: { command: 'x' } }));
    assert.strictEqual(bad.code, 400); assert.strictEqual(bad.data.error, 'bad_name');
    const badCfg = await post('/api/mcp/add', JSON.stringify({ name: 'cal', config: { type: 'http', url: 'nope' } }));
    assert.strictEqual(badCfg.code, 400); assert.strictEqual(badCfg.data.error, 'bad_config');
    const dup = await post('/api/mcp/add', JSON.stringify({ name: 'zeta', config: { command: 'x' } }));
    assert.strictEqual(dup.code, 400); assert.strictEqual(dup.data.error, 'already_active');
    const ok = await post('/api/mcp/add', JSON.stringify({ name: 'cal', config: { command: 'npx', args: ['-y', 'cal-mcp'] }, note: 'the calendar' }));
    assert.strictEqual(ok.code, 200, JSON.stringify(ok.data));
    const list = await get('/api/mcp/servers');
    assert.deepStrictEqual(list.data.pending.map((p) => [p.name, p.note]), [['cal', 'the calendar']]);
    assert.ok(!list.data.active.some((x) => x.name === 'cal'), 'staging never activates');
    const rej = await post('/api/mcp/reject', JSON.stringify({ name: 'cal' }));
    assert.strictEqual(rej.code, 200);
  });

  await t('off keeps the entry and takes it out of the spawn road; on puts it back', async () => {
    const client = require(path.join(REPO, 'shared-core', 'tools', 'mcp-client.js'));
    const off = await post('/api/mcp/enable', JSON.stringify({ name: 'zeta', enabled: false }));
    assert.strictEqual(off.code, 200, JSON.stringify(off.data));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(client.loadDownstream(), 'zeta'), false, 'the partner does not see it');
    let row = (await get('/api/mcp/servers')).data.active.find((x) => x.name === 'zeta');
    assert.strictEqual(row.disabled, true);
    assert.strictEqual(row.command, 'npx -y zeta-mcp', 'the entry is kept whole');
    const on = await post('/api/mcp/enable', JSON.stringify({ name: 'zeta', enabled: true }));
    assert.strictEqual(on.code, 200);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(client.loadDownstream(), 'zeta'), true);
    row = (await get('/api/mcp/servers')).data.active.find((x) => x.name === 'zeta');
    assert.strictEqual(row.disabled, false);
    const unknown = await post('/api/mcp/enable', JSON.stringify({ name: 'ghost', enabled: false }));
    assert.strictEqual(unknown.code, 409); assert.strictEqual(unknown.data.reason, 'not_active');
  });

  await t('remove drops the entry and its note, and says not_active the second time', async () => {
    const r = await post('/api/mcp/remove', JSON.stringify({ name: 'staged' }));
    assert.strictEqual(r.code, 200, JSON.stringify(r.data));
    const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    assert.strictEqual(active.mcpServers.staged, undefined);
    assert.strictEqual(active.notes.staged, undefined);
    assert.ok(active.mcpServers.zeta, 'the others stay');
    const again = await post('/api/mcp/remove', JSON.stringify({ name: 'staged' }));
    assert.strictEqual(again.code, 409); assert.strictEqual(again.data.reason, 'not_active');
  });

  await t('the card carries the controls: check, on and off, remove, add', async () => {
    const html = fs.readFileSync(path.join(REPO, 'proxy', 'ui', 'dashboard.html'), 'utf8');
    for (const fn of ['probeMcpServer', 'toggleMcpServer', 'removeMcpServer', 'addMcpServer', 'mcpAction']) assert.ok(new RegExp('function ' + fn + '\\(').test(html), fn);
    assert.ok(/id="mcp-add-config"/.test(html) && /id="mcp-add-name"/.test(html) && /id="mcp-add-note"/.test(html), 'the add form');
    assert.ok(/\/api\/mcp\/probe/.test(html), 'the check asks the probe road');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\nmcp-servers-route: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
