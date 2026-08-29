// SPDX-License-Identifier: AGPL-3.0-only
// The operator's "don't" binds mechanically, in three writing systems.
//
// Omission constraints decay in prose (73%→33% by turn 16, arXiv:2604.20911);
// gating the dispatch they cannot. What this suite pins is the FAIL-CLOSED
// geometry more than the happy path: a negation never lifts, a generic "go"
// never unlocks a scoped freeze, a bare action word never unlocks a generic
// one, and local work (builds, tests, status) is never gated at all — a wall
// that blocks work it should not is how operators learn to disable walls.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const led = require(path.join(ROOT, 'shared-core', 'constraint-ledger.js'));

console.log('\nOperator constraint ledger (CLG):');

test('CLG-1: freezes are detected in all three writing systems — and plain work-talk is not one', () => {
  for (const t of [
    'μην κάνεις τίποτα μέχρι να το δούμε',
    'min kaneis tipota',
    "don't do anything yet",
    'περίμενε να σου πω',
    'wait for my word'
  ]) assert.ok(led.detectFreeze(t), 'must freeze: ' + t);
  for (const t of [
    'push the fix and run the tests',
    'συνέχισε τη δουλειά στο recall',
    'kane build kai des ta tests',
    'to deployment kollise, des giati'
  ]) assert.strictEqual(led.detectFreeze(t), null, 'must NOT freeze: ' + t);
});

test('CLG-2: a scoped freeze knows its verb, and lifts are fail-closed from every direction', () => {
  const scoped = led.detectFreeze('tha sou pw egw pote push');
  assert.ok(scoped && scoped.scope === 'push', 'the verb names the scope');
  const generic = { id: 'g', input: { kind: 'freeze', scope: 'outward', quote: 'wait' }, timestamp: Date.now() };
  const pushF   = { id: 'p', input: { kind: 'freeze', scope: 'push', quote: 'tha sou pw' }, timestamp: Date.now() };
  assert.strictEqual(led.detectLift('min kaneis push akoma', [generic, pushF]).length, 0,
    'a negation near the verb never lifts — terse messages read literally');
  assert.strictEqual(led.detectLift('push', [generic]).length, 0,
    'a bare action word does not unlock a generic freeze');
  assert.strictEqual(led.detectLift('ok go', [pushF]).length, 0,
    'a generic continue-word does not unlock a scoped freeze');
  assert.strictEqual(led.detectLift('ok proxora', [generic]).length, 1, 'the generic lift works');
  assert.strictEqual(led.detectLift('kane push twra', [pushF]).length, 1, 'the action word lifts its scope');
});

test('CLG-3: outward means leaving the machine — local work is never gated', () => {
  for (const c of [
    'git push origin main',
    'git -C /a/b/repo push origin main 2>&1',   // the first blind trial's exact exploit shape
    'git --git-dir=/x/.git push',
    'git -c user.name=t push origin main',
    'git -C /x status && git push',              // the verb hides in the second segment
    'gh api -X PUT repos/x/y/rulesets/1 -f enforcement=disabled',
    'gh release create v1 dist.dmg',
    'npm publish',
    'wrangler r2 object put bucket/key --file f',
    'xcrun notarytool submit app.dmg --keychain-profile p',
    'curl -X POST https://api.example.com/upload -d @f',
    'rsync -a build/ user@host:/srv/www'
  ]) assert.ok(led.isOutwardCommand(c).outward, 'outward: ' + c);
  for (const c of [
    'git status', 'git commit -m x', 'npm run build', 'node tests/test-all.js',
    'curl -X POST http://127.0.0.1:8787/x -d a=1',
    'curl -sSL https://example.com/file -o f',
    'xcrun stapler staple app.dmg',
    'git log --grep push'                        // a MENTION of the verb is not the verb
  ]) assert.strictEqual(led.isOutwardCommand(c).outward, false, 'local: ' + c);
});

test('CLG-4: the whole loop holds on a hermetic store — freeze blocks, wrong words stay blocked, right words open', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clg-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const inner = [
    "const led = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'constraint-ledger.js')) + ");",
    "const f = led.detectFreeze('min kaneis tipota');",
    "led.recordFreeze({ scope: f.scope, quote: f.quote });",
    "const blocked = led.gate('git push origin main');",
    "const localOpen = !led.gate('npm run build').blocked;",
    "const lifted = led.detectLift('ok proxora', led.activeConstraints({}));",
    "lifted.forEach(r => led.recordLift(r.id, { scope: r.input.scope, quote: 'ok proxora' }));",
    "const openAfter = !led.gate('git push origin main').blocked;",
    "console.log(JSON.stringify({ blocked: blocked.blocked, quoted: /min kaneis tipota/.test(blocked.message || ''), localOpen, openAfter }));"
  ].join('\n');
  const r = cp.spawnSync('node', ['-e', inner], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
    }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual(r.status, 0, r.stderr.slice(0, 200));
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.blocked, true, 'the gate blocks the push');
  assert.strictEqual(out.quoted, true, 'the refusal carries the operator\'s own words');
  assert.strictEqual(out.localOpen, true, 'local work stays open under a freeze');
  assert.strictEqual(out.openAfter, true, 'the right words open the gate again');
});

test('CLG-5: enforcement is wired where commands actually pass (source pins)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs'), 'utf8');
  assert.ok(/constraintLedger\.gate\(/.test(server), 'the troth-bash server consults the gate');
  assert.ok(/FROZEN/.test(server), 'and refuses in the operator\'s name');
  const hooks = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8');
  assert.ok(/constraint-capture\.mjs/.test(hooks), 'the capture hook runs on every operator message');
  assert.ok(/hashline_edit\|Read\|Grep\|Glob/.test(hooks), 'the memory guard matcher covers reads too');
  const injector = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'injector.mjs'), 'utf8');
  assert.ok(/ACTIVE-CONSTRAINTS/.test(injector), 'active freezes ride the end of every turn context');
  const guard = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'memory-md-guard.mjs'), 'utf8');
  assert.ok(/memory_md_read/.test(guard), 'reads of claude memory are steered to recall');
  assert.ok(/troth_recall/.test(guard), 'with the recall call spelled out for the stranger who hits it');
});

test('CLG-6: consequential bash commands get pre-action precedent — routine ones stay free (P7.2 reaches the hands)', function () {
  const pac = require(path.join(ROOT, 'shared-core', 'tools', 'pre-action-context.js'));
  assert.ok(pac.isInteresting('Bash'), 'native bash is interesting now');
  assert.ok(pac.isInteresting('mcp__plugin_troth_troth-bash__run'), 'and the MCP lane too');
  const src = fs.readFileSync(path.join(ROOT, 'shared-core', 'tools', 'pre-action-context.js'), 'utf8');
  assert.ok(/BASH_SIGNALS/.test(src), 'the verb table exists');
  assert.ok(/_bashSignal/.test(src), 'and the classifier that keeps routine commands free');
  const hooks = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8');
  assert.ok(/Glob\|Bash\|mcp__plugin_troth_troth-bash__run/.test(hooks.replace(/\\/g, '')), 'pre-action-recall fires on both bash lanes');
  // Behavior, hermetically: one templated decision in a fresh store; a push
  // command must surface it, ls must touch nothing.
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clg6-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const inner = [
    "const state = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'state.js')) + ");",
    "const ar = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js')) + ");",
    "const pac = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'tools', 'pre-action-context.js')) + ");",
    "const rec = { id: ar.uuidv7(), timestamp: Date.now(), type: 'commitment', agent_id: 't', user_id: 'default', audience: 'model_visible', memory_class: 'procedural',",
    "  input: { kind: 'decision' }, output: { statement: 'DECISION — Never push without the word\\nWHEN: about to push\\nSTEPS:\\n1. ask', scope: 'decision:never-push' } };",
    "state.recordAction(rec, ar.toSearchText(rec));",
    "const g = pac.gatherPriorContext({ tool_name: 'Bash', args: { command: 'git push origin main' }, cwd: process.cwd() });",
    "const routine = pac.gatherPriorContext({ tool_name: 'Bash', args: { command: 'ls -la' }, cwd: process.cwd() });",
    "console.log(JSON.stringify({ surfaced: !!(g && g.summary && /push/i.test(g.summary)), routineNull: routine === null }));"
  ].join('\n');
  const r = cp.spawnSync('node', ['-e', inner], {
    env: Object.assign({}, process.env, { HOME, _TROTH_TEST_HOME: HOME, STATE_DB_PATH: path.join(HOME, '.troth', 'state.db') }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual(r.status, 0, r.stderr.slice(0, 200));
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.surfaced, true, 'the push command surfaces the decision');
  assert.strictEqual(out.routineNull, true, 'ls costs the substrate nothing');
});

test('CLG-7: the release is judged from where strangers stand (source pins)', () => {
  const gate = fs.readFileSync(path.join(ROOT, 'scripts', 'release-gate.sh'), 'utf8');
  assert.ok(/check_ship/.test(gate), 'the ship-reality check exists');
  assert.ok(gate.indexOf('api/appcast') !== -1, 'and reads the live appcast, not a local build product');
  assert.ok(/check_repo; check_open_parity; check_outgoing_history; check_ship/.test(gate), 'release mode runs all four walls');
  assert.ok(/check_outgoing_history\(\)/.test(gate), 'outgoing history is a wall of its own — authors and diffs travel with a push');
  const cron = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'parity-cron.yml'), 'utf8');
  assert.ok(/schedule:/.test(cron) && /appcast/.test(cron), 'the daily cron asks the same question between releases');
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(/macos-latest/.test(ci), 'no platform first runs after publish — macOS tests on every push');
});

test('CLG-8: what the first blind trial taught (source pins)', () => {
  // An unprimed agent, fresh context, no hints: its push slipped the old
  // regex as git -C <path> push, and the archiver's own retrieval hint
  // taught it a string id that the strict handler rejected. Each lesson
  // stays pinned where it was learned.
  const led = fs.readFileSync(path.join(ROOT, 'shared-core', 'constraint-ledger.js'), 'utf8');
  assert.ok(/_gitSubcommands/.test(led), 'git is parsed like git parses itself, not pattern-matched');
  const mem = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-memory', 'server.mjs'), 'utf8');
  assert.ok(/Number\(params\.archive_id\)/.test(mem), 'an archive id is accepted in either spelling');
  const hint = (fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'output-sandbox.mjs'), 'utf8').split('updatedMCPToolOutput')[1] || '');
  assert.ok(hint.indexOf('archive_id:' + String.fromCharCode(34)) === -1, 'the retrieval hint no longer teaches the quoted shape');
  const par = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'pre-action-recall.mjs'), 'utf8');
  assert.ok(!/still allowed/.test(par), 'the steer no longer promises a read the guard refuses');
});

test('CLG-9: only the operator\'s own words register a freeze — a system turn quoting one does not', function () {
  // The second blind trial's nastiest find: a task-notification QUOTED a
  // freeze verbatim and the capture hook registered a phantom constraint
  // no human ever stated. Proven hook-level: the same payload, marked as a
  // system notification, must write NOTHING to a fresh ledger.
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clg9-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit', session_id: 'clg9',
    prompt: '[SYSTEM NOTIFICATION - NOT USER INPUT] the operator said: min kaneis tipota'
  });
  const r = cp.spawnSync('node', [path.join(ROOT, 'plugin', 'hooks', 'constraint-capture.mjs')], {
    input: payload,
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db'),
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin')
    }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 200));
  assert.ok((r.stdout || '').indexOf('FREEZE REGISTERED') === -1, 'no confirmation for a phantom');
  const inner = "const led = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'constraint-ledger.js')) + ");" +
                "console.log(led.activeConstraints({}).length);";
  const chk = cp.spawnSync('node', ['-e', inner], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
    }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual((chk.stdout || '').trim(), '0', 'the ledger holds no phantom row');
  // And the sibling lessons from the same trial stay pinned in source:
  const sandbox = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'output-sandbox.mjs'), 'utf8');
  assert.ok(/archive_\(\?:excerpt\|search\)/.test(sandbox), 'an archive retrieval is never re-archived');
  const mem = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-memory', 'server.mjs'), 'utf8');
  assert.ok(/syntax error near/.test(mem), 'punctuation queries reach FTS as quoted phrases');
});
};