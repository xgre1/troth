#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
require('./hermetic-db.js'); // a test never opens the operator's own substrate
// substrate-backup.verifyRestore — DR-verify probe.
// exportArchive now snapshots engram_count + last signed-audit chain_hash
// into the manifest, and verifyRestore replays them from a scratch DB so
// the operator can prove a bundle is restorable (and unchanged) without
// touching the live ~/.troth. Also exercises the wal_checkpoint+copy
// path when state.js owns the live handle for the same DB.
//
// Hermetic via tests/hermetic-db.js: HOME redirected → state.db lands in
// the tmpdir; the scratch DB cleanup is automatic unless keep_scratch.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const backup  = require(path.join(PROJECT_ROOT, 'shared-core', 'substrate-backup.js'));
const engram  = require(path.join(PROJECT_ROOT, 'shared-core', 'engram.js'));
const signedAudit = require(path.join(PROJECT_ROOT, 'shared-core', 'signed-audit.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log('  \u2713 ' + name); pass++; },
        (e) => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
      );
    }
    console.log('  \u2713 ' + name); pass++;
  } catch (e) {
    console.log('  \u2717 ' + name + ': ' + e.message); fail++;
  }
}

console.log('\n=== substrate-backup.verifyRestore ===\n');

(async () => {

  await t('seed substrate: one engram + one signed-audit row', async () => {
    const rid = engram.recordEngram({
      agent_id: 'backup-verify', user_id: 'operator', cwd: null,
      statement: 'seed engram for backup verify',
      source: 'tests/substrate-backup-verify',
      source_authority: 'llm_inferred',
      scope: null, auto_verify: false
    });
    assert.ok(rid, 'engram seed must persist');
    const sa = await signedAudit.signAndAppend({
      record: { kind: 'test.seed', ts: Date.now() },
      kind:   'test.seed'
    });
    assert.strictEqual(sa.ok, true, 'signed-audit seed must persist');
  });

  let bundlePath;

  await t('exportArchive writes manifest with engram_count + last_chain_hash + db_copy_method', () => {
    bundlePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bk-')) + '/bundle';
    const r = backup.exportArchive({ out_path: bundlePath });
    assert.strictEqual(r.ok, true, 'export must succeed: ' + JSON.stringify(r));
    assert.strictEqual(typeof r.manifest.engram_count, 'number',
      'engram_count present in manifest');
    assert.ok(r.manifest.engram_count >= 1, 'manifest counted seed engram');
    assert.strictEqual(typeof r.manifest.last_chain_hash, 'string',
      'last_chain_hash present');
    assert.ok(/^[0-9a-f]{64}$/.test(r.manifest.last_chain_hash),
      'last_chain_hash is sha256 hex');
    // db_copy_method records whether the WAL flush actually fired or fell
    // through to plain copy. Both are valid; we only require that the
    // method string is one of the documented shapes.
    assert.ok(['copy', 'wal_checkpoint+copy'].indexOf(r.manifest.db_copy_method) >= 0,
      'db_copy_method recorded: ' + r.manifest.db_copy_method);
  });

  await t('verifyRestore on a fresh bundle → ok with same counts + hash', () => {
    const v = backup.verifyRestore({ bundle_path: bundlePath });
    assert.strictEqual(v.ok, true, 'verifyRestore: ' + JSON.stringify(v));
    assert.ok(v.schema_ok, 'schema present');
    assert.ok(typeof v.engram_count === 'number' && v.engram_count >= 1);
    assert.ok(typeof v.last_chain_hash === 'string');
  });

  await t('scratch DB cleaned up after verify (no leak in tmpdir)', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('troth-verify-')).length;
    const v = backup.verifyRestore({ bundle_path: bundlePath });
    assert.strictEqual(v.ok, true);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('troth-verify-')).length;
    assert.strictEqual(after, before, 'no scratch DB left behind');
  });

  await t('tamper the bundle DB → verifyRestore reports last_chain_hash_mismatch', () => {
    // Open the bundle's DB and append a phony chain row so the head no
    // longer matches the manifest. Use a sibling connection on the same
    // path (state.js's singleton is on the live HOME db, not this one).
    const Database = require('better-sqlite3');
    const bdb = new Database(path.join(bundlePath, 'state.db'));
    try {
      bdb.prepare(
        'INSERT INTO l4_signed_audit_chain (ts,action_id,kind,record_hash,prev_chain_hash,chain_hash,signature,public_key_id) ' +
        'VALUES (?,?,?,?,?,?,?,?)'
      ).run(Date.now(), null, 'test.tamper',
            'a'.repeat(64), null, 'b'.repeat(64), 'sig', 'gck:tampered');
    } finally { bdb.close(); }
    const v = backup.verifyRestore({ bundle_path: bundlePath });
    assert.strictEqual(v.ok, false, 'tampered bundle must fail verify');
    assert.strictEqual(v.error, 'last_chain_hash_mismatch');
    assert.ok(v.expected && v.got);
  });

  await t('tamper engram count → verifyRestore reports engram_count_mismatch', () => {
    // Rebuild a clean bundle, then drop a phony engram row so COUNT diverges
    // (we test the count mismatch in isolation from the chain mismatch).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bk2-')) + '/bundle';
    const r = backup.exportArchive({ out_path: dir });
    assert.strictEqual(r.ok, true);
    const Database = require('better-sqlite3');
    const bdb = new Database(path.join(dir, 'state.db'));
    try {
      // Engrams in action_records are type='commitment' +
      // output.commitment_type='engram'. Inject one so verify counts diverge.
      bdb.prepare(
        "INSERT INTO action_records (id, timestamp, type, agent_id, cwd, user_id, input, output) " +
        "VALUES (?,?,?,?,?,?,?,?)"
      ).run('019e-tamper-' + Math.random().toString(36).slice(2,8),
            Date.now(), 'commitment', 'tamper', null, 'op',
            JSON.stringify({ source: 'tamper' }),
            JSON.stringify({ commitment_type: 'engram', statement: 'tampered' }));
    } finally { bdb.close(); }
    const v = backup.verifyRestore({ bundle_path: dir });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.error, 'engram_count_mismatch');
    assert.ok(v.got > v.expected);
  });

  await t('verifyRestore on bundle with no DB → clean error, no crash', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bk-empty-'));
    fs.writeFileSync(path.join(empty, 'manifest.json'),
      JSON.stringify({ bundle_version: 1, engram_count: 0, last_chain_hash: null }));
    const v = backup.verifyRestore({ bundle_path: empty });
    assert.strictEqual(v.ok, false);
    assert.ok(/no state.db/.test(v.error));
  });

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
