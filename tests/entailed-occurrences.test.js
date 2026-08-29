#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Entailed occurrences — statements that presuppose a completed visit mint
// one, with receipts, behind a default-off flag.
//
// Measured gap this encodes: a haystack held "schedule a follow-up with
// Dr. Patel [planned]" and "nasal spray prescription from Dr. Patel
// [possession]" and no explicit "I went" anywhere — the human (and gold)
// count Patel as visited; the pool held only the plan. Properties:
//   1. dark by default — no flag, no derivation;
//   2. flag on: ONE derived visit [completed, inferred], both implications
//      attesting it, while the planned follow-up survives as its own row;
//   3. a later stated retelling promotes the row — 'inferred' disappears;
//   4. prospects derive nothing; an existing stated visit suppresses minting.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const ic = require(path.join(__dirname, '..', 'shared-core', 'instance-consolidation.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message || e)); } }

const turns = [{ id: 'en-1', timestamp: Date.now() - 86400000 }, { id: 'en-2', timestamp: Date.now() - 3600000 }];
const followUp = { kind: 'visit', entity: 'Dr. Patel', description: 'Follow-up appointment to discuss the sinus treatment', date_iso: null, status: 'planned', qualifier: 'schedule', quantity: null, turn_idxs: [0] };
const rx = { kind: 'possession', entity: 'nasal spray', description: 'nasal spray prescription from Dr. Patel', date_iso: null, status: 'completed', qualifier: 'having', quantity: null, turn_idxs: [1] };

function patelVisits(pool) {
  return pool.filter((p) => p.instance.kind === 'visit' && /patel/i.test(p.instance.entity));
}

t('dark by default — no flag, no derivation', () => {
  delete process.env.TROTH_INSTANCE_ENTAILMENT;
  const pool = [];
  ic.writeInstances({ instances: [followUp, rx], turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1' });
  assert.strictEqual(patelVisits(pool).length, 1);
  assert.strictEqual(patelVisits(pool)[0].instance.status, 'planned');
});

t('flag on: one inferred visit, both implications attesting, the plan survives', () => {
  process.env.TROTH_INSTANCE_ENTAILMENT = '1';
  const pool = [];
  const r = ic.writeInstances({ instances: [followUp, rx], turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1' });
  const visits = patelVisits(pool);
  assert.strictEqual(visits.length, 2, pool.map((p) => p.statement).join(' || '));
  const inferred = visits.find((v) => v.instance.basis === 'entailed');
  const planned = visits.find((v) => v.instance.status === 'planned');
  assert.ok(inferred && planned, 'both rows present');
  assert.ok(/\[completed, inferred\]/.test(inferred.statement), inferred.statement);
  assert.ok(r.derived >= 1, JSON.stringify(r));
});

t('a stated retelling promotes the inferred row — inferred disappears', () => {
  process.env.TROTH_INSTANCE_ENTAILMENT = '1';
  const pool = [];
  ic.writeInstances({ instances: [rx], turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1' });
  assert.strictEqual(patelVisits(pool)[0].instance.basis, 'entailed');
  const stated = { kind: 'visit', entity: 'Dr. Patel', description: 'Got back from Dr. Patel, sinuses are clearing up', date_iso: null, status: 'completed', qualifier: 'got back from', quantity: null, turn_idxs: [1] };
  ic.writeInstances({ instances: [stated], turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S2' });
  const visits = patelVisits(pool);
  assert.strictEqual(visits.length, 1, visits.map((v) => v.statement).join(' || '));
  assert.strictEqual(visits[0].instance.basis, 'stated');
  assert.ok(!/inferred/.test(visits[0].statement), visits[0].statement);
});

t('prospects derive nothing; an existing stated visit suppresses minting', () => {
  process.env.TROTH_INSTANCE_ENTAILMENT = '1';
  const pool = [];
  ic.writeInstances({
    instances: [
      { kind: 'activity', entity: 'Elden Ring', description: 'interested in the DLC', date_iso: null, status: 'planned', qualifier: 'interested in', quantity: null, turn_idxs: [0] },
      { kind: 'visit', entity: 'Dr. Lee', description: 'Got back from Dr. Lee, biopsy follow-up went fine', date_iso: null, status: 'completed', qualifier: 'got back from', quantity: null, turn_idxs: [0] },
      { kind: 'possession', entity: 'ointment', description: 'ointment prescription from Dr. Lee', date_iso: null, status: 'completed', qualifier: 'having', quantity: null, turn_idxs: [1] }
    ],
    turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1'
  });
  const lee = pool.filter((p) => p.instance.kind === 'visit' && /lee/i.test(p.instance.entity));
  assert.strictEqual(lee.length, 1, lee.map((v) => v.statement).join(' || '));
  assert.strictEqual(lee[0].instance.basis, 'stated');
  assert.ok(!pool.some((p) => p.instance.basis === 'entailed' && /elden/i.test(JSON.stringify(p.instance))));
  delete process.env.TROTH_INSTANCE_ENTAILMENT;
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
