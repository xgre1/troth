#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// instance consolidation: two occasions that each name people and share none
// never merge, whatever an alias or an anchor would say.
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

const austin  = { kind: 'event', entity: 'Austin Film Festival', description: 'participated in a 48-hour film challenge at the Austin Film Festival where the team wrote, shot, and edited a short film', date_iso: null, status: 'completed', qualifier: 'participated in' };
const seattle = { kind: 'event', entity: 'Seattle International Film Festival', description: 'attended a Q&A session after the screening at the Seattle International Film Festival', date_iso: null, status: 'completed', qualifier: 'attended' };

t('the occasion word itself is not a name: two festivals in two cities never merge', () => {
  assert.deepStrictEqual([...T._rawProperNames(austin)].sort(), ['austin']);
  assert.deepStrictEqual([...T._rawProperNames(seattle)].sort(), ['seattle']);
  assert.strictEqual(T._sameEvent(austin, seattle, {}), false);
  assert.strictEqual(T._sameOccurrence({ instance: austin }, seattle, null, {}), false);
});

const emilyEvent = { kind: 'event', entity: 'Emily', description: 'attended cousin Emily\'s wedding in the city, described as having a rooftop garden', date_iso: null, status: 'completed', qualifier: 'attended' };
const roommateVisit = { kind: 'visit', entity: 'college roommate', description: 'got back from a college roommate\'s wedding in the city; the ceremony was in a rooftop garden', date_iso: null, status: 'completed', qualifier: 'got back from' };
const dentistVisit = { kind: 'visit', entity: 'Dr. Lee', description: 'saw Dr. Lee for a cleaning', date_iso: null, status: 'completed', qualifier: 'saw' };

t('one wedding typed event by one pass and visit by the next is one wedding; a visit that is not an occasion never meets an event', () => {
  assert.strictEqual(T._sameOccurrence({ instance: emilyEvent }, roommateVisit, null, {}), true, 'rooftop garden joins the retelling across kinds');
  assert.strictEqual(T._sameOccurrence({ instance: emilyEvent }, dentistVisit, null, {}), false);
});

console.log('\ninstance-merge-cast: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
