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

t('off by the operator (TROTH_INSTANCE_ENTAILMENT=0) — no derivation', () => {
  process.env.TROTH_INSTANCE_ENTAILMENT = '0';
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

t('being prescribed by a named clinician is a visit to them, whatever kind the sentence was typed', () => {
  process.env.TROTH_INSTANCE_ENTAILMENT = '1';
  const pool = [];
  ic.writeInstances({
    instances: [
      { kind: 'activity', entity: 'antibiotics', description: 'was prescribed antibiotics for a UTI by my primary care physician, Dr. Smith', date_iso: null, status: 'completed', qualifier: 'prescribed', quantity: null, turn_idxs: [0] },
      { kind: 'visit', entity: 'primary care physician', description: 'schedule a follow-up with my primary care physician about the fatigue', date_iso: null, status: 'planned', qualifier: 'schedule', quantity: null, turn_idxs: [1] }
    ],
    turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1'
  });
  const smith = pool.filter((p) => p.instance.kind === 'visit' && /smith/i.test(p.instance.entity));
  assert.strictEqual(smith.length, 1, pool.map((p) => p.statement).join(' || '));
  assert.strictEqual(smith[0].instance.basis, 'entailed');
  assert.strictEqual(smith[0].instance.status, 'completed');
  // The follow-up with the bare role is the same person: one inferred row.
  const inferred = pool.filter((p) => p.instance.basis === 'entailed');
  assert.strictEqual(inferred.length, 1, inferred.map((p) => p.statement).join(' || '));
  // The agent first: "my primary care physician, Dr. Smith, had diagnosed me".
  const pool3 = [];
  ic.writeInstances({
    instances: [{ kind: 'activity', entity: 'chronic sinusitis', description: 'my primary care physician, Dr. Smith, had diagnosed me with a UTI; diagnosed with chronic sinusitis by an ENT specialist', date_iso: null, status: 'completed', qualifier: 'diagnosed', quantity: null, turn_idxs: [0] }],
    turns, agent_id: 'claude-code', user_id: 'default', _pool: pool3, session_id: 'S1'
  });
  const ents = pool3.filter((p) => p.instance.basis === 'entailed').map((p) => p.instance.entity).sort();
  assert.deepStrictEqual(ents, ['Dr. Smith', 'ENT specialist'], ents.join(' | '));
  // A stated visit to the clinician who holds the role absorbs the bare-role row.
  ic.writeInstances({
    instances: [{ kind: 'visit', entity: 'Dr. Patel', description: 'saw Dr. Patel, my ENT, about the sinusitis', date_iso: null, status: 'completed', qualifier: 'saw', quantity: null, turn_idxs: [1] }],
    turns, agent_id: 'claude-code', user_id: 'default', _pool: pool3, session_id: 'S2'
  });
  const patel = pool3.filter((p) => p.instance.kind === 'visit' && /patel|ent specialist/i.test(p.instance.entity));
  assert.strictEqual(patel.length, 1, patel.map((p) => p.statement).join(' || '));
  assert.strictEqual(patel[0].instance.basis, 'stated');
  assert.ok(/Patel/.test(patel[0].instance.entity), patel[0].instance.entity);
  // A bare role is not a person: "referred by my doctor" mints nothing.
  const pool2 = [];
  ic.writeInstances({
    instances: [{ kind: 'activity', entity: 'referral', description: 'was referred to a dermatologist by my doctor', date_iso: null, status: 'completed', qualifier: 'referred', quantity: null, turn_idxs: [0] }],
    turns, agent_id: 'claude-code', user_id: 'default', _pool: pool2, session_id: 'S1'
  });
  assert.ok(!pool2.some((p) => p.instance.basis === 'entailed'), pool2.map((p) => p.statement).join(' || '));
  delete process.env.TROTH_INSTANCE_ENTAILMENT;
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
