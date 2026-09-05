#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The class arms of recall run on the read worker when the process has one,
// and on the loop otherwise; the rows and their order are the same.
const assert = require('assert');
const path = require('path');
require('./hermetic-db.js');
process.env.TROTH_EMBED_PORT = '9';
process.env.TROTH_EMBEDDING_HOST = 'http://127.0.0.1:9';
process.env.TROTH_RECALL_CONCERNS = '0';
const CORE = path.join(__dirname, '..', 'shared-core');
const rerankerPath = path.join(CORE, 'local-reranker.js');
require.cache[rerankerPath] = { id: rerankerPath, filename: rerankerPath, loaded: true, exports: { rerank: async (q, docs) => docs.map(() => 0.42) } };
const engram = require(path.join(CORE, 'engram.js'));
const recall = require(path.join(CORE, 'recall.js'));
const rw = require(path.join(CORE, 'read-worker.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const AGENT = 'local-agent', CWD = '/w/arms-test';
function fact(statement) { engram.recordEngram({ agent_id: AGENT, cwd: CWD, statement, source: 'arms-test', auto_verify: false }); }
for (let i = 0; i < 12; i++) fact('The deadline for project ' + i + ' moved to Friday, the office said.');
fact('The deadline for taxes is in June every year.');
fact('Coffee beans are roasted on Tuesdays.');

console.log('\n=== recall class arms beside the loop ===\n');
(async () => {
  const phases = (r) => (r && r.profile && r.profile.phases) || [];
  const ask = (extra) => recall.recall(Object.assign({ query: 'deadline office Friday', class: 'all', audience: 'model_visible', limit: 8, profile: true }, extra || {}));
  await t('without a worker the arms run on the loop', async () => {
    assert.strictEqual(rw.hasWorker(), false);
    const r = await ask();
    assert.ok(r.length > 0, 'rows');
    assert.ok(!phases(r).some((p) => /^arms_off_loop/.test(p)), 'no off-loop phase: ' + JSON.stringify(phases(r)));
  });
  await t('with the worker up the same rows come back in the same order, off the loop', async () => {
    await rw.run('substrate_counts', {}, { timeout_ms: 60000 });
    assert.strictEqual(rw.hasWorker(), true);
    const on = await ask({ off_loop: false });
    const off = await ask();
    assert.ok(phases(off).some((p) => /^arms_off_loop/.test(p)), 'the off-loop phase is recorded: ' + JSON.stringify(phases(off)));
    assert.ok(off.length > 0 && on.length === off.length, 'same count: ' + on.length + ' vs ' + off.length);
    // The same rows: episodic scores carry a recency term that moves with the
    // clock, so two calls a moment apart differ in the third decimal, and
    // rows that tie on score may swap places between the calls. Every row
    // scores the same on both roads within that margin, and any two rows the
    // loop set clearly apart keep their order on the worker.
    const TIE = 0.05;
    assert.deepStrictEqual(off.map((x) => x.id).sort(), on.map((x) => x.id).sort(), 'the same rows');
    const onScore = new Map(on.map((x) => [x.id, x.score]));
    for (const x of off) assert.ok(Math.abs(x.score - onScore.get(x.id)) < TIE, 'score of ' + x.id + ': ' + x.score + ' vs ' + onScore.get(x.id));
    const offPos = new Map(off.map((x, i) => [x.id, i]));
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
      if (on[i].score - on[j].score > TIE) assert.ok(offPos.get(on[i].id) < offPos.get(on[j].id), 'order kept for rows set apart: ' + on[i].id + ' before ' + on[j].id);
    }
  });
  await t('a class arm answers by name on the worker', async () => {
    const o = { query: 'taxes June', audience: 'model_visible', limit: 5, cwd: CWD, topicTokens: new Set(), include_superseded: false, include_flagged: false };
    const rows = await rw.run('recall_class', { cls: 'episodic', opts: o }, { timeout_ms: 60000 });
    const loop = recall._recallClass('episodic', o);
    assert.ok(Array.isArray(rows) && rows.length >= 1 && /taxes/.test(rows[0].statement), JSON.stringify(rows).slice(0, 200));
    assert.deepStrictEqual(rows.map((r) => r.id), loop.map((r) => r.id), 'the worker and the loop name the same rows');
  });
  console.log('\nrecall-arms-off-loop: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
