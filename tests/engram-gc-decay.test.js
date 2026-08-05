#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// engram-gc decay-age regression.
// Proves decay is measured from LAST RETRIEVAL, not write time (research
// AI-Memory-Consolidation-Implementation-Details.md §3.5: Ebbinghaus utility
// decay is a function of recency of last retrieval — recall reinforces, the
// Bjork property). The prior code aged from write-ts, so a fact recalled
// yesterday but written 6 months ago was decayed as if untouched 6 months.
const assert = require('assert');
const path = require('path');
const { decayAgeDays } = require(path.join(__dirname, '..', 'shared-core', 'engram-gc.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

console.log('\n=== engram-gc decay-age (last-retrieval) ===\n');

t('never-retrieved engram ages from write time', () => {
  const age = decayAgeDays(NOW - 30 * DAY, null, NOW);
  assert.ok(Math.abs(age - 30) < 1e-6, 'expected ~30 days, got ' + age);
});

t('recently-retrieved old engram ages from retrieval, not write (Bjork)', () => {
  // Written 180 days ago, retrieved 1 day ago → should age ~1 day, not 180.
  const age = decayAgeDays(NOW - 180 * DAY, NOW - 1 * DAY, NOW);
  assert.ok(Math.abs(age - 1) < 1e-6, 'recall must reset decay age; got ' + age);
});

t('retrieval older than write is ignored (uses the later touch)', () => {
  // Stale stats row (retrieval ts before write ts) must not inflate age.
  const age = decayAgeDays(NOW - 10 * DAY, NOW - 50 * DAY, NOW);
  assert.ok(Math.abs(age - 10) < 1e-6, 'must use the later of write/retrieval; got ' + age);
});

t('future/zero now never yields negative age', () => {
  const age = decayAgeDays(NOW + 5 * DAY, null, NOW);
  assert.strictEqual(age, 0, 'age floored at 0');
});

t('missing write ts falls back to now (age 0)', () => {
  const age = decayAgeDays(undefined, null, NOW);
  assert.strictEqual(age, 0);
});

console.log('');
console.log('engram-gc decay-age: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
