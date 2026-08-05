// SPDX-License-Identifier: AGPL-3.0-only
// Verify B3+B4+B5+B7 against live state.db with proper isolation:
//   - Every test row tagged with TAG (random per run) so we can find + clean up.
//   - Delta-based assertions (count_before vs count_after) for PLR.
//   - Unique-token queries so only test rows match.
const assert = require('assert');
const engram = require('../shared-core/engram.js');
const state  = require('../shared-core/state.js');
const recall = require('../shared-core/recall.js');

const TAG = 'vbtag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let pass = 0, fail = 0;
const createdIds = [];

function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ': ' + (e.message || e)); fail++; }
}
function rec(opts) {
  const id = engram.recordEngram({ ...opts, auto_verify: false });
  if (id) createdIds.push(id);
  return id;
}

(async () => {
console.log('TAG=' + TAG);

console.log('\n=== B5: orchestration scope → substrate_internal+operational ===');
const roleId     = rec({ agent_id: 'verifier', statement: TAG + ' role engram', scope: 'role:backend:group:abc' });
const progressId = rec({ agent_id: 'verifier', statement: TAG + ' progress engram', scope: 'progress:role:qa:group:def' });
const completeId = rec({ agent_id: 'verifier', statement: TAG + ' complete engram', scope: 'complete:role:frontend:group:ghi' });
const regularId  = rec({ agent_id: 'verifier', statement: TAG + ' regular engram' });
const rows = state.queryActions({ type: 'commitment', limit: 50, order: 'desc' });
const find = (id) => rows.find(r => r.id === id);
check('role:* → audience=substrate_internal',     () => assert.strictEqual(find(roleId).audience, 'substrate_internal'));
check('role:* → memory_class=operational',        () => assert.strictEqual(find(roleId).memory_class, 'operational'));
check('progress:role:* → substrate_internal',     () => assert.strictEqual(find(progressId).audience, 'substrate_internal'));
check('complete:role:* → substrate_internal',     () => assert.strictEqual(find(completeId).audience, 'substrate_internal'));
check('no-scope → model_visible+episodic',        () => { const r = find(regularId); assert.strictEqual(r.audience, 'model_visible'); assert.strictEqual(r.memory_class, 'episodic'); });

console.log('\n=== B5: recall model_visible filters out substrate_internal ===');
const hits = recall.recall({ query: TAG, class: 'all', audience: 'model_visible', limit: 20 });
const surf = new Set(hits.map(h => h.id));
check('role:* NOT in model_visible recall',       () => assert.ok(!surf.has(roleId), 'role leaked'));
check('progress:* NOT in model_visible recall',   () => assert.ok(!surf.has(progressId), 'progress leaked'));
check('complete:* NOT in model_visible recall',   () => assert.ok(!surf.has(completeId), 'complete leaked'));
check('regular DOES surface in model_visible',    () => assert.ok(surf.has(regularId), 'regular missing — hits=' + JSON.stringify(hits.map(h => ({id:h.id, score:h.score, stmt:h.statement.slice(0,40)})))));

console.log('\n=== B3: auditEngramsByAgent + alias ===');
check('auditEngramsByAgent exported',             () => assert.strictEqual(typeof engram.auditEngramsByAgent, 'function'));
check('listAgentsWithEngrams === alias',          () => assert.strictEqual(engram.listAgentsWithEngrams, engram.auditEngramsByAgent));

console.log('\n=== B4: handoff:* scope auto-derivation ===');
const today = new Date().toISOString().slice(0, 10);
const handoffId = rec({ agent_id: 'claude-code', statement: TAG + ' handoff memo', scope: 'handoff:' + today + ':' + TAG });
const hRow = state.queryActions({ type: 'commitment', limit: 50, order: 'desc' }).find(r => r.id === handoffId);
check('handoff:* → substrate_internal',           () => assert.strictEqual(hRow.audience, 'substrate_internal'));
check('handoff:* → operational',                  () => assert.strictEqual(hRow.memory_class, 'operational'));
check('handoff:* NOT in model_visible recall',    () => { const h = recall.recall({ query: TAG, class: 'all', audience: 'model_visible', limit: 20 }); assert.ok(!h.some(r => r.id === handoffId)); });
check('handoff retrievable by exact scope',       () => { const d = engram.listEngrams({ scope: 'handoff:' + today + ':' + TAG, audience: 'all', limit: 10 }); assert.ok(d.some(e => e.id === handoffId)); });

console.log('\n=== A1: internal:* audience filter ===');
const internalId = rec({ agent_id: 'verifier', statement: TAG + ' internal note', scope: 'internal:test' });
check('internal:* → substrate_internal',          () => { const r = state.queryActions({ type: 'commitment', limit: 50, order: 'desc' }).find(rr => rr.id === internalId); assert.strictEqual(r.audience, 'substrate_internal'); });
check('internal:* invisible to model_visible',    () => { const h = recall.recall({ query: TAG, class: 'all', audience: 'model_visible', limit: 20 }); assert.ok(!h.some(r => r.id === internalId)); });

console.log('\n=== A8: soft cwd ranking (no hard SQL partition) ===');
const cwdA = rec({ agent_id: 'verifier', cwd: '/tmp/projA-' + TAG, statement: TAG + ' cwd-A row uniqlabel' });
const cwdB = rec({ agent_id: 'verifier', cwd: '/tmp/projB-' + TAG, statement: TAG + ' cwd-B row uniqlabel' });
const fromA = recall.recall({ query: TAG + ' uniqlabel', class: 'all', audience: 'model_visible', cwd: '/tmp/projA-' + TAG, limit: 5 });
const ids = new Set(fromA.map(r => r.id));
check('A8: both cwd rows reachable from cwd=A',   () => assert.ok(ids.has(cwdA) && ids.has(cwdB), 'partition leak — got: ' + JSON.stringify(fromA.map(r => ({id:r.id, score:r.score, cls:r.class})))));

console.log('\n=== B7: PLR triggers — delta-based ===');
const countRetrievals = () => state.queryActions({ type: 'decision', limit: 200, order: 'desc' }).filter(r => { try { return JSON.parse(r.input).kind === 'engram_retrieval'; } catch (_) { return false; } }).length;
const before = countRetrievals();
await engram.retrieveRelevant({ query: TAG + ' uniqlabel', k: 5 });
const afterFirst = countRetrievals();
await engram.retrieveRelevant({ query: TAG + ' uniqlabel', k: 5 });
const afterSecond = countRetrievals();
const delta1 = afterFirst - before;
const delta2 = afterSecond - afterFirst;
check('B7 first retrieve: delta ≤ top-K=3',       () => assert.ok(delta1 <= 3, 'delta1=' + delta1));
check('B7 second retrieve refractory (delta=0)',  () => assert.strictEqual(delta2, 0, 'refractory failed delta2=' + delta2));

// Cleanup all rows tagged with TAG
console.log('\n=== Cleanup ===');
const sqlite3 = require('better-sqlite3');
const dbPath = process.env.TROTH_STATE_PATH || require('path').join(require('os').homedir(), '.troth', 'state.db');
const db = sqlite3(dbPath);
const result = db.prepare("DELETE FROM action_records WHERE output LIKE ?").run('%' + TAG + '%');
db.close();
console.log('  Deleted ' + result.changes + ' tagged rows');

console.log('\n=== Results: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
})();
