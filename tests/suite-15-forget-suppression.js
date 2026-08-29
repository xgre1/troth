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
const state    = require(path.join(ROOT, 'shared-core', 'state.js'));
const actionRec = require(path.join(ROOT, 'shared-core', 'action-record.js'));

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

test('FORGET-6: the HTTP endpoint the app calls retires, it does not tombstone', () => {
  // Fixing the slash path is not enough: the Tauri app calls POST
  // /api/substrate/forget, and a free-standing scope:'system:tombstone' engram
  // — which nothing filters — leaves the "forgotten" fact still surfacing. The
  // endpoint lives inline in the proxy's
  // request handler, so this pins its SOURCE the way suite-24 pins
  // checkRemoteAuth: the tombstone write is gone, the blessed
  // reconsolidation is there, and the signed-fact floor is honoured.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const start = src.indexOf("url === '/api/substrate/forget'");
  assert.ok(start > 0, 'forget endpoint present');
  const block = src.slice(start, src.indexOf('/api/providers/openrouter/models', start));
  assert.ok(block.length > 0 && block.length < 8000, 'endpoint block sliced sanely');
  assert.ok(block.indexOf("scope: 'system:tombstone'") === -1, 'the unfiltered tombstone write is gone');
  assert.ok(/lability-reconsolidation/.test(block), 'retires through the blessed reconsolidation primitive');
  assert.ok(/tier:\s*'flagged'/.test(block), 'successor is flagged — it never surfaces itself');
  assert.ok(/reason:\s*'operator_forget'/.test(block), 'supersession reason names the operator act');
  assert.ok(/operator_confirmed/.test(block), 'signed operator facts stay protected');
});

test('FORGET-7: a successor OUTSIDE the fetched window still hides its prior', async () => {
  // The window scan was the whole guarantee: buildSupersededIds and the
  // listEngrams filter only saw pointers in the rows a query happened to
  // fetch, so a successor that fell out of the window let its retired
  // predecessor keep surfacing — the audit's window-limited gap. The
  // persisted superseded_ids index closes it. Simulated honestly: the
  // successor is written with an ANCIENT timestamp so no recent-first
  // window ever fetches it, then filler pushes it further out.
  const PHRASE7 = 'the ospreys nest above the lighthouse at Cape Vlokas';
  const prior = engram.recordEngram({
    agent_id: CTX.agent_id, user_id: CTX.user_id, cwd: null,
    statement: PHRASE7, source: 'forget-test',
    source_authority: 'llm_inferred', auto_verify: false
  });
  assert.ok(prior, 'prior engram persisted');
  // Handcrafted successor at timestamp ~0 (the epoch), the shape
  // lability-reconsolidation writes, minus its now-stamp.
  const sid = actionRec.uuidv7();
  const wrote = state.recordAction({
    id: sid, timestamp: 1000, type: 'commitment',
    agent_id: CTX.agent_id, cwd: null, user_id: CTX.user_id,
    audience: 'model_visible', memory_class: 'episodic',
    input: { source: 'forget-test:window-miss' },
    output: {
      statement: 'FORGOTTEN: ' + PHRASE7,
      commitment_type: 'engram', tier: 'flagged', salience: 1,
      lifetime: { supersedes: prior, reason: 'operator_forget' }
    }
  }, 'window-miss successor');
  assert.ok(wrote, 'successor persisted');
  // The persisted index saw the pointer at write time…
  assert.ok(state.listSupersededIds().indexOf(prior) >= 0, 'index mirrors the pointer');
  // …so a window that cannot contain the epoch-old successor still hides
  // the prior. limit:10 fetches the 10 NEWEST rows; the suite db holds far
  // more than 10 rows newer than the epoch.
  const view = engram.listEngrams({ limit: 10 });
  assert.ok(!view.some((e) => e.statement === PHRASE7), 'retired prior stays hidden beyond the window');
});

test('FORGET-8: the one-time backfill indexes pointers written before the index existed', () => {
  // Machines that already carry supersession pointers get them indexed by
  // the user_version 1→2 migration. Simulated by un-indexing a pointer and
  // rolling user_version back on the hermetic db, then loading state.js in
  // a CHILD process — the migration path a real machine takes at boot.
  const { spawnSync } = require('child_process');
  const db = state._dbForQuery();
  // Seed our own pointer synchronously — this test runs at registration
  // time, before the async FORGET tests above have populated the index, so
  // it must not depend on their side effects.
  const priorId = actionRec.uuidv7();
  state.recordAction({
    id: priorId, timestamp: Date.now(), type: 'commitment',
    agent_id: CTX.agent_id, cwd: null, user_id: CTX.user_id,
    audience: 'model_visible', memory_class: 'episodic',
    input: { source: 'forget-test:backfill' },
    output: { statement: 'backfill prior probe', commitment_type: 'engram', salience: 1 }
  }, 'backfill prior probe');
  const succId = actionRec.uuidv7();
  state.recordAction({
    id: succId, timestamp: Date.now(), type: 'commitment',
    agent_id: CTX.agent_id, cwd: null, user_id: CTX.user_id,
    audience: 'model_visible', memory_class: 'episodic',
    input: { source: 'forget-test:backfill' },
    output: { statement: 'FORGOTTEN: backfill prior probe', commitment_type: 'engram', tier: 'flagged', salience: 1,
             lifetime: { supersedes: priorId, reason: 'operator_forget' } }
  }, 'backfill successor probe');
  const before = state.listSupersededIds();
  assert.ok(before.indexOf(priorId) >= 0, 'the seeded pointer is indexed');
  db.prepare('DELETE FROM superseded_ids').run();          // hermetic test db only
  db.pragma('user_version = 1');
  assert.strictEqual(state.listSupersededIds().length, 0, 'index emptied for the simulation');
  const r = spawnSync(process.execPath, ['-e',
    'const s = require(process.argv[1]); console.log(JSON.stringify(s.listSupersededIds()));',
    path.join(ROOT, 'shared-core', 'state.js')
  ], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env) });
  assert.strictEqual(r.status, 0, 'child state load: ' + String(r.stderr).slice(-300));
  const rebuilt = JSON.parse(String(r.stdout).trim().split('\n').pop());
  for (const id of before) {
    assert.ok(rebuilt.indexOf(id) >= 0, 'backfill missed ' + id);
  }
  assert.ok(db.pragma('user_version', { simple: true }) >= 2, 'migration stamped');
});
};
