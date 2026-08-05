// SPDX-License-Identifier: AGPL-3.0-only
// Personalized PageRank — pure JS, no dependencies
// Power iteration method

function personalizedPageRank(entities, edges, seedIds, options = {}) {
  const { damping = 0.85, iterations = 20, seedBoost = 3.0 } = options;
  const n = entities.length;
  if (n === 0) return [];

  // Build adjacency map
  const idToIndex = new Map();
  entities.forEach((e, i) => idToIndex.set(e.id, i));

  const outLinks = new Array(n).fill(null).map(() => []);
  const inLinks = new Array(n).fill(null).map(() => []);

  for (const edge of edges) {
    const si = idToIndex.get(edge.source_id);
    const ti = idToIndex.get(edge.target_id);
    if (si !== undefined && ti !== undefined) {
      outLinks[si].push(ti);
      inLinks[ti].push(si);
    }
  }

  // Personalization vector — biased toward seed nodes
  const seedSet = new Set(seedIds.map(id => idToIndex.get(id)).filter(i => i !== undefined));
  const personalization = new Float64Array(n);
  if (seedSet.size > 0) {
    const seedWeight = 1.0 / seedSet.size;
    for (const idx of seedSet) {
      personalization[idx] = seedWeight * seedBoost;
    }
  } else {
    const uniform = 1.0 / n;
    personalization.fill(uniform);
  }

  // Normalize
  let pSum = 0;
  for (let i = 0; i < n; i++) pSum += personalization[i];
  if (pSum > 0) for (let i = 0; i < n; i++) personalization[i] /= pSum;

  // Initialize rank
  let rank = new Float64Array(n).fill(1.0 / n);

  // Power iteration
  for (let iter = 0; iter < iterations; iter++) {
    const newRank = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const j of inLinks[i]) {
        const outDegree = outLinks[j].length;
        if (outDegree > 0) sum += rank[j] / outDegree;
      }
      newRank[i] = (1 - damping) * personalization[i] + damping * sum;
    }

    // Normalize
    let total = 0;
    for (let i = 0; i < n; i++) total += newRank[i];
    if (total > 0) for (let i = 0; i < n; i++) newRank[i] /= total;

    rank = newRank;
  }

  // Return entities with rank scores, sorted descending
  return entities
    .map((e, i) => ({ ...e, rank: rank[i] }))
    .sort((a, b) => b.rank - a.rank);
}

module.exports = { personalizedPageRank };
