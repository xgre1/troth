// SPDX-License-Identifier: AGPL-3.0-only
// The hook that enriches prompts must never cost the prompt its context.
//
// The UserPromptSubmit injector walks recall, entities, epistemic density,
// precedents — work that scales with prompt length and machine load. The
// harness gives it 25 seconds and then discards its ENTIRE output. Observed
// live: two task notifications (~15KB machine payloads riding the same
// hook) blew that budget under load, and the turns lost recall wholesale.
// Three disciplines pinned here: machine-generated turns exit immediately
// (they are not operator prompts), analysis reads at most the head of a
// huge prompt, and the enrichment walk carries its own soft deadline so
// partial context ships instead of everything dying at the harness wall.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'plugin', 'hooks', 'injector.mjs');

console.log('\nHook budget discipline (HKB):');

test('HKB-1: a task-notification prompt exits fast and empty — no enrichment for machine turns', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const env = Object.assign({}, process.env, {
    HOME, _TROTH_TEST_HOME: HOME,
    STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
  });
  const notif = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n' +
    'x'.repeat(15000) + '\n</task-notification>';
  const t0 = Date.now();
  const r = cp.spawnSync('node', [HOOK], {
    env, input: JSON.stringify({ user_prompt: notif, cwd: HOME, session_id: 'hkb1' }),
    encoding: 'utf8', timeout: 20000
  });
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, 0, 'the hook contract holds');
  assert.strictEqual((r.stdout || '').trim(), '{}', 'no context spent on a machine turn');
  assert.ok(ms < 5000, 'and the exit is the fast path, not a full walk: ' + ms + 'ms');
});

test('HKB-2: the fast path is narrow and the analysis input is capped (source pins)', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.ok(/\^\\s\*\(\\\[SYSTEM NOTIFICATION\|<task-notification\)/.test(src),
    'the notification detector is anchored at the start — prose MENTIONING a notification still enriches');
  assert.ok(/_rawPrompt\.length > 6000/.test(src),
    'analysis reads at most the head of an oversized prompt');
  const guards = (src.match(/hookTimeLeft\(\)/g) || []).length;
  assert.ok(guards >= 6, 'the heavy sections each check the soft deadline: ' + guards + ' guards');
});

test('HKB-3: the soft deadline leaves real headroom under the harness wall', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const m = src.match(/_deadline = Date\.now\(\) \+ (\d+)/);
  assert.ok(m, 'the deadline is a named constant, findable');
  const soft = parseInt(m[1], 10);
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  const ups = hooks.hooks.UserPromptSubmit[0].hooks.find(h => /injector\.mjs/.test(h.command));
  assert.ok(ups && ups.timeout, 'the harness timeout is declared where the hook is wired');
  assert.ok(soft <= (ups.timeout * 1000) / 2,
    'soft deadline (' + soft + 'ms) stays at or under half the harness wall (' + ups.timeout + 's) — ' +
    'late sections still have time to ship what accumulated');
});
};
