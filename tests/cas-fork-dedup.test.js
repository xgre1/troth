#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
require('./hermetic-db.js'); // a test never opens the operator's own substrate
// CAS fork without copy.
// Acceptance criterion: "put(X) twice → one blob; fork costs no CAS
// copies." The CAS is content-addressed, so identical bytes yield the
// same hash and reuse the existing blob file. Forking is just registering
// a new artifact engram that references the SAME cid — refcount goes up,
// the on-disk byte count does not.
//
// Hermetic via tests/hermetic-db.js — temp HOME + per-test TROTH_CAS_DIR.

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cas-fork-'));
  process.env.TROTH_CAS_DIR = d;
  return d;
}

// Count every regular file under the CAS dir, recursively. The two-level
// shard layout (<aa>/<full-hash>) means the dirents are nested but the
// metric we care about is "how many BLOB files exist."
function countBlobs(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const shard of fs.readdirSync(dir)) {
    const sp = path.join(dir, shard);
    let stat;
    try { stat = fs.statSync(sp); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(sp)) {
      if (/^[0-9a-f]{64}$/.test(f)) n++;
    }
  }
  return n;
}

function totalBytes(dir) {
  let bytes = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const shard of fs.readdirSync(dir)) {
    const sp = path.join(dir, shard);
    let stat;
    try { stat = fs.statSync(sp); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(sp)) {
      try { bytes += fs.statSync(path.join(sp, f)).size; } catch (_) {}
    }
  }
  return bytes;
}

// Register an artifact engram that references a CID — what a "fork" looks
// like in the substrate. Multiple artifacts can reference the same cid.
function registerArtifact(hash, label) {
  return engram.recordEngram({
    agent_id: 'cas-fork-test', user_id: 'operator', cwd: null,
    statement: 'artifact ' + label + ' cid=' + hash,
    scope: 'artifact',
    source: 'cas-fork-test',
    source_authority: 'llm_inferred',
    auto_verify: false
  });
}

console.log('\n=== CAS fork without copy ===\n');

t('put(X) twice → exactly ONE blob on disk (content-addressed dedup)', () => {
  const dir = freshCasDir();
  const a = cas.casPut('payload-X');
  const b = cas.casPut('payload-X');
  assert.strictEqual(a.hash, b.hash, 'identical bytes → identical hash');
  assert.strictEqual(a.created, true);
  assert.strictEqual(b.created, false,
    'second put is a no-op (no new bytes written)');
  assert.strictEqual(countBlobs(dir), 1, 'exactly one blob file on disk');
});

t('fork: two artifacts referencing the same cid → still ONE blob', () => {
  const dir = freshCasDir();
  const put = cas.casPut('shared-payload');
  registerArtifact(put.hash, 'original');
  const before = totalBytes(dir);
  registerArtifact(put.hash, 'fork');         // the fork — same cid
  const after = totalBytes(dir);
  assert.strictEqual(after, before,
    'forking adds an engram, not bytes — CAS dir size must not grow');
  assert.strictEqual(countBlobs(dir), 1, 'still exactly one blob');
  assert.strictEqual(cas.casRefcount(put.hash), 2,
    'both artifacts contribute to refcount');
});

t('fork survives GC as long as ANY artifact references the cid', () => {
  const dir = freshCasDir();
  const put = cas.casPut('survives-gc');
  registerArtifact(put.hash, 'a1');
  registerArtifact(put.hash, 'a2');
  const r = cas.casGC();
  assert.strictEqual(r.removed, 0,
    'GC must NOT reap a blob with live references; got: ' + JSON.stringify(r));
  assert.strictEqual(countBlobs(dir), 1);
});

t('distinct bytes → distinct blobs, GC reaps only the unreferenced', () => {
  const dir = freshCasDir();
  const a = cas.casPut('alpha').hash;
  const b = cas.casPut('beta').hash;
  registerArtifact(a, 'a-ref');               // a is referenced; b is orphan
  assert.strictEqual(countBlobs(dir), 2);
  const r = cas.casGC();
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(r.removed_hashes, [b]);
  assert.strictEqual(countBlobs(dir), 1);
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
