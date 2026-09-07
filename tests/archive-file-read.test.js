#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// An archived tool result sits under ~/.troth/tool-archive. The read wall
// lets the engine read that one file, with Read or with a Grep on it, and
// still refuses any search or listing that would sweep the directory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const perm = require(path.join(__dirname, '..', 'shared-core', 'tools', 'permission.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const archiveDir = path.join(os.homedir(), '.troth', 'tool-archive');
fs.mkdirSync(archiveDir, { recursive: true });
const archived = path.join(archiveDir, 'Grep-test-' + Date.now() + '.json');
fs.writeFileSync(archived, JSON.stringify({ content: 'the full output that was archived' }));

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

console.log('\n=== reading an archived tool result ===\n');

(async () => {
  await t('a Grep on the archived file itself runs', async () => {
    let ran = 0;
    const gated = perm.wrapRunner(async () => { ran++; return JSON.stringify({ ok: true }); });
    const out = JSON.parse(await gated(call('Grep', { pattern: 'archived', path: archived }), {}));
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(ran, 1);
  });

  await t('a Read of the archived file runs', async () => {
    let ran = 0;
    const gated = perm.wrapRunner(async () => { ran++; return JSON.stringify({ ok: true }); });
    const out = JSON.parse(await gated(call('Read', { file_path: archived }), {}));
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(ran, 1);
  });

  await t('a Grep across the archive directory is refused and the refusal names the road', async () => {
    let ran = 0;
    const gated = perm.wrapRunner(async () => { ran++; return JSON.stringify({ ok: true }); });
    const out = JSON.parse(await gated(call('Grep', { pattern: 'anything', path: archiveDir }), {}));
    assert.strictEqual(out.error, 'path_policy_refusal', JSON.stringify(out));
    assert.strictEqual(ran, 0, 'the inner runner never fired');
    assert.ok(/archive_path/.test(out.hint), 'the hint names the exact-path road: ' + out.hint);
  });

  await t('a Glob over the substrate home is refused', async () => {
    let ran = 0;
    const gated = perm.wrapRunner(async () => { ran++; return JSON.stringify({ ok: true }); });
    const out = JSON.parse(await gated(call('Glob', { pattern: '**/*', path: path.join(os.homedir(), '.troth') }), {}));
    assert.strictEqual(out.error, 'path_policy_refusal', JSON.stringify(out));
    assert.strictEqual(ran, 0);
  });

  try { fs.unlinkSync(archived); } catch (_) {}
  console.log('\narchive-file-read: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
