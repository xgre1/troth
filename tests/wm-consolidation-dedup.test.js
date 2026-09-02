#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// wm_consolidation dedup: one fact, one row. The same fact stated three
// times in three turns is ONE consolidated:self row with reps=3; a later
// identical turn does not add a copy; a distinct fact gets its own row.
process.env.TROTH_SELF_FACT_LLM = '0';
require('./hermetic-db.js'); // pin a throwaway STATE_DB_PATH before state.js loads
const assert = require('assert');
const path = require('path');

const bw    = require(path.join(__dirname, '..', 'shared-core', 'background-worker.js'));
const eng   = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const ar    = require(path.join(__dirname, '..', 'shared-core', 'action-record.js'));

const task = bw.DEFAULT_TASKS.find(t => t.name === 'wm_consolidation');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const MARK = 'dedup' + Date.now().toString(36);
const FACT_TURN = 'I love true crime podcasts ' + MARK + ' and I am looking for something new tonight';
const AGENT = 'wmdedup-' + Date.now();
const CWD = require('os').tmpdir() + '/wmdedup-' + Date.now();

function recordTurn(userText, tsOffset) {
  const rec = {
    id: ar.uuidv7(),
    timestamp: Date.now() + (tsOffset || 0),
    type: 'tool_call',
    agent_id: AGENT,
    cwd: CWD,
    user_id: 'default',
    input: { tool_name: 'dialogue.turn', args: { user_text: userText } },
    output: { ok: true },
  };
  state.recordAction(rec, ar.toSearchText(rec));
}

function factRows(marker) {
  const rows = eng.listEngrams({ scope: 'consolidated:self', limit: 1000 }) || [];
  return rows.filter(e => e && typeof e.statement === 'string' && e.statement.toLowerCase().includes(marker.toLowerCase()));
}
function repsOf(marker) {
  const db = state._dbForQuery();
  const rows = db.prepare("SELECT output FROM action_records WHERE type='commitment' AND json_extract(output,'$.scope')='consolidated:self'").all();
  for (const r of rows) { let o; try { o = JSON.parse(r.output); } catch (_) { continue; } if (o.statement && o.statement.toLowerCase().includes(marker.toLowerCase())) return o.payload && o.payload.reps; }
  return null;
}

console.log('\n=== wm_consolidation dedup (one fact, one row) ===\n');

(async () => {
  if (!task) { console.error('FATAL: wm_consolidation task not found'); process.exit(1); }
  const view = { substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } };

  await t('the same fact stated three times is one row with reps=3', async () => {
    recordTurn(FACT_TURN, 0);
    recordTurn(FACT_TURN, 1);
    recordTurn(FACT_TURN, 2);
    await task.run(view);
    const n = factRows(MARK).length;
    assert.strictEqual(n, 1, 'expected exactly 1 fact row, got ' + n);
    assert.strictEqual(repsOf(MARK), 3, 'the three attesting turns are counted');
  });

  await t('re-running the task after another identical turn does NOT add a copy', async () => {
    recordTurn(FACT_TURN, 3);
    await task.run(view);
    assert.strictEqual(factRows(MARK).length, 1, 'across-run dedup');
  });

  await t('a distinct fact gets its own row', async () => {
    const MARK2 = 'dedupb' + Date.now().toString(36);
    recordTurn('I took a ' + MARK2 + ' pottery course, and I want to try a wheel again', 60 * 60 * 1000);
    await task.run(view);
    assert.strictEqual(factRows(MARK2).length, 1, 'distinct fact must have its own row');
    assert.strictEqual(factRows(MARK).length, 1, 'original still one row');
  });

  console.log('');
  console.log('wm_consolidation dedup: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
