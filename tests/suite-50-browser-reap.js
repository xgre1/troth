// SPDX-License-Identifier: AGPL-3.0-only
// What the idle reaper is allowed to close.
//
// The reaper exists so nothing troth starts outlives its usefulness on a
// machine whose owner has no idea these processes exist. It covers the
// embedder, the reranker, the chat model and the browser.
//
// For three of the four it worked. The browser was exempt, always, by a guard
// that read "only collect a headless tree" — written to protect a window
// somebody might be reading. The agent's browser is deliberately headed,
// because every mainstream search page refuses a headless CDP session, so the
// guard covered the exact process it was written to collect.
//
// Measured on one machine before this file existed: six Chrome processes
// holding 575 MB, two days old, forty-eight hours after the last recorded use,
// with the reaper running the entire time and a thirty-minute threshold set.
//
// These check the rules that decide, not the killing. The killing is two pkill
// lines and a timeout; the judgement is the part that was wrong.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { mayReapBrowser } = require(path.join(ROOT, 'shared-core', 'browser-reap.js'));

console.log('\nBrowser reaping (REAP):');

const PROFILE = '/somewhere/.troth/agent-browser-profile';
const HOUR = 3600000;
const NOW = 1786600000000;
const ours    = ['4711 /Applications/Chrome --remote-debugging-port=18222 --user-data-dir=' + PROFILE];
const theirs  = ['4712 /Applications/Chrome --remote-debugging-port=18222 --user-data-dir=/somewhere/Library/Chrome'];
const headless = ['4713 /Applications/Chrome --headless=new --remote-debugging-port=18222 --user-data-dir=' + PROFILE];

const ask = (o) => mayReapBrowser(Object.assign({
  port: 18222, now: NOW, idleMs: 2 * HOUR, agentProfile: PROFILE
}, o));

test('REAP-1: the browser troth started, idle for two days, is collected', () => {
  const v = ask({ lastUse: NOW - 48 * HOUR, procLines: ours });
  assert.strictEqual(v.reap, true, 'this is the case that was leaking: ' + v.reason);
});

test('REAP-2: being headed no longer makes it immortal', () => {
  // The whole defect in one assertion. Both lines below are headed; the only
  // difference is whose profile they carry.
  assert.strictEqual(ask({ lastUse: NOW - 48 * HOUR, procLines: ours }).reap, true, 'ours goes');
  assert.strictEqual(ask({ lastUse: NOW - 48 * HOUR, procLines: theirs }).reap, false, 'a stranger stays');
});

test('REAP-3: the operator\'s own debug browser is never touched', () => {
  const v = ask({ port: 9222, lastUse: NOW - 48 * HOUR, procLines: ours });
  assert.strictEqual(v.reap, false, 'port 9222 is theirs, whatever the profile says');
  assert.ok(/operator/.test(v.reason), 'and it says why: ' + v.reason);
});

test('REAP-4: a browser nobody asked troth to drive is not troth\'s to close', () => {
  // Human use writes no stamp. Silence means "cannot know", never "idle".
  const v = ask({ lastUse: 0, procLines: ours });
  assert.strictEqual(v.reap, false);
  assert.ok(/cannot know/.test(v.reason), v.reason);
});

test('REAP-5: recent use keeps it, on the longer leash a browser gets', () => {
  assert.strictEqual(ask({ lastUse: NOW - 30 * 60000, procLines: ours }).reap, false,
    'half an hour is nothing for a page somebody may still be reading');
  assert.strictEqual(ask({ lastUse: NOW - 3 * HOUR, procLines: ours }).reap, true,
    'three hours past a two-hour leash is not');
});

test('REAP-6: a headless tree of ours is still collected, as it always was', () => {
  assert.strictEqual(ask({ lastUse: NOW - 48 * HOUR, procLines: headless }).reap, true,
    'the previous behaviour is kept, not replaced');
});

test('REAP-7: nothing running is not something to kill', () => {
  const v = ask({ lastUse: NOW - 48 * HOUR, procLines: [] });
  assert.strictEqual(v.reap, false, v.reason);
});

test('REAP-8: the reaper and the launcher name the same directory (source pin)', () => {
  // Two copies of this path is two places to get it wrong, and the symptom
  // would be a browser that is never recognised as ours — which is exactly
  // the bug being fixed, wearing a different hat.
  const daemon = require(path.join(ROOT, 'shared-core', 'perception', 'chromium-daemon.js'));
  assert.strictEqual(typeof daemon.defaultProfileDir, 'function',
    'the daemon that creates the profile is the one that names it');
  assert.ok(/agent-browser-profile$/.test(daemon.defaultProfileDir()),
    'and it is the agent\'s own: ' + daemon.defaultProfileDir());
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  assert.ok(/defaultProfileDir\(\)/.test(src), 'the reaper asks it rather than rebuilding the path');
  assert.ok(/mayReapBrowser/.test(src), 'and it asks browser-reap.js for the verdict');
  assert.ok(/what: 'browser'[^\n]*mult:/.test(src), 'the browser carries its longer leash');
});

test('REAP-9: a browser with no profile of ours on the line is left alone', () => {
  // Defensive: if the daemon ever stops passing --user-data-dir, `ours` goes
  // false and the old, safe behaviour returns rather than a wrong kill.
  const v = mayReapBrowser({
    port: 18222, now: NOW, idleMs: 2 * HOUR, agentProfile: '',
    lastUse: NOW - 48 * HOUR, procLines: ours
  });
  assert.strictEqual(v.reap, false, 'unknown ownership is not permission: ' + v.reason);
});
};
