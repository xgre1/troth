#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// reconciled-view: subject by kind, and the mind doing the calendar.
// Fixtures are the ledgers the probes measured on 2026-09-02: a tank count
// that let plants and children in on statement cosine, a wedding count that
// a charity gala and a bachelor party sat close enough to pass, and a
// three-event order whose reader counted days by hand.
const assert = require('assert');
const { buildReconciledView } = require('../shared-core/reconciled-view.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== reconciled view: subject by kind, calendar ===\n');

const ASKED = Date.UTC(2023, 4, 30); // 2023-05-30
const inst = (id, kind, entity, text, extra) => Object.assign({
  source: 'instance-pool', id, refs: ['dialogue.turn:r' + id], _kind: kind, _status: 'owned', _qualifier: 'has', _entity: entity,
  statement: '[instance] ' + kind + ': has ' + entity + ' — ' + text + ' [owned] (attested ×1)', _cos: 0.45
}, extra || {});

const tanks = [
  inst('t1', 'possession', '20-gallon community tank', 'have a new 20-gallon community tank', { _entity_cos: 0.349 }),
  inst('t2', 'possession', '5-gallon tank', 'had a 5-gallon tank for a betta', { _entity_cos: 0.476 }),
  inst('t3', 'possession', '1-gallon tank for a friend\'s kid', 'set up a small 1-gallon tank for a friend\'s kid', { _entity_cos: 0.453 }),
  inst('t4', 'possession', 'java moss', 'has a java moss in a community tank', { _entity_cos: 0.257 }),
  inst('t5', 'possession', 'anacharis', 'has an anacharis in a community tank', { _entity_cos: 0.233 }),
  inst('t6', 'possession', 'two young children', 'has two young children', { _entity_cos: 0.214 }),
  { source: 'dialogue-window', id: 'r1', statement: 'user: I have a 20-gallon community tank and a 5-gallon one.', ts: ASKED - 86400000 },
];

t('a tank count keeps the tanks and sets the plants and the children aside, whatever their sentences say', () => {
  const v = buildReconciledView(tanks, { noun_head: 'tanks', question: 'How many tanks do I currently have, including the one I set up for my friend\'s kid?', reference_ts: ASKED });
  const kept = v.ledger.map(l => l.entity);
  assert.deepStrictEqual(kept.sort(), ['1-gallon tank for a friend\'s kid', '20-gallon community tank', '5-gallon tank'], kept.join(' | '));
  assert.ok(v.aside.every(a => /asked subject/.test(a.reason)), v.aside.map(a => a.reason).join(' | '));
});

const ev = (id, entity, text, date, extra) => Object.assign({
  source: 'instance-pool', id, refs: ['dialogue.turn:r' + id], _kind: 'event', _status: 'completed', _qualifier: 'attended', _entity: entity,
  statement: '[instance] event: attended ' + entity + ' — ' + text + ' [completed' + (date ? ', ' + date : '') + '] (attested ×1)', _cos: 0.45
}, extra || {});

const weddings = [
  ev('w1', 'Rachel', 'attended cousin Rachel\'s wedding at a vineyard', '2023-08-01', { _entity_cos: 0.21 }),
  ev('w2', 'Emily', 'attended cousin Emily\'s wedding in the city', null, { _entity_cos: 0.20 }),
  ev('w3', 'friend', 'attended a friend\'s wedding where Jen was the bride and Tom was her husband', null, { _entity_cos: 0.31 }),
  ev('w4', 'charity gala', 'attended a charity gala and won a silent auction', '2023-10-15', { _entity_cos: 0.329 }),
  ev('w5', 'bachelor party', 'met Alex at a bachelor party', '2023-10-15', { _entity_cos: 0.52 }),
  { source: 'dialogue-window', id: 'r1', statement: 'user: I attended cousin Rachel\'s wedding at a vineyard last month.', ts: ASKED - 86400000 },
];

t('an occasion in the words decides: weddings stay, a gala and a bachelor party leave however close their entities score', () => {
  const v = buildReconciledView(weddings, { noun_head: 'weddings', question: 'How many weddings have I attended?', reference_ts: Date.UTC(2023, 10, 1) });
  const kept = v.ledger.map(l => l.entity).sort();
  assert.deepStrictEqual(kept, ['Emily', 'Rachel', 'friend'], kept.join(' | '));
});

t('when the question asks for a time or an order, the view does the calendar', () => {
  const asked = Date.UTC(2023, 5, 1); // 2023-06-01
  const trips = [
    ev('a', 'Muir Woods', 'day hike to Muir Woods with family', '2023-03-10', { _kind: 'visit', _entity_cos: 0.5 }),
    ev('b', 'Big Sur and Monterey', 'road trip with friends to Big Sur and Monterey', '2023-04-20', { _kind: 'visit', _entity_cos: 0.5 }),
    ev('c', 'Yosemite National Park', 'solo camping trip to Yosemite', '2023-05-15', { _kind: 'visit', _entity_cos: 0.5 }),
    { source: 'dialogue-window', id: 'r1', statement: 'user: I just got back from Yosemite today.', ts: asked - 86400000 * 17 },
  ];
  const shape = { source: 'model', count: true, request: false, head: 'trip', head_phrase: 'trip', families: ['visit'], past: true, window: null, asks: 'count', status: 'any' };
  const v = buildReconciledView(trips, { question: 'What is the order of the three trips I took, from earliest to latest?', reference_ts: asked, shape });
  const out = v.render();
  assert.ok(out.indexOf('Calendar (computed from the dates above; the question was asked on 2023-06-01):') >= 0, out);
  assert.ok(/In order, earliest first: L\d \(2023-03-10\) → L\d \(2023-04-20\) → L\d \(2023-05-15\)/.test(out), out);
  assert.ok(/2023-05-15, 17 days before the question/.test(out), 'span to the question day');
  assert.ok(/is 41 days after L/.test(out) && /is 25 days after L/.test(out), 'spans between dated lines');
  const shapeTime = Object.assign({}, shape, { count: false, asks: 'time' });
  const v2 = buildReconciledView(trips, { question: 'How many days ago did I get back from Yosemite?', reference_ts: asked, shape: shapeTime });
  assert.ok(v2.render().indexOf('Calendar (computed') >= 0, 'a time question gets the calendar too');
  const v3 = buildReconciledView(trips, { question: 'How many trips did I take?', reference_ts: asked, shape: Object.assign({}, shape, { asks: 'count' }) });
  assert.ok(v3.render().indexOf('Calendar (computed') < 0, 'a plain count does not');
});

console.log('\nreconciled-view-subject: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
