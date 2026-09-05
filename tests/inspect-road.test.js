#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The inspection road's pure parts: the log filter, the unified-log
// argument walls and the reset-time reader.
const assert = require('assert');
const path = require('path');
const ins = require(path.join(__dirname, '..', 'proxy', 'modules', 'inspect.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== inspection road ===\n');

const LINES = [
  { ts: 10, type: 'info', msg: 'PAYLOAD BREAKDOWN | raw: 4.4 KB' },
  { ts: 20, type: 'info', msg: '[router] openai_sub: 429 rate limited' },
  { ts: 30, type: 'info', msg: 'PAYLOAD AFTER INJECT | 4.4 KB (added 0.0 KB)' },
  { ts: 40, type: 'error', msg: 'something else' }
];

t('grep narrows, limit keeps the tail, since keeps the newer', () => {
  assert.deepStrictEqual(ins.filterLogLines(LINES, { grep: 'payload' }).map((l) => l.ts), [10, 30]);
  assert.deepStrictEqual(ins.filterLogLines(LINES, { grep: 'PAYLOAD', limit: '1' }).map((l) => l.ts), [30]);
  assert.deepStrictEqual(ins.filterLogLines(LINES, { since: '20' }).map((l) => l.ts), [30, 40]);
  assert.deepStrictEqual(ins.filterLogLines(LINES, {}).length, 4);
});

t('a grep that is not a regex still matches as text', () => {
  assert.deepStrictEqual(ins.filterLogLines(LINES, { grep: '4.4 KB (added' }).map((l) => l.ts), [30]);
});

t('the unified-log window is a number and a unit, at most a day', () => {
  assert.strictEqual(ins.validateLast('5m'), '5m');
  assert.strictEqual(ins.validateLast(undefined), '5m');
  assert.strictEqual(ins.validateLast('24h'), '24h');
  assert.strictEqual(ins.validateLast('25h'), null);
  assert.strictEqual(ins.validateLast('5m; id'), null);
  assert.strictEqual(ins.validateLast('0m'), null);
});

t('the predicate keeps to its own characters', () => {
  assert.strictEqual(ins.validatePredicate('process == "troth-app"'), 'process == "troth-app"');
  assert.strictEqual(ins.validatePredicate(''), '');
  assert.strictEqual(ins.validatePredicate('subsystem == "one.troth" && eventMessage CONTAINS "entity"'), 'subsystem == "one.troth" && eventMessage CONTAINS "entity"');
  assert.strictEqual(ins.validatePredicate('x`id`'), null);
  assert.strictEqual(ins.validatePredicate('a;b'), null);
  assert.strictEqual(ins.validatePredicate('$(id)'), null);
  assert.strictEqual(ins.validatePredicate('x'.repeat(201)), null);
});

t('the reset time is read from the endpoint body', () => {
  assert.strictEqual(ins.parseResetsIn('{"error":{"type":"usage_limit_reached","resets_in_seconds":6193}}'), 6193);
  assert.strictEqual(ins.parseResetsIn('resets_in_seconds=90'), 90);
  assert.strictEqual(ins.parseResetsIn('no such field'), null);
});

console.log('\ninspect-road: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
