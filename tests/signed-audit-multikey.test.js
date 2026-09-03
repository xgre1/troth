#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
require('./hermetic-db.js'); // a test never opens the operator's own substrate
// Multi-key signed-audit verifier (C7 v2). Rotated keys must still verify
// older chain rows: the chain is forever, but the active signing key may
// rotate (compromise rumor, scheduled hygiene, hardware swap). v1 only
// verified against the ACTIVE key — every row signed under any other id
// failed as unknown_public_key_id, which would make rotation a destructive
// op against historical audit. v2 enumerates every *.pub in the key dir and
// looks up the right pubkey per row by id.
//
// Hermetic: temp HOME (hermetic-db.js) + a per-file temp key dir, so the
// real ~/.troth/audit-keys is never touched.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const signedAudit  = require(path.join(PROJECT_ROOT, 'shared-core', 'signed-audit.js'));
const state        = require(path.join(PROJECT_ROOT, 'shared-core', 'state.js'));

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

const KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sa-mk-'));

function activeFiles() {
  return ['active.key', 'active.pub', 'active.id'].map((f) => path.join(KEY_DIR, f));
}

function rotateActiveTo(prefix) {
  for (const f of activeFiles()) {
    if (fs.existsSync(f)) {
      const dest = f.replace('active.', prefix + '.');
      fs.renameSync(f, dest);
    }
  }
}

async function signOne(scope) {
  return signedAudit.signAndAppend({
    record:    { kind: 'control_channel.dispatched', scope, ok: true, ts: Date.now() },
    action_id: null,
    kind:      'control_channel.dispatched',
    key_dir:   KEY_DIR
  });
}

console.log('\n=== signed-audit multi-key verifier (C7 v2) ===\n');

(async () => {

  let keyAId = null;
  let keyBId = null;

  await t('init key A → sign 2 rows', async () => {
    const k = signedAudit.ensureKey({ key_dir: KEY_DIR });
    keyAId = k.public_key_id;
    assert.ok(/^gck:[0-9a-f]{16}$/.test(keyAId), 'key A id shape');
    const r1 = await signOne('control:chat');
    const r2 = await signOne('control:chat');
    assert.strictEqual(r1.public_key_id, keyAId);
    assert.strictEqual(r2.public_key_id, keyAId);
  });

  await t('rotate: rename A → prevA, generate active=B, sign 2 rows', async () => {
    rotateActiveTo('prevA');
    assert.ok(!fs.existsSync(path.join(KEY_DIR, 'active.key')),
      'active.key gone after rotation');
    assert.ok(fs.existsSync(path.join(KEY_DIR, 'prevA.pub')),
      'A.pub kept for verifier lookup');
    const k = signedAudit.ensureKey({ key_dir: KEY_DIR });
    keyBId = k.public_key_id;
    assert.notStrictEqual(keyBId, keyAId, 'rotation yielded a different id');
    const r3 = await signOne('control:chat');
    const r4 = await signOne('control:chat');
    assert.strictEqual(r3.public_key_id, keyBId);
    assert.strictEqual(r4.public_key_id, keyBId);
  });

  await t('loadAllPublicKeys returns both A and B', () => {
    const keys = signedAudit.loadAllPublicKeys({ key_dir: KEY_DIR });
    assert.ok(keys[keyAId], 'A discovered: ' + Object.keys(keys).join(','));
    assert.ok(keys[keyBId], 'B discovered: ' + Object.keys(keys).join(','));
  });

  await t('verifyChain walks across the rotation boundary (4 rows ok)', () => {
    const v = signedAudit.verifyChain({ key_dir: KEY_DIR });
    assert.strictEqual(v.ok, true,
      'rows signed by either A or B verify: ' + JSON.stringify(v));
    assert.ok(v.rows_checked >= 4);
  });

  await t('remove prevA.pub → first row fails as unknown_public_key_id', () => {
    fs.unlinkSync(path.join(KEY_DIR, 'prevA.pub'));
    const v = signedAudit.verifyChain({ key_dir: KEY_DIR });
    assert.strictEqual(v.ok, false, 'unknown old key id must fail');
    assert.strictEqual(v.first_tamper.reason, 'unknown_public_key_id');
    assert.strictEqual(v.first_tamper.got, keyAId);
    assert.ok(Array.isArray(v.first_tamper.known_ids));
    assert.ok(v.first_tamper.known_ids.indexOf(keyBId) >= 0,
      'B is still in known_ids');
  });

  await t('restore prevA.pub → chain verifies green again (audit survival)', () => {
    // Re-derive A's pub from its private key (still on disk) to simulate
    // operator recovery — or simply rewrite the .pub from what ensureKey
    // could regenerate. Here we use the private key to produce the SPKI.
    const crypto = require('crypto');
    const privPem = fs.readFileSync(path.join(KEY_DIR, 'prevA.key'), 'utf8');
    const pubObj  = crypto.createPublicKey(privPem);
    const pubPem  = pubObj.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(path.join(KEY_DIR, 'prevA.pub'), pubPem, { mode: 0o644 });
    const v = signedAudit.verifyChain({ key_dir: KEY_DIR });
    assert.strictEqual(v.ok, true,
      'restored pubkey re-enables verification: ' + JSON.stringify(v));
  });

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
