#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What the operator states about themselves is one current fact per subject
// and attribute: a newer statement of an employer's pay supersedes the older
// row, the older stays as history, and a fact on another attribute of the
// same subject stands beside it. The reader is given, so no engine runs.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-self-facts-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const bw = require(path.join(__dirname, '..', 'shared-core', 'background-worker.js'));
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const dm = require(path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'));
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== self facts: one current fact per subject and attribute ===\n');
const A = 'self-facts-test';
const facts = new Map([
  ['I get six hundred a month at Northwind', [{ kind: 'fact', what: 'I work at Northwind two days a week for 600 euros a month', subject: 'Northwind', attribute: 'pay' }]],
  ['From October they raise me to seven hundred a month', [{ kind: 'fact', what: 'From October Northwind pays me 700 euros a month', subject: 'Northwind', attribute: 'pay' }]],
  ['I go there on Wednesdays and Thursdays',   [{ kind: 'fact', what: 'I go to Northwind on Wednesdays and Thursdays', subject: 'Northwind', attribute: 'schedule' }]]
]);
const view = { substrate_ctx: { agent_id: A, user_id: 'default', cwd: null }, read_self_facts: async (text) => facts.get(String(text).trim()) || [] };
const current = () => engram.listEngrams({ scope: 'consolidated:self', audience: 'all', agent_id: A, limit: 20 }) || [];
const T0 = Date.now() - 10 * 60 * 1000;

(async () => {
  await t('the first statement of a subject\'s pay lands with its subject and attribute', async () => {
    dm.recordTurn({ agent_id: A, conversation_id: 's1', timestamp: T0, user_text: 'I get six hundred a month at Northwind', assistant_text: 'ok' });
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/promoted=1/.test(r.notes[0]), r.notes[0]);
    assert.ok(/\(given\)/.test(r.notes[0]), 'the note names the road: ' + r.notes[0]);
    const rows = current();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].payload.subject, 'Northwind');
    assert.strictEqual(rows[0].payload.attribute, 'pay');
  });
  await t('a newer statement on the same subject and attribute supersedes the older row', async () => {
    dm.recordTurn({ agent_id: A, conversation_id: 's2', timestamp: T0 + 60 * 1000, user_text: 'From October they raise me to seven hundred a month', assistant_text: 'ok' });
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/promoted=1 superseded=1/.test(r.notes[0]), r.notes[0]);
    const rows = current();
    assert.strictEqual(rows.length, 1, rows.map((e) => e.statement).join(' | '));
    assert.ok(/700 euros/.test(rows[0].statement), rows[0].statement);
    const raw = state.getAction(rows[0].id);
    const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
    assert.strictEqual(out.lifetime && out.lifetime.reason, 'newer_on_subject');
    assert.strictEqual(out.lifetime.supersedes.length, 1);
  });
  await t('another attribute of the same subject stands beside it', async () => {
    dm.recordTurn({ agent_id: A, conversation_id: 's3', timestamp: T0 + 120 * 1000, user_text: 'I go there on Wednesdays and Thursdays', assistant_text: 'ok' });
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/promoted=1 superseded=0/.test(r.notes[0]), r.notes[0]);
    assert.strictEqual(current().length, 2);
  });
  await t('the same fact told again is attested, never written twice', async () => {
    dm.recordTurn({ agent_id: A, conversation_id: 's4', timestamp: T0 + 180 * 1000, user_text: 'I go there on Wednesdays and Thursdays', assistant_text: 'ok' });
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/promoted=0/.test(r.notes[0]) && /skipped_dup=1/.test(r.notes[0]), r.notes[0]);
    assert.strictEqual(current().length, 2);
  });
  console.log('\nself-facts-supersede: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
