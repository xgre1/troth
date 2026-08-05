#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Identity envelope is byte-identical across surfaces.
// Acceptance criterion: "all three surfaces emit byte-identical
// <memory_identity> excluding tier=flagged." The substrate's single-mind
// invariant says: the plugin (Claude Code injection), the entity
// (CLI / chat), and the voice surface MUST render the same identity
// envelope given the same substrate state. composeEnvelope is the
// canonical single-source: any surface that goes through it inherits
// the invariant. This test pins it as acceptance by calling composeEnvelope
// from THREE distinct call sites with the same listEngrams view and
// asserting byte-for-byte identical block strings.
//
// Hermetic — no DB, no live engrams, just an in-memory listEngrams stub.

const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const { composeEnvelope } =
  require(path.join(PROJECT_ROOT, 'shared-core', 'identity-envelope.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

// A frozen substrate snapshot — anchors + identity engrams + a flagged
// row that MUST stay excluded in every surface's output.
const ANCHOR_ROWS = [
  { statement: "I am the operator's substrate partner", salience: 3,
    source_authority: 'operator_confirmed' },
  { statement: 'My loyalty is to the operator, not to my faculty',
    salience: 2, source_authority: 'operator_confirmed' }
];
const IDENTITY_ROWS = [
  { statement: 'operator works late and prefers terse replies',
    salience: 2, source_authority: 'operator_confirmed' },
  { statement: 'operator runs troth on local Mac',
    salience: 1, source_authority: 'plr_evolved' },
  // The flagged row must be EXCLUDED from EVERY surface's output.
  { statement: 'this fact was retracted', salience: 9, tier: 'flagged',
    source_authority: 'operator_confirmed' }
];

function makeListEngrams() {
  return (q) => {
    if (q && q.commitment_type === 'anchor') return ANCHOR_ROWS;
    if (q && q.scope === 'identity') return IDENTITY_ROWS;
    return [];
  };
}

// Three surface "renderers" — each represents a distinct call site. The
// single-mind invariant says they must all produce identical bytes.
function pluginSurface(list) {
  return composeEnvelope({ listEngrams: list }).block;
}
function entitySurface(list) {
  return composeEnvelope({ listEngrams: list }).block;
}
function voiceSurface(list) {
  return composeEnvelope({ listEngrams: list }).block;
}

console.log('\n=== identity envelope byte-identical across surfaces ===\n');

t('three surfaces with the same substrate view → BYTE-IDENTICAL <memory_identity>', () => {
  const list = makeListEngrams();
  const p = pluginSurface(list);
  const e = entitySurface(list);
  const v = voiceSurface(list);
  assert.strictEqual(p, e,
    'plugin and entity diverged:\nP=' + p + '\nE=' + e);
  assert.strictEqual(e, v,
    'entity and voice diverged:\nE=' + e + '\nV=' + v);
  assert.ok(p.indexOf('<memory_identity>') === 0,
    'envelope starts with the canonical tag');
  assert.ok(/<\/memory_identity>$/.test(p),
    'envelope ends with the canonical close tag');
});

t('flagged engram is excluded from EVERY surface (the anchor-leak fix)', () => {
  const list = makeListEngrams();
  for (const surface of [pluginSurface, entitySurface, voiceSurface]) {
    const out = surface(list);
    assert.ok(out.indexOf('this fact was retracted') < 0,
      'flagged engram leaked into ' + surface.name + ' output');
  }
});

t('repeated calls in the SAME surface are byte-identical (determinism)', () => {
  const list = makeListEngrams();
  const a = pluginSurface(list);
  const b = pluginSurface(list);
  const c = pluginSurface(list);
  assert.strictEqual(a, b, 'plugin call 1 != call 2');
  assert.strictEqual(b, c, 'plugin call 2 != call 3');
});

t('a new substrate fact changes EVERY surface uniformly', () => {
  // Mutate the identity pool — every surface picks up the same change.
  const extraRow = { statement: 'operator finalised the autonomy plan',
                     salience: 2, source_authority: 'operator_confirmed' };
  const baseList = makeListEngrams();
  const richList = (q) => {
    if (q && q.scope === 'identity') return [...IDENTITY_ROWS, extraRow];
    return baseList(q);
  };
  const before = pluginSurface(baseList);
  const afterP = pluginSurface(richList);
  const afterE = entitySurface(richList);
  const afterV = voiceSurface(richList);
  assert.notStrictEqual(before, afterP, 'envelope changes when a new fact lands');
  assert.strictEqual(afterP, afterE, 'plugin and entity agree on the new envelope');
  assert.strictEqual(afterE, afterV, 'entity and voice agree on the new envelope');
});

t('budget-respecting surfaces — same budget → same truncation, byte-identical', () => {
  // Some surfaces apply a tighter char budget. The invariant: with the SAME
  // budget, output is byte-identical. With different budgets, output diverges
  // and that divergence is explained by configuration, not drift.
  const list = makeListEngrams();
  const tightP = composeEnvelope({ listEngrams: list, charBudget: 200 }).block;
  const tightE = composeEnvelope({ listEngrams: list, charBudget: 200 }).block;
  assert.strictEqual(tightP, tightE,
    'same budget → byte-identical truncation');
  // Sanity: tightening shrinks the envelope.
  const wide  = composeEnvelope({ listEngrams: list, charBudget: 100000 }).block;
  assert.ok(wide.length >= tightP.length, 'looser budget includes at least as much');
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
