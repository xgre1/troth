// SPDX-License-Identifier: AGPL-3.0-only
// Production code (pretend) — computes rolling stats over a metrics stream.
// Called from a hot loop, so any allocation or extra branch here matters.

function rollingAverage(samples, windowSize) {
  if (!samples || samples.length === 0) return [];
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = samples.slice(start, i + 1);
    const sum = slice.reduce((a, b) => a + b.value, 0);
    out.push({
      timestamp: samples[i].timestamp,
      average: sum / slice.length
    });
  }
  return out;
}

function peakValue(samples) {
  // Bug: assumes every sample has a numeric value. Some samples in the
  // live feed carry `value: null` when the probe failed; this crashes
  // with TypeError on Math.max.
  return Math.max(...samples.map(s => s.value));
}

function summarise(samples, windowSize) {
  return {
    rolling: rollingAverage(samples, windowSize || 5),
    peak: peakValue(samples),
    count: samples.length
  };
}

module.exports = { rollingAverage, peakValue, summarise };
