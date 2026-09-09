#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// When Identity has no engine to read with (local only, no local engine up),
// the self-facts pass keeps its window: the patterns run, the watermark does
// not move, and a model reads those turns once one answers. Switched off,
// the patterns are the whole answer and the watermark moves.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-identity-waiting-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'troth-identity-waiting-')), 'config.json');
process.env.TROTH_CONFIG_PATH = cfgPath;
process.env.TROTH_LLAMACPP_HOST = 'http://127.0.0.1:9';
process.env.TROTH_INSTANCE_EXTRACT_ENGINE = '1';
delete process.env.TROTH_SELF_FACT_LLM;
delete process.env.TROTH_IDENTITY_ENGINE;
fs.writeFileSync(cfgPath, JSON.stringify({ identity: { engine: 'auto' } }));

const bw = require(path.join(__dirname, '..', 'shared-core', 'background-worker.js'));
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const dm = require(path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== identity waits for an engine ===\n');
const A = 'identity-waiting-test';
const view = { substrate_ctx: { agent_id: A, user_id: 'default', cwd: null } };
const marks = () => (engram.listEngrams({ scope: 'internal:wm_watermark', audience: 'all', agent_id: A, limit: 10 }) || []);

(async () => {
  await t('local only and no local engine: the pass waits and the watermark stays', async () => {
    dm.recordTurn({ agent_id: A, conversation_id: 'w1', timestamp: Date.now() - 5 * 60 * 1000, user_text: 'I work at Northwind two days a week', assistant_text: 'ok' });
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/wm_consolidation \(waiting\)/.test(r.notes[0]), 'the note names the road: ' + r.notes[0]);
    assert.ok(/window retained/.test(r.notes[0]), r.notes[0]);
    assert.strictEqual(marks().length, 0, 'no watermark row while the window waits');
  });

  await t('switched off, the patterns are the answer and the watermark moves', async () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ identity: { engine: 'off' } }));
    const r = await bw.tasks.workingMemoryConsolidation.run(view);
    assert.ok(/wm_consolidation \(patterns\)/.test(r.notes[0]), r.notes[0]);
    assert.ok(!/window retained/.test(r.notes[0]), r.notes[0]);
    assert.strictEqual(marks().length, 1, 'the watermark row is written');
  });

  console.log('\nidentity-waiting: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
