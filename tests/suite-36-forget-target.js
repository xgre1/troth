// SPDX-License-Identifier: AGPL-3.0-only
// /forget retires the row you MEANT, not one that reads like it.
//
// Measured on a live substrate 2026-08-10: clicking Forget in the dashboard
// retired a DIFFERENT memory in 5 of 6 attempts. The dashboard listed rows by
// id, then threw the id away and sent the statement text; the handler re-found
// its own target with retrieveRelevant(commitment_only) — whose candidate
// window is the newest 200 engrams — so anything older resolved to whichever
// recent row shared the most words. Clicking "the user prefers tabs over
// spaces" would have retired a security note.
//
// These pin the cure: identity travels with the click, the protection floor
// still holds on that road, non-engram rows are refused rather than mangled,
// and the CLI's text road (no id to travel with) keeps working.
module.exports = function run({ test }) {
const assert   = require('assert');
const path     = require('path');
const ROOT     = path.join(__dirname, '..');
const engram   = require(path.join(ROOT, 'shared-core', 'engram.js'));
const executor = require(path.join(ROOT, 'shared-core', 'slash', 'executor.js'));
const state    = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar       = require(path.join(ROOT, 'shared-core', 'action-record.js'));

console.log('\nForget targeting (FTGT):');

const forget = executor.DETERMINISTIC_HANDLERS.forget;
const CTX = { agent_id: 'ftgt-agent', user_id: 'operator', cwd: null };

// Two engrams whose text overlaps heavily on purpose: a lookup by words is
// free to confuse them, a lookup by id is not.
const KEEP = 'the ftgt harbour ledger is reconciled every Tuesday by the finance desk';
const DROP = 'the ftgt harbour ledger reconciliation moved to Thursday for the finance desk';

const seed = (statement, authority) => {
  const id = engram.recordEngram({
    agent_id: CTX.agent_id, user_id: CTX.user_id, cwd: null,
    statement, source: 'ftgt-test',
    source_authority: authority || 'llm_inferred', auto_verify: false
  });
  assert.ok(id, 'seeded: ' + statement.slice(0, 40));
  return id;
};
const isRetired = (id) => {
  const row = state.getAction(id);
  if (!row) return false;
  let out; try { out = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); } catch (_) { out = {}; }
  // The superseder carries the original text under a FORGOTTEN: marker; the
  // original itself is untouched, so "retired" means a successor points here.
  const d = state._dbForQuery();
  const n = d.prepare(
    "SELECT COUNT(*) AS n FROM action_records WHERE json_extract(output,'$.statement') = ?"
  ).get('FORGOTTEN: ' + String(out.statement || '')).n;
  return n > 0;
};

test('FTGT-1: forgetting BY ID retires that exact row and leaves its lookalike alone', async () => {
  const keepId = seed(KEEP);
  const dropId = seed(DROP);
  const r = await forget({ target_id: dropId, raw_args: '', args_array: [] }, CTX);
  assert.ok(r && r.ok, 'the id road retired something: ' + JSON.stringify(r));
  assert.strictEqual(r.side_effects.forgot_id, dropId, 'and it retired the row we named');
  assert.strictEqual(isRetired(dropId), true, 'the named row is retired');
  assert.strictEqual(isRetired(keepId), false, 'its near-identical neighbour is untouched');
});

test('FTGT-2: the id road still refuses a signed operator fact', async () => {
  // recordEngram will not mint an operator_confirmed fact without a signature
  // (the floor holds a level above this), so the row is written directly to
  // stand in for one that WAS properly signed.
  const signedId = ar.uuidv7();
  assert.ok(state.recordAction({
    id: signedId, timestamp: Date.now(), type: 'commitment', agent_id: CTX.agent_id,
    user_id: CTX.user_id, cwd: null, memory_class: 'semantic', audience: 'model_visible',
    input: { source: 'ftgt-test' },
    output: { statement: 'the ftgt vault combination must not be retired', commitment_type: 'engram',
              salience: 1, source_authority: 'operator_confirmed' }
  }, 'ftgt vault'), 'seeded a signed fact');
  const r = await forget({ target_id: signedId, raw_args: '', args_array: [] }, CTX);
  assert.strictEqual(r.ok, false, 'refused');
  assert.strictEqual(r.error, 'protected', 'with the protection reason: ' + JSON.stringify(r));
  assert.strictEqual(isRetired(signedId), false, 'and nothing was written');
});

test('FTGT-3: a row that is not a commitment engram is refused, never mangled', async () => {
  const id = ar.uuidv7();
  const wrote = state.recordAction({
    id, timestamp: Date.now(), type: 'tool_call', agent_id: CTX.agent_id,
    user_id: CTX.user_id, cwd: null, memory_class: 'episodic', audience: 'model_visible',
    input: { tool_name: 'dialogue.turn', args: { user_text: 'ftgt turn' } },
    output: { assistant_text: 'ftgt reply' }
  }, 'ftgt turn');
  assert.ok(wrote, 'seeded a dialogue turn');
  const r = await forget({ target_id: id, raw_args: '', args_array: [] }, CTX);
  assert.strictEqual(r.ok, false, 'refused');
  assert.strictEqual(r.error, 'not_forgettable', JSON.stringify(r));
});

test('FTGT-4: a missing id is refused rather than silently falling back to text', async () => {
  const r = await forget({ target_id: ar.uuidv7(), raw_args: KEEP, args_array: [KEEP] }, CTX);
  assert.strictEqual(r.ok, false, 'refused');
  assert.strictEqual(r.error, 'target_row_missing', JSON.stringify(r));
});

test('FTGT-5: the CLI text road still works (no id to travel with)', async () => {
  const id = seed('the ftgt lighthouse keeper signs the manifest at dawn');
  const r = await forget({ raw_args: 'ftgt lighthouse keeper manifest dawn', args_array: ['ftgt'] }, CTX);
  assert.ok(r && r.ok, 'text road retired something: ' + JSON.stringify(r));
  assert.strictEqual(isRetired(id), true, 'and it was the one whose words we gave');
});

test('FTGT-6: the proxy hands the id through (source pin)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const at = src.indexOf("name: 'forget', raw_args: stmt");
  assert.ok(at > 0, 'the forget spawn exists');
  assert.ok(/target_id:/.test(src.slice(at, at + 160)), 'and carries target_id: ' + src.slice(at, at + 120));
  const ui = fs.readFileSync(path.join(ROOT, 'proxy', 'ui', 'dashboard.html'), 'utf8');
  assert.ok(/dataset\.mid = it\.id/.test(ui), 'the list stores the row id');
  assert.ok(/forget',\s*\{\s*id:\s*mid/.test(ui), 'and the click sends it');
});
};
