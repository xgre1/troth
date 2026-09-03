#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Two facts about the per-prompt injector, pinned at the source: every block
// carries its own label (the precedent pointer is not "recall"), and topical
// overlap reads letters of any script, so a Greek prompt meets a Greek fact.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== injector blocks ===\n');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'injector.mjs'), 'utf8');

t('the precedent pointer carries its own label', () => {
  const recallLabels = (src.match(/'\[troth\/recall\]/g) || []).length;
  assert.strictEqual(recallLabels, 1, 'exactly one block is labelled recall, got ' + recallLabels);
  assert.ok(/'\[troth\/precedent\] ' \+ precedentCount/.test(src), 'the pointer is labelled precedent');
});

t('topical overlap reads letters of any script', () => {
  const m = /function tokenizeForOverlap\(text\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'tokenizer found');
  const fn = new Function(m[0] + '; return tokenizeForOverlap;')();
  const toks = fn('Πόσα βγάζω από τον Παπαδόπουλο τον μήνα');
  assert.ok(toks.has('παπαδόπουλο') && toks.has('μήνα'), [...toks].join(' | '));
  const en = fn('How many road bikes do I have');
  assert.ok(en.has('road') && en.has('bikes'), [...en].join(' | '));
});

t('a memory earns its place within reach of the best-scored one', () => {
  const m = /function earnsPlace\(rr, top\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'rule found');
  const fn = new Function(m[0] + '; return earnsPlace;')();
  assert.ok(fn(-1.65, -1.3), 'the answer beside a slightly better row is offered when the whole list is negative');
  assert.ok(fn(-1.12, -1.12), 'the best row of a negative list is offered');
  assert.ok(!fn(-6.7, -6.0), 'a hopeless list offers nothing');
  assert.ok(fn(3.05, 4.1) && !fn(0.9, 4.1), 'a positive list keeps only what stands near the top');
  assert.ok(!fn(-2.5, 0.5), 'far below a good top is not offered');
  assert.ok(!fn(null, 1) && !fn(1, null), 'no verdict, no place');
});

console.log('\ninjector-blocks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
