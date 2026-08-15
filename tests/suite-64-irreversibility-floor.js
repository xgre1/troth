// SPDX-License-Identifier: AGPL-3.0-only
// The stakes of an action are set by what it can do, not by what it claims.
//
// The seal wall (irreversibility_sealed) existed and held — for intents that
// told the truth about their class. But the dispatcher evaluated the wall on
// the intent's SELF-DECLARED class: an intent labeled 'low' aimed at a
// shell adapter (declared high) passed the predicate silently AND skipped
// the effect ledger. P7.4 closes the walk-around: the adapter's declared
// reach is the FLOOR — the intent's claim can raise the effective class,
// never lower it — and both the revalidation predicate and the effect
// ledger now judge the effective class.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dispatcher = require(path.join(ROOT, 'shared-core', 'dispatcher.js'));

console.log('\nIrreversibility floor (IRF):');

test('IRF-1: the effective class is the max of claim and adapter reach — the full truth table', () => {
  const f = dispatcher._effectiveIrrev;
  assert.strictEqual(f('low', 'high'), 'high', 'under-declaration is corrected upward');
  assert.strictEqual(f('high', 'low'), 'high', 'an honest high claim stands over a mild adapter');
  assert.strictEqual(f('medium', 'medium'), 'medium');
  assert.strictEqual(f('sealed_only', 'high'), 'sealed_only', 'the strictest class always wins');
  assert.strictEqual(f(undefined, 'high'), 'high', 'a missing claim inherits the adapter floor');
  assert.strictEqual(f('nonsense', 'medium'), 'medium', 'an invalid claim falls to low, then the floor lifts it');
  assert.strictEqual(f(undefined, undefined), 'low', 'nothing declared anywhere stays low');
});

test('IRF-2: the revalidation wall judges the effective class, not the claim', () => {
  // The predicate chain needs seeded sealed engrams to reach the
  // irreversibility check on a real row, so the plumbing is pinned with a
  // stubbed predicate registry instead: what matters HERE is that the
  // override reaches what the predicates see — the predicate's own
  // refusal behavior is pinned separately (L4-STVC-IRR-1, suite-07).
  const sm = require(path.join(ROOT, 'shared-core', 'state-machine.js'));
  const original = sm.PREDICATE_KINDS;
  const seen = [];
  try {
    sm.PREDICATE_KINDS = {
      grounded_in_sealed: () => null,
      capability_covers_intent: () => null,
      not_globally_paused: () => null,
      irreversibility_sealed: (_p, ctx) => {
        const cls = ctx.proposed.output.irreversibility_class;
        seen.push(cls);
        return (cls === 'high' || cls === 'sealed_only') ? 'no seals on ' + cls + ' intent' : null;
      }
    };
    const row = {
      id: 'itest', scope: 'intent:shell:do', grounded_in: [], capability_ref: null,
      irreversibility_class: 'low', seals: [], idempotency_key: 'k1'
    };
    const refused = dispatcher._revalidateIntent(row, 'high');
    assert.strictEqual(refused.ok, false, 'the wall fires on the effective class');
    assert.ok(/irreversibility_sealed/.test(refused.refusal_reason), refused.refusal_reason);
    const passed = dispatcher._revalidateIntent(row, 'low');
    assert.strictEqual(passed.ok, true, 'and stays silent for genuinely low effects');
    assert.deepStrictEqual(seen, ['high', 'low'],
      'the predicates judged the EFFECTIVE class both times, never the row\'s claim');
  } finally {
    sm.PREDICATE_KINDS = original;
  }
});

test('IRF-3: the dispatch pipeline wires the floor end to end (source pins)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared-core', 'dispatcher.js'), 'utf8');
  const adapterIdx = src.indexOf('const adapter = _findAdapter(intentRow.scope)');
  const revalIdx = src.indexOf('const recheck = _revalidateIntent(intentRow, effectiveIrrev)');
  assert.ok(adapterIdx !== -1 && revalIdx !== -1 && adapterIdx < revalIdx,
    'the adapter is resolved before revalidation — the floor needs its declared reach');
  assert.ok(/const _irrev = effectiveIrrev;/.test(src),
    'the effect ledger keys on the effective class too — an under-declared effect is still deduped');
});
};
