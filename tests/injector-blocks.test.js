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
  const en = fn('How many Mac Studios do I have');
  assert.ok(en.has('mac') && en.has('studios'), [...en].join(' | '));
});

console.log('\ninjector-blocks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
