#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
require('./hermetic-db.js'); // a test never opens the operator's own substrate
// signed-audit-on-dispatch — every successful (or thrown) control-channel
// dispatch must extend the tamper-evident signed-audit chain so the operator
// can structurally prove what the substrate did. design
//
// Hermetic: HOME has already been redirected to a tmp dir by
// tests/hermetic-db.js, so state.db and the audit-keys/ subdir both live
// off the real ~/.troth. We additionally use a fresh key_dir per case so
// chain length is deterministic.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const signedAudit  = require(path.join(PROJECT_ROOT, 'shared-core', 'signed-audit.js'));
const state        = require(path.join(PROJECT_ROOT, 'shared-core', 'state.js'));
const { makeControlAudit, DEFAULT_SIGNED_KINDS } =
  require(path.join(PROJECT_ROOT, 'shared-core', 'control-audit.js'));

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

// One key dir for the whole file. Per-subtest fresh keys would break
// verifyChain (which only checks against the ACTIVE key — rows signed
// by rotated/foreign keys are flagged unknown_public_key_id). The
// hermetic-db.js preloader already gives us a tmpdir HOME, so this is
// fully off the operator's real ~/.troth.
const SHARED_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sa-keys-'));

// Settle the fire-and-forget signed-audit appends. Two microtask ticks +
// one macrotask is enough: makeControlAudit wraps signAndAppend with
// Promise.resolve().then(...), so the first .then schedules the work,
// signAndAppend itself runs synchronously inside the next tick, and a
// setImmediate guarantees all of that has flushed before we read the DB.
function flush() {
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

function chainCount() {
  // listSignedAuditChain returns rows sorted by id asc; .length is the
  // post-insert chain length.
  return state.listSignedAuditChain({ limit: 5000 }).length;
}

console.log('\n=== signed-audit on control-channel dispatch (L4 / M4) ===\n');

(async () => {

  await t('DEFAULT_SIGNED_KINDS covers dispatched + handler_threw only', () => {
    assert.ok(DEFAULT_SIGNED_KINDS.has('control_channel.dispatched'));
    assert.ok(DEFAULT_SIGNED_KINDS.has('control_channel.handler_threw'));
    assert.ok(!DEFAULT_SIGNED_KINDS.has('control_channel.bad_signature'),
      'pre-dispatch rejections are NOT actions, must not extend the chain');
    assert.ok(!DEFAULT_SIGNED_KINDS.has('control_channel.unknown_scope'));
  });

  await t('audit() with no signedAudit option → no chain row written', async () => {
    const before = chainCount();
    const audit = makeControlAudit({
      recordEngram: () => {},
      // signedAudit omitted on purpose
      agent_id: 'test', cwd: '/tmp', user_id: 'test'
    });
    audit('control_channel.dispatched', { scope: 'control:noop', ok: true });
    await flush();
    assert.strictEqual(chainCount(), before, 'chain unchanged without signedAudit');
  });

  await t('dispatched event → exactly one chain row appended', async () => {
    const before = chainCount();
    const audit = makeControlAudit({
      recordEngram: () => {},
      signedAudit,
      signed_audit_key_dir: SHARED_KEY_DIR,
      agent_id: 'test', cwd: '/tmp', user_id: 'test'
    });
    audit('control_channel.dispatched', { scope: 'control:noop', ok: true });
    await flush();
    assert.strictEqual(chainCount(), before + 1, 'one row appended');
    const last = state.lastSignedAuditRow();
    assert.strictEqual(last.kind, 'control_channel.dispatched');
  });

  await t('handler_threw event → also extends the chain', async () => {
    const before = chainCount();
    const audit = makeControlAudit({
      recordEngram: () => {},
      signedAudit,
      signed_audit_key_dir: SHARED_KEY_DIR,
      agent_id: 'test', cwd: '/tmp', user_id: 'test'
    });
    audit('control_channel.handler_threw', { scope: 'control:noop', err: 'boom' });
    await flush();
    assert.strictEqual(chainCount(), before + 1);
  });

  await t('non-action kinds (bad_signature, unknown_scope) → no chain row', async () => {
    const before = chainCount();
    const audit = makeControlAudit({
      recordEngram: () => {},
      signedAudit,
      signed_audit_key_dir: SHARED_KEY_DIR,
      agent_id: 'test', cwd: '/tmp', user_id: 'test'
    });
    audit('control_channel.bad_signature', { scope: 'control:chat' });
    audit('control_channel.unknown_scope', { scope: 'control:no-such' });
    audit('control_channel.rate_limit_hit', { key_id: 'gck:xxx' });
    audit('control_channel.body_too_large', { remote: '127.0.0.1' });
    await flush();
    assert.strictEqual(chainCount(), before, 'pre-dispatch events do NOT extend the chain');
  });

  await t('two dispatched events → verifyChain() walks ok across N rows', async () => {
    const audit = makeControlAudit({
      recordEngram: () => {},
      signedAudit,
      signed_audit_key_dir: SHARED_KEY_DIR,
      agent_id: 'test', cwd: '/tmp', user_id: 'test'
    });
    audit('control_channel.dispatched', { scope: 'control:chat', ok: true });
    audit('control_channel.dispatched', { scope: 'control:chat', ok: true });
    await flush();
    // verifyChain checks the WHOLE chain — including rows from earlier
    // subtests, all signed by the same shared key. It must be ok.
    const r = signedAudit.verifyChain({ key_dir: SHARED_KEY_DIR });
    assert.strictEqual(r.ok, true,
      'chain verifies post-dispatch: ' + JSON.stringify(r));
    assert.ok(r.rows_checked >= 2, 'at least the two new rows are present');
  });

  await t('tampering a row → verifyChain detects + names the first bad row', async () => {
    // Walk the chain, flip one record_hash, expect a verification failure.
    const rows = state.listSignedAuditChain({ limit: 5000 });
    assert.ok(rows.length > 0, 'need at least one row to tamper');
    const victim = rows[Math.max(0, rows.length - 2)];
    const fake = crypto.createHash('sha256').update('TAMPERED').digest('hex');
    // The state module gates writes by EXPECTED_CALLERS; tampering via a
    // raw UPDATE is the operator's job, so for the test we go directly
    // through better-sqlite3 — same DB handle.
    const db = state._dbForTest ? state._dbForTest() : null;
    if (!db) {
      // No exposed handle — open a sibling connection on the same path.
      const Database = require('better-sqlite3');
      const dbPath = path.join(process.env.HOME, '.troth', 'state.db');
      const sib = new Database(dbPath);
      sib.prepare('UPDATE l4_signed_audit_chain SET record_hash = ? WHERE id = ?')
         .run(fake, victim.id);
      sib.close();
    } else {
      db.prepare('UPDATE l4_signed_audit_chain SET record_hash = ? WHERE id = ?')
        .run(fake, victim.id);
    }
    const r = signedAudit.verifyChain({ key_dir: SHARED_KEY_DIR });
    assert.strictEqual(r.ok, false, 'verifyChain must reject a tampered chain');
    assert.ok(r.first_tamper, 'reports the first tamper');
    // chain_hash_mismatch (record_hash flipped breaks the chain) is the
    // expected primary detection. unknown_public_key_id / signature_invalid
    // are also valid tamper reports if the chain order/key gets perturbed.
    assert.ok(/mismatch|signature_invalid|unknown_public_key_id/.test(r.first_tamper.reason),
      'reason explains why: ' + r.first_tamper.reason);
  });

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
