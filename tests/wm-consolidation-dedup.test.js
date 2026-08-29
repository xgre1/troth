#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// wm_consolidation dedup regression.
// Proves the fix for the live "12x identical 'operator emphasized:' spam"
// defect: the task wrote with auto_verify:false (dedup off) and never
// implemented the dedup its own comment promised, so each tick re-promoted the
// SAME emphasized fragment. Grounded in our ingested research
// (AI-Memory-Consolidation-Implementation-Details.md §3.4: an identical
// assertion is a storage NO-OP).
//
// The task reads the real engram/state singletons (require('./engram.js'))
// and has no DI seam, so this drives them directly (same pattern as ENT-58 in
// test-all.js) against the live ~/.troth DB, using a UNIQUE marker per run so
// it never collides with real data or other runs. It records real dialogue.turn
// tool_call rows, runs the task twice, and asserts the emphasized fragment is
// promoted exactly once.
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

// Unique marker so this test's writes never collide with real data / other runs.
const MARK = 'WMDEDUP' + Date.now().toString(36) + Math.floor(performance.now()).toString(36);
const EMPH = '!!! ' + MARK + ' this fragment is strongly emphasized and must promote once';
const AGENT = 'wmdedup-' + Date.now();
const CWD = require('os').tmpdir() + '/wmdedup-' + Date.now();

// Record a dialogue.turn tool_call row (what the task scans). timestamp must be
// AFTER the watermark; the task's no-watermark fallback looks back only 1h, so
// "now" rows qualify.
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

function countPromoted(marker) {
  const rows = eng.listEngrams({ scope: 'consolidated:dialogue', limit: 1000 }) || [];
  return rows.filter(e => e && typeof e.statement === 'string' && e.statement.includes(marker)).length;
}

console.log('\n=== wm_consolidation dedup (M1, live-singleton) ===\n');

(async () => {
  if (!task) { console.error('FATAL: wm_consolidation task not found'); process.exit(1); }

  const view = { substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } };

  await t('three identical emphasized turns promote the fragment exactly once', async () => {
    recordTurn(EMPH, 0);
    recordTurn(EMPH, 1);
    recordTurn(EMPH, 2);
    await task.run(view);
    const n = countPromoted(MARK);
    assert.strictEqual(n, 1, 'expected exactly 1 promoted copy, got ' + n);
  });

  await t('re-running the task does NOT add another copy (across-run dedup)', async () => {
    recordTurn(EMPH, 3); // a fresh identical turn after the first run
    await task.run(view);
    const n = countPromoted(MARK);
    assert.strictEqual(n, 1, 'across-run dedup failed: got ' + n + ' copies');
  });

  await t('a distinct emphasized fragment still promotes', async () => {
    // Distinct marker that does NOT contain MARK as a substring (else
    // countPromoted(MARK) would also match this fragment and over-count).
    const MARK2 = 'WMDEDUPB' + Date.now().toString(36);
    // Must clear detectEmphasis() >= 0.3 to be eligible for promotion — the
    // task only promotes emphasized turns. Mirror the same emphasis shape as
    // EMPH ("must promote"/"strongly emphasized" trigger the detector). A
    // fragment without emphasis words scores ~0.1 and is correctly skipped —
    // that is the task working as designed, not a dedup issue.
    const EMPH2 = '!!! ' + MARK2 + ' strongly emphasized and must promote once too';
    recordTurn(EMPH2, 60 * 60 * 1000);
    await task.run(view);
    assert.strictEqual(countPromoted(MARK2), 1, 'distinct emphasized fragment must promote');
    assert.strictEqual(countPromoted(MARK), 1, 'original still deduped to 1');
  });

  console.log('');
  console.log('wm_consolidation dedup: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
