// SPDX-License-Identifier: AGPL-3.0-only
// The code graph, askable.
//
// codelens indexes every project the partner works in — 8,303 entities and
// 31,248 CALLS edges for this repo — and reached the model exactly one way:
// the proxy injecting related code chunks into each request. There was no way
// to ASK it anything, so structural questions were answered with grep.
//
// That cost a working day on 2026-08-11, and got the answer wrong: a grep that
// excluded tests/ reported "nothing calls shared-core/action-outcome.js" when
// the truth is "only the test suite calls it" — which is the sharper finding,
// and the one the graph returns in milliseconds.
//
// While wrapping them, store.getCallers / getCallees turned out to have been
// broken since they were written: they filtered `e.relation = 'CALLS'` where
// the column is `relation_type` and the values are lower-case, so every call
// threw "no such column". Nothing called them, so nothing found out. An API
// that is wrong, unused and unreachable is one fact, not three — and that is
// what these tests exist to stop happening again.
module.exports = function run({ test }) {
const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const ROOT  = path.join(__dirname, '..');
const graph = require(path.join(ROOT, 'shared-core', 'code-graph.js'));

console.log('\nCode graph (CG):');

// The index belongs to the operator's real working tree, not to a hermetic
// HOME, so these read it where it actually lives. When this machine has never
// indexed the repo, the tests assert the honest-degradation contract instead.
const REAL_HOME = process.env._TROTH_REAL_HOME || process.env.HOME;
const withRealHome = (fn) => {
  const saved = process.env.HOME;
  process.env.HOME = REAL_HOME;
  try { return fn(); } finally { process.env.HOME = saved; }
};
const indexed = withRealHome(() => fs.existsSync(graph.dbPathFor(ROOT)));

test('CG-1: an unindexed directory says so, instead of answering "nothing"', () => {
  const r = graph.whoCalls('anything', { cwd: '/tmp/definitely-not-indexed-' + Date.now() });
  assert.strictEqual(r.indexed, false, 'it reports the index is absent');
  assert.ok(/no code index/.test(String(r.reason)), 'in words: ' + r.reason);
  assert.deepStrictEqual(r.callers, [], 'and returns no callers rather than a confident empty answer');
});

test('CG-2: store.getCallers no longer throws on the column it was written with', () => {
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'modules', 'codelens', 'store.js'), 'utf8');
  assert.ok(!/e\.relation = \?/.test(src), 'the wrong column name is gone');
  assert.ok(/e\.relation_type = \?/.test(src), 'and the real one is used');
  assert.ok(/\.all\(entityId, 'calls'\)/.test(src), 'with the value the index actually stores (lower-case)');
});

test('CG-3: the day-of question — test-only callers are named as such', function () {
  if (!indexed) return; // this machine has no index for the repo
  // The subject was markAccepted until the index started covering the whole
  // project instead of the directory the proxy was launched from: outcome-fold
  // calls it from production, and the assertion had only held because
  // shared-core was outside the indexed tree. getOutcome sits in the same file
  // and is genuinely reached by the suite alone.
  //
  // A test that names one symbol is a test with an expiry date. It is kept
  // that way on purpose — the verdict it pins is the one that says "built and
  // tested, never wired", and the day it stops being true of this symbol is a
  // day worth being told about rather than a day the check quietly loosens.
  const r = withRealHome(() => graph.whoCalls('getOutcome', { cwd: ROOT, exact: true }));
  if (!r.indexed || !r.found) return; // index exists but predates the file
  assert.strictEqual(r.production_callers, 0, 'nothing in production reaches it: ' + JSON.stringify(r.callers));
  assert.ok(r.test_callers >= 1, 'but the suite does: ' + JSON.stringify(r.callers));
  assert.ok(/ONLY the test suite/.test(r.verdict),
    'and the verdict says which, rather than "unused": ' + r.verdict);
  assert.ok(r.defined_in && r.defined_in[0] && /action-outcome\.js$/.test(r.defined_in[0].file),
    'naming where it lives: ' + JSON.stringify(r.defined_in));
});

test('CG-4: a live function reads as reached from production', function () {
  if (!indexed) return;
  // This is the test that caught the first implementation lying. The index
  // holds 24 definitions named `recordAction` and attributes all 254 inbound
  // edges to one of them; an FTS-ranked lookup returned 15 and missed that
  // one, so the tool reported "nothing calls this" about the substrate's
  // central write path — a verdict that would get a live function deleted.
  const r = withRealHome(() => graph.whoCalls('recordAction', { cwd: ROOT, exact: true }));
  if (!r.indexed || !r.found) return;
  assert.ok(r.found > 1, 'the lookup sees every definition sharing the name, not a ranked slice: ' + r.found);
  assert.ok(r.production_callers >= 1, 'and finds the real callers: ' + JSON.stringify(r).slice(0, 200));
  assert.ok(/production/.test(r.verdict), 'the verdict says so: ' + r.verdict);
  assert.ok(/by name/.test(String(r.attribution)),
    'and it states that attribution is by name, so nobody reads it as exact: ' + r.attribution);
});

test('CG-9: an unknown name answers in the same shape, never with a bare blank', function () {
  const r = graph.whoCalls('definitelyNotAFunctionName_' + Date.now(), { cwd: ROOT, exact: true });
  assert.ok(typeof r.verdict === 'string' && r.verdict.length > 0,
    'every answer carries a verdict — a caller who has to check for one will forget');
  assert.strictEqual(r.production_callers, 0);
  assert.deepStrictEqual(r.callers, []);
});

test('CG-5: a file map separates what is reached from what is not', function () {
  if (!indexed) return;
  const r = withRealHome(() => graph.fileMap('shared-core/action-outcome.js', { cwd: ROOT }));
  if (!r.indexed || !r.entities.length) return;
  assert.ok(Array.isArray(r.never_reached), 'it reports what nothing reaches');
  assert.ok(r.entities.every((e) => typeof e.reached_from_production === 'number'),
    'and counts production reach per entity, not just presence');
});

test('CG-6: every surface can ask, through one implementation', () => {
  const mcp = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs'), 'utf8');
  assert.ok(/troth_code_who_calls:/.test(mcp), 'the code surface can ask who calls something');
  assert.ok(/troth_code_calls:/.test(mcp), 'and what something reaches');
  assert.ok(/troth_code_file_map:/.test(mcp), 'and map a whole file');
  assert.ok(/shared-core\/code-graph\.js/.test(mcp), 'through the shared module');

  // And on the entity daemon too. A first pass removed them from here to keep
  // the system prompt under its cap, which was the wrong trade: the cap is not
  // a voice-latency budget, it is a truncation guard on the daemon's prompt in
  // BOTH modes, and it has been raised four times for exactly this reason.
  // Measured 2026-08-11: these two cost 31 chars in text mode (4,287 -> 4,318)
  // and the cap moved 4,500 -> 4,800 so the voice variant keeps its margin.
  // What we build has to work on every surface; the prompt budget is a
  // separate problem and must not quietly amputate one.
  const reg = require(path.join(ROOT, 'shared-core', 'substrate-tools.js')).REGISTRY;
  assert.ok(reg.code_who_calls && typeof reg.code_who_calls.run === 'function', 'the entity daemon can ask');
  assert.ok(reg.code_file_map && typeof reg.code_file_map.run === 'function', 'and map a file');
  const st = fs.readFileSync(path.join(ROOT, 'shared-core', 'substrate-tools.js'), 'utf8');
  assert.ok(/require\('\.\/code-graph\.js'\)/.test(st), 'through the same shared module');
});

test('CG-8: the daemon prompt fits in BOTH modes, with a hand connected', () => {
  const os = require('os');
  const sp = require(path.join(ROOT, 'shared-core', 'tools', 'system-prompt.js'));
  const runner = require(path.join(ROOT, 'shared-core', 'tools', 'runner.js'));
  const names = runner.unifiedToolsArray().map((t) => t.function && t.function.name).filter(Boolean);
  const saved = process.env.TROTH_MCP_CLIENTS_CONFIG;
  process.env.TROTH_MCP_CLIENTS_CONFIG = path.join(os.tmpdir(), 'cg-no-such-' + Date.now() + '.json');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-'));
  try {
    fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } }));
    for (const audio of [false, true]) {
      const out = sp.buildSystemPrompt({ agent_id: 'partner', cwd: ws, available_tools: names, audio });
      const label = audio ? 'voice' : 'text';
      assert.ok(out.length <= sp.DEFAULT_MAX_CHARS,
        label + ' fits: ' + out.length + ' / ' + sp.DEFAULT_MAX_CHARS);
      assert.ok(out.indexOf('(truncated)') === -1, label + ': nothing was sliced to make it fit');
      // A margin, not a coincidence — the hand-name list is dynamic and grows
      // with whatever the operator has connected.
      assert.ok(sp.DEFAULT_MAX_CHARS - out.length >= 150,
        label + ' keeps real headroom: ' + (sp.DEFAULT_MAX_CHARS - out.length) + ' chars');
    }
  } finally {
    if (saved === undefined) delete process.env.TROTH_MCP_CLIENTS_CONFIG;
    else process.env.TROTH_MCP_CLIENTS_CONFIG = saved;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('CG-7: the description tells the model to ask instead of grepping', () => {
  const mcp = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs'), 'utf8');
  const at = mcp.indexOf('troth_code_who_calls:');
  const block = mcp.slice(at, at + 900);
  assert.ok(/INSTEAD of grepping/i.test(block),
    'a tool nobody knows to reach for is the same as no tool: ' + block.slice(0, 200));
});

// ── The link between an edit and the code it touched ────────────────────
//
// Every recorded edit is meant to carry the ids and symbols of what it
// changed. Two writers record edits: the PostToolUse hook for the host's own
// Edit/Write, and troth's hashline tool. The second one's comment said it
// wrote "the same record shape" as the first and wrote the hash and the line
// count and nothing else.
//
// Measured over 120 consecutive edit records on a working machine: 101 carried
// no entities. hashline is the tool this project's own guide tells
// contributors to use, so the path that ran most was the path that taught the
// graph least, and the Code Map read those files as never edited.
//
// These build their own index rather than reading the operator's, so they say
// the same thing on a machine that has never indexed anything.
(function entityLinkTests() {
  const os = require('os');
  const cp = require('child_process');
  const pid = require(path.join(ROOT, 'shared-core', 'project-id.js'));

  let ready = true;
  let repoFile = null;
  try {
    const env = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'suite', GIT_AUTHOR_EMAIL: 'suite@invalid',
      GIT_COMMITTER_NAME: 'suite', GIT_COMMITTER_EMAIL: 'suite@invalid'
    });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-entities-'));
    cp.execFileSync('git', ['init', '-q'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    cp.execFileSync('git', ['add', 'a.txt'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
    cp.execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
    repoFile = path.join(repo, 'thing.js');
    fs.writeFileSync(repoFile, 'function thing() {}\n');
    pid._clearCache();

    const dbPath = pid.projectStorePath(repo, 'codelens/{key}.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY, name TEXT, type TEXT, file_path TEXT)');
    const ins = db.prepare('INSERT INTO entities (name, type, file_path) VALUES (?, ?, ?)');
    ins.run('thing', 'function', repoFile);
    ins.run('helper', 'function', repoFile);
    ins.run('elsewhere', 'function', path.join(repo, 'other.js'));
    db.close();
  } catch (_) { ready = false; }

  test('CG-10: an edit is told which entities it touched', () => {
    if (!ready) return;   // no git or no better-sqlite3 on this machine
    const r = graph.entitiesForFile(repoFile, os.homedir());
    assert.deepStrictEqual(r.ids && r.ids.length, 2, 'only this file\'s entities: ' + JSON.stringify(r));
    assert.deepStrictEqual(r.symbols, ['function:thing', 'function:helper'],
      'named as type:name, the shape the ledger already stores: ' + JSON.stringify(r.symbols));
  });

  test('CG-11: the answer comes from the FILE\'s project, not the caller\'s directory', () => {
    if (!ready) return;
    // The condition that broke it: a hook running from the operator's home.
    const fromHome = graph.entitiesForFile(repoFile, os.homedir());
    const fromTmp  = graph.entitiesForFile(repoFile, os.tmpdir());
    assert.deepStrictEqual(fromHome, fromTmp, 'the caller\'s position changes nothing');
  });

  test('CG-12: a file with no index behind it records the edit anyway', () => {
    const r = graph.entitiesForFile('/tmp/nothing-indexed-here.js', os.homedir());
    assert.deepStrictEqual(r, { ids: null, symbols: null },
      'best-effort: an unindexed project loses the link, never the edit');
    assert.deepStrictEqual(graph.entitiesForFile('', null), { ids: null, symbols: null },
      'and no path at all is answered, not thrown');
  });

  test('CG-13: both writers of an edit record ask the same function (source pin)', () => {
    // The whole point. A second copy of this lookup is how the two shapes
    // drifted apart in the first place, and the symptom was silent: files
    // edited all day reading as never edited.
    const hook = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'mark-edit.mjs'), 'utf8');
    const tool = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-hashline', 'server.mjs'), 'utf8');
    for (const [src, who] of [[hook, 'the PostToolUse hook'], [tool, 'the hashline tool']]) {
      assert.ok(/entitiesForFile/.test(src), who + ' asks code-graph for the entities');
      assert.ok(/codelens_entity_ids/.test(src), who + ' writes the ids into the record');
      assert.ok(/codelens_symbols/.test(src), who + ' writes the symbols too');
    }
    assert.ok(!/SELECT id, name, type FROM entities/.test(hook),
      'and the hook no longer carries its own copy of the query');
  });
})();
};
