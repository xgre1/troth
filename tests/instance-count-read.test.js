#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// instance-pool read arm — the understood stratum reads first on
// count-shaped queries, and ONLY there. Three proofs: (1) a count query
// naming an entity by alias reaches instances stored under the canonical
// slug with zero shared vocabulary; (2) non-count recall never mounts the
// typed pool; (3) the lift is the arm's own — the general pool stays
// audience-clean.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-instance-count-read-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';

const assert = require('assert');
const ic = require('../shared-core/instance-consolidation.js');
const identity = require('../shared-core/entity-identity.js');
const engram = require('../shared-core/engram.js');
const dialogueMemory = require('../shared-core/dialogue-memory.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const BRAIN = 'test-brain';

// The product parser speaks the v2 combined shape: rows ride under
// `instances`, each attested by a verbatim quote from its own turn.
const v2 = (rows) => JSON.stringify({ identities: [], instances: rows });

(async function main() {
console.log('\n=== instance-pool count-read arm ===\n');

// Seed: identity + turns + distilled instances (fixture extractor).
identity.recordEntityIdentity({ agent_id: BRAIN, name: 'Jen', kind: 'person', aliases: ['my sister'] });
const T0 = Date.now() - 10 * 60 * 1000;
const seed = [
  ['I attended Jen and Tom\'s wedding at the rooftop garden.', 'sess-1',
    { kind: 'event', entity: 'Jen', description: 'wedding, rooftop garden', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] }],
  ['Emily and Sarah\'s wedding by the lake was gorgeous.', 'sess-2',
    { kind: 'event', entity: 'Emily and Sarah', description: 'wedding by the lake', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] }],
  ['I visited Dr. Lee for the mole check.', 'sess-3',
    { kind: 'visit', entity: 'Dr. Lee', description: 'dermatologist mole check', date_iso: null, status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0] }]
];
for (let i = 0; i < seed.length; i++) {
  assert.ok(dialogueMemory.recordTurn({
    agent_id: BRAIN, conversation_id: seed[i][1], timestamp: T0 + i * 1000,
    user_text: seed[i][0], assistant_text: 'noted.'
  }));
  const s = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(v2([Object.assign({}, seed[i][2], { quote: seed[i][0] })]))
  });
  assert.strictEqual(s.written, 1, 'seed ' + i + ': ' + JSON.stringify(s));
}

await t('count query mounts the instance pool, labeled and provenance-counted', async () => {
  const items = await engram.retrieveRelevant({
    query: 'How many weddings have I attended this year?',
    k: 10, audience: 'model_visible'
  });
  const pool = items.filter(it => it.source === 'instance-pool');
  assert.ok(pool.length >= 2, 'both wedding instances must mount: got ' + pool.length);
  assert.ok(pool.every(it => it.statement.indexOf('[instance]') === 0), 'labeled for the composer');
  assert.ok(pool.every(it => /\(attested x\d+\)/.test(it.statement.replace('×', 'x'))), 'proof count present');
});

await t('identity carries the count: "my sister" query reaches the Jen instance (zero shared vocabulary)', async () => {
  const items = await engram.retrieveRelevant({
    query: 'How many times did I see my sister at events?',
    k: 10, audience: 'model_visible'
  });
  const pool = items.filter(it => it.source === 'instance-pool');
  assert.ok(pool.some(it => it.statement.indexOf('Jen') >= 0),
    'slug match must surface the canonical instance: ' + pool.map(p => p.statement).join(' || '));
});

await t('non-count recall NEVER mounts the typed pool', async () => {
  const items = await engram.retrieveRelevant({
    query: 'What should I wear to the dinner party tomorrow?',
    k: 10, audience: 'model_visible'
  });
  assert.strictEqual(items.filter(it => it.source === 'instance-pool').length, 0,
    'typed pool answers typed questions only');
});

await t('irrelevant instances stay out of a targeted count', async () => {
  const items = await engram.retrieveRelevant({
    query: 'How many weddings have I attended this year?',
    k: 10, audience: 'model_visible'
  });
  const pool = items.filter(it => it.source === 'instance-pool');
  assert.ok(!pool.some(it => it.statement.indexOf('Dr. Lee') >= 0),
    'the visit instance must not ride the weddings count');
});

console.log('');
console.log('instance-count-read: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
