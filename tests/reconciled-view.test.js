#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// reconciled-view - fixtures are the two measured failures: the tanks run
// where the answer arbitrated ledger-vs-raw and lost, and the kits run
// where a raw-attested item missing from the ledger had to be added.
const assert = require('assert');
const { buildReconciledView } = require('../shared-core/reconciled-view.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== reconciled view (one truth with receipts) ===\n');

// TANKS fixture: 3 ledger tanks; the 5-gallon's raw statement present.
const tanks = [
  { source: 'instance-pool', id: 'i1', statement: '[instance] possession: owns tank — 5-gallon tank with betta Finley [completed] (attested ×2)', refs: ['dialogue.turn:r1', 'dialogue.turn:r9'] },
  { source: 'instance-pool', id: 'i2', statement: '[instance] possession: owns tank — 20-gallon tank finished cycling [completed] (attested ×1)', refs: ['dialogue.turn:r2'] },
  { source: 'instance-pool', id: 'i3', statement: '[instance] possession: owns tank — 1-gallon for the friend\'s kid [completed] (attested ×1)', refs: ['dialogue.turn:r3'] },
  { source: 'dialogue-window', id: 'r1', statement: 'user: I have a 5-gallon tank with my betta Finley.', ts: 1 },
  { source: 'dialogue-window', id: 'r2', statement: 'user: My 20-gallon finished cycling this week.', ts: 2 },
  { source: 'dialogue-window', id: 'r3', statement: 'user: I set up a 1-gallon tank for my friend\'s kid.', ts: 3 },
  { source: 'instance-sweep', id: 'r4', statement: 'user: Thinking about aquascaping ideas generally.', ts: 4 },
];

t('every covered raw statement is demoted to SUPPORT, never a candidate', () => {
  const v = buildReconciledView(tanks);
  const covered = v.raw.filter(r => r.role === 'supports');
  assert.strictEqual(covered.length, 3);
  assert.deepStrictEqual(v.raw.find(r => r.id === 'r1').supports, [1]);
});

t('the ledger carries its receipts as statement numbers', () => {
  const v = buildReconciledView(tanks);
  assert.deepStrictEqual(v.ledger[0].refs, [1]);
  const out = v.render();
  assert.ok(out.indexOf('(attested by S1)') >= 0, out.split('\n')[1]);
  assert.ok(out.indexOf('[=L1]') >= 0, 'covered statement carries its ledger mark');
});

t('an uncovered raw statement is explicitly offered for judgment', () => {
  const v = buildReconciledView(tanks);
  const free = v.raw.find(r => r.id === 'r4');
  assert.strictEqual(free.role, 'new');
  const out = v.render();
  assert.ok(out.indexOf('S4. [+] ') >= 0, 'uncovered statement carries the + mark');
  assert.ok(out.indexOf('judge those individually') >= 0, 'legend explains the marks once');
});

// KITS fixture: 4 ledger kits but 5 raw kit statements - the 5th must
// surface as judge-material (the union the compose rule failed to enforce
// by prose becomes structure).
const kits = [
  { source: 'instance-pool', id: 'i1', statement: '[instance] purchase: bought Corvette kit [completed]', refs: ['dialogue.turn:k1'] },
  { source: 'instance-pool', id: 'i2', statement: '[instance] purchase: bought Camaro kit [completed]', refs: ['dialogue.turn:k2'] },
  { source: 'instance-pool', id: 'i3', statement: '[instance] activity: worked on Spitfire kit [completed]', refs: ['dialogue.turn:k3'] },
  { source: 'instance-pool', id: 'i4', statement: '[instance] purchase: bought F-15 kit [completed]', refs: ['dialogue.turn:k4'] },
  { source: 'dialogue-window', id: 'k1', statement: 'user: Picked up the Corvette model kit.', ts: 1 },
  { source: 'dialogue-window', id: 'k2', statement: 'user: The Camaro kit arrived.', ts: 2 },
  { source: 'dialogue-window', id: 'k3', statement: 'user: Working on the 1/48 Spitfire.', ts: 3 },
  { source: 'dialogue-window', id: 'k4', statement: 'user: Bought the Revell F-15.', ts: 4 },
  { source: 'instance-sweep', id: 'k5', statement: 'user: Also started the Tiger I tank kit last month.', ts: 5 },
];

t('the ledger-missing occurrence stands out as the ONLY judge line (kits class)', () => {
  const v = buildReconciledView(kits);
  const judged = v.raw.filter(r => r.role === 'new');
  assert.strictEqual(judged.length, 1);
  assert.strictEqual(judged[0].id, 'k5');
});

t('an instance attested only outside the shown statements is FLAGGED, not trusted silently', () => {
  const v = buildReconciledView([
    { source: 'instance-pool', id: 'i1', statement: '[instance] visit: visited Dr. X [completed]', refs: ['dialogue.turn:elsewhere'] },
    { source: 'dialogue-window', id: 'r1', statement: 'user: unrelated.', ts: 1 },
  ]);
  assert.ok(v.ledger[0].flags.length === 1);
  assert.ok(v.render().indexOf('[flag: attested outside the shown statements]') >= 0);
});

t('with no instances at all the view degrades to the plain numbered statements', () => {
  const v = buildReconciledView([
    { source: 'dialogue-window', id: 'r1', statement: 'user: plain.', ts: 1 },
  ]);
  const out = v.render();
  assert.ok(out.indexOf('Consolidated ledger') < 0);
  assert.ok(out.indexOf('S1. user: plain.') >= 0);
  assert.ok(out.indexOf('judge those individually') < 0, 'no legend noise when there is no ledger');
  assert.ok(out.indexOf('[+]') < 0, 'no coverage marks when there is no ledger');
});

t('possessions render as owned with the doctrine stated once', () => {
  const v = buildReconciledView(tanks);
  const out = v.render();
  assert.ok(out.indexOf('[owned') >= 0, 'possession status renders as owned');
  assert.ok(!/possession:[^\n]*\[completed/.test(out), 'no possession line keeps [completed');
  assert.ok(out.indexOf('Possessions stay owned until an explicit disposal') >= 0, 'doctrine header present');
});

t('the ownership doctrine stays out of non-possession views', () => {
  const v = buildReconciledView(kits);
  assert.ok(v.render().indexOf('Possessions stay owned') < 0);
});

// Cast counting scope: the clause that counts over the cast is for
// person-headed count questions only. Measured failure: a weddings count
// read the cast's four people as four weddings.
const withCast = [
  { source: 'instance-pool', id: 'i1', statement: '[instance] event: attended Emily — Cousin\'s wedding in the city [completed] (attested ×1)', refs: ['dialogue.turn:r1'] },
  { source: 'identity-cast', id: 'c1', statement: '[cast] Emily — person (cousin)', link_names: ['emily'] },
  { source: 'identity-cast', id: 'c2', statement: '[cast] Jen — person (friend)', link_names: ['jen'] },
  { source: 'dialogue-window', id: 'r1', statement: 'user: Emily\'s wedding was lovely.', ts: 1 }
];

t('a person-headed count keeps the cast counting clause', () => {
  const v = buildReconciledView(withCast, { noun_head: 'doctors' });
  assert.ok(v.render().indexOf('count over THIS list') >= 0);
});

t('an event-headed count renders the cast as a glossary, never counted', () => {
  const v = buildReconciledView(withCast, { noun_head: 'weddings' });
  const out = v.render();
  assert.ok(out.indexOf('count over THIS list') < 0, 'counting clause must go');
  assert.ok(out.indexOf('glossary for reading the evidence') >= 0, 'glossary header present');
  assert.ok(out.indexOf('C1.') >= 0, 'the cast itself still renders');
});

t('no head supplied leaves the clause exactly as before', () => {
  const v = buildReconciledView(withCast);
  assert.ok(v.render().indexOf('count over THIS list') >= 0);
});

console.log('');
console.log('reconciled-view: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
