#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Identity promotion: a fact stated 3× reaches the always-on envelope.
// Pipeline: dialogue.turn rows → wm_consolidation writes the FACT once to
// consolidated:self with reps counted → identity-promotion.runOnce lifts a
// fact past min_age_ms with reps ≥ MIN_REPS to scope='identity' →
// composeEnvelope carries it. Nothing raw, nothing shouted, no "remember".
process.env.TROTH_SELF_FACT_LLM = '0';
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
    .then(() => { console.log('  ✓ ' + name); pass++; },
          (e) => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
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

console.log('\n=== identity promotion: a fact stated 3× → always-on envelope ===\n');

(async () => {
  const FACT = 'true crime podcasts';
  const text = 'I love ' + FACT + ' and I am looking for something new to listen to tonight';

  await t('Stage 1+2: the fact stated in three turns → ONE consolidated:self row, reps 3', async () => {
    recordTurn(text);
    recordTurn(text);
    recordTurn(text);
    await wmTask.run({ substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } });
    const rows = engram.listEngrams({ scope: 'consolidated:self', principal: null, audience: 'all', limit: 100 }) || [];
    const hits = rows.filter((r) => typeof r.statement === 'string' && r.statement.indexOf(FACT) >= 0);
    assert.strictEqual(hits.length, 1, 'one row for one fact; got ' + hits.length);
    assert.ok(hits[0].statement.indexOf('operator emphasized') < 0, 'the row is the fact, not a shouted fragment');
  });

  await t('Stage 3 — too-young row → NOT yet promoted (min_age_ms gate)', () => {
    const r = promote.runOnce({ min_age_ms: 60 * 60 * 1000, min_reps: 3 });
    assert.strictEqual(r.promoted, 0, 'fresh row must wait for the next-day gate; got ' + JSON.stringify(r));
  });

  await t('Stage 3 — age + reps satisfied → ONE identity engram, carrying the fact and its kind', () => {
    const future = Date.now() + 13 * 60 * 60 * 1000;
    const r = promote.runOnce({ now: () => future, min_age_ms: 12 * 60 * 60 * 1000, min_reps: 3 });
    assert.strictEqual(r.promoted, 1, 'one row, age + reps satisfied → one promotion; got ' + JSON.stringify(r));
    const db = state._dbForQuery();
    const row = db.prepare("SELECT output FROM action_records WHERE id=?").get(r.ids[0]);
    const o = JSON.parse(row.output);
    assert.ok(o.statement.indexOf(FACT) >= 0, 'the identity engram is the fact');
    assert.strictEqual(o.payload && o.payload.fact_kind, 'liking');
    assert.ok(o.payload.reps >= 3);
  });

  await t('Stage 4 — composeEnvelope carries the promoted fact', () => {
    const list = (q) => engram.listEngrams(Object.assign({}, q, { principal: null, audience: 'all' }));
    const { items, block } = composeEnvelope({ listEngrams: list });
    const texts = items.map((i) => i.statement);
    assert.ok(texts.some((s) => s.indexOf(FACT) >= 0), 'promoted fact must appear in the always-on envelope; got ' + JSON.stringify(texts));
    assert.ok(block.indexOf('<memory_identity>') === 0);
  });

  await t('Re-running runOnce is IDEMPOTENT', () => {
    const future = Date.now() + 14 * 60 * 60 * 1000;
    const r = promote.runOnce({ now: () => future, min_age_ms: 12 * 60 * 60 * 1000, min_reps: 3 });
    assert.strictEqual(r.promoted, 0, 'second pass must skip already-promoted; got ' + JSON.stringify(r));
  });

  await t('A fact stated twice → NOT promoted even past min_age_ms', async () => {
    const SHALLOW = 'four-space indentation in every file';
    const t2 = 'I prefer ' + SHALLOW + ', it reads better to me';
    recordTurn(t2);
    recordTurn(t2);
    await wmTask.run({ substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } });
    const future = Date.now() + 15 * 60 * 60 * 1000;
    const r = promote.runOnce({ now: () => future, min_age_ms: 12 * 60 * 60 * 1000, min_reps: 3 });
    const promotedRow = (engram.listEngrams({ scope: 'identity', principal: null, audience: 'all', limit: 200 }) || [])
      .find((e) => typeof e.statement === 'string' && e.statement.indexOf('four-space') >= 0);
    assert.strictEqual(promotedRow, undefined, 'a 2×-stated fact must not promote at min_reps=3');
    assert.strictEqual(r.promoted, 0);
  });

  console.log('');
  console.log('identity promotion: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
