#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A capability store that cannot be opened is reported as unreachable:
// listEngrams surfaces the error when asked, the resolver says
// { unreachable } instead of "nothing sealed", and mcp_call refuses with
// capability_store_unreachable rather than sending the operator to mint.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-capstore-'));
// A regular file where the store's directory should be: the database
// cannot be created or opened underneath it.
const BLOCK = path.join(TMP, 'not-a-dir');
fs.writeFileSync(BLOCK, 'x');
process.env.STATE_DB_PATH = path.join(BLOCK, 'state.db');
process.env.TROTH_MCP_PENDING_CONFIG = path.join(TMP, 'mcp-pending.json');
process.env.TROTH_MCP_CLIENTS_CONFIG = path.join(TMP, 'mcp-clients.json');
const eng = require(path.join(REPO, 'shared-core', 'engram.js'));
const mc = require(path.join(REPO, 'shared-core', 'tools', 'mcp-client.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== capability store unreachable ===\n');

(async () => {
  await t('listEngrams stays quiet by default and throws when asked', async () => {
    assert.deepStrictEqual(eng.listEngrams({ principal: null, audience: 'all', limit: 5 }), []);
    assert.throws(() => eng.listEngrams({ principal: null, audience: 'all', limit: 5, throw_on_error: true }));
  });

  await t('the resolver says unreachable, never "nothing sealed"', async () => {
    const r = mc._autoResolveMcpAuthorization('intent:mcp:call:some-server', 'low');
    assert.ok(r && r.unreachable, JSON.stringify(r));
  });

  await t('mcp_call refuses as capability_store_unreachable with the seal intact', async () => {
    let contacted = false;
    const r = await mc.REGISTRY.mcp_call.run({ server: 'some-server', tool: 'ping', args: {} }, { agent_id: 'partner', user_id: 'operator', cwd: TMP, _mcp_mock: () => { contacted = true; return { ok: true }; } });
    assert.strictEqual(contacted, false, 'the server is never contacted');
    assert.strictEqual(r.ok, false, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(r.reason, 'capability_store_unreachable', JSON.stringify(r).slice(0, 300));
    assert.ok(/stay valid/.test(r.hint), r.hint);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\ncapability-store-unreachable: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
