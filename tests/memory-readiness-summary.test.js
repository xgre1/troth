#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The one-line memory summary every surface can show: the stage and how much
// is left, as numbers, with a pause named as a pause.
const assert = require('assert');
const path = require('path');
const { summarize } = require(path.join(__dirname, '..', 'shared-core', 'memory-readiness.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const base = (o) => Object.assign({ stage: 'ready', indexing: { recall_total: 12431, recall_missing: 0 }, embedder: { progress: 1 }, drain: { alive: true }, paused: { paused: false } }, o);

console.log('\n=== memory readiness summary ===\n');

t('ready names the count indexed', () => {
  assert.strictEqual(summarize(base({})), 'memory ready · 12,431 indexed');
});
t('indexing names what is left of the total', () => {
  assert.strictEqual(summarize(base({ stage: 'indexing', indexing: { recall_total: 89151, recall_missing: 91 } })), 'memory indexing · 91 left of 89,151');
});
t('a download names its progress', () => {
  assert.strictEqual(summarize(base({ stage: 'engine_downloading', embedder: { progress: 0.42 } })), 'memory engine downloading 42%');
});
t('no engine is word matching only', () => {
  assert.strictEqual(summarize(base({ stage: 'unavailable' })), 'memory: word matching only');
});
t('a pause is named as a pause, on any stage', () => {
  assert.strictEqual(summarize(base({ paused: { paused: true } })), 'memory ready · 12,431 indexed · paused by you');
  assert.strictEqual(summarize(base({ stage: 'indexing', indexing: { recall_total: 10, recall_missing: 3 }, paused: { paused: true } })), 'memory indexing · 3 left of 10 · paused by you');
});
t('indexing with no worker says so; a paused one does not double up', () => {
  assert.strictEqual(summarize(base({ stage: 'indexing', indexing: { recall_total: 10, recall_missing: 3 }, drain: { alive: false } })), 'memory indexing · 3 left of 10 · no worker running');
  assert.strictEqual(summarize(base({ stage: 'indexing', indexing: { recall_total: 10, recall_missing: 3 }, drain: { alive: false }, paused: { paused: true } })), 'memory indexing · 3 left of 10 · paused by you');
});
t('the summary rides on readiness() itself', () => {
  const r = require(path.join(__dirname, '..', 'shared-core', 'memory-readiness.js')).readiness();
  assert.strictEqual(typeof r.summary, 'string');
  assert.ok(/^memory/.test(r.summary), r.summary);
});

console.log('\nmemory-readiness-summary: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
