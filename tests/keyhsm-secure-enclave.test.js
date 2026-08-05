#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// host.keyhsm secure-enclave backend.
// Acceptance criterion: 'hardware-signed operator-tier engram
// requires a touch, key never in process memory.' Touch-to-sign is a
// YubiKey-tier property; this backend is the OTHER hardware rung — the
// macOS Keychain (Secure Enclave-backed when the chip supports it). The
// operator's private key bytes live in Keychain, not on disk; verify()
// stays backend-agnostic.
//
// Hermetic: the live test never reaches into the operator's actual
// Keychain (would persist + prompt for ACL grants). The pure sign helper
// is exercised against a freshly-generated Ed25519 keypair stored only in
// the test's memory, and the verify path round-trips through the existing
// operator-key.verify so any future backend swap reuses the same oracle.
// The 'live SE round-trip' test is gated on TROTH_SE_LIVE=1 so an
// operator opt-in run exercises the actual `security` CLI; default skip.

const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const se = require(path.join(PROJECT_ROOT, 'shared-core', 'host', 'keyhsm', 'secure-enclave.js'));
const opKey = require(path.join(PROJECT_ROOT, 'shared-core', 'operator-key.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

console.log('\n=== host.keyhsm secure-enclave ===\n');

t('module exposes the host.keyhsm contract surface', () => {
  assert.strictEqual(se.name, 'secure-enclave');
  assert.strictEqual(typeof se.probe, 'function');
  assert.strictEqual(typeof se.publicKey, 'function');
  assert.strictEqual(typeof se.sign, 'function');
  assert.strictEqual(typeof se.verify, 'function');
  assert.strictEqual(se.requiresPresence, false);
});

t('probe() — available on darwin where `security` CLI is reachable', () => {
  const p = se.probe();
  if (process.platform === 'darwin') {
    // Allow probe to fail if the test runs in a context without the login
    // keychain (CI headless): we accept available:true OR a clean
    // available:false with a reason. Hard fail = throw.
    assert.strictEqual(typeof p.backend, 'string');
    assert.strictEqual(p.backend, 'secure-enclave');
    if (!p.available) {
      assert.strictEqual(typeof p.reason, 'string', 'unavailable probe must explain why');
    } else {
      assert.strictEqual(p.hardware, true, 'available SE probe must claim hardware');
      assert.strictEqual(p.dev_only, false);
    }
  } else {
    assert.strictEqual(p.available, false);
    assert.strictEqual(p.reason, 'platform_not_darwin');
  }
});

t('_publicKeyId — deterministic gck-se:<16-hex> from SPKI PEM', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const id = se._publicKeyId(pem);
  assert.ok(/^gck-se:[0-9a-f]{16}$/.test(id), 'id shape: ' + id);
  assert.strictEqual(se._publicKeyId(pem), id, 'deterministic');
});

t('_signWithMaterial — Ed25519 sign + verify round-trip', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem  = publicKey.export({ type: 'spki',  format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const mat = { id: se._publicKeyId(pubPem), pub_pem: pubPem, priv_pem: privPem };

  const bytes = 'canonical engram body to sign';
  const sig = se._signWithMaterial(bytes, mat);
  assert.strictEqual(typeof sig, 'string');
  // base64 of an Ed25519 sig is 88 chars (64 bytes -> 88 b64).
  assert.strictEqual(sig.length, 88, 'ed25519 sig is 64 bytes base64-encoded');

  assert.strictEqual(se.verify(bytes, sig, pubPem), true,
    'verify accepts the genuine sig');
  // Backend-agnostic verify must also accept it (delegates to operator-key).
  assert.strictEqual(opKey.verify(pubPem, bytes, sig), true,
    'operator-key.verify is the shared oracle and agrees');
});

t('_signWithMaterial — sig of TAMPERED bytes is rejected', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem  = publicKey.export({ type: 'spki',  format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const mat = { priv_pem: privPem };

  const sig = se._signWithMaterial('original', mat);
  assert.strictEqual(se.verify('TAMPERED', sig, pubPem), false);
});

t('_signWithMaterial — wrong-key verify rejected', () => {
  const a = crypto.generateKeyPairSync('ed25519');
  const b = crypto.generateKeyPairSync('ed25519');
  const sig = se._signWithMaterial('msg', {
    priv_pem: a.privateKey.export({ type: 'pkcs8', format: 'pem' })
  });
  const pubB = b.publicKey.export({ type: 'spki', format: 'pem' });
  assert.strictEqual(se.verify('msg', sig, pubB), false,
    'verify with a stranger pubkey must fail');
});

t('_signWithMaterial — material_missing thrown on bad input', () => {
  assert.throws(() => se._signWithMaterial('x', null), /material_missing/);
  assert.throws(() => se._signWithMaterial('x', {}),   /material_missing/);
});

// Live Keychain round-trip — operator opt-in via TROTH_SE_LIVE=1. Skipped
// by default so npm test never writes to the operator's real Keychain.
const LIVE = /^(1|on|true|yes)$/i.test(String(process.env.TROTH_SE_LIVE || ''));
if (LIVE && process.platform === 'darwin') {
  const TEST_ITEM    = 'troth-se-test-' + Date.now();
  const TEST_ACCOUNT = 'se-test-account';
  process.env.TROTH_SE_KEYCHAIN_ITEM    = TEST_ITEM;
  process.env.TROTH_SE_KEYCHAIN_ACCOUNT = TEST_ACCOUNT;
  // Re-require so the module picks up the test env names.
  delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'shared-core', 'host', 'keyhsm', 'secure-enclave.js'))];
  const seLive = require(path.join(PROJECT_ROOT, 'shared-core', 'host', 'keyhsm', 'secure-enclave.js'));

  t('LIVE: lazy-provisioned Keychain item — sign + verify against publicKey', () => {
    const sig = seLive.sign('live-sign-bytes');
    assert.ok(sig.length >= 80);
    const pub = seLive.publicKey();
    assert.ok(pub && pub.id && pub.pem);
    assert.strictEqual(seLive.verify('live-sign-bytes', sig, pub.pem), true);
  });

  // Cleanup — remove the test Keychain item so the run leaves no residue.
  spawnSync('security',
    ['delete-generic-password', '-s', TEST_ITEM, '-a', TEST_ACCOUNT],
    { stdio: 'ignore' });
} else {
  console.log('  (live SE round-trip skipped — set TROTH_SE_LIVE=1 on macOS to enable)');
}

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
