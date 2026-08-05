#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// CAS garbage collection.
// Acceptance criterion: "expired artifact GC'd, pinned untouched."
// casGC() walks every blob under _casDir(), unlinks the ones whose
// refcount has fallen to zero AND which are not pinned. casPin() writes a
// cas_pin:<hash> engram (operator-side surface) and the TROTH_CAS_PINNED
// env var lets CI / harness add hashes from outside the substrate.
//
// Hermetic via tests/hermetic-db.js — HOME redirected to tmpdir; CAS lives
// at $HOME/.troth/cas/. Each test isolates state via TROTH_CAS_DIR.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const cas    = require(path.join(PROJECT_ROOT, 'shared-core', 'cas.js'));
const engram = require(path.join(PROJECT_ROOT, 'shared-core', 'engram.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

function freshCasDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cas-'));
  process.env.TROTH_CAS_DIR = d;
  return d;
}

// Helper: write an artifact engram that references the given hash, so
// casRefcount() returns > 0. Mirrors what cas-do.js does in production.
function holdReference(hash, label) {
  return engram.recordEngram({
    agent_id: 'cas-gc-test', user_id: 'operator', cwd: null,
    statement: 'artifact ' + (label || 'live') + ' cid=' + hash,
    scope: 'artifact',
    source: 'cas-gc-test',
    source_authority: 'llm_inferred',
    auto_verify: false
  });
}

console.log('\n=== CAS garbage collection ===\n');

t('casGC on empty CAS → scanned:0 removed:0 — no crash', () => {
  freshCasDir();
  const r = cas.casGC();
  assert.strictEqual(r.scanned, 0);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(r.kept, 0);
});

t('blob with a live referencing artifact engram is KEPT', () => {
  freshCasDir();
  const put = cas.casPut('reachable-blob-content');
  assert.ok(put.created);
  const ref = holdReference(put.hash, 'reachable');
  assert.ok(ref);
  assert.strictEqual(cas.casRefcount(put.hash), 1);
  const r = cas.casGC();
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.removed, 0, 'must NOT remove live-referenced blob');
  assert.strictEqual(r.kept, 1);
  assert.ok(fs.existsSync(cas.blobPath(put.hash)),
    'blob file still on disk');
});

t('blob with refcount=0 → REMOVED (no engram references it)', () => {
  freshCasDir();
  const put = cas.casPut('orphan-blob-content');
  assert.strictEqual(cas.casRefcount(put.hash), 0,
    'no artifact engram → refcount must be 0');
  assert.ok(fs.existsSync(cas.blobPath(put.hash)));
  const r = cas.casGC();
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.removed, 1, 'orphan blob should be reaped');
  assert.ok(!fs.existsSync(cas.blobPath(put.hash)),
    'blob file unlinked');
  assert.deepStrictEqual(r.removed_hashes, [put.hash]);
});

t('pinned blob with refcount=0 → KEPT (pin via casPin engram)', () => {
  freshCasDir();
  const put = cas.casPut('pinned-via-engram');
  const pin = cas.casPin(put.hash);
  assert.strictEqual(pin.ok, true, 'pin engram write must succeed: ' + JSON.stringify(pin));
  assert.strictEqual(cas.isPinned(put.hash), true);
  const r = cas.casGC();
  assert.strictEqual(r.removed, 0, 'pinned blob never reaped');
  assert.strictEqual(r.kept, 1);
  assert.ok(fs.existsSync(cas.blobPath(put.hash)));
});

t('pinned blob via TROTH_CAS_PINNED env → KEPT', () => {
  freshCasDir();
  const put = cas.casPut('pinned-via-env');
  const prev = process.env.TROTH_CAS_PINNED;
  process.env.TROTH_CAS_PINNED = put.hash;
  try {
    assert.strictEqual(cas.isPinned(put.hash), true);
    const r = cas.casGC();
    assert.strictEqual(r.removed, 0);
    assert.ok(fs.existsSync(cas.blobPath(put.hash)));
  } finally {
    if (prev === undefined) delete process.env.TROTH_CAS_PINNED;
    else process.env.TROTH_CAS_PINNED = prev;
  }
});

t('mixed run — one live, one orphan, one pinned → only orphan reaped', () => {
  freshCasDir();
  const live   = cas.casPut('live-mixed').hash;
  const orphan = cas.casPut('orphan-mixed').hash;
  const pinned = cas.casPut('pinned-mixed').hash;
  holdReference(live, 'live-mixed');
  cas.casPin(pinned);

  const r = cas.casGC();
  assert.strictEqual(r.scanned, 3);
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(r.removed_hashes, [orphan]);
  assert.ok(fs.existsSync(cas.blobPath(live)),   'live blob kept');
  assert.ok(fs.existsSync(cas.blobPath(pinned)), 'pinned blob kept');
  assert.ok(!fs.existsSync(cas.blobPath(orphan)), 'orphan blob removed');
});

t('extra_pinned option pins additional hashes for one GC pass', () => {
  freshCasDir();
  const a = cas.casPut('ad-hoc-pin-a').hash;
  const b = cas.casPut('ad-hoc-pin-b').hash;
  const r = cas.casGC({ extra_pinned: [a] });
  assert.strictEqual(r.removed, 1, 'b should be removed');
  assert.deepStrictEqual(r.removed_hashes, [b]);
  assert.ok(fs.existsSync(cas.blobPath(a)));
  assert.ok(!fs.existsSync(cas.blobPath(b)));
});

t('GC is idempotent — re-running yields scanned=remaining, removed=0', () => {
  freshCasDir();
  cas.casPut('once-orphan');
  cas.casGC();      // reap
  const r2 = cas.casGC();
  assert.strictEqual(r2.removed, 0, 'nothing left to reap');
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
