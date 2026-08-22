// SPDX-License-Identifier: AGPL-3.0-only
// The first walk toward the memory files meets the memory itself.
//
// Reading CLAUDE.md or memory/*.md is a memory question wearing a file's
// clothes. A steer alone was measured insufficient — 48 walks in seven days
// on a machine where recall was auto-served every turn — so the FIRST such
// walk of a session now returns an ask that CARRIES a taste of the answer:
// a cheap lexical search (no embedder, safe on a virgin install) pulls the
// top commitments for what the session is about, and the agent decides with
// them in view. Substrate acting, not advising.
//
// Deliberate limits, all pinned here: later walks in the same session get
// the plain steer (an agent working ON memory files must not be nagged per
// read); an empty substrate never asks (nothing to show is a steer, not a
// roadblock); and every failure falls open to the steer.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nMemory-surface first-walk ask (MSF):');

// Unique per run: the once-per-session marker lives in the shared tmpdir and
// must never leak between suite runs.
const RUN = Date.now().toString(36);

function mkEnv() {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'msf-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  return Object.assign({}, process.env, {
    HOME, _TROTH_TEST_HOME: HOME,
    STATE_DB_PATH: path.join(HOME, '.troth', 'state.db'),
    CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin')
  });
}
function fire(env, sess) {
  const payload = JSON.stringify({
    tool_name: 'Read', session_id: sess, cwd: '/x',
    tool_input: { file_path: '/x/.claude/projects/thing/memory/MEMORY.md' }
  });
  const r = cp.spawnSync('node', [path.join(ROOT, 'plugin', 'hooks', 'pre-action-recall.mjs')],
    { env, input: payload, encoding: 'utf8', timeout: 30000 });
  return JSON.parse(r.stdout.trim()).hookSpecificOutput;
}
function fireShell(env, sess, command) {
  const payload = JSON.stringify({
    tool_name: 'mcp__plugin_troth_troth-bash__run', session_id: sess, cwd: '/x',
    tool_input: { command }
  });
  const r = cp.spawnSync('node', [path.join(ROOT, 'plugin', 'hooks', 'pre-action-recall.mjs')],
    { env, input: payload, encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '').trim();
  if (!out || out === '{}') return null;          // hook stayed silent
  return JSON.parse(out).hookSpecificOutput || null;
}
function seed(env) {
  // Seed through the real writers so FTS rows exist the way production makes
  // them: one commitment worth remembering, one fresh intent naming the topic.
  const seedSrc = `
    const state = require(${JSON.stringify(path.join(ROOT, 'shared-core', 'state.js'))});
    const ar = require(${JSON.stringify(path.join(ROOT, 'shared-core', 'action-record.js'))});
    for (const [type, output] of [
      ['commitment', { statement: 'The parser rewrite keeps the tokenizer table frozen until release', commitment_type: 'engram' }],
      ['intent', {}]
    ]) {
      const rec = ar.create({
        type, agent_id: 'suite-57', session_id: 'seed', cwd: '/x',
        input: type === 'intent'
          ? { goal: 'continue the parser rewrite tokenizer work', source_message_hash: 'msf-hash' }
          : { source: 'suite-57' },
        output: type === 'intent' ? { chosen_path: 'observed' } : output
      });
      if (type === 'commitment') { rec.audience = 'model_visible'; }
      const v = ar.validate(rec);
      if (!v.ok) { console.error(JSON.stringify(v.errors)); process.exit(1); }
      state.recordAction(rec, ar.toSearchText(rec));
    }
    console.log('seeded');
  `;
  const r = cp.spawnSync('node', ['-e', seedSrc], { env, encoding: 'utf8', timeout: 20000 });
  assert.ok(/seeded/.test(r.stdout), 'seed wrote: ' + (r.stderr || r.stdout).slice(0, 200));
}

test('MSF-1: with matching memories held, the first walk asks and shows them', function () {
  const env = mkEnv();
  seed(env);
  const out = fire(env, 'msf-one-'+RUN);
  assert.strictEqual(out.permissionDecision, 'ask', 'first walk is an ask');
  assert.ok(/substrate already remembers/.test(out.permissionDecisionReason), 'and says why');
  assert.ok(/tokenizer table frozen/.test(out.permissionDecisionReason),
    'with the actual memory inside: ' + out.permissionDecisionReason.slice(0, 200));
  assert.ok(/troth_recall/.test(out.permissionDecisionReason), 'and the road to the full answer');
});

test('MSF-2: the second walk of the same session is a steer, not a nag', function () {
  const env = mkEnv();
  seed(env);
  fire(env, 'msf-two-'+RUN);
  const second = fire(env, 'msf-two-'+RUN);
  assert.strictEqual(second.permissionDecision, 'allow');
  assert.ok(/MEMORY file/.test(second.additionalContext), 'the plain steer remains');
});

test('MSF-3: an empty substrate steers instead of asking — a fresh install is never blocked on nothing', function () {
  const env = mkEnv();   // no seed
  const out = fire(env, 'msf-three-'+RUN);
  assert.strictEqual(out.permissionDecision, 'allow',
    'nothing to show means nothing to ask about');
  assert.ok(/MEMORY file/.test(out.additionalContext));
});

test('MSF-4: the same hunt through the shell is caught, not just through Read', function () {
  // The matcher always listed Bash; only the file-path fields were read, so a
  // search for prior work across the home document folders walked straight past
  // a guard that stops the identical search through Read.
  const env = mkEnv();
  seed(env);
  const out = fireShell(env, 'msf-four-'+RUN,
    'find ~/Desktop ~/Downloads ~/Documents -type f -name "*.md" -mtime -2');
  assert.ok(out, 'the shell hunt must not pass silently');
  assert.strictEqual(out.permissionDecision, 'ask');
  assert.ok(/substrate already remembers|MEMORY file/.test(
    out.permissionDecisionReason || out.additionalContext || ''), 'and says why');
});

test('MSF-5: naming a memory file in a shell command is caught too', function () {
  const env = mkEnv();
  seed(env);
  const out = fireShell(env, 'msf-five-'+RUN, 'grep -rn troth ~/.claude/projects/x/memory/MEMORY.md');
  assert.ok(out, 'a shell command naming a memory surface must not pass silently');
});

test('MSF-6: ordinary repo work through the shell stays silent', function () {
  // A guard that fires on every search is a guard that gets turned off.
  const env = mkEnv();
  seed(env);
  for (const cmd of [
    'find src -name "*.js" -newer package.json',
    'node tests/test-all.js',
    'grep -rn scaleUsage proxy/server.js',
    'ls -la dist/'
  ]) {
    assert.strictEqual(fireShell(env, 'msf-six-'+RUN+'-'+cmd.length, cmd), null,
      'must stay silent for: ' + cmd);
  }
});


};
