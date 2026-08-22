#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// instance lifecycle — status transitions and same-occurrence merging.
// Specimens are the two counting hazards: "Dr. Patel"
// (planned visit later completed — tense-based counting can't decide) and
// the weddings over-count (one event retold under two names — merged by
// identity, never counted twice).
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-instance-lifecycle-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';

const assert = require('assert');
const ic = require('../shared-core/instance-consolidation.js');
const identity = require('../shared-core/entity-identity.js');
const engram = require('../shared-core/engram.js');
const state = require('../shared-core/state.js');
const dialogueMemory = require('../shared-core/dialogue-memory.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const BRAIN = 'test-brain';

function turnRow(text, ts, sess) {
  assert.ok(dialogueMemory.recordTurn({
    agent_id: BRAIN, conversation_id: sess, timestamp: ts,
    user_text: text, assistant_text: 'noted.'
  }), 'turn must persist: ' + text.slice(0, 40));
}

function rawOf(id) {
  const raw = state.getAction(id);
  return typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
}

function currentVisits() {
  return engram.listEngrams({ scope: 'instance:visit', audience: 'all', agent_id: BRAIN, limit: 20 }) || [];
}

(async function main() {
console.log('\n=== instance lifecycle (transitions + same-occurrence merge) ===\n');

const T0 = Date.now() - 5 * 60 * 1000;

// ── SPECIMEN 1: Dr. Patel — planned, then completed ─────────────────────
await t('window 1: a planned visit lands as status planned', async () => {
  turnRow("I'll schedule a follow-up with Dr. Patel about my chronic sinusitis.", T0, 'sess-P1');
  const s = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify([
      { kind: 'visit', entity: 'Dr. Patel', description: 'ENT follow-up for chronic sinusitis', date_iso: null, status: 'planned', qualifier: 'scheduled', quantity: null, turn_idxs: [0] }
    ]))
  });
  assert.strictEqual(s.written, 1, JSON.stringify(s));
  const v = currentVisits();
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].payload.instance.status, 'planned');
});

let transitionedId = null;
await t('window 2: "the appointment went well" TRANSITIONS planned→completed, one current instance, provenance union', async () => {
  turnRow('The appointment with Dr. Patel went well — sinuses are clearing up.', T0 + 60 * 1000, 'sess-P2');
  const s = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify([
      { kind: 'visit', entity: 'Dr. Patel', description: 'ENT follow-up for chronic sinusitis', date_iso: null, status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0] }
    ]))
  });
  assert.strictEqual(s.transitions, 1, JSON.stringify(s));
  assert.strictEqual(s.written, 0, 'a transition is not a new occurrence');
  const v = currentVisits();
  assert.strictEqual(v.length, 1, 'supersession must leave ONE current instance, got ' + v.length);
  assert.strictEqual(v[0].payload.instance.status, 'completed');
  transitionedId = v[0].id;
  const out = rawOf(transitionedId);
  assert.strictEqual(out.provenance_ref.length, 2, 'provenance must union both attesting turns');
  assert.strictEqual(out.lifetime && out.lifetime.reason, 'status_transition');
});

await t('terminal guard: a stale "planned" retelling cannot downgrade completed', async () => {
  turnRow("I'm planning to see Dr. Patel about the sinus thing.", T0 + 120 * 1000, 'sess-P3');
  const s = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify([
      { kind: 'visit', entity: 'Dr. Patel', description: 'sinus follow-up', date_iso: null, status: 'planned', qualifier: 'planning', quantity: null, turn_idxs: [0] }
    ]))
  });
  const v = currentVisits();
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].payload.instance.status, 'completed', 'terminal status must not regress');
  assert.strictEqual(s.transitions, 0, 'no transition happened: ' + JSON.stringify(s));
});

// ── SPECIMEN 2: the weddings over-count — one event, two names ──────────
await t('one occurrence under two names merges by identity (restatement, proof count grows)', async () => {
  identity.recordEntityIdentity({ agent_id: BRAIN, name: 'Jen', kind: 'person', aliases: ['my sister'] });
  turnRow("My sister's wedding was at a rooftop garden — I was maid of honor.", T0 + 180 * 1000, 'sess-W1');
  const s1 = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify([
      { kind: 'event', entity: 'my sister', description: 'wedding, rooftop garden, maid of honor', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] }
    ]))
  });
  assert.strictEqual(s1.written, 1, JSON.stringify(s1));
  turnRow("Jen and Tom's wedding photos came back — the rooftop shots are stunning.", T0 + 240 * 1000, 'sess-W2');
  const s2 = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify([
      { kind: 'event', entity: 'Jen', description: 'wedding at the rooftop garden', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] }
    ]))
  });
  assert.strictEqual(s2.written, 0, 'the same wedding must NOT become a second instance: ' + JSON.stringify(s2));
  assert.strictEqual(s2.strengthened, 1, 'restatement strengthens: ' + JSON.stringify(s2));
  const events = engram.listEngrams({ scope: 'instance:event', audience: 'all', agent_id: BRAIN, limit: 20 });
  assert.strictEqual(events.length, 1, 'ONE wedding, however it was named — got ' + events.length);
  const inst = events[0].payload.instance;
  assert.strictEqual(inst.entity_slug, 'jen');
  assert.strictEqual(rawOf(events[0].id).provenance_ref.length, 2, 'both tellings attested');
});

await t('two PINNED different dates stay two occurrences (never merged)', async () => {
  turnRow('I saw Dr. Lee on March 3rd for the first mole check.', T0 + 300 * 1000, 'sess-D1');
  turnRow('I saw Dr. Lee again on June 9th for the follow-up.', T0 + 360 * 1000, 'sess-D1b');
  const s = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: (prompt) => Promise.resolve(JSON.stringify(
      prompt.indexOf('March') >= 0
        ? [{ kind: 'visit', entity: 'Dr. Lee', description: 'first mole check', date_iso: '2023-03-03', status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0] }]
        : [{ kind: 'visit', entity: 'Dr. Lee', description: 'mole follow-up', date_iso: '2023-06-09', status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0] }]
    ))
  });
  assert.strictEqual(s.written, 2, 'distinct dated visits are distinct occurrences: ' + JSON.stringify(s));
  const lee = currentVisits().filter(v => v.payload.instance.entity === 'Dr. Lee');
  assert.strictEqual(lee.length, 2);
});

console.log('');
console.log('instance-lifecycle: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
