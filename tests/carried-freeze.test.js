#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// carried_freeze regression — the carried metric must not decay.
//
// Proves the fix for the live "saved by troth 12.4B → 3.4B overnight" defect:
// tokens_removed_carried multiplied each removal by turns read from Claude
// Code transcripts, files another program prunes on its own 30-day schedule
// (and rejects outright past the V8 string cap). Four properties hold now:
//   1. a removal settled by its transcript freezes its exact turn count onto
//      the row and the value survives total loss of every timeline source;
//   2. a compaction seen only through substrate traces does NOT settle a row
//      — freezing a fresh row from sparse beats locks a near-zero multiplier
//      (the live "today froze at ×0" defect) — those rows wait for quiet;
//   3. rows with no timeline anywhere freeze at zero only once a month old;
//   4. frozen values are floors: when a readable transcript later shows MORE
//      turns than a frozen row holds, the audit arm raises it — never lowers.
require('./hermetic-db.js'); // pin a throwaway STATE_DB_PATH before state.js loads
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The transcript arm of sessionTimeline reads HOME/.claude/projects — point it
// at a scratch HOME before analytics loads.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'carried-freeze-home-'));
process.env.HOME = scratchHome;

const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const bw = require(path.join(__dirname, '..', 'shared-core', 'background-worker.js'));
const analytics = require(path.join(__dirname, '..', 'shared-core', 'analytics.js'));

const task = bw.tasks.carriedFreeze;
const db = state.db();
const now = Date.now();
const B = now - 3600 * 1000;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message || e)); }
}

const insSaving = db.prepare('INSERT INTO savings_ledger (ts,kind,tokens,session_id) VALUES (?,?,?,?)');
const insBeat = db.prepare('INSERT INTO hook_events (ts,session_id,event) VALUES (?,?,?)');
const insAction = db.prepare('INSERT INTO action_records (id,timestamp,type,agent_id,session_id) VALUES (?,?,?,?,?)');
const getFrozen = db.prepare('SELECT carried_turns FROM savings_ledger WHERE session_id = ?');

const pdir = path.join(scratchHome, '.claude', 'projects', 'px');
fs.mkdirSync(pdir, { recursive: true });
function writeTranscript(sid, userTurns, gapMs, compactAtMs) {
  const lines = [];
  for (let i = 1; i <= userTurns; i++) lines.push(JSON.stringify({ type: 'user', timestamp: new Date(B + i * gapMs).toISOString() }));
  if (compactAtMs) lines.push(JSON.stringify({ subtype: 'compact_boundary', timestamp: new Date(B + compactAtMs).toISOString() }));
  fs.writeFileSync(path.join(pdir, sid + '.jsonl'), lines.join('\n') + '\n');
}

// S: transcript session — 30 user turns, conversation compaction after 15.
insSaving.run(B, 'context_filter', 100, 'S');
writeTranscript('S', 30, 10000, 155500);
// U: substrate-only session with a claude-code compaction mark after its
// removal — sparse beats say "stop at 3"; must NOT settle.
insSaving.run(B, 'mcp_cache:hit', 60, 'U');
for (let i = 1; i <= 3; i++) insBeat.run(B + i * 10000, 'U', 'PostToolUse.x');
insAction.run('cf-test-u-cc', B + 40000, 'compact', 'claude-code', 'U');
// Q: active session, no compaction — must wait.
insSaving.run(now - 1800 * 1000, 'mcp_cache:hit', 50, 'Q');
for (let i = 1; i <= 5; i++) insBeat.run(now - 1800 * 1000 + i * 60000, 'Q', 'PostToolUse.x');
// R: month-old, zero traces — honest floor of zero.
insSaving.run(now - 35 * 86400 * 1000, 'gemcache:hit', 77, 'R');

task.run().then((r1) => {
  t('transcript-settled removal froze at its exact turn count', () => {
    assert.strictEqual(getFrozen.get('S').carried_turns, 15);
  });
  t('substrate-sourced compaction does not settle a fresh row', () => {
    assert.strictEqual(getFrozen.get('U').carried_turns, null);
  });
  t('active session with no compaction is still settling', () => {
    assert.strictEqual(getFrozen.get('Q').carried_turns, null);
  });
  t('month-old row with no timeline froze at zero', () => {
    assert.strictEqual(getFrozen.get('R').carried_turns, 0);
  });

  // Every timeline source dies; the frozen value must not move.
  fs.unlinkSync(path.join(pdir, 'S.jsonl'));
  db.prepare('DELETE FROM hook_events').run();
  db.prepare("DELETE FROM action_records WHERE id LIKE 'cf-test-%'").run();
  t('frozen value survives total timeline loss', () => {
    const o = analytics.getAnalytics({ window: 'all' }).overview;
    const s = (o.removal_sessions || []).find((x) => x.session_id === 'S');
    assert.ok(s, 'session S present');
    assert.strictEqual(s.carried, 1600); // 100 × (1 + 15)
    assert.strictEqual(s.timeline, 'frozen');
  });

  // A richer readable transcript appears: 20 user turns before the
  // compaction. The audit arm must raise 15 → 20.
  writeTranscript('S', 20, 7000, 155500);
  return task.run();
}).then(() => {
  t('audit raised the frozen floor from primary evidence', () => {
    assert.strictEqual(getFrozen.get('S').carried_turns, 20);
  });
  t('evidence-less zero-frozen row carries the measured era average, marked estimated', () => {
    assert.strictEqual(getFrozen.get('R').carried_turns, 223);
    const o = analytics.getAnalytics({ window: 'all' }).overview;
    const r = (o.removal_sessions || []).find((x) => x.session_id === 'R');
    assert.ok(r, 'session R present');
    assert.strictEqual(r.timeline, 'estimated');
    assert.strictEqual(r.carried, 77 * 224);
    assert.strictEqual(o.removal_carried_estimated, 77 * 224);
  });
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('suite error:', e);
  process.exit(1);
});
