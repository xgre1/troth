// SPDX-License-Identifier: AGPL-3.0-only
// The two rules that graduated from warning to wall.
//
// In-context rules do not bind behavior — measured here at roughly sixty
// corrections from hard enforcement for every one from advice. The two
// deterministic HOW-rules ran warn-first for six weeks to price their false
// positives: ten firings, every one genuine — success claimed with zero
// tools run, or a file edited without being read that turn. On that record
// they now block, which forces the turn to regenerate with the reason in
// view instead of shipping the unbacked claim.
//
// The checks are deterministic on the turn's own trace — no second model,
// no judgment call — which is what makes a block safe to hold.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const critic = require(path.join(ROOT, 'shared-core', 'critic.js'));

console.log('\nHOW-rails enforcement (HOWR):');

test('HOWR-1: a success claim with zero tools run blocks the turn', () => {
  const r = critic.review('Everything works now — the fix is verified and tests pass.',
    { how_rules: true, toolCallsInTurn: 0 });
  assert.strictEqual(r.ok, false, 'unbacked claims do not ship');
  assert.ok(/verify-evidence/.test(r.reasons.join(' ')), 'and the reason names the rule');
});

test('HOWR-2: the same claim with tools run in the turn passes — evidence was plausibly shown', () => {
  const r = critic.review('Everything works now — tests pass.',
    { how_rules: true, toolCallsInTurn: 3 });
  assert.strictEqual(r.ok, true, 'the zero-tool guard is the precision guard');
});

test('HOWR-3: an edit to a file never read this turn blocks', () => {
  const r = critic.review('Edited the parser.', {
    how_rules: true, toolCallsInTurn: 2,
    toolSequence: [{ name: 'edit', target: '/x/parser.js' }]
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/verify-first/.test(r.reasons.join(' ')));
  const ok = critic.review('Edited the parser.', {
    how_rules: true, toolCallsInTurn: 2,
    toolSequence: [{ name: 'cached_read', target: '/x/parser.js' }, { name: 'edit', target: '/x/parser.js' }]
  });
  assert.strictEqual(ok.ok, true, 'reading first — by any read tool — satisfies it');
});

test('HOWR-4: both rules carry block severity, and new rules still start as warn (source pin)', () => {
  for (const r of critic.DETERMINISTIC_HOW_RULES) {
    if (r.id === 'verify-evidence' || r.id === 'verify-before-edit') {
      assert.strictEqual(r.severity, 'block', r.id + ' graduated on its measured record');
    }
  }
  const src = require('fs').readFileSync(path.join(ROOT, 'shared-core', 'critic.js'), 'utf8');
  assert.ok(/New rules START as warn/.test(src),
    'the graduation discipline is stated where the next rule will be written');
});
};
