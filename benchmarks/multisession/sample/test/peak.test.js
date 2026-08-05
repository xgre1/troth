// SPDX-License-Identifier: AGPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert');
const { peakValue } = require('../src/metrics');

// Negative values expose the null-coercion bug: null coerces to 0
// inside Math.max, so the "peak" of a negative-only dataset would come
// back as 0 instead of the real max. Fix must filter nulls before the
// reduction.
test('peakValue returns real max when values are negative and some are null', () => {
  const samples = [
    { t: 1, value: -3 },
    { t: 2, value: null },
    { t: 3, value: -1 },
    { t: 4, value: -5 }
  ];
  assert.strictEqual(peakValue(samples), -1);
});
