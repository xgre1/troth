#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// wm_consolidation working→episodic promotion.
// A turn earns a durable record by what it STATES about the operator, never
// by how loudly it is said. The task reads new dialogue turns for
// self-statements (a role, a constraint, a skill, a liking, a prior effort)
// and writes each distinct fact once, in the operator's own words, to
// scope='consolidated:self' at the episodic class with plr_evolved
// authority and the attesting turns counted. An angry sentence in capitals
// writes nothing; the old scope 'consolidated:dialogue' is never written.
//
// Hermetic via tests/hermetic-db.js — temp HOME, fresh action_records,
// fresh state.db. The local-engine reader is off so the run is deterministic.
process.env.TROTH_SELF_FACT_LLM = '0';
require('./hermetic-db.js');
const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const bw    = require(path.join(PROJECT_ROOT, 'shared-core', 'background-worker.js'));
const state = require(path.join(PROJECT_ROOT, 'shared-core', 'state.js'));
const ar    = require(path.join(PROJECT_ROOT, 'shared-core', 'action-record.js'));

const task = bw.DEFAULT_TASKS.find((t) => t.name === 'wm_consolidation');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; },
          (e) => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const AGENT = 'wmproma-' + Date.now();
const CWD   = require('os').tmpdir() + '/wmproma-' + Date.now();
const MARK  = 'promote' + Date.now().toString(36);

function recordTurn(userText) {
  const rec = {
    id: ar.uuidv7(),
    timestamp: Date.now(),
    type: 'tool_call',
    agent_id: AGENT,
    cwd: CWD,
    user_id: 'default',
    input:  { tool_name: 'dialogue.turn', args: { user_text: userText } },
    output: { ok: true },
  };
  state.recordAction(rec, ar.toSearchText(rec));
}

function rowsAt(scope, needle) {
  const db = state._dbForQuery();
  const rows = db.prepare(
    "SELECT timestamp, memory_class, audience, output FROM action_records " +
    "WHERE type='commitment' AND json_extract(output,'$.scope')=? ORDER BY timestamp DESC LIMIT 200"
  ).all(scope);
  const out = [];
  for (const r of rows) {
    let o; try { o = JSON.parse(r.output); } catch (_) { continue; }
    if (o && typeof o.statement === 'string' && (!needle || o.statement.toLowerCase().indexOf(needle.toLowerCase()) >= 0)) out.push(Object.assign({}, r, { _parsed: o }));
  }
  return out;
}

console.log('\n=== wm_consolidation working→episodic promotion ===\n');

(async () => {
  if (!task) { console.error('FATAL: wm_consolidation task not found'); process.exit(1); }
  const view = { substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } };

  await t('a turn that states a fact about the operator → ONE consolidated:self row holding the fact, episodic, plr_evolved', async () => {
    recordTurn('I took a ' + MARK + ' mixology class. Any ideas for a cocktail at the party?');
    const r = await task.run(view);
    assert.ok(r && Array.isArray(r.notes), 'task returned notes: ' + JSON.stringify(r));
    const rows = rowsAt('consolidated:self', MARK);
    assert.strictEqual(rows.length, 1, 'exactly one fact row mentioning ' + MARK + '; got ' + rows.length);
    const row = rows[0];
    assert.strictEqual(row.memory_class, 'episodic', 'promotion target is the episodic class — got ' + row.memory_class);
    assert.strictEqual(row._parsed.source_authority, 'plr_evolved');
    assert.ok(/mixology class/i.test(row._parsed.statement), 'the statement is the fact in the operator\'s words: ' + row._parsed.statement);
    assert.ok(row._parsed.statement.indexOf('operator emphasized') < 0, 'no emphasis prefix');
    assert.strictEqual(row._parsed.payload && row._parsed.payload.fact_kind, 'skill');
    assert.strictEqual(row._parsed.payload && row._parsed.payload.reps, 1);
  });

  await t('a loud angry turn states nothing about the operator → no row anywhere', async () => {
    const LOUD = 'LOUD' + Date.now().toString(36);
    recordTurn('!!! FIX IT NOW ' + LOUD + ' THIS IS BROKEN AGAIN YOU MUST STOP DOING THIS !!!');
    await task.run(view);
    assert.strictEqual(rowsAt('consolidated:self', LOUD).length, 0, 'a loud turn with no self-statement writes nothing');
    assert.strictEqual(rowsAt('consolidated:dialogue', LOUD).length, 0, 'the old emphasis scope is never written');
  });

  await t('a neutral aside with no self-statement → no promotion', async () => {
    const NEUTRAL = 'neutral' + Date.now().toString(36);
    recordTurn('quick note ' + NEUTRAL + ' just an aside about the weather today');
    await task.run(view);
    assert.strictEqual(rowsAt('consolidated:self', NEUTRAL).length, 0);
  });

  await t('the source dialogue.turn rows stay in action_records as the working trace', async () => {
    const db = state._dbForQuery();
    const turns = db.prepare(
      "SELECT count(*) AS n FROM action_records " +
      "WHERE type='tool_call' AND agent_id=? AND json_extract(input,'$.tool_name')='dialogue.turn'"
    ).get(AGENT);
    assert.ok(turns.n >= 3, 'dialogue.turn rows persist as the working trace; got ' + turns.n);
  });

  console.log('');
  console.log('wm_consolidation promotion: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
