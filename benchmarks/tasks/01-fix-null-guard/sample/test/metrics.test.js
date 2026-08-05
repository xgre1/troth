// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('assert');
const { peakValue, summarise } = require('../src/metrics');

// Pretend the metrics feed occasionally drops a null-valued sample
// when its probe failed. The tool has to still compute a peak over
// the numeric ones.
const fixture = [
  { timestamp: 1, value: 3 },
  { timestamp: 2, value: null },
  { timestamp: 3, value: 7 },
  { timestamp: 4, value: 2 },
  { timestamp: 5, value: null },
  { timestamp: 6, value: 6 }
];

console.log('Testing peakValue with nulls…');
const peak = peakValue(fixture);
assert.strictEqual(peak, 7, 'peak over non-null values should be 7, got ' + peak);
console.log('  ✓ peakValue ignores null samples');

console.log('Testing summarise end-to-end…');
const s = summarise(fixture, 3);
assert.strictEqual(s.count, 6, 'count should include null samples');
assert.strictEqual(s.peak, 7, 'peak should ignore null samples');
assert.ok(Array.isArray(s.rolling), 'rolling should be an array');
console.log('  ✓ summarise passes');

console.log('All tests passed.');
