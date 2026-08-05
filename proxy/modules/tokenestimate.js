// SPDX-License-Identifier: AGPL-3.0-only
// Model-aware char-based token estimation.
//
// Old rule of thumb (Anthropic pre-4.7, OpenAI, most OSS models): ~4 chars/token
// for prose, ~5.33 chars/token with Anthropic's 0.75 scaling constant.
//
// Opus 4.7 ships a new BPE vocab that maps the same text to 1.0–1.35× more
// tokens, with the high end for code, JSON, structured data, and CJK. Using
// the legacy constant under-estimates context consumption by up to 35%, which
// risks silent overflow of max_tokens caps and broken compaction triggers.
//
// This module picks the right denominator based on the target model. It is
// deliberately simple (char count / constant) — for ground-truth, use the
// Anthropic /v1/messages/count_tokens endpoint via tokencount.js.
//
//  Infrastructure; P1]

// Denominators: higher = fewer tokens per char (looser estimate).
// Lower = more tokens per char (tighter, safer for cap checks).
var DENOM_LEGACY = 5.33;     // Anthropic 4.6 and older, GPT, Qwen, DeepSeek
var DENOM_OPUS_4_7 = 3.2;    // Empirical ~1.35× inflation target for code-heavy traffic
var DENOM_CJK = 2.5;         // Heuristic when content appears CJK-dominant

// Ratio used to detect CJK-dominance: if >25% of chars are outside Basic Latin,
// we treat the content as CJK-heavy and use a tighter denominator.
var CJK_THRESHOLD = 0.25;

function isOpus47(model) {
  return typeof model === 'string' && model.indexOf('claude-opus-4-7') === 0;
}

// Quick CJK-dominance check on a sample of the text (don't scan huge bodies).
function looksCjkHeavy(text) {
  if (!text || text.length < 40) return false;
  var sample = text.length > 2000 ? text.slice(0, 2000) : text;
  var nonLatin = 0;
  for (var i = 0; i < sample.length; i++) {
    var c = sample.charCodeAt(i);
    // Anything above Basic Latin + Latin-1 Supplement + whitespace/punct
    if (c > 0x024F) nonLatin++;
  }
  return (nonLatin / sample.length) > CJK_THRESHOLD;
}

function denominatorFor(model, text) {
  if (isOpus47(model)) {
    return looksCjkHeavy(text) ? DENOM_CJK : DENOM_OPUS_4_7;
  }
  // Legacy models: same char/token whether code or prose, CJK slightly tighter.
  return looksCjkHeavy(text) ? DENOM_CJK : DENOM_LEGACY;
}

// Primary API. Returns integer token estimate.
function estimateTokens(text, model) {
  if (!text) return 0;
  var denom = denominatorFor(model, text);
  return Math.ceil(text.length / denom);
}

// For request bodies: estimate tokens of the serialized body with model aware.
function estimateBodyTokens(bodyStr, model) {
  return estimateTokens(bodyStr, model);
}

module.exports = {
  estimateTokens: estimateTokens,
  estimateBodyTokens: estimateBodyTokens,
  denominatorFor: denominatorFor,
  looksCjkHeavy: looksCjkHeavy,
  isOpus47: isOpus47,
  DENOM_LEGACY: DENOM_LEGACY,
  DENOM_OPUS_4_7: DENOM_OPUS_4_7,
  DENOM_CJK: DENOM_CJK
};
