// SPDX-License-Identifier: AGPL-3.0-only
// A vector must not outlive the memory it belongs to.
//
// Nothing in this codebase had ever deleted from engram_embeddings. The
// garbage collector tombstones an engram and moves on; the vector stays.
//
// That is expensive in an exact place: the dense recall arm streams EVERY
// recallable embedding on EVERY call, so dead vectors are paid for on every
// single turn. Three kinds accumulate: vectors on engrams the GC has already
// killed, vectors on superseded engrams (deliberately spared), and orphans
// whose row is gone entirely. Sweeping the dead ones shortens the full dense
// scan — real, and small.
//
// The first pass at this measurement claimed 41.6%, and was wrong by 37x: it
// ran COUNT(*) over a JOIN of embeddings to tombstones, and many tombstones
// point at the same engram, so pairs were counted as vectors. Recorded because
// the inflated number was quotable and would have justified far more work than
// the defect deserves — the correct question is COUNT(DISTINCT engram_id), and
// the honest verdict is "worth doing, not worth prioritising".
//
// And the deeper reason there were so many: 99.8% of the engrams the GC kills
// die within an HOUR of being written, most within a minute. They are machine
// diagnostics — 43,182 "body_halting (sigterm)", 25,468 pre-compact markers —
// written by the system, embedded, then swept. Write-then-delete churn is
// 64.4% of the whole table. This suite fixes the cost of that churn; the churn
// itself is upstream and still open.
//
// Superseded engrams are deliberately spared. They are real memories kept for
// audit, recall already skips them by following the supersession chain, and
// they are half a percent. Taking their vectors would trade nothing for the
// loss of "what did I would believe".
module.exports = function run({ test }) {
const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const state  = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar     = require(path.join(ROOT, 'shared-core', 'action-record.js'));
const engram = require(path.join(ROOT, 'shared-core', 'engram.js'));

console.log('\nDead vectors (DV):');

const vec = (seed) => Array.from({ length: 8 }, (_, i) => Math.sin(seed + i) / 2);
const hasVector = (id) => !!state.getEmbedding(id);

const seedEngram = (statement, salience) => {
  const id = engram.recordEngram({
    agent_id: 'dv-test', user_id: 'default', cwd: null,
    statement, source: 'dv-test', salience: salience == null ? 1 : salience,
    source_authority: 'llm_inferred', auto_verify: false
  });
  assert.ok(id, 'seeded: ' + statement.slice(0, 30));
  state.setEmbedding(id, vec(statement.length), { model: 'dv-model' });
  assert.ok(hasVector(id), 'and it carries a vector');
  return id;
};

// A tombstone as engram-gc writes one: type commitment, replaces:<id>.
const tombstone = (deadId, reason) => {
  const id = ar.uuidv7();
  const ok = state.recordAction({
    id, timestamp: Date.now(), type: 'commitment', agent_id: 'dv-test',
    user_id: 'default', cwd: null, memory_class: 'semantic', audience: 'model_visible',
    input:  { source: 'engram-gc:' + (reason || 'below_min_salience') },
    output: { statement: 'dead', commitment_type: 'engram_tombstoned', replaces: deadId, reason: reason || 'below_min_salience' }
  }, 'dv tombstone');
  assert.ok(ok, 'tombstone written');
  return id;
};

test('DV-1: the missing primitive exists and removes exactly one vector', () => {
  const a = seedEngram('the dv harbour bell rings at seven');
  const b = seedEngram('the dv lighthouse keeper signs at dawn');
  assert.strictEqual(state.deleteEmbedding(a), true, 'it deletes');
  assert.strictEqual(hasVector(a), false, 'the vector is gone');
  assert.strictEqual(hasVector(b), true, 'and its neighbour is untouched');
  assert.strictEqual(state.deleteEmbedding(a), false, 'deleting twice is not an error, it is a no-op');
  assert.strictEqual(state.deleteEmbedding(null), false, 'and nothing is deleted for nothing');
});

test('DV-2: the sweep clears vectors of tombstoned memories, and only those', () => {
  const dead  = seedEngram('the dv ferry timetable that was withdrawn');
  const alive = seedEngram('the dv ferry timetable currently in force');
  tombstone(dead);
  const r = state.pruneDeadEmbeddings(1000);
  assert.ok(r.tombstoned >= 1, 'it swept at least the one we killed: ' + JSON.stringify(r));
  assert.strictEqual(hasVector(dead), false, 'the dead memory lost its vector');
  assert.strictEqual(hasVector(alive), true, 'the live one kept it');
});

test('DV-3: a superseded memory KEEPS its vector — it is history, not garbage', () => {
  const older = seedEngram('the dv reconciliation used to close on Tuesday');
  const newer = ar.uuidv7();
  assert.ok(state.recordAction({
    id: newer, timestamp: Date.now(), type: 'commitment', agent_id: 'dv-test',
    user_id: 'default', cwd: null, memory_class: 'semantic', audience: 'model_visible',
    input: { source: 'dv-test' },
    output: { statement: 'the dv reconciliation closes on Thursday', commitment_type: 'engram',
              lifetime: { supersedes: older } }
  }, 'dv supersede'), 'supersession written');
  state.pruneDeadEmbeddings(1000);
  assert.strictEqual(hasVector(older), true,
    'superseded memories stay findable by meaning — "what did I used to believe" is a real question');
});

test('DV-4: a vector whose row is gone entirely is swept as orphaned', () => {
  const ghost = seedEngram('the dv ghost entry that will lose its row');
  state._dbForQuery().prepare('DELETE FROM action_records WHERE id = ?').run(ghost);
  const r = state.pruneDeadEmbeddings(1000);
  assert.ok(r.orphaned >= 1, 'the orphan was found: ' + JSON.stringify(r));
  assert.strictEqual(hasVector(ghost), false, 'and swept');
});

test('DV-5: the collector now takes the vector at the moment it kills (source pin)', () => {
  const fs = require('fs');
  const gc = fs.readFileSync(path.join(ROOT, 'shared-core', 'engram-gc.js'), 'utf8');
  const at = gc.indexOf("commitment_type: 'engram_tombstoned'");
  assert.ok(at > 0, 'the tombstone writer is here');
  assert.ok(/state\.deleteEmbedding\(rec\.id\)/.test(gc),
    'and it drops the vector with it, so the backlog cannot rebuild');
  const worker = fs.readFileSync(path.join(ROOT, 'shared-core', 'background-worker.js'), 'utf8');
  assert.ok(/pruneDeadEmbeddings\(5000\)/.test(worker),
    'while the daily prune clears what earlier runs left behind');
});
};
