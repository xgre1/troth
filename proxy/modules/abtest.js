// SPDX-License-Identifier: AGPL-3.0-only
// Braintrust-style A/B prompt variation testing.
//
// Research [MW]: Real-time evaluation on production traces. We add the
// ability to run A/B variants of prompts and track per-variant quality
// scores via the existing critic.providerQuality mechanism.
//
// Variants are configured per prompt slot (e.g., "routine-feature" → A or B).
// Hash of session-id determines which variant a request gets (deterministic
// per session so a session sees consistent variant).

const crypto = require('crypto');

let variants = {}; // promptSlot → { A: text, B: text, splitRatio: 0.5 }
let stats = {}; // variantKey → { samples, totalQualityScore, totalIssues }

function defineVariant(slot, variantA, variantB, splitRatio) {
  variants[slot] = { A: variantA, B: variantB, splitRatio: splitRatio || 0.5 };
}

// Pick variant deterministically by session hash
function pickVariant(slot, sessionId) {
  if (!variants[slot]) return { variant: 'default', text: null };
  const v = variants[slot];
  if (!sessionId) return { variant: 'A', text: v.A };
  const h = crypto.createHash('md5').update(sessionId + slot).digest('hex');
  const r = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  const which = r < v.splitRatio ? 'A' : 'B';
  return { variant: which, text: v[which] };
}

function recordResult(slot, variant, qualityScore, issueCount) {
  const key = slot + ':' + variant;
  if (!stats[key]) stats[key] = { samples: 0, totalQualityScore: 0, totalIssues: 0 };
  stats[key].samples++;
  stats[key].totalQualityScore += qualityScore || 0;
  stats[key].totalIssues += issueCount || 0;
}

function getStats() {
  const out = {};
  for (const key of Object.keys(stats)) {
    const s = stats[key];
    out[key] = {
      samples: s.samples,
      avgQuality: s.samples > 0 ? Math.round((s.totalQualityScore / s.samples) * 10) / 10 : 0,
      avgIssues: s.samples > 0 ? Math.round((s.totalIssues / s.samples) * 10) / 10 : 0,
    };
  }
  return out;
}

// Suggest a winner for each slot (more samples + higher quality wins)
function declareWinners() {
  const winners = {};
  for (const slot of Object.keys(variants)) {
    const aKey = slot + ':A';
    const bKey = slot + ':B';
    const a = stats[aKey];
    const b = stats[bKey];
    if (!a || !b) { winners[slot] = 'insufficient data'; continue; }
    if (a.samples < 10 || b.samples < 10) { winners[slot] = 'insufficient samples'; continue; }
    const aAvg = a.totalQualityScore / a.samples;
    const bAvg = b.totalQualityScore / b.samples;
    if (Math.abs(aAvg - bAvg) < 0.5) winners[slot] = 'tied';
    else winners[slot] = aAvg > bAvg ? 'A' : 'B';
  }
  return winners;
}

module.exports = { defineVariant, pickVariant, recordResult, getStats, declareWinners };
