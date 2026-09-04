#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What an intent is read from: an imperative that opens the message or
// follows a lead-in, in the message's own words. A pasted transcript is
// somebody else's words and yields no intent; a verb met mid-sentence in
// another language is not an order; the session orientation shows only a
// deliberate goal.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-intent-shape-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'shared-core', 'intent-extract.js'));
const mind = require(path.join(__dirname, '..', 'shared-core', 'mind-state.js'));
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const ar = require(path.join(__dirname, '..', 'shared-core', 'action-record.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== intent shape ===\n');

t('an imperative that opens the message, or follows a lead-in, is a goal', () => {
  assert.strictEqual(E.extractIntent('Restart the proxy').intent.input.extraction, 'verb_object');
  assert.strictEqual(E.extractIntent('please restart the proxy and check the logs').intent.input.goal, 'restart proxy and check the logs');
  assert.strictEqual(E.extractIntent('I want you to refactor the user query without breaking the API').intent.input.extraction, 'verb_object');
});

t('a verb met mid-sentence in another language is not an order', () => {
  const r = E.extractIntent('orea gia des ekana restart alla bro des ta kala');
  assert.ok(r.ok && r.intent.input.extraction === 'fallback_no_verb', JSON.stringify(r).slice(0, 200));
});

t('a pasted transcript yields no intent', () => {
  const chat = '[3/9/26, 9:48:02 am] someone: it starts from the understanding\n[3/9/26, 9:48:11 am] someone: make the font the same size\n[3/9/26, 9:48:13 am] someone: as the one above';
  const r = E.extractIntent(chat);
  assert.ok(!r.ok && r.reason === 'pasted_text', JSON.stringify(r));
  assert.ok(E._isPasted('> quoted line one\n> quoted line two\n> quoted line three'));
  assert.ok(!E._isPasted('Add OAuth login to the auth service.\nMust not break existing API.'));
});

t('the orientation shows the latest deliberate goal, never a fallback echo', () => {
  const cwd = '/tmp/intent-shape-cwd';
  const write = (goal, extraction, ts) => {
    const rec = { id: ar.uuidv7(), timestamp: ts, type: 'intent', agent_id: 'intent-shape', cwd, user_id: 'default', input: { goal, extraction, source_message_hash: 'sha256:x' }, output: { chosen_path: goal } };
    state.recordAction(rec, ar.toSearchText(rec));
  };
  const now = Date.now();
  write('restart proxy and check the logs', 'verb_object', now - 60000);
  write('orea gia des ekana restart alla bro des ta kala', 'fallback_no_verb', now - 1000);
  const ms = mind.recomputeFromSubstrate(state, { cwd, agent_id: 'intent-shape', user_id: 'default' });
  const st = ms && ms.mind_state ? ms.mind_state : ms;
  assert.ok(st && st.current_intent, 'a current intent: ' + JSON.stringify(ms).slice(0, 200));
  assert.strictEqual(st.current_intent.what, 'restart proxy and check the logs');
});

console.log('\nintent-shape: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
