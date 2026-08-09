// SPDX-License-Identifier: AGPL-3.0-only
// Plan-window usage — the honest half of "show my 5h usage"
// (PLAN-COHERENCE item 5). planWindow sums ONLY subscription-marked rows
// (' (plan)'), only inside the trailing window, grouped by plan family.
// Consumption only — the endpoint never invents a percentage. Deltas
// against a baseline so sibling suites' ledger rows never flake this.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const usage = require(path.join(ROOT, 'shared-core', 'claude-usage-ingest.js'));

console.log('\nPlan-window usage (USAGE):');

test('USAGE-1: plan rows in-window, by family; API rows and stale rows stay out', () => {
  const before = usage.planWindow(5);
  const b = (fam, k) => (before.families[fam] ? before.families[fam][k] : 0) || 0;
  const db = state.db();
  const ins = db.prepare('INSERT INTO usage_ledger (ts, model, tokens_in, tokens_out, cached_in, requests) VALUES (?,?,?,?,?,?)');
  const now = Date.now();
  ins.run(now - 60e3, 'claude-fable-5 (plan)', 1000, 200, 5000, 1);
  ins.run(now - 60e3, 'claude-opus-5 (plan)', 500, 100, 0, 1);
  ins.run(now - 60e3, 'kimi-k3 (plan)', 300, 50, 0, 1);
  ins.run(now - 60e3, 'claude-fable-5', 999999, 1, 0, 1);              // API-rate row: not plan
  ins.run(now - 10 * 3600e3, 'claude-fable-5 (plan)', 7777, 1, 0, 1);  // outside the 5h window

  const w = usage.planWindow(5);
  assert.strictEqual((w.families.claude.tokens_in || 0) - b('claude', 'tokens_in'), 1500, 'claude family sums its plan rows only');
  assert.strictEqual((w.families.claude.tokens_out || 0) - b('claude', 'tokens_out'), 300);
  assert.strictEqual((w.families.claude.cached_in || 0) - b('claude', 'cached_in'), 5000, 'cache reads counted separately, not hidden');
  assert.strictEqual((w.families.claude.requests || 0) - b('claude', 'requests'), 2);
  assert.strictEqual((w.families.kimi.tokens_in || 0) - b('kimi', 'tokens_in'), 300, 'kimi is its own family');
  // The window clamps to sane bounds and reports what it used.
  assert.strictEqual(usage.planWindow(0).hours, 5, 'nonsense hours fall back to the default');
  assert.strictEqual(usage.planWindow(9999).hours, 168, 'window caps at a week');
  // No percentage anywhere in the shape — consumption only, by design.
  assert.ok(!('percent' in w) && !('ratio' in w), 'no invented denominator');
});
};
