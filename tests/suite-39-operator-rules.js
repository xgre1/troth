// SPDX-License-Identifier: AGPL-3.0-only
// Rules the operator gave, kept the way facts are kept.
//
// Measured 2026-08-11: the substrate held 5,143 rows of type='lesson' and not
// one came from a person — 3,785 curriculum import, 886 fidelity warnings,
// 281 error tax, 122 critic. `state.recordOperatorLesson` existed with ZERO
// callers and appeared in neither tool registry, so everything the operator
// ever said about HOW to work lived in conversation only and died with the
// window.
//
// Two traps this pins, both of which produced a rule that was written and
// could never be read:
//
//   actionRecord.create() DROPS memory_class and audience (verified: they are
//   absent from the object it returns), and recordAction fail-closes to
//   operational/substrate_internal — which recall filters out. 1,150 of the
//   machine-written lessons on this substrate are unreadable for exactly this
//   reason.
//
//   A rule with no vector is invisible to the dense arm until the next
//   background drain. Written and asked about in the same minute, it came
//   back with nothing — which reads as "it forgot", the one thing a memory
//   must never do.
module.exports = function run({ test }) {
const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const lesson = require(path.join(ROOT, 'shared-core', 'lesson.js'));
const state  = require(path.join(ROOT, 'shared-core', 'state.js'));
const recall = require(path.join(ROOT, 'shared-core', 'recall.js'));

console.log('\nOperator rules (RULE):');

const embedderUp = () => {
  try { return !!require(path.join(ROOT, 'shared-core', 'local-embedder.js')).isAvailable(); }
  catch (_) { return false; }
};

const R1 = 'never darken the rulesuite lighthouse without the keeper signing off first';
const R1_PARAPHRASE = 'do not leave the rulesuite lighthouse dark unless the keeper has signed off';
const R2 = 'always re-measure the rulesuite tide table before quoting a departure time';

test('RULE-1: a rule is written recallable — the class and audience recall filters on', async () => {
  const r = await lesson.recordRule({ text: R1, why: 'a keeperless dark night stranded two boats' });
  assert.ok(r && r.ok, 'the write reports success: ' + JSON.stringify(r));
  assert.ok(r.id, 'and names the row');
  const row = state.getAction(r.id);
  assert.ok(row, 'the row exists');
  assert.strictEqual(row.memory_class, 'semantic',
    'memory_class survived create() dropping it — otherwise recall never sees this');
  assert.strictEqual(row.audience, 'model_visible',
    'audience survived too — the fail-closed default would have hidden it');
});

test('RULE-2: it carries a vector at write time, not after the next drain', async function () {
  if (!embedderUp()) return; // no embedder on this machine: nothing to assert
  const r = await lesson.recordRule({ text: R2 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.embedded, true, 'the write embedded it: ' + JSON.stringify(r));
  const v = state.getEmbedding(r.id);
  assert.ok(v && v.length > 0, 'and the vector is on disk immediately');
});

test('RULE-3: a verbatim restatement does not double the shelf', async () => {
  const before = lesson.listRules({ limit: 100 }).length;
  const r = await lesson.recordRule({ text: R1, confirm: true });
  assert.ok(r.ok, 'it succeeds rather than erroring at the operator: ' + JSON.stringify(r));
  assert.strictEqual(r.duplicate, true, 'and says it already held this one');
  assert.strictEqual(lesson.listRules({ limit: 100 }).length, before, 'the shelf did not grow');
});

test('RULE-4: a near-miss is HANDED BACK, never silently written or silently dropped', async function () {
  if (!embedderUp()) return;
  const before = lesson.listRules({ limit: 100 }).length;
  const r = await lesson.recordRule({ text: R1_PARAPHRASE });
  assert.strictEqual(r.ok, false, 'it did not write on its own: ' + JSON.stringify(r));
  assert.strictEqual(r.error, 'similar_rules_exist', JSON.stringify(r));
  assert.ok(Array.isArray(r.similar) && r.similar.length, 'and shows what it already holds');
  assert.ok(/ask the operator/i.test(String(r.detail)), 'and says to ask when it is ambiguous: ' + r.detail);
  assert.strictEqual(lesson.listRules({ limit: 100 }).length, before, 'nothing was added behind the caller');
  const forced = await lesson.recordRule({ text: R1_PARAPHRASE, confirm: true });
  assert.ok(forced.ok && !forced.duplicate, 'and a caller who means it can still add it: ' + JSON.stringify(forced));
});

test('RULE-5: junk is refused before it reaches the shelf', async () => {
  assert.strictEqual((await lesson.recordRule({ text: '' })).error, 'empty_rule');
  assert.strictEqual((await lesson.recordRule({ text: 'ok' })).error, 'too_short');
});

test('RULE-6: reading the rules never consumes them (the lesson pull does)', async () => {
  // Seeds its own rule: sync test bodies run at declaration time, before the
  // async ones above have written anything, so depending on their rows made
  // this pass or fail on ordering rather than on behaviour.
  await lesson.recordRule({ text: 'log every rulesuite harbour departure in the ledger the same day', confirm: true });
  const first  = lesson.listRules({ limit: 100 }).map((r) => r.id);
  const second = lesson.listRules({ limit: 100 }).map((r) => r.id);
  assert.ok(first.length > 0, 'there are rules to read');
  assert.deepStrictEqual(second, first, 'a second read returns the same rules');
});

test('RULE-7: a rule comes back through ORDINARY recall, by meaning', async function () {
  if (!embedderUp()) return;
  const hits = await recall.recall({
    query: 'may we leave the rulesuite lighthouse unlit tonight',
    class: 'all', audience: 'model_visible', limit: 5, cwd: null, rerank: false
  });
  const items = (hits && (hits.items || hits.results || hits)) || [];
  assert.ok(items.some((h) => /rulesuite lighthouse/.test(String(h.statement || ''))),
    'the rule is reachable on the same road as every other memory: ' +
    JSON.stringify(items.slice(0, 3).map((h) => String(h.statement || '').slice(0, 40))));
});

test('RULE-8: BOTH registries expose the road, and they share one implementation', () => {
  const fs = require('fs');
  const reg = require(path.join(ROOT, 'shared-core', 'substrate-tools.js')).REGISTRY;
  assert.ok(reg.rule_record && typeof reg.rule_record.run === 'function', 'the entity daemon can write a rule');
  assert.ok(reg.rule_list   && typeof reg.rule_list.run   === 'function', 'and read them');

  const mcp = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs'), 'utf8');
  assert.ok(/troth_rule_record:/.test(mcp), 'the MCP surface can write a rule');
  assert.ok(/troth_rule_list:/.test(mcp),   'and read them');

  // One implementation, for the reason the forget handler has one: two copies
  // of the same rule drift, and the half that drifts is the untested half.
  const st = fs.readFileSync(path.join(ROOT, 'shared-core', 'substrate-tools.js'), 'utf8');
  assert.ok(/require\('\.\/lesson\.js'\)/.test(st), 'the daemon road calls the shared module');
  assert.ok(/shared-core\/lesson\.js/.test(mcp),    'and so does the MCP road');
});

test('RULE-9: /save can reach the tools and no longer caps the save at five', () => {
  const fs = require('fs');
  const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'save', 'SKILL.md'), 'utf8');
  assert.ok(/allowed-tools:.*rule_record/.test(skill), 'the skill may write rules');
  assert.ok(/allowed-tools:.*rule_list/.test(skill),   'and read what is already held');
  assert.ok(!/1[–-]5 facts/.test(skill), 'the arbitrary cap is gone');
  assert.ok(/no target number/i.test(skill), 'and says so in words');
  assert.ok(/ask (the operator|which they meant)/i.test(skill), 'and tells the model to ask when a rule is ambiguous');
  // The retrospective: one observation about how the work went, because a
  // session's shape (what had to be corrected, what was insisted on) is
  // invisible to both the fact list and the rule list, and it is the part
  // that makes the next session better.
  assert.ok(/working-relationship:/.test(skill), 'the save writes one conclusion about the work itself');
  assert.ok(/observation, never a rule/i.test(skill),
    'and is told not to promote its reading of the operator\'s mood into a standing rule');
});

test('RULE-10: a rule scoped to one project does not answer in another', async () => {
  // Measured 2026-08-11 before the fix: listRules honoured the scope but
  // recall did not, so a rule written in one repo came back while working in
  // a different one. The listing road is the road a person walks; recall is
  // the road the partner walks on its own, and that is the one that matters.
  const A = '/tmp/rulesuite-alpha';
  const B = '/tmp/rulesuite-beta';
  const HERE  = 'in the rulesuite alpha repo the harbour manifests are filed by hand, never by the nightly job';
  const ANY   = 'always re-read the rulesuite manifest before filing it anywhere';
  assert.ok((await lesson.recordRule({ text: HERE, scope: 'project', cwd: A, confirm: true })).ok, 'project rule written');
  assert.ok((await lesson.recordRule({ text: ANY,  scope: 'global',  confirm: true })).ok, 'global rule written');

  // The listing road.
  assert.ok(lesson.listRules({ limit: 100, cwd: A }).some((r) => r.text === HERE), 'its own project lists it');
  assert.ok(!lesson.listRules({ limit: 100, cwd: B }).some((r) => r.text === HERE), 'another project does not');

  // The road the partner walks.
  const ask = async (cwd) => {
    const hits = await recall.recall({
      query: 'how do we file the rulesuite harbour manifests here',
      class: 'all', audience: 'model_visible', limit: 5, cwd, rerank: false
    });
    const items = (hits && (hits.items || hits.results || hits)) || [];
    return items.map((h) => String(h.statement || ''));
  };
  const inA = await ask(A);
  const inB = await ask(B);
  assert.ok(inA.some((s) => s === HERE), 'recall returns it in its own project: ' + JSON.stringify(inA.slice(0, 2)));
  assert.ok(!inB.some((s) => s === HERE), 'and never in another: ' + JSON.stringify(inB.slice(0, 3)));
  assert.ok(!(await ask(null)).some((s) => s === HERE), 'nor when the question belongs to no project');
});
};
