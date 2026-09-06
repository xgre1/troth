#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A stopped turn stops waiting on an external MCP tool: the call rejects
// as cancelled the moment the turn is stopped, and the server is told
// (notifications/cancelled for that request id) so it can drop the work.
// A call nobody stops still answers. The downstream is a stdio stand-in
// whose one tool waits as long as it is told.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SHARED = path.join(__dirname, '..', 'shared-core');
const mcp = require(path.join(SHARED, 'tools', 'mcp-client.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-fake-slow.js');
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'troth-mcp-cancel-')), 'wire.log');
const spec = { command: process.execPath, args: [FIXTURE], env: { MCP_FAKE_LOG: LOG } };
function wire() { try { return fs.readFileSync(LOG, 'utf8'); } catch (_) { return ''; } }

console.log('\n=== a stopped turn stops waiting on an MCP tool ===\n');
(async () => {
  let state = null;
  await t('the downstream starts and answers a short call', async () => {
    state = await mcp.startDownstream('slow', spec, { initTimeoutMs: 10000 });
    const res = await mcp.rpc(state, 'tools/call', { name: 'wait', arguments: { ms: 150 } }, { shouldCancel: () => false });
    assert.ok(res && res.content && /waited 150/.test(res.content[0].text), JSON.stringify(res).slice(0, 200));
  });

  await t('a call in flight rejects as cancelled right after the stop, and the server is told', async () => {
    assert.ok(state, 'downstream is up');
    const c = { cancelled: false };
    setTimeout(() => { c.cancelled = true; }, 300);
    const t0 = Date.now();
    let err = null;
    try { await mcp.rpc(state, 'tools/call', { name: 'wait', arguments: { ms: 15000 } }, { shouldCancel: () => c.cancelled }); }
    catch (e) { err = e; }
    const ms = Date.now() - t0;
    assert.ok(err && err.message === 'cancelled', 'rejected as cancelled: ' + (err && err.message));
    assert.ok(ms >= 250 && ms < 1500, 'it came back right after the stop: ' + ms + ' ms');
    await sleep(200);
    const log = wire();
    const called = (log.match(/^call:(\d+)$/m) || [])[1];
    assert.ok(/^cancelled:\d+:operator_cancel$/m.test(log), 'the server saw the cancellation: ' + JSON.stringify(log));
    const cancelledId = log.match(/^cancelled:(\d+):/m)[1];
    assert.ok(called && log.split('\n').filter((l) => l === 'call:' + cancelledId).length === 1, 'for the request that was in flight');
    assert.strictEqual(state.pending.size, 0, 'nothing is left pending');
  });

  await t('the downstream still answers after a cancelled call', async () => {
    const res = await mcp.rpc(state, 'tools/call', { name: 'wait', arguments: { ms: 100 } }, { shouldCancel: () => false });
    assert.ok(res && res.content && /waited 100/.test(res.content[0].text), JSON.stringify(res).slice(0, 200));
  });

  try { mcp.shutdownAll(); } catch (_) {}
  console.log('\nmcp-cancel: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
