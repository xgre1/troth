// SPDX-License-Identifier: AGPL-3.0-only
// AlphaCode 2 Lite — K-sample + simple cluster + best-pick.
//
// Research [MoA]: Generate 1M samples → execute filter → behavioral cluster
// → rerank. Full version is compute-heavy ($$). Lite version: K=3 samples,
// simple text-similarity clustering, pick the most consistent answer.
//
// Opt-in only — adds K× cost. Use for high-stakes single-shot answers.

// Hash for clustering: collapse whitespace + punctuation, take first 100 chars
function clusterKey(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 100);
}

// Generate K samples and pick the most consistent.
// Caller passes a function that runs ONE generation. We run it K times,
// cluster outputs, return the largest cluster's representative.
async function kSampleVote(generateFn, k) {
  k = k || 3;
  const samples = [];
  for (let i = 0; i < k; i++) {
    try {
      const out = await generateFn();
      if (out) samples.push(out);
    } catch (e) {}
  }
  if (samples.length === 0) return null;
  if (samples.length === 1) return samples[0];

  // Cluster by similarity
  const clusters = new Map();
  for (const s of samples) {
    const key = clusterKey(s);
    if (!clusters.has(key)) clusters.set(key, { count: 0, exemplar: s });
    clusters.get(key).count++;
  }

  // Return the largest cluster's exemplar
  let best = null;
  for (const [key, cluster] of clusters) {
    if (!best || cluster.count > best.count) best = cluster;
  }
  return best ? best.exemplar : samples[0];
}

module.exports = { kSampleVote, clusterKey };
