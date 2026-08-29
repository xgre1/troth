// SPDX-License-Identifier: AGPL-3.0-only
// The inventory behind "why is the laptop hot".
//
// troth keeps long-lived children on the machine it runs on: a proxy, two
// small model servers, sometimes a chat model, sometimes a browser, one MCP
// server set per editor session. When the machine heats up the question is
// which of those is doing it, and the first number a shell offers (%CPU) is a
// lifetime average that names the wrong process. Cumulative CPU time and
// resident memory are the two numbers that identify a burner; this module
// reports those.
//
// The parser is pure so the classification is provable on a fixture instead
// of on whatever happens to be running where the suite runs.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sl = require(path.join(ROOT, 'shared-core', 'system-load.js'));

console.log('\nSystem load inventory (SYS):');

const HOME = '/somewhere';
const PROFILE = HOME + '/.troth/agent-browser-profile';
const FIXTURE = [
  '  PID   RSS TIME ARGS',
  ' 4001 153600 01:02:03 troth-proxy-8000',
  ' 4002 740352 00:07:23 /somewhere/.troth/bin/llama-server -m x.gguf --reranking --port 11438 -ngl 999',
  ' 4003 401408 12:00 /somewhere/.troth/bin/llama-server -m y.gguf --embeddings --port 11437',
  ' 4004 585728 1-02:03:04 /Applications/Chrome --remote-debugging-port=18222 --user-data-dir=' + PROFILE,
  ' 4005 512000 00:00:09 /Applications/Chrome --remote-debugging-port=9222 --user-data-dir=/somewhere/Library/Chrome',
  ' 4006  81920 00:00:33 node /somewhere/repo/plugin/mcp-servers/troth-bash/server.mjs',
  ' 4007  10240 00:00:01 grep something-unrelated'
].join('\n');

test('SYS-1: troth-owned processes are recognised, nothing else is', () => {
  const rows = sl.parsePsSnapshot(FIXTURE, { home: HOME, agentProfile: PROFILE });
  const roles = rows.map(r => r.role).sort();
  assert.deepStrictEqual(roles, ['browser', 'embedder', 'mcp:troth-bash', 'proxy', 'reranker'],
    'exactly the five: ' + JSON.stringify(roles));
});

test('SYS-2: the operator\'s own browser is not in the inventory', () => {
  // Same binary, same flag shape, different profile: none of this card's
  // business — the rule the reaper already lives by.
  const rows = sl.parsePsSnapshot(FIXTURE, { home: HOME, agentProfile: PROFILE });
  assert.ok(!rows.some(r => r.pid === 4005), 'port 9222 with their profile stays invisible');
});

test('SYS-3: CPU is time consumed, parsed across every ps shape', () => {
  // MM:SS, HH:MM:SS and DD-HH:MM:SS all occur in the wild; the DD- form is
  // exactly the one a two-day-old forgotten browser reports.
  assert.strictEqual(sl.parseCpuTime('00:07:23'), 443);
  assert.strictEqual(sl.parseCpuTime('12:00'), 720);
  assert.strictEqual(sl.parseCpuTime('1-02:03:04'), 93784);
  const rows = sl.parsePsSnapshot(FIXTURE, { home: HOME, agentProfile: PROFILE });
  const browser = rows.find(r => r.role === 'browser');
  assert.strictEqual(browser.cpu_seconds, 93784, 'the day-old browser carries its true total');
  assert.strictEqual(browser.rss_mb, 572, 'and its memory in MB');
});

test('SYS-4: the leash matches the reaper, role for role', () => {
  const prev = process.env.TROTH_MODEL_IDLE_MIN;
  try {
    process.env.TROTH_MODEL_IDLE_MIN = '30';
    assert.strictEqual(sl.leashMinutes('embedder'), 30);
    assert.strictEqual(sl.leashMinutes('reranker'), 30);
    assert.strictEqual(sl.leashMinutes('local chat'), 60, 'chat carries the 2x leash');
    assert.strictEqual(sl.leashMinutes('browser'), 120, 'the browser carries the 4x leash');
    assert.strictEqual(sl.leashMinutes('proxy'), null, 'the proxy is never idle-reaped');
    process.env.TROTH_MODEL_IDLE_MIN = '0';
    assert.strictEqual(sl.leashMinutes('embedder'), null, 'reaper off means no countdown, not a lie');
  } finally {
    if (prev === undefined) delete process.env.TROTH_MODEL_IDLE_MIN; else process.env.TROTH_MODEL_IDLE_MIN = prev;
  }
});

test('SYS-5: a live snapshot answers in the documented shape without throwing', () => {
  const s = sl.snapshot();
  assert.ok(s && typeof s.ts === 'number');
  assert.ok(s.machine && s.machine.cores >= 1);
  assert.ok(Array.isArray(s.processes), 'processes is always an array');
  for (const p of s.processes) {
    assert.ok(typeof p.role === 'string' && typeof p.rss_mb === 'number' && typeof p.cpu_seconds === 'number');
  }
});
};
