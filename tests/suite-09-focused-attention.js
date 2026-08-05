// SPDX-License-Identifier: AGPL-3.0-only
// Focused attention (COCKPIT-DESIGN-v0.1.md section 14): dialogue turns are
// stamped with their conversation thread (session_id column) and the
// INJECTED working window can be scoped by thread (cockpit panes) or by
// project cwd (plugin sessions), while unscoped reads keep the one-mind
// cross-surface default byte-for-byte. Root motivation: parallel projects
// through the plugin cross-bled their threads.
module.exports = function run({ test }) {
const assert = require('assert');
const dm = require('../shared-core/dialogue-memory.js');

console.log('Focused attention:');

const AID = 'fa-suite-agent';

function rec(conv, cwd, u, a) {
  return dm.recordTurn({
    agent_id: AID,
    cwd,
    user_text: u,
    assistant_text: a,
    conversation_id: conv,
  });
}

test('FA-1: a stamped turn round-trips through a conversation-scoped read', () => {
  assert.strictEqual(rec('fa-conv-A', '/tmp/fa-p1', 'design the site hero', 'hero drafted'), true);
  const turns = dm.recentTurns({ agent_id: AID, conversation_id: 'fa-conv-A', limit: 10 });
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].user_text, 'design the site hero');
});

test('FA-2: thread isolation, pane A never sees pane B turns', () => {
  assert.strictEqual(rec('fa-conv-B', '/tmp/fa-p1', 'pick the logo colors', 'palette picked'), true);
  assert.strictEqual(rec('fa-conv-A', '/tmp/fa-p1', 'now the pricing section', 'pricing drafted'), true);
  const a = dm.recentTurns({ agent_id: AID, conversation_id: 'fa-conv-A', limit: 10 });
  assert.deepStrictEqual(a.map((t) => t.user_text), ['design the site hero', 'now the pricing section']);
  const b = dm.recentTurns({ agent_id: AID, conversation_id: 'fa-conv-B', limit: 10 });
  assert.deepStrictEqual(b.map((t) => t.user_text), ['pick the logo colors']);
});

test('FA-3: legacy unstamped rows never leak into a scoped window', () => {
  assert.strictEqual(
    dm.recordTurn({ agent_id: AID, cwd: '/tmp/fa-p1', user_text: 'legacy unscoped turn', assistant_text: 'ok' }),
    true,
  );
  const a = dm.recentTurns({ agent_id: AID, conversation_id: 'fa-conv-A', limit: 10 });
  assert(!a.some((t) => t.user_text === 'legacy unscoped turn'));
});

test('FA-4: unscoped read is the unchanged one-mind window (sees every thread)', () => {
  const all = dm.recentTurns({ agent_id: AID, limit: 20 });
  const texts = all.map((t) => t.user_text);
  for (const expected of [
    'design the site hero',
    'pick the logo colors',
    'now the pricing section',
    'legacy unscoped turn',
  ]) {
    assert(texts.includes(expected), 'missing from global window: ' + expected);
  }
});

test('FA-5: same_cwd hard-filters by project; default read still crosses cwds', () => {
  assert.strictEqual(rec('fa-conv-C', '/tmp/fa-p2', 'other project turn', 'done'), true);
  const p1 = dm.recentTurns({ agent_id: AID, cwd: '/tmp/fa-p1', same_cwd: true, limit: 20 });
  assert(!p1.some((t) => t.user_text === 'other project turn'));
  assert(p1.some((t) => t.user_text === 'design the site hero'));
  const noFilter = dm.recentTurns({ agent_id: AID, cwd: '/tmp/fa-p1', limit: 20 });
  assert(noFilter.some((t) => t.user_text === 'other project turn'));
});

test('FA-6: scoped read returns chronological order (append-ready)', () => {
  const a = dm.recentTurns({ agent_id: AID, conversation_id: 'fa-conv-A', limit: 10 });
  assert(a.length >= 2);
  for (let i = 1; i < a.length; i++) assert(a[i].ts >= a[i - 1].ts);
});

test('FA-7: skillSummaries feeds the slash popup (names + shapes, sorted)', () => {
  const loader = require('../shared-core/slash/loader.js');
  const skills = loader.skillSummaries(process.cwd());
  assert(Array.isArray(skills) && skills.length >= 10, 'expected the core skill set, got ' + skills.length);
  const names = skills.map((s) => s.name);
  for (const expected of ['recall', 'remember', 'goal', 'context', 'think']) {
    assert(names.includes(expected), 'missing core skill: ' + expected);
  }
  for (const s of skills) {
    assert(typeof s.name === 'string' && s.name.length > 0);
    assert(typeof s.description === 'string');
    assert(typeof s.deterministic === 'boolean');
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(names, sorted, 'summaries must be name-sorted');
});

test('FA-8: jobs_status tool is registered and lists cleanly with no runs', async () => {
  const tools = require('../shared-core/substrate-tools.js');
  assert(tools.REGISTRY.jobs_status, 'jobs_status missing from REGISTRY');
  assert.strictEqual(tools.REGISTRY.jobs_status.schema.function.name, 'jobs_status');
  const r = await tools.REGISTRY.jobs_status.run({}, {});
  assert.strictEqual(r.ok, true);
  assert(Array.isArray(r.runs));
  assert.strictEqual(r.count, r.runs.length);
});

test('FA-9: jobs_status unknown run id fails closed, not thrown', async () => {
  const tools = require('../shared-core/substrate-tools.js');
  const r = await tools.REGISTRY.jobs_status.run({ run_id: 'no-such-run-xyz' }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'run_not_found');
});

test('FA-10: jobs_status run detail returns a REAL multi-line log tail', async () => {
  // the autonomy design: "the entity gets a runs tool... (list, status, log tail)".
  // Hermetic runs dir via TROTH_RUNS_DIR; runner.js re-required so its
  // module-level RUNS_DIR picks the override up. substrate-tools requires
  // the runner per call, so purging the runner alone is enough.
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const runnerPath = require.resolve('../bin/runner.js');
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa10-runs-'));
  const runId = 'fa10-fake-run';
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
    id: runId, task: 'tail me', branch: 'troth/fa10', started_at: '2026-07-03T00:00:00Z',
  }));
  fs.writeFileSync(path.join(runDir, 'exit-code'), '0\n'); // deterministic state, no Docker
  const logLines = [];
  for (let i = 1; i <= 60; i++) logLines.push('line-' + String(i).padStart(2, '0') + ' tool_call payload ' + 'x'.repeat(60));
  fs.writeFileSync(path.join(runDir, 'log.txt'), logLines.join('\n') + '\n');
  process.env.TROTH_RUNS_DIR = runsDir;
  delete require.cache[runnerPath];
  try {
    const tools = require('../shared-core/substrate-tools.js');
    const r = await tools.REGISTRY.jobs_status.run({ run_id: runId }, {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.run.state, 'done');
    const log = r.run.log;
    assert.strictEqual(log.lastLine, undefined, 'the 100-char lastLine stub must be gone');
    const got = log.tail.split('\n');
    assert.strictEqual(got.length, 40, 'default tail is the last 40 lines, got ' + got.length);
    assert.strictEqual(got[0], logLines[20], 'tail must start 40 lines from the end');
    assert.strictEqual(got[39], logLines[59], 'tail must end at the LAST line');
    assert.strictEqual(log.tail_lines, 40);
    assert.strictEqual(log.truncated, true);
    assert(log.total_bytes > 0);
    // tail_lines is honored
    const r5 = await tools.REGISTRY.jobs_status.run({ run_id: runId, tail_lines: 5 }, {});
    const got5 = r5.run.log.tail.split('\n');
    assert.strictEqual(got5.length, 5);
    assert.strictEqual(got5[4], logLines[59]);
  } finally {
    delete process.env.TROTH_RUNS_DIR;
    delete require.cache[runnerPath]; // later suites get the default dir back
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
};
