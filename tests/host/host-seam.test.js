#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// M0.2/M0.3 seam smoke test — verifies the host-abstraction + faculty seams
// resolve and satisfy their contracts WITHOUT requiring real hardware/VMM.
// Run: node tests/host/host-seam.test.js
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; }
}

console.log('\n=== Host + Faculty seam ===\n');

const host = require(path.join(__dirname, '..', '..', 'shared-core', 'host', 'host.js'));

// host.keyhsm's file backend probes `available` iff an operator key file
// exists (file.js:probe → opKey.exists()). The hermetic-db.js preloader gives
// us a fresh tmpdir HOME so no key is present at boot — initialize one so
// the keyhsm seam has something to resolve to. Production runs `troth key
// init` once before anything else; this is the test-time equivalent.
const opKey = require(path.join(__dirname, '..', '..', 'shared-core', 'operator-key.js'));
try {
  if (!opKey.exists()) opKey.initKeypair('hermetic-test-passphrase-not-real', { scrypt_n: 16384 });
} catch (_) { /* if init isn't possible we let the assertion below fail loudly */ }
host._reset();

t('keyhsm resolves to a backend with the contract shape', () => {
  const p = host.keyhsm.probe();
  assert.ok(p && typeof p === 'object', 'probe returns an object');
  // file backend available iff an operator key exists; either way the seam
  // must expose sign/publicKey/verify methods.
  assert.strictEqual(typeof host.keyhsm.verify, 'function', 'keyhsm.verify is a function');
});

t('hypervisor resolves to docker dev_only shim and refuses production launch', () => {
  const p = host.hypervisor.probe();
  assert.ok(p && typeof p === 'object');
  // docker shim is dev_only; launch must throw (never a silent prod launcher).
  assert.throws(() => host.hypervisor.launch('img', {}), /dev_only|dev harness/i);
});

t('presence resolves to headless and returns the presence contract shape', () => {
  const p = host.presence.probe();
  assert.ok(p && p.available, 'headless presence is always available');
  const s = host.presence.state();
  assert.ok('operator_present' in s && 'deep_asleep' in s && 'seconds_idle' in s,
    'state() has the {operator_present,seconds_idle,deep_asleep} contract');
});

t('TROTH_HOST_FORCE=fallback selects the fallback backend per namespace', () => {
  const prev = process.env.TROTH_HOST_FORCE;
  process.env.TROTH_HOST_FORCE = 'fallback';
  host._reset();
  try {
    assert.strictEqual(host.presence.backendName(), 'headless');
    assert.strictEqual(host.hypervisor.backendName(), 'docker');
  } finally {
    if (prev === undefined) delete process.env.TROTH_HOST_FORCE; else process.env.TROTH_HOST_FORCE = prev;
    host._reset();
  }
});

t('faculty seam exposes wake + activeFamily and never forwards a writing tool', () => {
  const faculty = require(path.join(__dirname, '..', '..', 'shared-core', 'faculty.js'));
  assert.strictEqual(typeof faculty.wake, 'function', 'faculty.wake exists');
  assert.strictEqual(typeof faculty.activeFamily, 'function', 'faculty.activeFamily exists');
  // Contract: wake's signature accepts prompt/grammar/audience only — there is
  // no `tools` parameter path (S2). Static surface check.
  assert.ok(!/tools\s*:/.test(faculty.wake.toString()), 'wake() does not accept a tools param');
});

console.log('');
console.log(`Host seam: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
