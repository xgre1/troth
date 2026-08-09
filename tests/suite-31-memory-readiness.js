// SPDX-License-Identifier: AGPL-3.0-only
// Memory readiness — one owner for the pipeline's truth (PLAN-COHERENCE law 5).
//
// The counts are the load-bearing part: recall_missing feeds the "still
// indexing" stage, and archive_chunks vs archive_embedded is how a surface
// says "your imported archive is keyword-only" instead of implying semantic
// search that is not there (the backfill deliberately excludes docs:chats).
// Seeded against the hermetic db; the composed readiness() is smoke-tested
// for shape and stage sanity (the embedder's download state is machine-
// dependent by nature — the stage TRANSITIONS live in the counts).
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar = require(path.join(ROOT, 'shared-core', 'action-record.js'));
const mr = require(path.join(ROOT, 'shared-core', 'memory-readiness.js'));

console.log('\nMemory readiness (READY):');

test('READY-1: memoryIndexCounts counts the three truths and keeps the archive out of recall_missing', () => {
  const before = state.memoryIndexCounts(null);
  const seed = (extra) => {
    const id = ar.uuidv7();
    const wrote = state.recordAction(Object.assign({
      id, timestamp: Date.now(), type: 'commitment',
      agent_id: 'ready-test', cwd: null, user_id: 'operator',
      audience: 'model_visible', memory_class: 'semantic',
      input: { source: 'suite-31' },
      output: Object.assign({ statement: 'readiness probe ' + id, commitment_type: 'engram', salience: 1 }, extra || {})
    }), 'readiness probe');
    assert.ok(wrote, 'seed row persisted');
    return id;
  };
  // A recallable row with no vector → +1 recall_missing.
  seed({});
  // An archive row with no vector → +1 archive_chunks, NOT in recall_missing
  // (the backfill's own exclusion; the count must mirror it exactly).
  seed({ scope: 'docs:chats' });
  // An archive row WITH a vector → +1 archive_chunks AND +1 archive_embedded.
  const emb = seed({ scope: 'docs:chats' });
  assert.ok(state.setEmbedding(emb, new Array(8).fill(0.5), { model: 'test-embed' }), 'vector stored');

  const after = state.memoryIndexCounts(null);
  assert.strictEqual(after.recall_missing, before.recall_missing + 1, 'archive rows never inflate recall_missing');
  assert.strictEqual(after.archive_chunks, before.archive_chunks + 2);
  assert.strictEqual(after.archive_embedded, before.archive_embedded + 1);
  // The bounded drain's own lister: sees the unembedded archive row, never
  // the embedded one — this is what heals the field-hit import (39 vectors
  // out of ~1000 chunks) over idle cycles.
  const missing = state.listArchiveMissingEmbeddings(500).map((r) => r.id);
  assert.ok(missing.length >= 1, 'the drain has work to see');
  assert.ok(!missing.includes(emb), 'an embedded archive row is never re-listed');
});

test('READY-2: readiness() composes the one answer every surface renders', () => {
  const r = mr.readiness();
  assert.ok(['engine_downloading', 'indexing', 'ready', 'unavailable'].includes(r.stage), 'a real stage: ' + r.stage);
  assert.strictEqual(typeof r.embedder.ready, 'boolean');
  assert.strictEqual(typeof r.reranker.ready, 'boolean');
  assert.ok(r.indexing.archive_chunks >= 2, 'sees the archive rows seeded above');
  assert.ok(r.indexing.archive_chunks > r.indexing.archive_embedded, 'and the not-yet-embedded gap');
  assert.ok(r.reasons.some((s) => /still embedding/.test(s)),
    'the archive gap is STATED, not implied away: ' + JSON.stringify(r.reasons));
  // Stage honesty: with the hermetic HOME the engine cannot be "ready with
  // nothing missing" unless the embedder truly is on disk here — accept any
  // stage but require it to be CONSISTENT with what the parts say.
  if (r.stage === 'ready') assert.ok(r.embedder.ready && r.indexing.recall_missing === 0);
  if (r.stage === 'indexing') assert.ok(r.indexing.recall_missing > 0);
  if (r.stage === 'engine_downloading') assert.ok(!r.embedder.ready);
});

test('READY-3: the proxy serves it read-only on the authed GET chain (source pin)', () => {
  // Functional proof lives in READY-1/2 (the module the endpoint returns);
  // this pins the wiring: the readiness url rides the SAME checkRemoteAuth
  // GET chain as /api/embed/status, and the handler only requires + calls —
  // no download kicks on a status read (the poll that owns the kick is
  // embed/status, by its own comment).
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const gate = src.indexOf("url === '/api/memory/readiness'");
  assert.ok(gate > 0, 'readiness is in the authed GET gate');
  const branch = src.indexOf("url === '/api/memory/readiness'", gate + 1);
  assert.ok(branch > 0, 'and has its handler branch');
  const handler = src.slice(branch, branch + 600);
  assert.ok(/memory-readiness\.js/.test(handler), 'the branch serves the shared module');
  assert.ok(!/prepareModel|ensureServer|downloadFollow/.test(handler), 'a status read never starts a download');
});

test('READY-4: rows with no embeddable text are OUTSIDE the index promise (never counted, never listed)', () => {
  const before = state.memoryIndexCounts(null);
  const mk = (input, output) => {
    const id = ar.uuidv7();
    const wrote = state.recordAction({ id, timestamp: Date.now(), type: 'tool_call',
      agent_id: 'ready-test', cwd: null, user_id: 'operator',
      audience: 'model_visible', memory_class: 'episodic',
      input, output }, 'poison probe');
    assert.ok(wrote, 'poison row persisted');
    return id;
  };
  // The two field shapes behind the frozen dashboards: a blank dialogue
  // turn and bare tool telemetry (sql_exec-style) in a recallable class.
  // They stay in the db untouched — they are simply not "still indexing".
  const p1 = mk({ tool_name: 'dialogue.turn', args: { user_text: '' } }, { assistant_text: '' });
  const p2 = mk({ tool_name: 'sql_exec', args: { q: 'SELECT 1' } }, { status: 'ok' });
  const after = state.memoryIndexCounts(null);
  assert.strictEqual(after.recall_missing, before.recall_missing, 'poison never inflates recall_missing');
  assert.strictEqual(after.recall_total, before.recall_total, 'nor the index-promise total');
  assert.strictEqual(after.recall_total, after.recall_embedded + after.recall_missing,
    'total = embedded + missing stays a true progress pair');
  const ids = state.listRecallableMissingEmbeddings(500).map((r) => r.id);
  assert.ok(!ids.includes(p1) && !ids.includes(p2), 'and the drain lister never pulls them — the archive lane cannot starve behind them');
});

test('READY-5: the drain heartbeat reads the ledger and gates every "background drain" claim', () => {
  // This hermetic home has work owed (READY-1 seeded an unembedded row)
  // and no ledger row yet → not alive, and the verdict is STATED.
  let r = mr.readiness();
  assert.strictEqual(r.drain.alive, false, 'no ledger row → not alive: ' + JSON.stringify(r.drain));
  if (r.stage !== 'unavailable') {
    assert.ok(r.reasons.some((s) => /no background worker/.test(s)),
      'work owed + no heartbeat → the not-running verdict is a reason: ' + JSON.stringify(r.reasons));
  }
  // A fresh run record — exactly what startWorker submits — flips it.
  const id = ar.uuidv7();
  const wrote = state.recordAction({ id, timestamp: Date.now(), type: 'decision',
    agent_id: 'maintenance', cwd: null, user_id: 'default',
    audience: 'substrate_internal', memory_class: 'operational',
    input: { kind: 'background_task_run', task: 'embedding_backfill', signals: { scheduler: true } },
    output: { decision: 'ran', reason: 'startWorker', notes: 'embedding_backfill: embedded=64 failed=0 this_run (more remaining)' } }, 'background task run');
  assert.ok(wrote, 'ledger row persisted');
  r = mr.readiness();
  assert.strictEqual(r.drain.alive, true, 'fresh ledger row → alive');
  assert.ok(/embedded=64/.test(String(r.drain.last_notes)), 'the run notes ride home: ' + r.drain.last_notes);
  assert.ok(!r.reasons.some((s) => /no background worker/.test(s)), 'and the verdict clears');
});
};
