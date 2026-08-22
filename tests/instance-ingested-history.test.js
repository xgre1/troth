#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Caller-windowed consolidation — ingested histories whose turns are far
// older than any cadence lookback (bench haystacks, imported archives).
// Proves: (1) the cadence window alone sees NOTHING in an old history,
// (2) an explicit since distills it, (3) the caller-windowed pass leaves
// no watermark behind, (4) re-running the same window is idempotent
// through pool matching alone.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-instance-ingested-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';

const assert = require('assert');
const ic = require('../shared-core/instance-consolidation.js');
const engram = require('../shared-core/engram.js');
const dialogueMemory = require('../shared-core/dialogue-memory.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const BRAIN = 'test-brain';
const TWO_YEARS_AGO = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;

function watermarks() {
  return (engram.listEngrams({ audience: 'substrate_internal', agent_id: BRAIN, limit: 50 }) || [])
    .filter(e => e && e.scope === ic.WATERMARK_SCOPE);
}

(async function main() {
console.log('\n=== instance consolidation over ingested histories ===\n');

assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-old', timestamp: TWO_YEARS_AGO,
  user_text: 'I attended an amazing baking class at the local culinary school yesterday.',
  assistant_text: 'Sounds fun.'
}));

const extractor = () => Promise.resolve(JSON.stringify([
  { kind: 'activity', entity: 'baking class', description: 'local culinary school class', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] }
]));

await t('cadence window alone sees NOTHING in a years-old history', async () => {
  const s = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: extractor });
  assert.strictEqual(s.processed, 0, 'the 24h lookback must exclude ancient turns: ' + JSON.stringify(s));
  assert.strictEqual(s.written, 0);
});

await t('explicit since distills the full history', async () => {
  const s = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: extractor, since: 0 });
  assert.strictEqual(s.processed, 1, JSON.stringify(s));
  assert.strictEqual(s.written, 1);
  assert.strictEqual(s.windowed_by, 'caller');
  const acts = engram.listEngrams({ scope: 'instance:activity', audience: 'all', agent_id: BRAIN, limit: 10 });
  assert.strictEqual(acts.length, 1);
});

await t('caller-windowed pass leaves NO watermark behind', () => {
  assert.strictEqual(watermarks().length, 0,
    'a bench/import pass must not plant cadence state the live worker would trust');
});

await t('re-running the same window is idempotent through pool matching alone', async () => {
  const s = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: extractor, since: 0 });
  assert.strictEqual(s.written, 0, 'no duplicate distillation: ' + JSON.stringify(s));
  assert.strictEqual(s.dup, 1);
});

console.log('');
console.log('instance-ingested-history: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
