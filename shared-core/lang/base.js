// SPDX-License-Identifier: AGPL-3.0-only
// Universal helpers shared across language modules.
//
// Pure-function. No I/O. No language privilege — every language module
// composes these helpers in the same way.

'use strict';

// ── Universal accent folding ────────────────────────────────────────────
// Unicode NFD splits accented characters into base + combining mark.
// Stripping the marks gives accent-folded text. Works equally for:
//   French é/è/à/ç, German ä/ö/ü/ß, Spanish ñ/á, Portuguese ã/ç, Polish
//   ł/ą, Czech č/š, Greek ά/έ/ή/ί/ό/ύ/ώ, Vietnamese ạ/ậ, Turkish ı/ş/ğ.
// Unicode property \p{Mn} = combining marks.
function accentFold(text) {
  if (!text) return '';
  return String(text).normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}

// ── Universal lowercase + whitespace normalize ──────────────────────────
function normalizeBasic(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Default tokenizer ──────────────────────────────────────────────────
// Latin/Cyrillic/Greek/etc — split on non-letter boundaries, length ≥ 3.
// CJK runs (Han, Hiragana, Katakana) — character bigrams, since these
// scripts don't use whitespace and unigrams are too noisy.
//
// Language modules can override by exporting their own `tokenize`. The
// default works correctly for all scripts; overrides are for fine-tuning.
function defaultTokenize(text, stopTokens) {
  if (!text) return new Set();
  const stop = stopTokens instanceof Set ? stopTokens : new Set();
  const out = new Set();
  const lower = String(text).toLowerCase();
  // Word-style tokens (any letter script delimited by non-letter).
  for (const t of lower.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (t && t.length >= 3 && !stop.has(t)) out.add(t);
  }
  // CJK bigrams.
  const cjkRuns = lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

// ── Per-language module → marker matcher ───────────────────────────────
// Given a language module's `supersessionMarkers` (array of strings or
// RegExp), build a single combined regex. Strings are escaped; RegExps
// are inlined. Caller decides flags (default: `iu` — case-insensitive,
// unicode-aware).
function buildMarkerRegex(markers, flags) {
  if (!Array.isArray(markers) || markers.length === 0) return null;
  const parts = markers.map((m) => {
    if (m instanceof RegExp) return m.source;
    return String(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp('(?:^|\\s)(?:' + parts.join('|') + ')', flags || 'iu');
}

// ── Apply a language module's normalize chain to a text ─────────────────
// chain = [accentFold, normalizeBasic, transliterate?, ...]
// Always idempotent. Modules pass an array of fns or skip via [].
function runNormalizeChain(text, chain) {
  let out = String(text || '');
  if (!Array.isArray(chain)) return out;
  for (const fn of chain) {
    if (typeof fn === 'function') out = fn(out);
  }
  return out;
}

module.exports = {
  accentFold,
  normalizeBasic,
  defaultTokenize,
  buildMarkerRegex,
  runNormalizeChain
};
