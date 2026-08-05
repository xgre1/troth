#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// composeEnvelope unit test (single-mind). Verifies the single-mind invariant:
// union of both pools, flagged-excluded from BOTH, dedup, authority×salience
// ranking via the shared fail-neutral model, hard budget.
const assert = require('assert');
const path = require('path');
const { composeEnvelope } = require(path.join(__dirname, '..', 'shared-core', 'identity-envelope.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// Fake listEngrams that returns different rows per query shape.
function makeList(anchorRows, identityRows) {
  return (q) => {
    if (q && q.commitment_type === 'anchor') return anchorRows;
    if (q && q.scope === 'identity') return identityRows;
    return [];
  };
}

console.log('\n=== composeEnvelope (single identity surface) ===\n');

t('unions both pools (anchors + scope:identity)', () => {
  const list = makeList(
    [{ statement: 'I am the operator\'s partner', salience: 2, source_authority: 'operator_confirmed' }],
    [{ statement: 'operator prefers terse reviews', salience: 1, source_authority: 'operator_confirmed' }]
  );
  const { items } = composeEnvelope({ listEngrams: list });
  const texts = items.map(i => i.statement);
  assert.ok(texts.includes('I am the operator\'s partner'), 'anchor present');
  assert.ok(texts.includes('operator prefers terse reviews'), 'identity engram present');
});

t('excludes tier=flagged from BOTH pools (fixes the anchor leak)', () => {
  const list = makeList(
    [{ statement: 'flagged anchor', salience: 9, tier: 'flagged', source_authority: 'operator_confirmed' },
     { statement: 'good anchor', salience: 1, source_authority: 'operator_confirmed' }],
    [{ statement: 'flagged identity', salience: 9, tier: 'flagged' }]
  );
  const { items } = composeEnvelope({ listEngrams: list });
  const texts = items.map(i => i.statement);
  assert.ok(!texts.includes('flagged anchor'), 'flagged anchor excluded (was the leak)');
  assert.ok(!texts.includes('flagged identity'), 'flagged identity excluded');
  assert.ok(texts.includes('good anchor'), 'unflagged anchor kept');
});

t('dedups by normalized statement, anchor wins over identity', () => {
  const list = makeList(
    [{ statement: 'Same Fact', salience: 1, source_authority: 'operator_confirmed' }],
    [{ statement: 'same fact', salience: 5, source_authority: 'llm_inferred' }]
  );
  const { items } = composeEnvelope({ listEngrams: list });
  const same = items.filter(i => i.statement.toLowerCase() === 'same fact');
  assert.strictEqual(same.length, 1, 'deduped to one');
  assert.strictEqual(same[0].source, 'anchor', 'anchor instance won the dedup');
});

t('unlabeled (no source_authority) rides the conservative floor, below operator_confirmed', () => {
  // Grounded  against the live source distribution: the unlabeled
  // engram pool is dominated by low-trust provenance (test/seed/deliberator/
  // watcher), so unlabeled defaults to the regex_extracted floor (0.30), NOT
  // parity with operator-confirmed (the reverted d7b614f 1.00 regression). The
  // real upgrade is source-derived authority (operator decision #4).
  const list = makeList(
    [],
    [{ statement: 'labeled op fact', salience: 1, source_authority: 'operator_confirmed' },
     { statement: 'legacy unlabeled fact', salience: 1 }] // no source_authority
  );
  const { items } = composeEnvelope({ listEngrams: list });
  const op = items.find(i => i.statement === 'labeled op fact');
  const legacy = items.find(i => i.statement === 'legacy unlabeled fact');
  assert.ok(op && legacy, 'both present (unlabeled still surfaces, just lower-ranked)');
  assert.ok(op.score > legacy.score, 'operator_confirmed must outrank unlabeled; got op=' + op.score + ' legacy=' + legacy.score);
  assert.ok(Math.abs(legacy.score - 0.30) < 1e-9, 'unlabeled rides the conservative 0.30 floor; got ' + legacy.score);
});

t('ranks by salience × authority and honors the item budget', () => {
  const list = makeList(
    [],
    Array.from({ length: 20 }, (_, i) => ({ statement: 'fact ' + i, salience: i, source_authority: 'operator_confirmed' }))
  );
  const { items, block } = composeEnvelope({ listEngrams: list, budgetItems: 5 });
  assert.strictEqual(items.length, 5, 'capped to budget');
  assert.strictEqual(items[0].statement, 'fact 19', 'highest salience first');
  assert.ok(block.startsWith('<memory_identity>') && block.endsWith('</memory_identity>'), 'renders the block');
});

t('empty pools render an empty block, never throw', () => {
  const { items, block } = composeEnvelope({ listEngrams: () => [] });
  assert.strictEqual(items.length, 0);
  assert.strictEqual(block, '');
});

t('a throwing listEngrams degrades gracefully (best-effort envelope)', () => {
  const { block } = composeEnvelope({ listEngrams: () => { throw new Error('db down'); } });
  assert.strictEqual(block, '', 'never breaks the turn on identity-read failure');
});

console.log('');
console.log(`composeEnvelope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
