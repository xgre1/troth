#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// instance consolidation: two occasions that each name people and share
// none never merge, whatever an alias or an anchor would say. Measured
// 2026-09-02: "a friend's wedding where Jen was the bride and Tom was her
// husband" and "cousin Emily's wedding in the city" became ONE ledger line.
const assert = require('assert');
const ic = require('../shared-core/instance-consolidation.js');
const T = ic.__test;

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== instance merge: distinct by cast ===\n');

const jenTom = { kind: 'event', entity: 'friend', description: 'attended a friend\'s wedding last weekend where Jen was the bride and Tom was her husband', date_iso: null, status: 'completed', qualifier: 'attended' };
const emily  = { kind: 'event', entity: 'Emily\'s wedding in the city', description: 'attended cousin Emily\'s wedding in the city; it featured a rooftop garden', date_iso: null, status: 'completed', qualifier: 'attended' };
const emilySarah = { kind: 'event', entity: 'college roommate\'s wedding', description: 'attended Emily\'s wedding where she married Sarah', date_iso: null, status: 'completed', qualifier: 'attended' };
const rachelRetold = { kind: 'event', entity: 'Rachel', description: 'Rachel\'s wedding at the vineyard was stunning, I was a bridesmaid', date_iso: null, status: 'completed', qualifier: 'attended' };
const rachel = { kind: 'event', entity: 'Rachel\'s wedding at the vineyard', description: 'attended cousin Rachel\'s wedding at a vineyard', date_iso: '2023-08-01', status: 'completed', qualifier: 'attended' };

t('the names a line carries on its own words', () => {
  assert.deepStrictEqual([...T._rawProperNames(jenTom)].sort(), ['jen', 'tom']);
  assert.deepStrictEqual([...T._rawProperNames(emily)].sort(), ['emily']);
  assert.deepStrictEqual([...T._rawProperNames(emilySarah)].sort(), ['emily', 'sarah']);
});

t('two weddings naming different people never merge', () => {
  assert.strictEqual(T._sameEvent(jenTom, emily, {}), false);
  assert.strictEqual(T._sameEvent(emily, jenTom, {}), false);
  assert.strictEqual(T._sameOccurrence({ instance: jenTom }, emily, null, {}), false);
});

t('a wedding retold under a shared name still joins', () => {
  assert.strictEqual(T._sameEvent(emily, emilySarah, {}), true, 'Emily on both sides');
  assert.strictEqual(T._sameEvent(rachel, rachelRetold, {}), true, 'Rachel on both sides');
});

console.log('\ninstance-merge-cast: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
