// SPDX-License-Identifier: AGPL-3.0-only
// What corpora does this mind hold, and what is inside one?
//
// Both questions had wrong answers on a real substrate (measured 2026-08-11,
// 43k engrams):
//
//   chameleon.listScopes() counted scopes among the engrams listEngrams()
//   returns — and that reader caps its LIMIT at 2000 rows. So the answer meant
//   "scopes among the 2000 most recent engrams": 57 reported against a true
//   2024, and any corpus ingested before the last 2000 writes was absent
//   entirely. Every size a screen showed would have been fiction.
//
//   The proxy then narrowed it further by agent_id, which only records WHICH
//   SURFACE wrote a row — not whose mind it belongs to (that is principal_id).
//   Ingest ran from whichever surface was open that day, so 12 of the
//   substrate's 30 research corpora were invisible.
//
//   And there was no way to READ a corpus at all: recall answers "which
//   passage matches these words", never "what is in here" — so reaching
//   ingested research required already knowing its vocabulary.
module.exports = function run({ test }) {
const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const state  = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar     = require(path.join(ROOT, 'shared-core', 'action-record.js'));
const chameleon = require(path.join(ROOT, 'shared-core', 'chameleon.js'));

console.log('\nCorpus inventory (CINV):');

const SCOPE_OLD = 'docs:cinv-buried';
const SCOPE_NEW = 'docs:cinv-fresh';

// One chunk of a corpus, written the way ingest writes them.
const seedChunk = (scope, statement, agent_id, ts) => {
  const id = ar.uuidv7();
  const ok = state.recordAction({
    id, timestamp: ts, type: 'commitment', agent_id: agent_id || 'cinv-agent',
    user_id: 'default', cwd: null, memory_class: 'semantic', audience: 'model_visible',
    input:  { source: 'ingest:' + scope },
    output: { statement, commitment_type: 'engram', scope, salience: 1,
              source_authority: 'regex_extracted' }
  }, statement);
  assert.ok(ok, 'seeded ' + scope);
  return id;
};

const T0 = Date.now() - 90 * 24 * 3600 * 1000; // the buried corpus is old

test('CINV-1: a corpus buried under more than 2000 newer engrams is still counted, exactly', () => {
  for (let i = 0; i < 5; i++) seedChunk(SCOPE_OLD, '[buried #' + i + '] the harbour survey of 1974', 'cinv-agent', T0 + i);

  // Bury it. 2100 newer rows is past the reader cap that used to define the
  // whole answer — one more than the window means the corpus vanished.
  const d = state._dbForQuery();
  const insert = d.prepare(
    'INSERT INTO action_records (id, timestamp, type, agent_id, user_id, cwd, principal_id, audience, memory_class, input, output, schema_version) ' +
    "VALUES (?, ?, 'commitment', 'cinv-agent', 'default', NULL, 'partner', 'model_visible', 'semantic', ?, ?, 1)");
  const bury = d.transaction(() => {
    for (let i = 0; i < 2100; i++) {
      insert.run(ar.uuidv7(), T0 + 10000 + i,
        JSON.stringify({ source: 'cinv-noise' }),
        JSON.stringify({ statement: 'noise ' + i, commitment_type: 'engram', scope: 'cinv:noise', salience: 1 }));
    }
  });
  bury();

  const inv = state.scopeInventory({ prefix: 'docs:cinv-' });
  const buried = inv.find((s) => s.scope === SCOPE_OLD);
  assert.ok(buried, 'the buried corpus appears at all: ' + JSON.stringify(inv.map((s) => s.scope)));
  assert.strictEqual(buried.count, 5, 'with its true size, not a windowed guess');
});

test('CINV-2: the count is per corpus and carries how much of it is searchable', () => {
  for (let i = 0; i < 3; i++) seedChunk(SCOPE_NEW, '[fresh #' + i + '] the lighthouse ledger', 'other-surface', Date.now() + i);
  const inv = state.scopeInventory({ prefix: 'docs:cinv-' });
  const fresh = inv.find((s) => s.scope === SCOPE_NEW);
  assert.ok(fresh, 'the fresh corpus is listed');
  assert.strictEqual(fresh.count, 3, 'exact size');
  assert.strictEqual(typeof fresh.embedded, 'number', 'embedded rides along');
  assert.ok(fresh.embedded <= fresh.count, 'and never exceeds the size');
  assert.ok(fresh.last_ts >= fresh.first_ts, 'the ingest window is ordered');
});

test('CINV-3: agent_id narrows only when asked — it is a surface, not a mind', () => {
  // SCOPE_NEW was written by 'other-surface'. A default read is the whole
  // partner brain and must see it; an explicit agent filter is an audit view.
  const all = chameleon.listScopes({ prefix: 'docs:cinv-' }).map((s) => s.scope);
  assert.ok(all.indexOf(SCOPE_NEW) !== -1, 'default read sees another surface\'s corpus: ' + JSON.stringify(all));
  const narrowed = chameleon.listScopes({ prefix: 'docs:cinv-', agent_id: 'cinv-agent' }).map((s) => s.scope);
  assert.ok(narrowed.indexOf(SCOPE_NEW) === -1, 'the explicit filter excludes it: ' + JSON.stringify(narrowed));
  assert.ok(narrowed.indexOf(SCOPE_OLD) !== -1, 'and keeps what that surface did write');
});

test('CINV-4: a corpus can be READ in ingest order, paged, without a query', () => {
  const p1 = state.scopeChunks({ scope: SCOPE_OLD, limit: 2, offset: 0 });
  assert.strictEqual(p1.total, 5, 'the total is the corpus, not the page');
  assert.strictEqual(p1.items.length, 2, 'the page is the page');
  assert.ok(/buried #0/.test(p1.items[0].statement), 'oldest first — a document reads as a document: ' + p1.items[0].statement);
  const p2 = state.scopeChunks({ scope: SCOPE_OLD, limit: 2, offset: 2 });
  assert.ok(/buried #2/.test(p2.items[0].statement), 'the next page continues: ' + p2.items[0].statement);
  assert.strictEqual(state.scopeChunks({ scope: '' }).total, 0, 'no scope, no guessing');
});

test('CINV-5: the proxy exposes both roads and the dashboard walks them (source pin)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  assert.ok(/\/api\/substrate\/scope\?/.test(src), 'the browse endpoint exists');
  assert.ok(/api\/substrate\/query/.test(src), 'the scoped-search endpoint exists');
  const at = src.indexOf("url === '/api/substrate/scopes'");
  assert.ok(at > 0, 'the inventory endpoint exists');
  const block = src.slice(at, at + 1200);
  assert.ok(/scAgent = scU\.searchParams\.get\('agent_id'\) \|\| null/.test(block),
    'and no longer defaults to hard-filtering by surface: ' + block.slice(0, 200));

  const ui = fs.readFileSync(path.join(ROOT, 'proxy', 'ui', 'dashboard.html'), 'utf8');
  assert.ok(/function loadCorpora/.test(ui), 'the dashboard lists what was given');
  assert.ok(/function openCorpus/.test(ui), 'and can open one');
  assert.ok(/function renderCorpora/.test(ui), 'and can filter by name without re-reading the substrate');
  // ONE surface. Documents were a card of their own first, and a person does
  // not know that a document is stored differently from an action record —
  // they should not have to learn it to find their own files. So the class
  // lives in the same dropdown as every other class, rendering into the same
  // list, driven by the same search box.
  assert.ok(/<option value="__knowledge__">knowledge intelligence<\/option>/.test(ui),
    'knowledge is a class in the records filter, not a separate card');
  // A filter that is the only one without a number reads as second-class.
  assert.ok(/c\.knowledge \? ' \(' \+ c\.knowledge\.toLocaleString\(\)/.test(ui),
    'and it carries a count like every other class');
  assert.ok(/typeEl\.value === '__knowledge__'/.test(ui), 'and selecting it renders them in the records list');
  assert.ok(/function recSearch/.test(ui), 'one search box serves both');
  assert.ok(!/id="corpus-list"/.test(ui) && !/id="corpus-summary"/.test(ui),
    'the separate card is gone, not merely hidden');
  // "Corpus" is our word for it, never the operator's. Scan the MARKUP only:
  // script bodies are full of identifiers like CORPUS_ROWS, and a first pass
  // that included them failed on our own variable names — the assertion was
  // right, the extraction was naive.
  const markup = ui
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const onScreen = (markup.match(/>[^<]{3,}</g) || []).join(' ') +
                   ' ' + (markup.match(/placeholder="[^"]*"/g) || []).join(' ');
  const leak = onScreen.match(/[^.\n]{0,60}corp(us|ora)[^.\n]{0,60}/i);
  assert.ok(!leak, 'the word corpus never reaches the screen: ' + (leak && leak[0]));
});
};
