// SPDX-License-Identifier: AGPL-3.0-only
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nReader/writer field contract (FC):');

function inSandbox(inner) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const r = cp.spawnSync('node', ['-e', inner], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
    }),
    encoding: 'utf8', timeout: 60000
  });
  assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('FC-1: a lesson written by the writer is readable by the field the readers use', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const query = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'query.js')) + ");",
    "state.recordLesson('fc-session', '/tmp/fc', 'errortax', 'fp-1', 'the lesson body that must survive the round trip');",
    "const rows = query.getLessons(state, { limit: 10 }) || [];",
    "const readable = rows.filter(r => r.output && r.output.text).length;",
    "console.log(JSON.stringify({ stored: rows.length, readable }));"
  ].join('\n'));
  assert.ok(out.stored > 0, 'the writer stored a lesson');
  assert.strictEqual(out.readable, out.stored, 'every stored lesson exposes the field the readers read');
});

test('FC-2: the lesson ranker scores on the stored body, not on an absent field', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const query = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'query.js')) + ");",
    "const lib = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'lesson-library.js')) + ");",
    "state.recordLesson('fc-session', '/tmp/fc', 'errortax', 'fp-2', 'a specific and structurally anchored lesson about retry handling in the http client');",
    "const rows = query.getLessons(state, { limit: 10 }) || [];",
    "const ranked = lib.rankLessons(rows, { limit: 5, fileExists: () => false });",
    "const specificity = ranked.length ? (ranked[0]._quality && ranked[0]._quality.dimensions && ranked[0]._quality.dimensions.specificity) : null;",
    "console.log(JSON.stringify({ ranked: ranked.length, specificity }));"
  ].join('\n'));
  assert.ok(out.ranked > 0, 'the ranker returned the lesson');
  assert.ok(out.specificity === null || out.specificity > 0,
    'specificity is scored from the stored body — zero would mean the ranker read a field the writer never wrote');
});

test('FC-3: an intent stores its goal on input, not on output', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const ar = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");",
    "const rec = ar.create({ type: 'intent', agent_id: 'fc', cwd: '/tmp/fc',",
    "  input: { goal: 'finish the retry work', source_message_hash: 'h', extraction: 'test' },",
    "  output: { chosen_path: 'finish the retry work' } });",
    "state.recordAction(rec, ar.toSearchText(rec));",
    "const rows = state.queryActions({ type: 'intent', limit: 5 }) || [];",
    "let withGoal = 0;",
    "for (const r of rows) { let i; try { i = JSON.parse(r.input); } catch (_) { continue; } if (i && i.goal) withGoal++; }",
    "console.log(JSON.stringify({ rows: rows.length, withGoal }));"
  ].join('\n'));
  assert.ok(out.rows > 0, 'the intent was stored');
  assert.strictEqual(out.withGoal, out.rows, 'the goal lives on input — any reader that looks on output finds nothing');
});

test('FC-4: a compiled procedure is retrievable by its trigger words, not only by its name', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const ar = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");",
    "const comp = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'procedure-compiler.js')) + ");",
    "const recall = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'recall.js')) + ");",
    "const rec = comp.compileProcedure({ seq: ['Quarantine', 'Rollback'], signature: 'sig', occurrences: 5, sessions: ['s1','s2'] }, { agent_id: 'fc', cwd: '/tmp/fc' });",
    "state.recordAction(rec, ar.toSearchText(rec));",
    "const row = state.getAction(rec.id);",
    "const byTrigger = recall._recallProcedural({ query: 'quarantine', audience: 'model_visible', limit: 5, cwd: null, topicTokens: new Set() });",
    "console.log(JSON.stringify({ memory_class: row.memory_class, audience: row.audience, byTrigger: byTrigger.length }));"
  ].join('\n'));
  assert.strictEqual(out.memory_class, 'procedural',
    'the compiler stamps the class the procedural reader queries — operational would make every compiled procedure invisible');
  assert.strictEqual(out.audience, 'model_visible', 'and the audience the reader asks for');
  assert.ok(out.byTrigger > 0,
    'a trigger word finds the procedure — the machine-generated name is not a retrieval path any human types');
});

test('FC-5: an avoided path carries its text where the prospective reader looks', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const ar = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");",
    "const rec = ar.create({ type: 'avoided_path', agent_id: 'fc', cwd: '/tmp/fc',",
    "  input: { fingerprint: 'fp', reason_kind: 'critic' },",
    "  output: { avoidance_text: 'do not force push', suggest_instead: 'ask first', cost_avoided_estimate: 1 } });",
    "state.recordAction(rec, ar.toSearchText(rec));",
    "const avoided = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'avoided.js')) + ");",
    "const paths = avoided.getAvoidedPaths(state, { limit: 5 }) || [];",
    "let usable = 0;",
    "for (const p of paths) { const o = (p && p.output) || {}; if (String(o.avoidance_text || '')) usable++; }",
    "console.log(JSON.stringify({ paths: paths.length, usable }));"
  ].join('\n'));
  assert.ok(out.paths > 0, 'the avoided path was stored');
  assert.strictEqual(out.usable, out.paths, 'every stored path exposes the field the reader reads');
});

test('FC-6: a scoped corpus survives a recency window filled by other writes', () => {
  const out = inSandbox([
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "engram.recordEngram({ agent_id: 'fc', user_id: 'default', cwd: '/tmp/fc',",
    "  statement: 'where we left off before the compaction', source: 'test',",
    "  scope: 'handoff:2026-01-01:sess', salience: 1.5, auto_verify: false });",
    "for (let i = 0; i < 120; i++) {",
    "  engram.recordEngram({ agent_id: 'fc', user_id: 'default', cwd: '/tmp/fc',",
    "    statement: 'unrelated engram number ' + i, source: 'test', auto_verify: false });",
    "}",
    "const blind = (engram.listEngrams({ audience: 'substrate_internal', limit: 50 }) || [])",
    "  .filter(e => e && typeof e.scope === 'string' && e.scope.indexOf('handoff:') === 0).length;",
    "const scoped = (engram.listEngrams({ audience: 'substrate_internal', scope_prefix: 'handoff:', limit: 50 }) || []).length;",
    "console.log(JSON.stringify({ blind, scoped }));"
  ].join('\n'));
  assert.ok(out.scoped > 0,
    'a scope-prefixed read finds the handoff after 120 later writes — the whole point of pushing the filter into the query');
  assert.ok(out.blind === 0 || out.blind < out.scoped,
    'the scope-blind window is what buried it; this pins the regression that fetch-then-filter reintroduces');
});

test('FC-7: an ingested turn carries its event time, not the write time', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const ar = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");",
    "const dm = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'dialogue-memory.js')) + ");",
    "const eventTs = 1684541000000;",
    "const ok = dm.recordTurn({ agent_id: 'fc', user_text: 'what did we plan', assistant_text: 'the plan', timestamp: eventTs });",
    "const rows = state.queryActions({ type: 'tool_call', limit: 5, order: 'desc' }) || [];",
    "const rec = rows.map(r => ar.fromRow(r)).find(r => r && r.input && r.input.tool_name === 'dialogue.turn');",
    "console.log(JSON.stringify({ ok, ts: rec && rec.timestamp, idTs: rec && ar.uuidv7Timestamp(rec.id) }));"
  ].join('\n'));
  assert.strictEqual(out.ok, true, 'the backdated write is accepted');
  assert.strictEqual(out.ts, 1684541000000,
    'the stored timestamp is the event time — Date.now() here made every ingested history land at NOW and temporal recall blind');
  assert.strictEqual(out.idTs, 1684541000000,
    'the minted UUIDv7 id embeds the same event time, keeping ORDER BY id consistent with event order');
});

test('FC-8: a context-stamped write is filterable by context_id end to end', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const dm = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'dialogue-memory.js')) + ");",
    "const engram = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js')) + ");",
    "dm.recordTurn({ agent_id: 'fc', user_text: 'inside ctx a', assistant_text: 'noted', context_id: 'ctx:alpha' });",
    "dm.recordTurn({ agent_id: 'fc', user_text: 'no ctx here', assistant_text: 'noted' });",
    "engram.recordEngram({ agent_id: 'fc', statement: 'fact inside ctx a', source: 'test', context_id: 'ctx:alpha', auto_verify: false });",
    "const scoped = state.queryActions({ context_id: 'ctx:alpha', limit: 10 }) || [];",
    "const all = state.queryActions({ limit: 10 }) || [];",
    "console.log(JSON.stringify({ scoped: scoped.length, all: all.length, kinds: scoped.map(r => r.type).sort() }));"
  ].join('\n'));
  assert.strictEqual(out.scoped, 2,
    'exactly the two ctx:alpha writes come back through the context_id filter — the unstamped turn stays out');
  assert.ok(out.all >= 3, 'the unfiltered read still sees everything');
  assert.deepStrictEqual(out.kinds, ['commitment', 'tool_call'],
    'both writer paths (dialogue turn and engram) carried the stamp to the column');
});

test('FC-9: a bound read serves its context and starves the rest', () => {
  const out = inSandbox([
    "const H = 3600000;",
    "const dm = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'dialogue-memory.js')) + ");",
    "const recall = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'recall.js')) + ");",
    "const ctxReg = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'context-registry.js')) + ");",
    "const mk = ctxReg.ensureContext('alpha-work');",
    "const again = ctxReg.ensureContext('alpha-work');",
    "dm.recordTurn({ agent_id: 'fc', user_text: 'the alpha deadline moved to friday', assistant_text: 'noted the deadline', context_id: 'ctx:alpha-work', timestamp: Date.now() - 30 * H });",
    "dm.recordTurn({ agent_id: 'fc', user_text: 'the beta deadline moved to monday', assistant_text: 'noted that too', context_id: 'ctx:beta-work', timestamp: Date.now() - 30 * H });",
    "dm.recordTurn({ agent_id: 'fc', user_text: 'an unsorted deadline note', assistant_text: 'noted loosely', timestamp: Date.now() - 30 * H });",
    "(async () => {",
    "  const bound = await recall.recall({ query: 'deadline moved', class: 'all', audience: 'model_visible', limit: 10, context_id: 'ctx:alpha-work' });",
    "  const open = await recall.recall({ query: 'deadline moved', class: 'all', audience: 'model_visible', limit: 10 });",
    "  console.log(JSON.stringify({",
    "    created: mk.ok && !mk.existed, idempotent: again.ok && again.existed,",
    "    mention: ctxReg.resolveMention('we are working on alpha work today'),",
    "    boundHits: bound.length,",
    "    boundLeak: bound.filter(h => /beta|unsorted/i.test(h.statement)).length,",
    "    openHits: open.length",
    "  }));",
    "})();"
  ].join('\n'));
  assert.strictEqual(out.created, true, 'first ensureContext creates the registry engram');
  assert.strictEqual(out.idempotent, true, 'second ensureContext finds it instead of duplicating');
  assert.strictEqual(out.mention, 'ctx:alpha-work', 'a plain-text mention resolves to the registered context');
  assert.ok(out.boundHits >= 1, 'the bound read still surfaces the in-context memory');
  assert.strictEqual(out.boundLeak, 0,
    'neither the other context nor the unsorted row crosses into a bound read — the leak this whole design exists to stop');
  assert.ok(out.openHits >= out.boundHits, 'a read that names no conversation and no context keeps seeing everything');
});

test('FC-10: a session whose file activity names a context stamps every later write in it', () => {
  const out = inSandbox([
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const ar = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");",
    "const ctxReg = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'context-registry.js')) + ");",
    "ctxReg.ensureContext('alpha-work');",
    "const S = 'sess-fc10';",
    "for (let i = 0; i < 4; i++) {",
    "  state.recordAction({ id: ar.uuidv7(), timestamp: Date.now(), type: 'edit', agent_id: 'fc', session_id: S,",
    "    input: { file_path: '/w/alpha-work/src/f' + i + '.js' }, output: {} }, 'edit');",
    "}",
    "const id = ar.uuidv7();",
    "state.recordAction({ id, timestamp: Date.now(), type: 'decision', agent_id: 'fc', session_id: S,",
    "  input: {}, output: { note: 'unstamped write in the same session' } }, 'decision');",
    "const row = state.getAction(id);",
    "const loneId = ar.uuidv7();",
    "state.recordAction({ id: loneId, timestamp: Date.now(), type: 'decision', agent_id: 'fc',",
    "  input: {}, output: {} }, 'lone');",
    "console.log(JSON.stringify({ stamped: row && row.context_id, lone: state.getAction(loneId).context_id || null }));"
  ].join('\n'));
  assert.strictEqual(out.stamped, 'ctx:alpha-work',
    'the write inherited the session file-activity context at the substrate boundary — no caller had to know the concept exists');
  assert.strictEqual(out.lone, null, 'a sessionless write stays unbound');
});

};
