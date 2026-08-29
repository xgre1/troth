#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Identity promotion: 3×-fact → always-on envelope.
// Acceptance criterion: 'a fact stated 3× appears in the always-on
// envelope next day with no "remember" command.' Pipeline:
//   1. dialogue.turn rows accumulate in action_records.
//   2. wm_consolidation collapses the emphasized fragment into
//      consolidated:dialogue.
//   3. identity-promotion.runOnce (new) reads consolidated
//      rows past min_age_ms whose underlying fragment appears MIN_REPS
//      times in the dialogue trace and writes a scope='identity' engram.
//   4. composeEnvelope picks the new identity engram into the always-on
//      block.
//
// No "remember" command anywhere on the path. Hermetic via tests/hermetic-
// db.js — turns + engrams against a tmpdir state.db, time injected so the
// "next day" criterion is provable without real wall-clock.

require('./hermetic-db.js');
const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const promote = require(path.join(PROJECT_ROOT, 'shared-core', 'identity-promotion.js'));
const bw      = require(path.join(PROJECT_ROOT, 'shared-core', 'background-worker.js'));
const engram  = require(path.join(PROJECT_ROOT, 'shared-core', 'engram.js'));
const state   = require(path.join(PROJECT_ROOT, 'shared-core', 'state.js'));
const ar      = require(path.join(PROJECT_ROOT, 'shared-core', 'action-record.js'));
const { composeEnvelope } =
  require(path.join(PROJECT_ROOT, 'shared-core', 'identity-envelope.js'));

const wmTask = bw.DEFAULT_TASKS.find((t) => t.name === 'wm_consolidation');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; },
          (e) => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; });
}

const AGENT = 'idprom-' + Date.now();
const CWD   = require('os').tmpdir() + '/idprom-' + Date.now();

function recordTurn(userText) {
  const rec = {
    id: ar.uuidv7(), timestamp: Date.now(), type: 'tool_call',
    agent_id: AGENT, cwd: CWD, user_id: 'default',
    input: { tool_name: 'dialogue.turn', args: { user_text: userText } },
    output: { ok: true }
  };
  state.recordAction(rec, ar.toSearchText(rec));
}

console.log('\n=== identity promotion: 3×-fact → always-on envelope ===\n');

(async () => {

  await t('Stage 1+2: 3× emphasized turns → ONE consolidated:dialogue engram (dedup)', async () => {
    const FACT = 'operator runs troth on local Mac';
    const text = '!!! ' + FACT + ' this is strongly emphasized and must promote';
    recordTurn(text);
    recordTurn(text);
    recordTurn(text);
    await wmTask.run({ substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } });
    const rows = engram.listEngrams({
      scope: 'consolidated:dialogue', principal: null, audience: 'all', limit: 100
    }) || [];
    const hits = rows.filter((r) => typeof r.statement === 'string' &&
                                    r.statement.indexOf(FACT) >= 0);
    assert.strictEqual(hits.length, 1,
      'wm_consolidation must dedup 3 identical turns into 1 row; got ' + hits.length);
  });

  await t('Stage 3 — too-young consolidated row → NOT yet promoted (min_age_ms gate)', () => {
    const r = promote.runOnce({
      // min_age_ms=1h; the consolidated row was written seconds ago.
      min_age_ms: 60 * 60 * 1000,
      min_reps: 3
    });
    assert.strictEqual(r.promoted, 0,
      'fresh row must wait for the "next day" gate; got ' + JSON.stringify(r));
  });

  await t('Stage 3 — age + reps satisfied → ONE identity engram promoted', () => {
    // Simulate the next-day-ish gate by setting now() forward 13h. The
    // injected clock keeps the test hermetic without any sleep.
    const future = Date.now() + 13 * 60 * 60 * 1000;
    const r = promote.runOnce({
      now: () => future, min_age_ms: 12 * 60 * 60 * 1000, min_reps: 3
    });
    assert.strictEqual(r.promoted, 1,
      'one consolidated row, age + reps satisfied → one promotion; got ' +
      JSON.stringify(r));
  });

  await t('Stage 4 — composeEnvelope picks up the promoted identity engram', () => {
    const list = (q) => engram.listEngrams(Object.assign({},
      q, { principal: null, audience: 'all' }));
    const { items, block } = composeEnvelope({ listEngrams: list });
    const texts = items.map((i) => i.statement);
    assert.ok(texts.some((s) => s.indexOf('local Mac') >= 0),
      'promoted fact must appear in always-on envelope; got ' + JSON.stringify(texts));
    assert.ok(block.indexOf('<memory_identity>') === 0);
  });

  await t('Re-running runOnce is IDEMPOTENT — already promoted not re-promoted', () => {
    const future = Date.now() + 14 * 60 * 60 * 1000;
    const r = promote.runOnce({
      now: () => future, min_age_ms: 12 * 60 * 60 * 1000, min_reps: 3
    });
    assert.strictEqual(r.promoted, 0,
      'second pass must skip already-promoted; got ' + JSON.stringify(r));
  });

  await t('Below-threshold fact (stated 2×) → NOT promoted even past min_age_ms', async () => {
    const SHALLOW = 'operator prefers four-space indent';
    const text = '!!! ' + SHALLOW + ' is strongly emphasized for testing';
    recordTurn(text);
    recordTurn(text);
    await wmTask.run({ substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } });
    const future = Date.now() + 15 * 60 * 60 * 1000;
    const r = promote.runOnce({
      now: () => future, min_age_ms: 12 * 60 * 60 * 1000, min_reps: 3
    });
    // Reps=2 must not cross the threshold.
    const promotedRow = engram.listEngrams({
      scope: 'identity', principal: null, audience: 'all', limit: 200
    }).find((e) => typeof e.statement === 'string' && e.statement.indexOf('four-space') >= 0);
    assert.strictEqual(promotedRow, undefined,
      'a 2×-stated fact must not promote at min_reps=3; got ' +
      (promotedRow && promotedRow.statement));
    assert.strictEqual(r.promoted, 0);
  });

  console.log('');
  console.log('identity promotion: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
