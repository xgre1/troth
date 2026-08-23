#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Qualifier facets — a retelling adds an attested facet, it never overwrites
// a stated commitment.
//
// Reproduced live defect this encodes: merging "interested in the DLC" onto
// a stated "played about 30 hours" row replaced qualifier AND description on
// the pool row — the rendered ledger line lost the hours and presented a
// played, quantity-bearing game as a mere interest. Three properties hold:
//   1. the scalar qualifier stays the strongest commitment (played), with the
//      retelling kept as a facet with its own receipts;
//   2. a description carrying digits is never blanked by one that carries none;
//   3. the order of arrival does not matter — a stated verb arriving AFTER a
//      prospective one takes the primary slot.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const ic = require(path.join(__dirname, '..', 'shared-core', 'instance-consolidation.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message || e)); } }

const turns = [{ id: 'fq-1', timestamp: Date.now() - 86400000 }, { id: 'fq-2', timestamp: Date.now() - 3600000 }];
function inst(qualifier, description, extra) {
  return Object.assign({
    kind: 'activity', entity: 'Elden Ring', description,
    date_iso: null, status: 'completed', qualifier, quantity: null, turn_idxs: [0]
  }, extra || {});
}

t('a retelling becomes a facet; the stated verb and its numbers survive', () => {
  const pool = [];
  const r1 = ic.writeInstances({ instances: [inst('played', 'played about 30 hours', { quantity: 30 })], turns: [turns[0]], agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1' });
  assert.strictEqual(r1.written, 1);
  const r2 = ic.writeInstances({ instances: [inst('interested in', 'interested in the DLC')], turns: [turns[1]], agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S2' });
  assert.strictEqual(r2.written + r2.strengthened, 1, JSON.stringify(r2));
  const row = pool[0];
  assert.ok(/^activity: played /.test(row.statement), row.statement);
  assert.ok(row.statement.indexOf('30 hours') >= 0, row.statement);
  assert.ok(row.statement.indexOf('(qty 30)') >= 0, row.statement);
  assert.ok(row.statement.indexOf('also said: interested in') >= 0, row.statement);
  assert.strictEqual(row.instance.qualifier, 'played');
  assert.strictEqual(row.instance.facets.length, 2);
});

t('arrival order does not matter — the stated verb takes the primary slot', () => {
  const pool = [];
  ic.writeInstances({ instances: [inst('interested in', 'interested in trying it')], turns: [turns[0]], agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1' });
  ic.writeInstances({ instances: [inst('played', 'played 12 hours', { quantity: 12 })], turns: [turns[1]], agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S2' });
  const row = pool[0];
  assert.strictEqual(row.instance.qualifier, 'played', JSON.stringify(row.instance.facets));
  assert.ok(row.statement.indexOf('12 hours') >= 0, row.statement);
});

t('single-write rows carry their facet from birth', () => {
  const pool = [];
  ic.writeInstances({ instances: [inst('led', 'led the data analysis team')], turns: [turns[0]], agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1' });
  const f = pool[0].instance.facets;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].class, 'agentive');
});
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
