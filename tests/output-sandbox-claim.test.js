#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// output-sandbox session-claim regression.
//
// MCP servers are daemon-managed and outlive sessions, so the savings and
// archive rows they write carry a stale spawn-time session id or none at
// all — those rows never joined any session's carried count (measured live:
// every bash_compression and mcp_cache:hit row ever written had NULL
// session_id, because the servers read CLAUDE_SESSION_ID, which the host
// never sets for MCP processes, and the host-set CLAUDE_CODE_SESSION_ID
// goes stale across sessions). The PostToolUse hook runs inside the calling
// session, so it claims the last half-minute's unclaimed rows with the id
// the payload carries. This drives the REPO copy of the hook over a
// throwaway DB and asserts both tables get claimed.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const db = state.db();

db.prepare('INSERT INTO savings_ledger (ts,kind,tokens,session_id) VALUES (?,?,?,?)')
  .run(Date.now() - 5000, 'bash_compression', 4500, null);
db.prepare('INSERT INTO tool_output_archive (session_id,tool,ts,raw,summary) VALUES (?,?,?,?,?)')
  .run(null, 'bash', Date.now() - 5000, 'x', 'y');
// A row already owned by another session must not be re-claimed.
db.prepare('INSERT INTO savings_ledger (ts,kind,tokens,session_id) VALUES (?,?,?,?)')
  .run(Date.now() - 5000, 'bash_compression', 100, 'OTHER-SESSION');

const hook = path.join(__dirname, '..', 'plugin', 'hooks', 'output-sandbox.mjs');
const payload = JSON.stringify({
  tool_name: 'mcp__plugin_troth_troth-bash__run',
  session_id: 'CLAIM-TEST-SID',
  tool_input: {},
  tool_response: { content: [{ type: 'text', text: 'small output' }] }
});
const r = spawnSync(process.execPath, [hook], {
  input: payload,
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..', 'plugin') }
});

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message || e)); }
}

t('hook exits cleanly on a small MCP response', () => {
  assert.strictEqual(r.status, 0, 'exit 0, stderr: ' + (r.stderr || '').slice(0, 200));
});
t('unclaimed savings row is claimed by the calling session', () => {
  const row = db.prepare("SELECT session_id FROM savings_ledger WHERE tokens = 4500").get();
  assert.strictEqual(row.session_id, 'CLAIM-TEST-SID');
});
t('unclaimed archive row is claimed by the calling session', () => {
  const row = db.prepare('SELECT session_id FROM tool_output_archive').get();
  assert.strictEqual(row.session_id, 'CLAIM-TEST-SID');
});
t('a row owned by another session stays owned', () => {
  const row = db.prepare("SELECT session_id FROM savings_ledger WHERE tokens = 100").get();
  assert.strictEqual(row.session_id, 'OTHER-SESSION');
});
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
