#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A fact the reader returns about the operator stands on its subject: the
// message or the two before it name the subject, the subject is a name and
// not a chat word, the fact names its subject, and the fact is the reader's
// own sentence rather than the message copied back. The hygiene pass retires
// a row that copies its turn.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-self-stand-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const bw = require(path.join(__dirname, '..', 'shared-core', 'background-worker.js'));
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const dm = require(path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'));
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== a self fact stands on its subject ===\n');
const stands = bw.selfFactStands;
const src = (text, before) => ({ text, before: before || '' });

(async () => {
  await t('a third-person sentence naming the subject the message names stands', async () => {
    assert.strictEqual(stands('The person is paid 600 a month by Northwind, part time', 'fact', 'Northwind', 'pay', src('vboya is 600 per month now part time, Northwind I mean')), true);
  });
  await t('a short message copied back is a quote and does not stand', async () => {
    assert.strictEqual(stands('Apla valame q4.', 'effort', 'q4', 'status', src('Apla valame q4.')), false);
    assert.strictEqual(stands('einai + 145e to mina EYKA', 'fact', 'EYKA', 'pay', src('einai + 145e to mina EYKA')), false);
    assert.strictEqual(stands('My studio machine sits in the living room', 'fact', 'studio machine', 'location', src('My studio machine sits in the living room')), true, 'a whole sentence naming its subject stands even verbatim');
    assert.strictEqual(stands('exw sto xeri +2600-3100 tora', 'fact', 'xeri', 'amount', src('exw sto xeri +2600-3100 tora kai vlepoume')), false);
  });
  await t('a subject none of the messages mention does not stand', async () => {
    assert.strictEqual(stands('The person does social media marketing for Nike', 'role', 'Nike', 'role', src('Κάνω social media marketing για τη Contoso', 'ok let us start')), false);
  });
  await t('a subject named two messages earlier stands', async () => {
    assert.strictEqual(stands('From October Northwind pays the person 700 a month', 'fact', 'Northwind', 'pay', src('From October they raise me to seven hundred a month', 'I get six hundred a month at Northwind')), true);
  });
  await t('a chat word or a pronoun is no subject', async () => {
    assert.strictEqual(stands('katse 3 meres tin evdomada enow re', 'fact', 'katse', 'schedule', src('katse 3 meres tin evdomada enow re, kai meta')), false);
    assert.strictEqual(stands('The person works two days a week there', 'fact', 'there', 'schedule', src('I work two days a week there')), false);
  });
  await t('a fact that does not name its subject does not stand', async () => {
    assert.strictEqual(stands('The person is paid 600 a month', 'fact', 'Northwind', 'pay', src('Northwind pays me 600 a month')), false);
  });
  await t('without a source turn the older rules alone decide', async () => {
    assert.strictEqual(stands('I work at Northwind two days a week', 'fact', 'Northwind', 'schedule'), true);
    assert.strictEqual(stands('Apla valame q4.', 'fact', null, null), false);
  });
  await t('the hygiene pass retires a row that copies its turn', async () => {
    const A = 'self-stand-hygiene';
    dm.recordTurn({ agent_id: A, conversation_id: 'h1', timestamp: Date.now() - 60000, user_text: 'douleuw sto Northwind 2 meres', assistant_text: 'ok' });
    const turn = (state.queryActions({ type: 'tool_call', agent_id: A, limit: 5 }) || []).find((r) => String(r.input).includes('dialogue.turn'));
    assert.ok(turn, 'the turn is recorded');
    const self = (statement, payload) => engram.recordEngram({
      agent_id: A, user_id: 'default', cwd: null, statement, scope: 'consolidated:self', source: 'background_worker.wm_consolidation', source_authority: 'plr_evolved', auto_verify: false,
      extra_output: { payload: Object.assign({ fact_kind: 'fact', reps: 1 }, payload) }
    });
    self('douleuw sto Northwind 2 meres', { subject: 'Northwind', attribute: 'schedule', turn_ids: [turn.id] });
    self('The person works two days a week at Northwind', { subject: 'Northwind', attribute: 'schedule', turn_ids: [turn.id] });
    const r = await bw.tasks.memoryHygiene.run({ substrate_ctx: { agent_id: A, user_id: 'default', cwd: null } });
    assert.ok(/remarks_retired=1/.test(r.notes[0]), r.notes[0]);
    const rows = engram.listEngrams({ scope: 'consolidated:self', audience: 'all', agent_id: A, limit: 20 }) || [];
    assert.deepStrictEqual(rows.map((x) => x.statement), ['The person works two days a week at Northwind'], rows.map((x) => x.statement).join(' | '));
  });
  await t('the turn behind a retired row is read again and its fact comes back in the reader\'s words', async () => {
    const A = 'self-stand-hygiene';
    const asks = engram.listEngrams({ scope: 'internal:wm_reread', audience: 'all', agent_id: A, limit: 10 }) || [];
    assert.strictEqual(asks.length, 1, 'one turn queued: ' + asks.map((a) => a.statement).join(' | '));
    const view = { substrate_ctx: { agent_id: A, user_id: 'default', cwd: null },
      read_self_facts: async (text) => (/douleuw sto Northwind 2 meres/.test(text) ? [{ kind: 'fact', what: 'The person works two days a week at Northwind, part time', subject: 'Northwind', attribute: 'schedule' }] : []) };
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/promoted=1|skipped_dup=1|skipped_older=1/.test(r.notes[0]), 'the turn was read again: ' + r.notes[0]);
    assert.strictEqual((engram.listEngrams({ scope: 'internal:wm_reread', audience: 'all', agent_id: A, limit: 10 }) || []).length, 0, 'the ask is consumed');
    const rows = engram.listEngrams({ scope: 'consolidated:self', audience: 'all', agent_id: A, limit: 20 }) || [];
    assert.ok(rows.some((x) => /two days a week at Northwind/.test(x.statement)), rows.map((x) => x.statement).join(' | '));
  });
  console.log('\nself-facts-stand: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
