#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Event-identity merge — retellings of one social occasion become ONE
// ledger occurrence.
//
// Fixture strings are the REAL extractor output from the measured failure
// (a wedding haystack where every session shares one date, the same wedding
// is retold as "friend Emily's", "cousin Emily's" and "the city wedding",
// and the run counted 5 weddings where gold says 3). Four rungs, in order:
// disjoint named participants split, a shared name joins, same-axis anchors
// with no overlap split, no separator anywhere joins. Pinned different
// dates always split. Possessions keep their own guard untouched.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const ic = require(path.join(__dirname, '..', 'shared-core', 'instance-consolidation.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message || e)); } }

const AGENT = 'claude-code';
const turns = [{ id: 'turn-1', timestamp: Date.now() - 86400000 }];

function inst(kind, entity, description, quote, extra) {
  return Object.assign({
    kind, entity, description, quote,
    date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0]
  }, extra || {});
}

function writeAll(instances) {
  const pool = [];
  const r = ic.writeInstances({ instances, turns, agent_id: AGENT, user_id: 'default', _pool: pool, session_id: 'S-test' });
  return { r, pool };
}

t('disjoint named participants split; a shared name joins the retelling', () => {
  const { r, pool } = writeAll([
    inst('event', "Emily and Sarah's wedding", 'Attended wedding of friend Emily and her partner Sarah', 'My friend Emily finally got to tie the knot'),
    inst('event', 'Rachel', "Cousin's wedding at a vineyard in August", "one of them was my cousin's wedding at a vineyard in August"),
    inst('event', 'Emily', "Cousin's wedding in the city at a rooftop garden and trendy restaurant", "My cousin Emily's wedding in the city was really lovely")
  ]);
  assert.strictEqual(r.written, 2, 'two real weddings, third mention merged: ' + JSON.stringify(r));
  assert.strictEqual(r.dup, 1);
  assert.strictEqual(pool.length, 2);
});

t('same-axis anchors with no overlap split even without names', () => {
  const { r } = writeAll([
    inst('event', 'wedding', 'Wedding at a vineyard in August', 'the vineyard wedding in August was perfect'),
    inst('event', 'wedding', 'Wedding in the city last weekend', 'got back from a wedding in the city')
  ]);
  assert.strictEqual(r.written, 2, JSON.stringify(r));
});

t('no separator anywhere joins - a retelling, not a new occasion', () => {
  const { r } = writeAll([
    inst('event', "cousin's wedding", 'Attended cousin wedding ceremony', 'the wedding was beautiful'),
    inst('event', 'the wedding', 'The wedding reception afterwards', 'such a lovely wedding')
  ]);
  assert.strictEqual(r.written, 1, JSON.stringify(r));
  assert.strictEqual(r.dup, 1);
});

t('pinned different dates always split, whatever the wording shares', () => {
  const { r } = writeAll([
    inst('event', "Emily's birthday", 'Birthday dinner', 'we celebrated Emily', { date_iso: '2023-03-01' }),
    inst('event', "Emily's birthday", 'Birthday dinner again', 'we celebrated Emily', { date_iso: '2024-03-01' })
  ]);
  assert.strictEqual(r.written, 2, JSON.stringify(r));
});

t('possessions keep their numeric-difference guard untouched', () => {
  const { r } = writeAll([
    inst('possession', 'tank', '5-gallon tank with betta', 'my 5-gallon tank', { qualifier: 'possess' }),
    inst('possession', 'tank', '20-gallon tank finished cycling', 'my 20-gallon tank', { qualifier: 'possess' })
  ]);
  assert.strictEqual(r.written, 2, JSON.stringify(r));
});

// Registry-name rung: role-only references join through a UNIQUE alias and
// stay silent through a shared one.
const identity = require(path.join(__dirname, '..', 'shared-core', 'entity-identity.js'));

t('a unique alias joins the retelling through the registry', () => {
  identity._resetCacheForTests();
  identity.recordEntityIdentity({ agent_id: 'claude-code', name: 'Jen', kind: 'person', relation: 'friend', aliases: ['the bride'] });
  identity._resetCacheForTests();
  const { r } = writeAll([
    inst('event', 'wedding', "The bride's wedding at a vineyard in August", "the bride's wedding was lovely"),
    inst('event', 'Jen and Tom', 'Wedding of Jen and Tom in the city last weekend', 'Jen and Tom got married')
  ]);
  assert.strictEqual(r.written, 1, JSON.stringify(r));
  assert.strictEqual(r.dup, 1);
});

t('a shared alias stays silent - conflicting anchors split as before', () => {
  identity._resetCacheForTests();
  identity.recordEntityIdentity({ agent_id: 'claude-code', name: 'Mara', kind: 'person', relation: 'cousin', aliases: ['the bride'] });
  identity._resetCacheForTests();
  const { r } = writeAll([
    inst('event', 'wedding', "The bride's wedding at a vineyard in August", "the bride's wedding was lovely"),
    inst('event', 'wedding', 'Wedding in the city last weekend', 'got back from a wedding in the city')
  ]);
  assert.strictEqual(r.written, 2, JSON.stringify(r));
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
