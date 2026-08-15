// SPDX-License-Identifier: AGPL-3.0-only
// The mind answers its own memory questions.
//
// P7.3: a memory-shaped user turn whose recall is confident is answered by
// the substrate directly — respond_directly, no language faculty summoned.
// The engine stays pure: the runtime attaches pre-fetched recall to the
// event, and the rule judges confidence STRUCTURALLY (top hit dominates its
// runner-up ≥1.5×, and is lexically grounded in the question) because
// per-class recall scores share no calibrated scale — a numeric threshold
// over them would be pseudo-precision. Below confidence the turn falls to
// the llm road, which mounts the same memories as context: the fallback
// loses nothing, so the gate can afford to be strict.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const engine = require(path.join(ROOT, 'shared-core', 'decision-engine.js'));
const shaped = require(path.join(ROOT, 'shared-core', 'memory-shaped.js'));

console.log('\nMemory dispatch (MDS):');

const decide = engine.makeEngine();
const VIEW = { mind: { active_projects: [] } };
const ask = (text, hits) => decide(VIEW, {
  type: 'user_input',
  input: { text },
  recall: hits ? { hits } : undefined
});

const STRONG = { statement: 'The schema decision: keep engram statements as templated text, scope decision:*', score: 10, class: 'semantic', source: 'engram' };
const WEAK   = { statement: 'Unrelated bookkeeping row', score: 2, class: 'episodic', source: 'dialogue' };

test('MDS-1: the classifier lives once — both consumers import the same shape (source pins)', () => {
  const rf = fs.readFileSync(path.join(ROOT, 'proxy', 'modules', 'recallforce.js'), 'utf8');
  assert.ok(/require\('\.\.\/\.\.\/shared-core\/memory-shaped\.js'\)/.test(rf),
    'recallforce imports the shared classifier');
  assert.ok(!/MEMORY_PATTERNS = \[/.test(rf), 'and keeps no pattern list of its own — two lists drift');
  const de = fs.readFileSync(path.join(ROOT, 'shared-core', 'decision-engine.js'), 'utf8');
  assert.ok(/require\('\.\/memory-shaped\.js'\)/.test(de), 'the engine consumes the same classifier');
  const rfMod = require(path.join(ROOT, 'proxy', 'modules', 'recallforce.js'));
  assert.strictEqual(rfMod.isMemoryShaped, shaped.isMemoryShaped, 'the re-export IS the shared function, not a copy');
});

test('MDS-2: a confident recall answers directly — the mind speaks, no faculty summoned', () => {
  const a = ask('what did we decide about the schema?', [STRONG, WEAK]);
  assert.strictEqual(a.kind, 'respond_directly', a._rule);
  assert.strictEqual(a.reason, 'memory_dispatch');
  assert.ok(a.text.indexOf(STRONG.statement) === 0, 'the statement is the answer');
  assert.ok(a.text.indexOf('recalled from substrate (semantic)') !== -1,
    'with its provenance named — a direct answer never hides where it came from');
});

test('MDS-3: every confidence gate falls through to the llm road, never to silence', () => {
  const noDominance = ask('what did we decide about the schema?', [
    { ...STRONG, score: 10 }, { ...STRONG, statement: 'A rival schema decision statement', score: 9 }
  ]);
  assert.strictEqual(noDominance.kind, 'llm', 'a contested top hit is not confidence');
  const noGrounding = ask('what did we decide about the schema?', [
    { statement: 'Totally unrelated fact touching nothing relevant', score: 10, class: 'semantic' }
  ]);
  assert.strictEqual(noGrounding.kind, 'llm', 'an ungrounded hit is not confidence');
  const noRecall = ask('what did we decide about the schema?');
  assert.strictEqual(noRecall.kind, 'llm', 'no recall attached — the runtime road decides, the rule stays silent');
  const notMemory = ask('please refactor the schema module', [STRONG, WEAK]);
  assert.strictEqual(notMemory.kind, 'llm', 'a work instruction is never intercepted, whatever recall rode in');
});

test('MDS-4: the runtime attaches recall before deciding, fail-open (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'troth-entity.js'), 'utf8');
  assert.ok(/memory-shaped\.js/.test(src) && /isMemoryShaped\(event\.input\.text\)/.test(src),
    'the daemon gates the extra recall on the memory shape — no new I/O for ordinary turns');
  assert.ok(/recall is a gift, never a gate/.test(src),
    'and recall failure drops the attachment instead of the turn');
});

test('MDS-5: queryOverlap is scale-free and honest at its edges', () => {
  assert.strictEqual(shaped.queryOverlap('', 'anything'), 0, 'no query tokens, no confidence');
  assert.strictEqual(shaped.queryOverlap('schema decision', 'the schema decision holds'), 1);
  assert.ok(shaped.queryOverlap('τι είχαμε πει για το schema', 'schema: κρατάμε ό,τι είχαμε πει') > 0,
    'Greek tokens ground Greek questions');
});
};
