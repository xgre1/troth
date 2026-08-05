#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// troth audit verify — CLI acceptance.
// What this has to hold: `troth audit verify` returns ok:true over a clean
// session and detects any tampered or forged row. Until this test, the verifier
// existed as bin/audit-verify.js but wasn't reachable through the troth
// CLI router — now bin/troth.js dispatches `audit verify`.
//
// Hermetic via tests/hermetic-db.js — temp HOME → fresh state.db, fresh
// audit-keys/.

const assert = require('assert');
const path   = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'bin', 'troth.js');

function run(args) {
  const r = spawnSync(process.execPath,
    ['-r', path.join(PROJECT_ROOT, 'tests', 'hermetic-db.js'), CLI].concat(args),
    { encoding: 'utf8', env: Object.assign({}, process.env, { CI: '1' }) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

console.log('\n=== troth audit verify CLI ===\n');

t('`troth audit verify` on empty chain exits 0 + reports empty:true', () => {
  const r = run(['audit', 'verify']);
  assert.strictEqual(r.status, 0,
    'exit 0 on empty chain (no rows = nothing to tamper). got ' + r.status +
    ' stderr=' + r.stderr);
  assert.ok(/empty.*true|rows_checked.*0/.test(r.stdout),
    'reports empty: ' + r.stdout.slice(0, 200));
});

t('`troth audit verify` after one signed-audit row → exit 0 (intact)', () => {
  // Seed via the same signed-audit module the CLI walks. This proves the
  // CLI exercises the production verifyChain path end-to-end.
  const seed = spawnSync(process.execPath,
    ['-r', path.join(PROJECT_ROOT, 'tests', 'hermetic-db.js'),
     '-e', `
       const sa = require('${path.join(PROJECT_ROOT, 'shared-core', 'signed-audit.js').replace(/\\/g, '\\\\')}');
       sa.signAndAppend({ record:{kind:'test'}, kind:'test' })
         .then(()=>process.exit(0), e=>{console.error(e); process.exit(1);});
     `],
    { encoding: 'utf8', env: process.env });
  assert.strictEqual(seed.status, 0, 'seed: ' + seed.stderr);
  const r = run(['audit', 'verify']);
  assert.strictEqual(r.status, 0,
    'exit 0 on intact chain. stdout=' + r.stdout.slice(0, 300) +
    ' stderr=' + r.stderr.slice(0, 300));
  assert.ok(/Chain intact/.test(r.stdout), 'prints intact: ' + r.stdout.slice(0, 200));
});

t('`troth audit verify` unknown subcommand → exit 2 with usage', () => {
  const r = run(['audit', 'something']);
  assert.strictEqual(r.status, 2, 'exit 2 on bad subcommand');
  assert.ok(/Usage:/.test(r.stderr), 'prints usage on stderr');
});

t('`troth audit verify` after row tamper → exit 1 + first_tamper reported', () => {
  // Tamper the row we just seeded.
  const tamper = spawnSync(process.execPath,
    ['-r', path.join(PROJECT_ROOT, 'tests', 'hermetic-db.js'),
     '-e', `
       const Database = require('better-sqlite3');
       const path = require('path');
       const dbPath = path.join(process.env.HOME, '.troth', 'state.db');
       const db = new Database(dbPath);
       db.prepare('UPDATE l4_signed_audit_chain SET record_hash = ? WHERE id = (SELECT MIN(id) FROM l4_signed_audit_chain)')
         .run('f'.repeat(64));
       db.close();
     `],
    { encoding: 'utf8', env: process.env });
  assert.strictEqual(tamper.status, 0, 'tamper: ' + tamper.stderr);
  const r = run(['audit', 'verify']);
  assert.strictEqual(r.status, 1,
    'exit 1 on tampered chain. stdout=' + r.stdout.slice(0, 400) +
    ' stderr=' + r.stderr.slice(0, 200));
  assert.ok(/Tamper detected/.test(r.stdout), 'prints tamper marker');
  assert.ok(/first_tamper/.test(r.stdout), 'reports first_tamper in JSON');
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
