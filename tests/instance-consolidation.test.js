#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// instance-consolidation — typed distillation with mandatory provenance.
// Proves the four covenants: (1) no provenance ⇒ no write, (2) extractor
// down ⇒ window retained (queue, not drop), (3) identity-resolved entities
// carry the canonical slug (counting merges by identity), (4) instances are
// substrate_internal — invisible to conversational recall by construction.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-instance-consolidation-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';

const assert = require('assert');
const ic = require('../shared-core/instance-consolidation.js');
const identity = require('../shared-core/entity-identity.js');
const engram = require('../shared-core/engram.js');
const dialogueMemory = require('../shared-core/dialogue-memory.js');

let pass = 0, fail = 0;
function t(name, fn) {
  const p = fn && fn.constructor && fn.constructor.name === 'AsyncFunction'
    ? fn() : Promise.resolve().then(fn);
  return p.then(() => { console.log('  ✓ ' + name); pass++; })
          .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const BRAIN = 'test-brain';

(async function main() {
console.log('\n=== instance-consolidation (typed distillation) ===\n');

await t('parseExtraction: fenced JSON accepted, schema violations dropped', () => {
  const raw = 'Sure, here you go:\n```json\n' + JSON.stringify([
    { kind: 'visit', entity: 'Dr. Lee', description: 'dermatologist, mole check', date_iso: '2023-05-12', status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0] },
    { kind: 'teleport', entity: 'x', description: 'bad kind', turn_idxs: [0] },
    { kind: 'visit', entity: 'Dr. Ghost', description: 'NO provenance', turn_idxs: [] },
    { kind: 'visit', entity: 'Dr. Range', description: 'idx out of range', turn_idxs: [99] }
  ]) + '\n```';
  const out = ic.parseExtraction(raw, 2);
  assert.strictEqual(out.instances.length, 1, 'only the valid row survives');
  assert.strictEqual(out.dropped, 3);
  assert.strictEqual(out.instances[0].entity, 'Dr. Lee');
});

await t('parseExtraction: garbage in, empty out', () => {
  assert.strictEqual(ic.parseExtraction('no json here', 5).instances.length, 0);
  assert.strictEqual(ic.parseExtraction('{"not":"array"}', 5).instances.length, 0);
});

// Seed real turns through the real write path.
const T0 = Date.now() - 60 * 1000;
assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-A', timestamp: T0,
  user_text: 'I visited Dr. Lee the dermatologist for the mole biopsy follow-up — results were benign.',
  assistant_text: 'Great news about the results.'
}));
assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-A', timestamp: T0 + 1000,
  user_text: "My sister's wedding was last June — I was maid of honor at the rooftop garden.",
  assistant_text: 'That sounds lovely.'
}));

// Identity from item 1: the mind knows who "my sister" is.
identity.recordEntityIdentity({ agent_id: BRAIN, name: 'Jen', kind: 'person', aliases: ['my sister'] });

// Deterministic extractor fixture: returns instances tied to turn order.
function fixtureExtractor(prompt) {
  const out = [
    { kind: 'visit', entity: 'Dr. Lee', description: 'dermatologist biopsy follow-up (benign)', date_iso: null, status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0] }
  ];
  if (prompt.indexOf('wedding') >= 0) {
    out.push({ kind: 'event', entity: 'my sister', description: 'wedding at the rooftop garden, maid of honor', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [1] });
  }
  return Promise.resolve(JSON.stringify(out));
}

let firstStats = null;
await t('runPass writes typed instances with provenance to the REAL turn ids', async () => {
  firstStats = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: fixtureExtractor });
  assert.strictEqual(firstStats.written, 2, 'two instances written: ' + JSON.stringify(firstStats));
  assert.ok(firstStats.advanced, 'watermark must advance on success');
  const visits = engram.listEngrams({ scope: 'instance:visit', audience: 'all', agent_id: BRAIN, limit: 10 });
  assert.strictEqual(visits.length, 1);
  const inst = visits[0].payload && visits[0].payload.instance;
  assert.ok(inst && inst.kind === 'visit' && inst.entity === 'Dr. Lee', 'payload.instance intact');
});

await t('provenance covenant: refs point at dialogue.turn rows', () => {
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: BRAIN, limit: 10 });
  for (const r of rows) {
    // provenance_ref is written top-level in output; hydration exposes
    // grounded_in/payload — read through the raw action row instead.
    const state = require('../shared-core/state.js');
    const raw = state.getAction(r.id);
    const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
    assert.ok(Array.isArray(out.provenance_ref) && out.provenance_ref.length,
      'every instance must carry provenance_ref');
    assert.ok(out.provenance_ref.every(x => /^dialogue\.turn:/.test(x)), out.provenance_ref.join('|'));
  }
});

await t('identity resolution: "my sister" instance carries entity_slug jen', () => {
  const events = engram.listEngrams({ scope: 'instance:event', audience: 'all', agent_id: BRAIN, limit: 10 });
  assert.strictEqual(events.length, 1);
  const inst = events[0].payload.instance;
  assert.strictEqual(inst.entity_slug, 'jen', 'counting must merge by identity, not surface string');
  assert.strictEqual(inst.canonical, 'Jen');
});

await t('idempotence: second pass writes nothing new', async () => {
  const again = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: fixtureExtractor });
  assert.strictEqual(again.written, 0, 'no re-distillation: ' + JSON.stringify(again));
  assert.strictEqual(again.processed, 0, 'watermark must have excluded the processed turns');
});

await t('queue-on-unavailable: extractor down ⇒ watermark NOT advanced, retry succeeds', async () => {
  assert.ok(dialogueMemory.recordTurn({
    agent_id: BRAIN, conversation_id: 'sess-B', timestamp: Date.now(),
    user_text: 'I bought a new tennis racket from the sports store downtown yesterday.',
    assistant_text: 'Nice choice.'
  }));
  const down = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.reject(new Error('ECONNREFUSED'))
  });
  assert.strictEqual(down.advanced, false, 'window must be retained');
  assert.strictEqual(down.written, 0);
  const retry = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify([
      { kind: 'purchase', entity: 'tennis racket', description: 'from the sports store downtown', date_iso: null, status: 'completed', qualifier: 'bought', quantity: null, turn_idxs: [0] }
    ]))
  });
  assert.strictEqual(retry.written, 1, 'retained window must distill on retry: ' + JSON.stringify(retry));
});

await t('poisoning-safe by construction: instances invisible to model_visible reads', () => {
  const visible = engram.listEngrams({ audience: 'model_visible', agent_id: BRAIN, limit: 100 }) || [];
  const leaked = visible.filter(e => e && String(e.scope || '').indexOf('instance:') === 0);
  assert.strictEqual(leaked.length, 0, 'conversational recall must never mount the typed pool');
  const lifted = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: BRAIN, limit: 100 }) || [];
  assert.ok(lifted.length >= 3, 'the count reader lifts them explicitly (audience:all): got ' + lifted.length);
});

await t('flag gate: enabled() follows TROTH_INSTANCE_CONSOLIDATION', () => {
  delete process.env.TROTH_INSTANCE_CONSOLIDATION;
  assert.strictEqual(ic.enabled(), false, 'default OFF until the live gate');
  process.env.TROTH_INSTANCE_CONSOLIDATION = '1';
  assert.strictEqual(ic.enabled(), true);
  delete process.env.TROTH_INSTANCE_CONSOLIDATION;
});

console.log('');
console.log('instance-consolidation: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
