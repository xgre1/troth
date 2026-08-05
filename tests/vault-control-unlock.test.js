#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// vault.controlUnlock — control-channel adapter for the credential-vault
// unlock (closes the control:unlock_vault stub in
// bin/troth-entity.js). Proves a wrong/short passphrase maps to a clean
// {ok:false} instead of throwing, a correct passphrase round-trips to
// {ok:true}, and the passphrase is NEVER echoed in the result.
//
// Hermetic: every call targets a throwaway temp vault_path via opts — never
// the live ~/.troth vault. The module locks between cases so state can't
// leak.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

const vault = require(path.join(__dirname, '..', 'shared-core', 'vault.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vault-ctl-'));
const VPATH  = path.join(tmpDir, 'vault.bin');
// Low scrypt cost so the test is fast but still exercises the real KDF.
const OPTS   = { vault_path: VPATH, scrypt_n: 16384 };
const GOOD   = 'correct horse battery staple';

console.log('\n=== vault.controlUnlock ===\n');

t('missing/non-string passphrase → {ok:false}, no throw', () => {
  assert.strictEqual(vault.controlUnlock({}, OPTS).ok, false);
  assert.strictEqual(vault.controlUnlock({ passphrase: 123 }, OPTS).ok, false);
  assert.strictEqual(vault.controlUnlock(null, OPTS).ok, false);
});

t('short passphrase (<8) → {ok:false} mapped from unlock() throw', () => {
  const r = vault.controlUnlock({ passphrase: 'short' }, OPTS);
  assert.strictEqual(r.ok, false);
  assert.ok(/>= 8 chars/.test(r.error), 'maps the length error: ' + r.error);
});

t('correct passphrase on fresh vault → {ok:true} + session, file created', () => {
  vault.lock();
  const r = vault.controlUnlock({ passphrase: GOOD }, OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry_count, 0, 'fresh vault has no entries');
  assert.ok(typeof r.session_expires_at === 'number' && r.session_expires_at > Date.now());
  assert.ok(fs.existsSync(VPATH), 'vault file persisted on init');
  vault.lock();
});

t('wrong passphrase on existing vault → {ok:false}, no throw', () => {
  vault.lock();
  const r = vault.controlUnlock({ passphrase: 'totally wrong passphrase' }, OPTS);
  assert.strictEqual(r.ok, false);
  assert.ok(/decryption failed|wrong passphrase/i.test(r.error), 'maps decrypt error: ' + r.error);
  vault.lock();
});

t('result NEVER contains the passphrase (success or failure)', () => {
  vault.lock();
  const ok  = JSON.stringify(vault.controlUnlock({ passphrase: GOOD }, OPTS));
  vault.lock();
  const bad = JSON.stringify(vault.controlUnlock({ passphrase: 'short' }, OPTS));
  assert.ok(ok.indexOf(GOOD) < 0, 'success result leaks passphrase');
  assert.ok(bad.indexOf('short') < 0, 'failure result leaks passphrase');
  vault.lock();
});

t('payload.session_ms honored', () => {
  vault.lock();
  const before = Date.now();
  const r = vault.controlUnlock({ passphrase: GOOD, session_ms: 5000 }, OPTS);
  assert.strictEqual(r.ok, true);
  assert.ok(r.session_expires_at - before <= 6000, 'short session window applied');
  vault.lock();
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
