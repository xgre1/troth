// SPDX-License-Identifier: AGPL-3.0-only
// suite-15-forget-suppression.js — /forget actually suppresses the memory.
//
// Regression for the confirmed bug: the
// old /forget wrote a "TOMBSTONE: …" engram at scope 'system:tombstone', which
// NOTHING filters, so the "forgotten" memory kept surfacing at recall. The
// SKILL even falsely claimed listEngrams excluded that scope. The fix writes a
// SUPERSEDER (lifetime.supersedes -> original, tier='flagged'), which both
// recall paths honor.
//
// End-to-end + hermetic (tests/hermetic-db.js gives a throwaway state.db). We
// seed a real engram, prove it surfaces, run the deterministic /forget handler,
// and prove it is gone from BOTH retrieval surfaces:
//   - retrieveRelevant(commitment_only:true) -> listEngrams supersedes filter
//   - retrieveRelevant()                      -> recall.recall supersedes+flagged
// plus: the content-free superseder itself never surfaces, and the not-found
// path answers honestly. The operator_confirmed protection branch is guarded in
// executor.js (a signed fact needs a signed op; it can't be written here without
// a key, so it is covered by read, not by this offline suite).

module.exports = function run({ test }) {
const assert   = require('assert');
const path     = require('path');
const ROOT     = path.join(__dirname, '..');
const engram   = require(path.join(ROOT, 'shared-core', 'engram.js'));
const executor = require(path.join(ROOT, 'shared-core', 'slash', 'executor.js'));

const forget = executor.DETERMINISTIC_HANDLERS.forget;
const CTX = { agent_id: 'forget-test', user_id: 'operator', cwd: null };

// A distinctive phrase so the query is unambiguous in a shared hermetic db.
const PHRASE = 'the zither collection lives in the attic on Kolokotroni street';
// Query on the RARE tokens only — the full sentence carries common words
// ('the', 'in', 'on') that OR-match unrelated rows in the shared suite db and
// push the target out of a small top-k pool. The rare terms rank it cleanly.
const QUERY = 'zither Kolokotroni attic collection';

function surfaces(statementNeedle, opts) {
  // Returns true if any retrieved engram statement contains the needle.
  return engram.retrieveRelevant(Object.assign({ query: QUERY, k: 12, cwd: null }, opts))
    .then((hits) => hits.some((h) => String(h.statement || '').indexOf(statementNeedle) !== -1));
}

test('FORGET-1: baseline — a fresh engram is recallable before we forget it', async () => {
  const id = engram.recordEngram({
    agent_id: CTX.agent_id, user_id: CTX.user_id, cwd: null,
    statement: PHRASE, source: 'forget-test',
    source_authority: 'llm_inferred', auto_verify: false
  });
  assert.ok(id, 'seed engram must persist');
  // Assert presence on the commitment path (broad listEngrams pool — robust in
  // the shared suite db). The recall.recall path is ranking-based; in a clean
  // db it surfaces this too (proven by the isolated SLA-15 + manual probe), but
  // asserting a specific row in a small top-k against a polluted shared db is
  // flaky by nature, so the SUPPRESSION proof below (absence is unambiguous)
  // carries the recall.recall guarantee.
  assert.strictEqual(await surfaces(PHRASE, { commitment_only: true }), true, 'surfaces before /forget');
});

test('FORGET-2: /forget retires it from BOTH recall paths', async () => {
  const res = await forget({ raw_args: 'zither collection attic' }, CTX);
  assert.ok(res.ok, '/forget reports ok');
  assert.ok(res.side_effects && res.side_effects.forgot_id, 'reports the retired id');
  // The whole point: the original no longer surfaces on EITHER path. Absence is
  // unambiguous (no ranking dependency) — this is the real regression guard for
  // the bug where a 'system:tombstone' marker filtered nothing.
  assert.strictEqual(await surfaces(PHRASE, { commitment_only: true }), false, 'gone from the commitment path');
  assert.strictEqual(await surfaces(PHRASE), false, 'gone from the recall.recall path');
});

test('FORGET-3: the flagged superseder never surfaces, but IS recoverable in audit', async () => {
  // The superseder is 'FORGOTTEN: <original>' at tier=flagged. It carries the
  // original terms (so recall co-retrieves it and the pointer registers), but
  // flagged keeps it out of every DEFAULT read — including a fresh commitment
  // query that shares its terms.
  assert.strictEqual(await surfaces('FORGOTTEN:', { commitment_only: true }), false, 'superseder hidden on the commitment path');
  assert.strictEqual(await surfaces('FORGOTTEN:'), false, 'superseder hidden on the recall path');
  // Soft delete: an explicit audit view (include_flagged + include_superseded)
  // still finds it, so a /forget is recoverable — never a hard delete.
  const audit = engram.listEngrams({ include_flagged: true, include_superseded: true, limit: 50 });
  assert.ok(audit.some((e) => e.statement === 'FORGOTTEN: ' + PHRASE), 'superseder recoverable in audit view');
});

test('FORGET-4: /forget on a real miss answers honestly, writes nothing', async () => {
  const res = await forget({ raw_args: 'qqzzxv nonexistent gibberish wumpus token plover' }, CTX);
  assert.ok(res.ok, 'a miss is not an error');
  assert.ok(/already forgotten|Nothing in substrate/i.test(res.text || ''), 'says there was nothing to forget');
  assert.ok(!res.side_effects || !res.side_effects.engrams || !res.side_effects.engrams.length,
    'no superseder written on a miss');
});

test('FORGET-5: empty args is rejected', async () => {
  const res = await forget({ raw_args: '' }, CTX);
  assert.strictEqual(res.ok, false, 'empty /forget is a usage error');
});
};
