// SPDX-License-Identifier: AGPL-3.0-only
// A memory comes back the size it went in.
//
// All three recall arms clipped every returned statement to 600 characters —
// a prompt budget applied at the data layer, in place from 2026-06-08 to
// 2026-08-14. Every consumer that spends context already clips at its own
// edge (the injector to its block sizes, the voice prefix to its session
// budget, the reranker to its input slice), so the cap protected nothing —
// but the two surfaces that pass text through untouched inherited it: the
// recall tool handed the model amputated memories, and the dashboard search
// showed the same cut. The day it was caught, an operator's open-items list
// came back ending mid-item and the full text was only reachable by fetching
// the raw record by id.
//
// The cap also degraded dedup: hits are deduplicated on normalized statement
// text, so two DISTINCT memories sharing a 600-character prefix collapsed
// into one — the same false-duplicate defect a 200-character slice had
// caused before, one size up.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const engram = require(path.join(ROOT, 'shared-core', 'engram.js'));
const recall = require(path.join(ROOT, 'shared-core', 'recall.js'));

console.log('\nRecall carries statements whole (WHOLE):');

const NONCE = 'zq' + Date.now().toString(36);
const CTX = { agent_id: 'suite-51', user_id: 'default' };

function longStatement(tailToken) {
  // Well past the old cap before the tail token appears.
  let s = 'The ' + NONCE + ' migration plan settles the store question: ';
  while (s.length < 700) s += 'each store is named by identity and adopted across renames; ';
  return s + 'FINAL-' + tailToken;
}

test('WHOLE-1: a statement longer than the old cap survives recall intact', async () => {
  const body = longStatement('INTACT');
  const id = engram.recordEngram({
    agent_id: CTX.agent_id, user_id: CTX.user_id, cwd: null,
    statement: body, source: 'suite-51',
    source_authority: 'llm_inferred', auto_verify: false
  });
  assert.ok(id, 'seed engram persisted');
  const hits = await recall.recall({ query: NONCE + ' migration plan store', class: 'all', audience: 'model_visible', cwd: null, limit: 10 });
  const mine = hits.find(h => String(h.statement || '').indexOf(NONCE) !== -1);
  assert.ok(mine, 'the engram surfaces for its own vocabulary');
  assert.ok(mine.statement.length > 600,
    'and it comes back longer than the old cap: ' + mine.statement.length);
  assert.ok(/FINAL-INTACT$/.test(mine.statement),
    'down to its last word — the part past 600 chars is the part that used to vanish');
});

test('WHOLE-2: two distinct memories sharing a long prefix are not one memory', async () => {
  // The dedup regression the cap caused: identical first 600 chars, different
  // conclusions. Under the cap these normalized to the same text and the
  // second was dropped as a duplicate.
  for (const tail of ['ALPHA-ROAD', 'BETA-ROAD']) {
    assert.ok(engram.recordEngram({
      agent_id: CTX.agent_id, user_id: CTX.user_id, cwd: null,
      statement: longStatement(tail), source: 'suite-51',
      source_authority: 'llm_inferred', auto_verify: false
    }), 'seeded ' + tail);
  }
  const hits = await recall.recall({ query: NONCE + ' migration plan store', class: 'all', audience: 'model_visible', cwd: null, limit: 12 });
  const tails = hits.map(h => (String(h.statement).match(/FINAL-([A-Z-]+)$/) || [])[1]).filter(Boolean);
  assert.ok(tails.includes('ALPHA-ROAD') && tails.includes('BETA-ROAD'),
    'both survive dedup because they really differ: ' + JSON.stringify(tails));
});

test('WHOLE-3: the budgets live at the edges that spend (source pins)', () => {
  const fs = require('fs');
  const rc = fs.readFileSync(path.join(ROOT, 'shared-core', 'recall.js'), 'utf8');
  assert.ok(!/slice\(0, 600\)/.test(rc), 'the data layer no longer clips what it returns');
  assert.ok(/slice\(0, 1200\)/.test(rc), 'the reranker keeps its own input slice — that budget is its');
  const inj = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'injector.mjs'), 'utf8');
  assert.ok(/statement[^\n]*slice\(0, (120|200)\)/.test(inj),
    'the injector clips to its block sizes at its own edge');
  const voice = fs.readFileSync(path.join(ROOT, 'bin', 'troth-entity.js'), 'utf8');
  assert.ok(/SESSION_CHAR_BUDGET/.test(voice),
    'the voice prefix keeps its session budget');
});

test('WHOLE-4: the model-facing edge budgets honestly — clipped says so, with a road back', () => {
  // The critical-examination pass on this very fix: removing the data-layer
  // cap was right, but the MCP recall road then passed statements to the
  // model UNBOUNDED — measured over 52,833 recallable statements, p99 is
  // 1,202 chars and one outlier reaches 10,555, so a limit-50 recall on a
  // bad day meant ~33k tokens of tail in the window. The edge now clips at
  // 2,000 (p99 plus two-thirds headroom) and, unlike the old cap, it is
  // neither silent nor a dead end: the item carries truncated:true and its
  // id, one troth_fetch_action away from the whole text.
  const fs = require('fs');
  const srv = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs'), 'utf8');
  assert.ok(/STATEMENT_EDGE_CHARS = 2000/.test(srv), 'one named budget, chosen from the measured distribution');
  assert.ok(/truncated: true/.test(srv), 'a clipped statement says it was clipped');
  assert.strictEqual((srv.match(/statement: i\.statement/g) || []).length, 0,
    'no raw statement pass-through remains on the model-facing edge');
  assert.ok((srv.match(/edgeStatement\(/g) || []).length >= 5,
    'every statement map goes through the one edge function');
});
};
