#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// wm_consolidation working→episodic promotion.
// Acceptance criterion: "plugin-only session shows working→episodic
// promotions." Dialogue turns land in action_records as transient working
// memory (memory_class flag attaches at engram-write time via
// recordEngram); the wm_consolidation background task scans recent
// emphasized turns and writes a CONSOLIDATED engram at the episodic class
// with source_authority=plr_evolved. This test pins the promotion: a
// turn → run task → an episodic engram exists with the expected provenance.
//
// Hermetic via tests/hermetic-db.js — temp HOME, fresh action_records,
// fresh state.db.

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
    .then(() => { console.log('  \u2713 ' + name); pass++; },
          (e) => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; });
}

const AGENT = 'wmproma-' + Date.now();
const CWD   = '/tmp/wmproma-' + Date.now();
const MARK  = 'PROMOTE' + Date.now().toString(36) +
  Math.floor(performance.now()).toString(36);

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

// Query the durable action_records ledger directly — listEngrams projects
// only a subset of columns, and memory_class isn't on the projection. The
// acceptance ASSERTION is structural ("the promoted row is at episodic
// class") so we read the column the substrate stamped.
function findPromotedRow(marker) {
  const db = state._dbForQuery();
  // memory_class is a top-level column; source_authority lives inside the
  // output JSON. Read both.
  const rows = db.prepare(
    "SELECT timestamp, memory_class, audience, output " +
    "FROM action_records " +
    "WHERE type='commitment' AND json_extract(output,'$.scope')='consolidated:dialogue' " +
    "ORDER BY timestamp DESC LIMIT 100"
  ).all();
  for (const r of rows) {
    let out;
    try { out = JSON.parse(r.output); } catch (_) { continue; }
    if (out && typeof out.statement === 'string' && out.statement.indexOf(marker) >= 0) {
      return Object.assign({}, r, { _parsed: out });
    }
  }
  return null;
}

console.log('\n=== wm_consolidation working→episodic promotion ===\n');

(async () => {
  if (!task) { console.error('FATAL: wm_consolidation task not found'); process.exit(1); }
  const view = { substrate_ctx: { agent_id: AGENT, cwd: CWD, user_id: 'default' } };

  await t('emphasized turn → wm_consolidation writes an EPISODIC-class consolidated engram', async () => {
    // detectEmphasis must score >= 0.3 — '!!!' + 'must promote' + 'strongly emphasized'
    // are all in the detector's vocabulary (see wm-consolidation-dedup test's MARK shape).
    recordTurn('!!! ' + MARK + ' this turn is strongly emphasized and must promote into episodic memory');
    const r = await task.run(view);
    assert.ok(r && Array.isArray(r.notes), 'task returned notes: ' + JSON.stringify(r));
    const row = findPromotedRow(MARK);
    assert.ok(row, 'a consolidated:dialogue row mentioning ' + MARK + ' must exist');
    assert.strictEqual(row.memory_class, 'episodic',
      'promotion target is the episodic class — got ' + row.memory_class);
    assert.strictEqual(row._parsed.source_authority, 'plr_evolved',
      'consolidated engrams carry plr_evolved authority (above llm_inferred) — got ' +
      row._parsed.source_authority);
    assert.strictEqual(row._parsed.scope, 'consolidated:dialogue');
    assert.ok(row._parsed.statement.indexOf('operator emphasized: ') === 0,
      'promoted statement preserves the canonical prefix');
  });

  await t('un-emphasized turn → no promotion (boost < 0.3)', async () => {
    const MARK_NEUTRAL = 'PROMOTENO' + Date.now().toString(36);
    recordTurn('quick neutral note ' + MARK_NEUTRAL + ' just an aside');
    await task.run(view);
    const row = findPromotedRow(MARK_NEUTRAL);
    assert.strictEqual(row, null,
      'a low-emphasis turn must NOT yield a consolidated row');
  });

  await t('the source dialogue.turn row stays in action_records as the working trace', async () => {
    // Promotion is a NEW row, not an UPDATE — the original working-memory
    // dialogue.turn lives on in action_records (audit trail).
    const db = state._dbForQuery();
    const turns = db.prepare(
      "SELECT count(*) AS n FROM action_records " +
      "WHERE type='tool_call' AND agent_id=? AND json_extract(input,'$.tool_name')='dialogue.turn'"
    ).get(AGENT);
    assert.ok(turns.n >= 2, 'dialogue.turn rows persist as the working trace; got ' + turns.n);
  });

  console.log('');
  console.log('wm_consolidation promotion: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
