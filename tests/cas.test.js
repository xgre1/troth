#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// CAS test. Hermetic on two axes:
//   1. blob ops run against a throwaway TROTH_CAS_DIR — never the live
//      ~/.troth/cas;
//   2. the dispatcher's artifact-engram write is exercised against a STUBBED
//      engram module (require.cache injection, same pattern as
//      faculty-commit-bridge.test.js) — never the live state.db.
const assert = require('assert');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

// Throwaway CAS root BEFORE requiring cas.js (it resolves the dir per-call,
// but set it up front so nothing can leak to ~/.troth).
process.env.TROTH_CAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-test-'));

// Stub the engram store so the dispatcher's recordEngram / refcount path is
// observable and hermetic. Seed the require cache before cas.js / cas-do.js
// pull it in (both require('./engram.js') / require('../engram.js')).
const engramPath = path.join(__dirname, '..', 'shared-core', 'engram.js');
const recorded = [];           // captures recordEngram opts
let   engramRows = [];          // what listEngrams returns (for refcount)
require.cache[require.resolve(engramPath)] = {
  id: require.resolve(engramPath),
  filename: require.resolve(engramPath),
  loaded: true,
  exports: {
    recordEngram(opts) { recorded.push(opts); return 'engram-' + recorded.length; },
    listEngrams() { return engramRows; }
  }
};

const cas   = require(path.join(__dirname, '..', 'shared-core', 'cas.js'));
const casDo = require(path.join(__dirname, '..', 'shared-core', 'dispatchers', 'cas-do.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; })
    .catch(e => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== CAS (content-addressed store) ===\n');

(async () => {
  await t('put returns a 64-hex sha256 hash + byte size, created:true first time', () => {
    const r = cas.casPut('hello world');
    assert.match(r.hash, /^[0-9a-f]{64}$/);
    assert.strictEqual(r.size, 11);
    assert.strictEqual(r.created, true);
  });

  await t('identical content dedups: same hash, created:false, single blob on disk', () => {
    const a = cas.casPut('dedup me');
    const b = cas.casPut('dedup me');
    assert.strictEqual(b.hash, a.hash);
    assert.strictEqual(b.created, false);
    const p = cas.blobPath(a.hash);
    assert.ok(fs.existsSync(p), 'blob exists on disk');
  });

  await t('get round-trips utf8 content', () => {
    const { hash } = cas.casPut('round trip');
    assert.strictEqual(cas.casGet(hash), 'round trip');
  });

  await t('base64 encoding round-trips binary bytes', () => {
    const b64 = Buffer.from([0, 1, 2, 3, 255]).toString('base64');
    const { hash } = cas.casPut(b64, 'base64');
    assert.strictEqual(cas.casGet(hash, 'base64'), b64);
  });

  await t('has reflects presence', () => {
    const { hash } = cas.casPut('present');
    assert.strictEqual(cas.casHas(hash), true);
  });

  await t('absent hash yields null/false', () => {
    const absent = 'a'.repeat(64);
    assert.strictEqual(cas.casGet(absent), null);
    assert.strictEqual(cas.casHas(absent), false);
  });

  await t('malformed / path-traversal hash is rejected (no path escape)', () => {
    for (const bad of ['../../etc/passwd', 'not-a-hash', '', '/abs/path', 'A'.repeat(64)]) {
      assert.strictEqual(cas.casGet(bad), null);
      assert.strictEqual(cas.casHas(bad), false);
      assert.strictEqual(cas.casRefcount(bad), 0);
    }
  });

  await t('dispatcher routes put and records exactly one artifact engram', async () => {
    recorded.length = 0;
    const r = await casDo.dispatch({ id: 'intent:abc', payload: { op: 'put', content: 'via dispatcher' } });
    assert.strictEqual(r.ok, true);
    assert.match(r.result.hash, /^[0-9a-f]{64}$/);
    assert.strictEqual(recorded.length, 1, 'one artifact engram');
    assert.strictEqual(recorded[0].scope, 'artifact');
    assert.ok(recorded[0].statement.indexOf(r.result.hash) >= 0, 'cid embedded in statement');
    assert.strictEqual(recorded[0].extra_output.produced_by_intent_id, 'intent:abc');
    assert.strictEqual(recorded[0].source_authority, 'llm_inferred');
  });

  await t('dispatcher get returns content; missing hash returns ok:false', async () => {
    const put = await casDo.dispatch({ payload: { op: 'put', content: 'fetch me' } });
    const get = await casDo.dispatch({ payload: { op: 'get', hash: put.result.hash } });
    assert.strictEqual(get.ok, true);
    assert.strictEqual(get.result.content, 'fetch me');
    const miss = await casDo.dispatch({ payload: { op: 'get', hash: 'b'.repeat(64) } });
    assert.strictEqual(miss.ok, false);
    assert.strictEqual(miss.error, 'cas_not_found');
  });

  await t('dispatcher rejects unknown / malformed ops', async () => {
    const bad = await casDo.dispatch({ payload: { op: 'delete', hash: 'x' } });
    assert.strictEqual(bad.ok, false);
    const noContent = await casDo.dispatch({ payload: { op: 'put' } });
    assert.strictEqual(noContent.ok, false);
  });

  await t('refcount counts live artifact engrams referencing the cid (own + parent)', () => {
    const cid     = 'c'.repeat(64);
    const childCid = 'd'.repeat(64);
    engramRows = [
      { scope: 'artifact', statement: 'artifact ' + cid },                       // own reference
      { scope: 'artifact', statement: 'artifact ' + childCid + ' parents=' + cid }, // parent reference
      { scope: 'artifact', statement: 'artifact ' + 'e'.repeat(64) }             // unrelated
    ];
    assert.strictEqual(cas.casRefcount(cid), 2);
    assert.strictEqual(cas.casRefcount(childCid), 1);
    engramRows = [];
  });

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
