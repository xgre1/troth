#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// external_suspicious_not_grounded STVC wall test (S4, M2).
// Proves the prompt-injection wall is REAL, not cosmetic an internal audit: an
// intent that grounds in a flagged-injection engram (scope contains
// 'external_suspicious') is REFUSED before any LLM sees it.
//
// HERMETIC: stubs engram.listEngrams with a CONTROLLED pool so the test does
// not depend on the live 77k-row DB, recordEngram's id scheme, or other tests'
// writes. (The predicate reads listEngrams internally with no DI seam, so we
// seed the require cache — same pattern as faculty-commit-bridge.test.js.)
const assert = require('assert');
const path = require('path');

const engPath = path.join(__dirname, '..', 'shared-core', 'engram.js');
const realEng = require(engPath);

// Controlled engram pool. The predicate resolves grounded_in refs against this.
const POOL = [
  { id: 'flagged-1', scope: 'browser:external_suspicious', statement: 'injected page text' },
  { id: 'flagged-2', scope: 'perception:external_suspicious:x', statement: 'more injection' },
  { id: 'clean-1', scope: 'decision:ok', source_authority: 'operator_confirmed', statement: 'a real operator decision' },
];
require.cache[require.resolve(engPath)].exports = Object.assign({}, realEng, {
  listEngrams() { return POOL.slice(); },
});

const sm = require(path.join(__dirname, '..', 'shared-core', 'state-machine.js'));
const pred = sm.PREDICATE_KINDS.external_suspicious_not_grounded;

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

function check(grounded, scope) {
  return pred({ kind: 'external_suspicious_not_grounded' }, {
    proposed: { type: 'commitment', output: {
      scope: scope || 'intent:http:do', grounded_in: grounded, irreversibility_class: 'low',
    } },
  });
}

console.log('\n=== external_suspicious_not_grounded wall (S4, hermetic) ===\n');

t('predicate is registered', () => {
  assert.strictEqual(typeof pred, 'function');
});

t('REFUSES an intent grounded in a flagged-injection engram (by scope)', () => {
  const refusal = check(['flagged-1']);
  assert.ok(refusal && /external_suspicious_not_grounded/.test(refusal), 'got ' + JSON.stringify(refusal));
});

t('REFUSES when flagged ref is mixed in with a clean ref', () => {
  const refusal = check(['clean-1', 'flagged-2']);
  assert.ok(refusal && /flagged-2/.test(refusal), 'must catch the flagged one; got ' + JSON.stringify(refusal));
});

t('PASSES an intent grounded only in a clean engram', () => {
  assert.strictEqual(check(['clean-1']), null);
});

t('SILENT PASS for non-intent scopes', () => {
  assert.strictEqual(check(['flagged-1'], 'identity'), null);
});

t('SILENT PASS when grounded_in is empty (that is grounded_in_sealed concern)', () => {
  assert.strictEqual(check([]), null);
});

t('unknown ref (not in pool) does not crash, does not false-refuse', () => {
  assert.strictEqual(check(['does-not-exist']), null);
});

// Restore real engram module so other suites are unaffected.
require.cache[require.resolve(engPath)].exports = realEng;

console.log('');
console.log('external_suspicious wall: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
