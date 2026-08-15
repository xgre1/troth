// SPDX-License-Identifier: AGPL-3.0-only
// Pages the partner read, kept and MARKED.
//
// Measured 2026-08-11: `WebFetch` had **0 records** in the entire substrate.
// Not "unsaved" — unseen: no PostToolUse matcher covered it, so five months of
// arXiv, DeepMind and Google Ads reading left behind only whatever fitted in a
// summary sentence, itself truncated at 8,000 characters with one vector for
// the whole turn.
//
// The design problem this settles is the one that blocked it for a day.
// recall.js audienceOk() is an EXACT match against what the caller asked for
// (default 'model_visible'), so the obvious move — tag fetched text
// 'synthesis_of_external' — does not lower its trust, it removes it from every
// answer. Knowledge that never answers is not knowledge; a stranger's page
// carrying the operator's own weight is worse. So the mark travels WITH the
// passage as provenance, and recall keeps returning it.
//
// The mark had to be plumbed twice: chameleon passed a provenance object and
// engram.recordEngram ignored it, building its own from file_path /
// codelens_entity_id / source_module. The tier reached nothing until
// recordEngram learned to honour it — verified before the drain was wired,
// which is why this suite pins the storage, not just the intent.
module.exports = function run({ test }) {
const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const state  = require(path.join(ROOT, 'shared-core', 'state.js'));
const engram = require(path.join(ROOT, 'shared-core', 'engram.js'));
const drain  = require(path.join(ROOT, 'shared-core', 'knowledge-drain.js'));

console.log('\nWeb provenance (WP):');

const URL_ = 'https://support.example.org/ads/answer/6146252';
const BODY = 'Quality score is computed from expected click-through rate, ad relevance, and landing page experience. '.repeat(8);

test('WP-1: an engram can carry WHOSE words it holds', () => {
  const id = engram.recordEngram({
    agent_id: 'wp-test', user_id: 'default', cwd: null,
    statement: 'wp probe passage about scoring',
    source: 'wp-test', scope: 'docs:web:wp-test',
    provenance: { tier: 'external', ref: URL_ }, auto_verify: false
  });
  assert.ok(id, 'written');
  let out = {};
  try { out = JSON.parse(state.getAction(id).output); } catch (_) {}
  assert.ok(out.provenance, 'provenance survived the write — it did not before: recordEngram ignored the object');
  assert.strictEqual(out.provenance.tier, 'external', 'and carries the tier: ' + JSON.stringify(out.provenance));
  assert.strictEqual(out.provenance.ref, URL_, 'and where it came from');
});

test('WP-2: a page is queued with its body — it has no durable source to re-read', async () => {
  const sha = 'wp-' + Date.now();
  const queued = state.spoolKnowledge({ kind: 'web', ref: URL_, sha, bytes: BODY.length, payload: BODY });
  assert.ok(queued, 'queued');
  const pending = state.listPendingKnowledge(50).filter((r) => r.kind === 'web' && r.ref === URL_);
  assert.strictEqual(pending.length, 1, 'exactly one row');
  assert.ok(String(pending[0].payload || '').indexOf('landing page experience') !== -1,
    'carrying the body, because re-fetching later gets different bytes, a paywall, or nothing');
});

test('WP-3: the drain files it by site, marked external, and it is recallable', async () => {
  const r = await drain.drainOnce(state, { budget: 4, agent_id: 'wp-test' });
  assert.ok(r.ingested >= 1, 'the page was kept: ' + JSON.stringify(r));

  const scope = drain.webScopeFor(URL_);
  assert.strictEqual(scope, 'docs:web:support.example.org', 'a corpus per site: ' + scope);

  const rows = state._dbForQuery()
    .prepare("SELECT memory_class AS mc, audience AS au, json_extract(output,'$.provenance') AS pv FROM action_records WHERE json_extract(output,'$.scope') = ?")
    .all(scope);
  assert.ok(rows.length >= 1, 'passages were written');
  for (const row of rows) {
    const pv = JSON.parse(row.pv || '{}');
    assert.strictEqual(pv.tier, 'external', 'every passage says it came from outside: ' + row.pv);
    assert.strictEqual(pv.ref, URL_, 'and names the page');
    // The point of the whole design: MARKED, not hidden.
    assert.strictEqual(row.au, 'model_visible',
      'and stays answerable — tagging it synthesis_of_external would delete it from recall, not de-rank it');
    assert.strictEqual(row.mc, 'semantic', 'in the class recall reads for knowledge');
  }
});

test('WP-4: operator documents are NOT marked external', async () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
  const doc = path.join(dir, 'operator-note.md');
  fs.writeFileSync(doc, '# Mine\n\n' + 'The harbour ledger is reconciled every Tuesday by the finance desk. '.repeat(8));
  state.spoolKnowledge({ kind: 'file', ref: doc, sha: 'wp-file-' + Date.now(), bytes: 600 });
  await drain.drainOnce(state, { budget: 4, agent_id: 'wp-test' });
  // Passages only. Temp dirs under /var/folders all collapse to the same
  // scope slug, so this must not sweep up whatever another suite ingested
  // into the same corpus — it asks for the rows this document produced.
  const rows = state._dbForQuery()
    .prepare("SELECT json_extract(output,'$.provenance') AS pv FROM action_records WHERE json_extract(output,'$.scope') = ? AND json_extract(input,'$.source') LIKE 'seen:%' AND json_extract(output,'$.statement') LIKE '%harbour ledger is reconciled%'")
    .all(drain.scopeFor(doc));
  assert.ok(rows.length >= 1, 'the document was kept');
  const tiers = rows.map((r) => (JSON.parse(r.pv || '{}').tier));
  assert.ok(tiers.every((t) => t === 'operator'),
    'what the operator handed over is theirs, not an outside page: ' + JSON.stringify(tiers));
});

test('WP-5: the hook that never matched WebFetch now does (source pin)', () => {
  const fs = require('fs');
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  const post = (hooks.hooks || hooks).PostToolUse || [];
  const matchers = [].concat(post).map((m) => String(m.matcher || ''));
  assert.ok(matchers.some((m) => /WebFetch/.test(m)),
    'WebFetch reaches a hook at all — it reached none, which is why the substrate held 0 records of it: ' + JSON.stringify(matchers));
  const hook = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'mark-read.mjs'), 'utf8');
  assert.ok(/tool === 'WebFetch'/.test(hook), 'and the hook handles it');
  assert.ok(/kind: 'web'/.test(hook), 'queueing it as a page, with its body');
});
};
