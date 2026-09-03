#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The staging file: absent or empty reads as nothing staged; a file that
// cannot be read or parsed is an error naming it, on the module road and
// on the CLI, never an empty list.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-pending-'));
const PENDING = path.join(TMP, 'mcp-pending.json');
process.env.TROTH_MCP_PENDING_CONFIG = PENDING;
process.env.STATE_DB_PATH = path.join(TMP, 'state.db');
const mc = require(path.join(REPO, 'shared-core', 'tools', 'mcp-client.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
function cli() {
  return spawnSync(process.execPath, [path.join(REPO, 'bin', 'troth.js'), 'mcp', 'pending'], {
    env: Object.assign({}, process.env, { TROTH_MCP_PENDING_CONFIG: PENDING }), encoding: 'utf8', timeout: 30000
  });
}

console.log('\n=== staging file: absent, empty, unreadable, malformed ===\n');

t('an absent file is nothing staged', () => {
  assert.deepStrictEqual(mc.listPendingServers(), []);
});

t('an empty file is nothing staged', () => {
  fs.writeFileSync(PENDING, '');
  assert.deepStrictEqual(mc.listPendingServers(), []);
});

t('a malformed file is an error that names it', () => {
  fs.writeFileSync(PENDING, '{ not json');
  assert.throws(() => mc.listPendingServers(), (e) => e.code === 'REGISTRY_MALFORMED' && e.path === PENDING && /cannot parse/.test(e.message));
});

t('the CLI reports the malformed file with exit 2', () => {
  const r = cli();
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const j = JSON.parse(r.stderr.trim().split('\n').pop());
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.error, 'pending_malformed');
  assert.strictEqual(j.path, PENDING);
});

t('an unreadable file is an error that names it, on the module road and the CLI', () => {
  if (isRoot) { console.log('    (root reads everything; skipped)'); return; }
  fs.writeFileSync(PENDING, JSON.stringify({ mcpServers: { staged: { command: 'x' } } }));
  fs.chmodSync(PENDING, 0o000);
  try {
    assert.throws(() => mc.listPendingServers(), (e) => e.code === 'REGISTRY_UNREADABLE' && e.path === PENDING && /EACCES/.test(e.message));
    const r = cli();
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    const j = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.strictEqual(j.error, 'pending_unreadable');
    assert.ok(/EACCES/.test(j.detail), j.detail);
  } finally { fs.chmodSync(PENDING, 0o600); }
});

t('a readable staged entry still lists', () => {
  fs.writeFileSync(PENDING, JSON.stringify({ mcpServers: { staged: { command: 'x' } }, notes: { staged: { note: 'why', requested_at: 1 } } }));
  const rows = mc.listPendingServers();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'staged');
  assert.strictEqual(rows[0].note, 'why');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\nmcp-registry-unreadable: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
