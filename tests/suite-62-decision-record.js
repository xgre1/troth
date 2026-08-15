// SPDX-License-Identifier: AGPL-3.0-only
// A decision record is a strategy a weaker mind can re-run.
//
// The measured shape (five-way research pass, 2026-08-15): distilled
// strategy beats raw trajectory; the step SKELETON is the transferable
// payload; the contrastive wrong-turn is the best single field; abstraction
// ships with one grounding example or it loses to the raw trace; provenance
// is required because weak-source traces poison stronger consumers; and the
// whole render stays inside ~750 tokens. This suite pins that shape at its
// three lives: composed (pure function), recorded (through the real MCP
// server into the real row, landing as procedural/model_visible so existing
// filters retrieve it with zero migrations), and surfaced (the compact tier
// at the moment of action — a 140-char clip would behead the skeleton).
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const composer = require(path.join(ROOT, 'shared-core', 'decision-record.js'));

console.log('\nDecision records (DRC):');

const GOOD = {
  strategy: 'Trace the data path before claiming coverage',
  trigger: 'About to state that a mechanism applies across lanes or surfaces without having read each lane end to end',
  steps: [
    'List every lane the data crosses',
    'Read the transform at each boundary in full',
    'State coverage per lane, never in aggregate'
  ],
  contrast: {
    mistake: 'Assume the guard at the entry point holds downstream',
    why: 'Boundaries transform payloads — a field dropped at translation silently voids the guard',
    correct: 'Verify the field survives each translation before claiming it binds'
  },
  example: 'recallforce: tool_choice was dropped whole at the OpenAI-compat conversion; only per-lane reading caught it',
  provenance: { model: 'claude-fable-5', verdict: 'test_passed' }
};

test('DRC-1: the composer renders the template in transfer order, with the compact tier and a scope slug', () => {
  const r = composer.compose(GOOD);
  assert.strictEqual(r.ok, true, r.error);
  const lines = r.statement.split('\n');
  assert.ok(lines[0].startsWith('DECISION — Trace the data path'), 'the name leads');
  assert.ok(lines[1].startsWith('WHEN: '), 'the situation key is line two — it is the retrieval key');
  assert.ok(r.statement.indexOf('STEPS:') !== -1 && /  1\. /.test(r.statement), 'the skeleton is numbered');
  assert.ok(r.statement.indexOf('CONTRAST: ✗') !== -1, 'the wrong turn is rendered');
  assert.ok(lines[lines.length - 1].startsWith('SOURCE: '), 'provenance closes the record — clipping never removes the shape');
  assert.ok(/^decision:[a-z0-9-]+$/.test(r.scope), 'the scope slugs from the strategy: ' + r.scope);
  assert.ok(r.compact.indexOf('CONTRAST') === -1 && r.compact.indexOf('SOURCE') === -1,
    'the compact tier is name + WHEN + skeleton only');
  assert.ok(/  3\. /.test(r.compact), 'and the skeleton survives whole in it');
});

test('DRC-2: every missing load-bearing field is a wall, not a warning', () => {
  const cases = [
    [{ ...GOOD, strategy: '' }, 'missing_strategy'],
    [{ ...GOOD, trigger: '  ' }, 'missing_trigger'],
    [{ ...GOOD, steps: ['only one move'] }, 'missing_steps'],
    [{ ...GOOD, steps: Array(9).fill('step') }, 'too_many_steps'],
    [{ ...GOOD, contrast: { mistake: 'x', why: '', correct: 'y' } }, 'partial_contrast'],
    [{ ...GOOD, provenance: undefined }, 'missing_provenance'],
    [{ ...GOOD, provenance: { model: 'm', verdict: 'probably-fine' } }, 'bad_verdict']
  ];
  for (const [input, expected] of cases) {
    const r = composer.compose(input);
    assert.strictEqual(r.ok, false, expected + ' must reject');
    assert.strictEqual(r.error, expected);
  }
});

test('DRC-3: ceilings hold — verbose records measurably hurt their consumers', () => {
  const long = { ...GOOD,
    strategy: 'x'.repeat(300), trigger: 'y'.repeat(900),
    steps: Array(7).fill('z'.repeat(500)), example: 'e'.repeat(900) };
  const r = composer.compose(long);
  assert.strictEqual(r.ok, true);
  assert.ok(r.statement.length <= composer.CEILINGS.total, 'total ceiling: ' + r.statement.length);
  assert.ok(r.statement.split('\n')[0].length <= 'DECISION — '.length + composer.CEILINGS.strategy,
    'the name stays a name');
});

test('DRC-4: recorded through the real server, the row lands procedural — existing filters retrieve it with zero migrations', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const env = Object.assign({}, process.env, {
    HOME, _TROTH_TEST_HOME: HOME,
    STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
  });
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'suite', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'troth_decision_record', arguments: GOOD } }
  ].map(JSON.stringify).join('\n') + '\n';
  // stdin must stay open past the reply: the record path does real work
  // (DB init, embed attempt) and an immediate EOF races it — the server
  // exits before the id:2 reply flushes. Same discipline as the manual
  // verification snippet in MCP-HOST-INSTALL.md.
  const msgsFile = path.join(HOME, 'msgs.jsonl');
  fs.writeFileSync(msgsFile, msgs);
  const r = cp.spawnSync('sh', ['-c',
    '{ cat ' + msgsFile + '; sleep 10; } | node ' + path.join(ROOT, 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs')],
    { env, encoding: 'utf8', timeout: 45000 });
  const reply = (r.stdout || '').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .find(x => x && x.id === 2);
  assert.ok(reply, 'the server answered');
  const blocks = reply.result.content;
  let payload = null;
  for (const b of blocks) { try { payload = JSON.parse(b.text); break; } catch (_) {} }
  assert.ok(payload && payload.ok, 'the write succeeded: ' + JSON.stringify(payload).slice(0, 200));
  assert.ok(/^decision:/.test(payload.scope), 'and reports its decision scope');

  const Database = require('better-sqlite3');
  const db = new Database(env.STATE_DB_PATH, { readonly: true, fileMustExist: true });
  const row = db.prepare("SELECT memory_class, audience, output FROM action_records WHERE type='commitment'").get();
  db.close();
  assert.ok(row, 'one commitment row landed');
  assert.strictEqual(row.memory_class, 'procedural', 'decision:* derives procedural — the shelf existing filters already query');
  assert.strictEqual(row.audience, 'model_visible');
  const out = JSON.parse(row.output);
  assert.ok(out.statement.startsWith('DECISION — '), 'the statement IS the template — every recall surface renders it for free');
  assert.ok(out.compact && out.compact.indexOf('SOURCE') === -1, 'the compact tier rides along for weak consumers');
});

test('DRC-5: at the moment of action the record surfaces in its compact tier, skeleton whole', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drc5-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const script = `
    const path = require('path');
    const composer = require(${JSON.stringify(path.join(ROOT, 'shared-core', 'decision-record.js'))});
    const engram = require(${JSON.stringify(path.join(ROOT, 'shared-core', 'engram.js'))});
    const good = ${JSON.stringify({ ...GOOD, example: 'the payload-parser rewrite kept coverage honest' })};
    const composed = composer.compose(good);
    // agent_id is required — engram.js refuses anonymous writes (read-side
    // isolation depends on it); the MCP road stamps it via ctxFromArgs.
    engram.recordEngram({ statement: composed.statement, source: 'suite', salience: 1,
      agent_id: 'suite-agent', scope: composed.scope, extra_output: { compact: composed.compact } });
    const pac = require(${JSON.stringify(path.join(ROOT, 'shared-core', 'tools', 'pre-action-context.js'))});
    const got = pac.gatherPriorContext({ tool_name: 'Edit', args: { file_path: '/w/payload-parser.js' }, cwd: '/w' });
    console.log(JSON.stringify(got || {}));
  `;
  const r = cp.spawnSync('node', ['-e', script], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
    }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual(r.status, 0, r.stderr.slice(0, 300));
  const got = JSON.parse((r.stdout || '{}').trim().split('\n').pop());
  assert.ok(got.summary, 'the strategy surfaced at the moment of action');
  assert.ok(got.summary.indexOf('DECISION — ') !== -1, 'as the template, not prose about it');
  assert.ok(/  \d\. /.test(got.summary), 'with the skeleton whole — the payload survived rendering');
  assert.ok(got.summary.indexOf('SOURCE') === -1, 'and in the compact tier — tail sections stay home');
});

test('DRC-6: the writers and the fallback road are wired (source pins)', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'think', 'SKILL.md'), 'utf8');
  assert.ok(/decision_record\(\{ strategy/.test(skill), '/troth:think writes strategies through the composer road');
  assert.ok(/verdict.*test_passed.*needs a test that ran/.test(skill.replace(/\n/g, ' ')),
    'and the skill states the verdict honesty rule');
  const pac = fs.readFileSync(path.join(ROOT, 'shared-core', 'tools', 'pre-action-context.js'), 'utf8');
  assert.ok(/_precedentByFts/.test(pac) && /memory_class: 'procedural'/.test(pac),
    'the FTS fallback reaches the strategy shelf through the existing procedural filter');
});
};
