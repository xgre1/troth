#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// count-mount regression — on a count-shaped query the understood stratum
// mounts as a CLASS and brings its receipts.
//
// Measured failure this encodes: the third doctor existed in the instance
// pool but neither stratum reached the model — the instance ranked low, and
// the raw turn naming the specialist ("Dr. Patel", "ENT") shares no tokens
// with "how many doctors did I visit", so lexical recall never surfaces it.
// Two properties hold now:
//   1. the pool instance mounts on the count query even with thin overlap;
//   2. a mounted instance pulls its provenance turns into the raw side, so
//      the reconciled view links receipts instead of flagging their absence.
// Writes go through the REAL writers (dialogueMemory.recordTurn, the same
// path the ingest uses), so FTS and audiences behave as in production.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');

const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const dialogueMemory = require(path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'));

const db = state.db();
const AGENT = 'claude-code';

// Turn A overlaps the query lexically — it anchors recall's candidate pool.
dialogueMemory.recordTurn({
  agent_id: AGENT, user_id: 'default',
  user_text: 'I visited my doctor for my annual checkup and asked about my sleep.',
  assistant_text: 'Good that the doctor visit went well.',
  faculty: 'count-mount-test'
});
// Turn B names the specialist — zero overlap with the query.
dialogueMemory.recordTurn({
  agent_id: AGENT, user_id: 'default',
  user_text: 'I finally saw Dr. Patel about the sinus pain, she is an ENT.',
  assistant_text: 'Glad the appointment happened.',
  faculty: 'count-mount-test'
});

const turnB = db.prepare(
  "SELECT id FROM action_records WHERE input LIKE '%Patel%' ORDER BY timestamp DESC LIMIT 1"
).get();
assert.ok(turnB && turnB.id, 'turn B recorded through the real writer');

engram.recordEngram({
  agent_id: AGENT,
  statement: 'visit: Dr. Patel — ENT appointment for sinus pain [completed]',
  scope: 'instance:visit',
  source: 'instance_consolidation',
  source_authority: 'plr_evolved',
  audience: 'substrate_internal',
  memory_class: 'operational',
  auto_verify: false,
  extra_output: {
    payload: { instance: { kind: 'visit', entity: 'Dr. Patel', entity_slug: 'dr-patel', description: 'ENT appointment', status: 'completed' } },
    provenance_ref: ['dialogue.turn:' + turnB.id]
  }
});

(async () => {
  let pass = 0, fail = 0;
  function t(name, fn) { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message || e)); } }

  const items = await engram.retrieveRelevant({ query: 'How many different doctors did I visit?', k: 5 });

  t('the visit instance mounts on the count query', () => {
    assert.ok(items.some((it) => it.source === 'instance-pool' && /Dr\. Patel/.test(it.statement)),
      'sources: ' + JSON.stringify(items.map(i => i.source)));
  });
  t('the instance pulls its provenance turn into the raw side', () => {
    const prov = items.find((it) => it.source === 'provenance');
    assert.ok(prov, 'provenance item present');
    assert.strictEqual(prov.id, turnB.id);
    assert.ok(/ENT/.test(prov.statement));
  });
  t('the reconciled view links the receipt instead of flagging its absence', () => {
    const { buildReconciledView } = require(path.join(__dirname, '..', 'shared-core', 'reconciled-view.js'));
    const v = buildReconciledView(items);
    const led = v.ledger.find((l) => /Dr\. Patel/.test(l.statement));
    assert.ok(led, 'ledger line present');
    assert.ok(led.refs.length >= 1, 'receipts linked');
    assert.strictEqual(led.flags.length, 0, 'no absence flag');
  });

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('suite error:', e); process.exit(1); });
