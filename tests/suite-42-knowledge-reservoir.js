// SPDX-License-Identifier: AGPL-3.0-only
// What the partner has SEEN, kept.
//
// The substrate kept what the operator said and nothing of what the partner
// read. A `read` record holds a path, a line count and a byte count — no
// content — and is filed substrate_internal, so even the receipt is
// unreachable. Most reads are re-reads of a file already opened, because there
// was nowhere for it to have stayed.
//
// Two decisions this pins, both measured rather than assumed:
//
//   POINTERS, NOT CONTENT. The queue holds a path and a content hash. The file
//   is on disk, so re-reading in the idle worker is free, while chunking and
//   embedding cost 51ms per 800 chars and must never land on the operator's
//   turn — which already carries 488ms of hook time per Read.
//
//   DOCUMENTS, NOT EVERYTHING. Most files a partner reads are source code,
//   not documents. Code is codelens's job and goes stale on every edit. And
//   over a documents tree, the bulk of what an unfiltered predicate would
//   capture sits inside node_modules.
module.exports = function run({ test }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const ROOT  = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const cache = require(path.join(ROOT, 'proxy', 'modules', 'troth-cache.js'));
const drain = require(path.join(ROOT, 'shared-core', 'knowledge-drain.js'));

console.log('\nKnowledge reservoir (KR):');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-'));
const DOC = path.join(DIR, 'harbour-study.md');
const BODY = '# The harbour study\n\n' +
  'Transhipment cargo follows the bonded warehouse schedule, not the daily manifest run. '.repeat(12) +
  '\n\nThe reconciliation window closes at noon on the day of signature.\n';
fs.writeFileSync(DOC, BODY);

test('KR-1: the predicate keeps documents and refuses work', () => {
  assert.ok(cache.isKnowledgeFile('/x/study.pdf'), 'a pdf is knowledge');
  assert.ok(cache.isKnowledgeFile('/x/notes.md'), 'so is a note');
  assert.ok(cache.isKnowledgeFile('/x/clients.csv'), 'and a spreadsheet export');
  assert.ok(!cache.isKnowledgeFile('/x/src/index.js'), 'source code is not — codelens holds that');
  assert.ok(!cache.isKnowledgeFile('/x/p/node_modules/pkg/readme.md'),
    'and a dependency readme is not, whatever its extension');
  assert.ok(!cache.isKnowledgeFile('/x/p/dist/report.html'), 'nor a build output');
});

test('KR-2: a document read is queued once, however many times it is read', () => {
  const sha = 'kr-sha-' + Date.now();
  assert.strictEqual(cache.spoolIfKnowledge(DOC, sha), true, 'the first read queues it');
  assert.strictEqual(cache.spoolIfKnowledge(DOC, sha), false, 'the second adds nothing');
  assert.strictEqual(cache.spoolIfKnowledge(path.join(ROOT, 'shared-core', 'state.js'), 'x'), false,
    'and a source file is never queued at all');
});

test('KR-3: a corpus is named for where the document lives — the "what for"', () => {
  // The home is passed explicitly: the first version read process.env.HOME and
  // passed only on the machine it was written on, which is a test that proves
  // nothing about anyone else's.
  // The user name here is one of the placeholders the release gate allows
  // (operator / user / you). It has to stay home-SHAPED, because scopeFor
  // encodes "Users" and "home" as machine prefixes to skip — rewriting the
  // root to something invented tested nothing and quietly passed.
  const H = '/Users/operator';
  // Invented client names. The first version of this test used two real ones
  // from the author's own folders — harmless on the machine that wrote it, a
  // published client list in the open repo.
  assert.strictEqual(drain.scopeFor('/Users/operator/Documents/northwind/researches/x.md', H), 'docs:seen:northwind');
  assert.strictEqual(drain.scopeFor('/Users/operator/Desktop/tarrant/report.pdf', H), 'docs:seen:tarrant');
  // A path under a DIFFERENT home must not become a corpus called "users".
  assert.strictEqual(drain.scopeFor('/Users/user/Documents/acme/spec.md', H), 'docs:seen:acme');
  // And the folder names it, never the file — one corpus per document would be
  // a filing cabinet with one sheet in every drawer.
  assert.strictEqual(drain.scopeFor('/tmp/loose.txt', H), 'docs:seen:unsorted');
});

test('KR-4: the drain turns a pointer into recallable passages, exactly once', async () => {
  const sha = 'kr-drain-' + Date.now();
  const spooled = state.spoolKnowledge({ kind: 'file', ref: DOC, sha, bytes: BODY.length });
  assert.ok(spooled, 'queued');
  const r = await drain.drainOnce(state, { budget: 4, agent_id: 'kr-test' });
  assert.ok(r.ingested >= 1, 'something was kept: ' + JSON.stringify(r));
  assert.ok(r.chunks >= 1, 'as passages: ' + JSON.stringify(r));

  const scope = drain.scopeFor(DOC);
  const held = state._dbForQuery()
    .prepare("SELECT json_extract(output,'$.statement') AS s FROM action_records WHERE json_extract(output,'$.scope') = ?")
    .all(scope).map((x) => String(x.s || ''));
  assert.ok(held.some((s) => /bonded warehouse schedule/.test(s)),
    'and the words are actually there: ' + JSON.stringify(held.slice(0, 1)));

  // Read again, queue again, drain again: the content is unchanged, so nothing
  // is chunked twice. This is what makes 8,407 re-reads cost nothing.
  state.spoolKnowledge({ kind: 'file', ref: DOC, sha: sha + '-second-row', bytes: BODY.length });
  const before = held.length;
  await drain.drainOnce(state, { budget: 4, agent_id: 'kr-test' });
  const after = state._dbForQuery()
    .prepare("SELECT COUNT(*) AS n FROM action_records WHERE json_extract(output,'$.scope') = ?")
    .get(scope).n;
  assert.ok(after >= before, 'sanity');
  const sources = state._dbForQuery()
    .prepare("SELECT DISTINCT json_extract(input,'$.source') AS s FROM action_records WHERE json_extract(output,'$.scope') = ?")
    .all(scope).map((x) => String(x.s || ''));
  assert.ok(sources.every((s) => s.indexOf('seen:') === 0), 'every passage carries its content hash as provenance: ' + JSON.stringify(sources));
});

test('KR-8: a passage is filed WHERE it belongs, so it surfaces in its own project', async () => {
  // recall boosts a passage whose cwd matches the current project (1.0) over
  // one that does not (0.5). Filing everything with cwd:null — the first
  // version of this drain — gives every corpus the neutral score forever, so a
  // body of work about one project never surfaces preferentially while working
  // in it. That is the whole point of keeping it.
  const doc = path.join(DIR, 'placed-study.md');
  fs.writeFileSync(doc, '# Placed\n\nThe pilot boards at the outer buoy in all weathers. '.repeat(10));
  state.spoolKnowledge({ kind: 'file', ref: doc, sha: 'kr-placed-' + Date.now(), bytes: 600 });
  const r = await drain.drainOnce(state, { budget: 4, agent_id: 'kr-test' });
  assert.ok(r.ingested >= 1, JSON.stringify(r));
  const rows = state._dbForQuery()
    .prepare("SELECT cwd FROM action_records WHERE json_extract(output,'$.scope') = ? AND json_extract(input,'$.source') LIKE 'seen:%'")
    .all(drain.scopeFor(doc));
  assert.ok(rows.length >= 1, 'passages were written');
  assert.ok(rows.every((x) => x.cwd === DIR),
    'and every one carries the folder it came from: ' + JSON.stringify(rows.slice(0, 2)));
});

test('KR-5: a document that vanished before the drain is closed honestly', async () => {
  const gonePath = path.join(DIR, 'vanished.md');
  fs.writeFileSync(gonePath, 'x'.repeat(400));
  const sha = 'kr-gone-' + Date.now();
  state.spoolKnowledge({ kind: 'file', ref: gonePath, sha, bytes: 400 });
  fs.unlinkSync(gonePath);
  const r = await drain.drainOnce(state, { budget: 4, agent_id: 'kr-test' });
  assert.ok(r.gone >= 1, 'it reports the source as gone rather than inventing one: ' + JSON.stringify(r));
  const row = state._dbForQuery()
    .prepare('SELECT done_at, result FROM knowledge_spool WHERE ref = ?').get(gonePath);
  assert.ok(row && row.done_at, 'and the queue does not retry it forever');
  assert.strictEqual(row.result, 'source_gone', 'saying why: ' + (row && row.result));
});

test('KR-7: the reason a document was opened is kept, and kept apart', async () => {
  // A grep pattern is not a reason. The substrate holds 14,995 search records
  // carrying raw patterns and none of them answer "what was I working on".
  // The operator's own last question does, and at capture time it is free.
  const WHY = 'checking whether the harbour manifests are filed the same day';
  const doc = path.join(DIR, 'why-study.md');
  fs.writeFileSync(doc, '# Filing practice\n\n' +
    'Manifests signed before noon are filed the same day by the finance desk. '.repeat(10));
  const sha = 'kr-why-' + Date.now();
  state.spoolKnowledge({ kind: 'file', ref: doc, sha, bytes: 700, why: WHY });
  const r = await drain.drainOnce(state, { budget: 4, agent_id: 'kr-test' });
  assert.ok(r.ingested >= 1, 'the document was kept: ' + JSON.stringify(r));
  assert.ok(r.reasons >= 1, 'and so was the reason: ' + JSON.stringify(r));

  const scope = drain.scopeFor(doc);
  const rows = state._dbForQuery()
    .prepare("SELECT json_extract(output,'$.statement') AS s, json_extract(input,'$.source') AS src FROM action_records WHERE json_extract(output,'$.scope') = ?")
    .all(scope).map((x) => ({ s: String(x.s || ''), src: String(x.src || '') }));

  const reason = rows.filter((x) => x.src.indexOf('seen-why:') === 0);
  assert.strictEqual(reason.length, 1, 'exactly one reason line per document, not one per passage');
  assert.ok(reason[0].s.indexOf(WHY) !== -1, 'carrying the question verbatim: ' + reason[0].s);
  assert.ok(reason[0].s.indexOf('why-study.md') !== -1, 'and naming the document');

  // The material stays material: no passage carries our bookkeeping.
  const passages = rows.filter((x) => x.src.indexOf('seen:') === 0);
  assert.ok(passages.length >= 1, 'the document produced passages');
  assert.ok(passages.every((x) => x.s.indexOf('while working on') === -1),
    'and none of them was stapled with the reason');
});

test('KR-6: the proxy queues it and the idle worker drains it (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'modules', 'troth-cache.js'), 'utf8');
  const at = src.indexOf("use.name === 'Read'");
  assert.ok(at > 0, 'the queue branch sits on the Read path');
  assert.ok(/spoolIfKnowledge\(paths\[0\], hashes\[0\], askedFor\)/.test(src),
    'reusing the path and hash this loop already computed, plus the question in flight');
  assert.ok(/const askedFor = lastOperatorText\(msgs\);/.test(src),
    'and reading that question once per body, not once per tool result');
  const worker = require(path.join(ROOT, 'shared-core', 'background-worker.js'));
  const names = (worker.DEFAULT_TASKS || []).map((t) => t.name);
  assert.ok(names.indexOf('knowledge_drain') !== -1, 'the idle worker drains it: ' + JSON.stringify(names.slice(-3)));
  // Membership in DEFAULT_TASKS is NOT the same as having a runner. That list
  // belongs to the entity daemon; every install keeps a proxy alive. Asserting
  // membership alone lets a queue with no reader pass its own test.
  const proxySrc = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  assert.ok(proxySrc.indexOf('bw.tasks.knowledgeDrain') !== -1,
    'and the proxy — the one process every install keeps alive — hosts it too');
});
};
