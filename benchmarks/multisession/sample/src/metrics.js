// SPDX-License-Identifier: AGPL-3.0-only
// metrics helpers. samples look like: { t: <ms>, value: <number|null> }
// the probe returns null when it fails, so null values really do reach
// these functions in production.

function peakValue(samples) {
  return Math.max(...samples.map(s => s.value));
}

function avgValue(samples) {
  const sum = samples.reduce((a, s) => a + s.value, 0);
  return sum / samples.length;
}

module.exports = { peakValue, avgValue };
