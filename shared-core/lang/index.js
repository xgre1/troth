// SPDX-License-Identifier: AGPL-3.0-only
// Language registry + dispatch.
//
// All language modules are equal citizens. The registry orders them
// only for fallback heuristics (script detection passes are tried in
// order; markers from all enabled modules are unioned for matching).
//
// Adding a new language = drop in `lang/<code>.js` exporting the
// standard interface and add it to MODULES. No edits anywhere else.

'use strict';

const { defaultTokenize, buildMarkerRegex, runNormalizeChain } = require('./base');

const MODULES = [
  require('./en'),
  require('./el'),
  require('./es'),
  require('./fr'),
  require('./de'),
  require('./it'),
  require('./pt'),
  require('./ja'),
  require('./zh'),
  require('./ar')
];

const BY_CODE = new Map(MODULES.map(m => [m.code, m]));

// ── Language detection (script-based, no external deps yet) ──────────
// First module whose detectsScript fires wins. Order matters: more
// specific scripts (CJK, Greek, Arabic) before generic Latin so an
// English-only prompt doesn't preempt a Greek/JA mixed string.
function detectLanguage(text) {
  if (!text) return null;
  // Run non-Latin detectors first.
  const nonLatinFirst = ['ja', 'zh', 'ar', 'el'];
  for (const code of nonLatinFirst) {
    const m = BY_CODE.get(code);
    if (m && m.detectsScript && m.detectsScript(text)) return m;
  }
  // Then Latin variants — these all overlap on basic ASCII so we can't
  // disambiguate ES from FR from EN purely by script. tinyld would do
  // better; for now we just default to EN and let markers from all
  // Latin modules be unioned at match time.
  return BY_CODE.get('en');
}

// ── Combined supersession marker matcher ──────────────────────────────
// Build a single regex unioning markers from every module. Cached so
// we pay the build cost once. Used when we want a fast "does ANY
// language's marker fire?" check without committing to a language.
let _allMarkersRe = null;
function allSupersessionMarkers() {
  if (_allMarkersRe) return _allMarkersRe;
  const flat = [];
  for (const m of MODULES) {
    if (Array.isArray(m.supersessionMarkers)) flat.push(...m.supersessionMarkers);
  }
  _allMarkersRe = buildMarkerRegex(flat, 'iu');
  return _allMarkersRe;
}

// ── Combined stopword set ────────────────────────────────────────────
let _allStops = null;
function allStopTokens() {
  if (_allStops) return _allStops;
  const set = new Set();
  for (const m of MODULES) {
    if (Array.isArray(m.stopTokens)) for (const t of m.stopTokens) set.add(t);
  }
  _allStops = set;
  return _allStops;
}

// ── Universal normalize — runs every module's transliterate so a
// Greeklish "oxi" and a native Greek "όχι" both end up as the same
// canonical token. Then the matching module's normalize finishes
// (accent fold, etc.) for fine-tuned cleanup. This makes token
// overlap robust to language drift across consecutive intents.
function normalize(text, langModule) {
  if (!text) return '';
  let out = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  // Run every transliterate that exists. Each is idempotent — only
  // replaces declared chat-form patterns, leaves other text intact.
  for (const m of MODULES) {
    if (m._internal && typeof m._internal.transliterate === 'function') {
      out = m._internal.transliterate(out);
    }
  }
  // Final pass: routed module's normalize for accent folding.
  const mod = langModule || detectLanguage(out) || BY_CODE.get('en');
  if (mod && typeof mod.normalize === 'function') return mod.normalize(out);
  return out;
}

// ── Tokenize. Module override → use it. Else default tokenizer with
//    the GLOBAL stopword set (cheap unioned filter, language-blind). ──
function tokenize(text, langModule) {
  const mod = langModule || detectLanguage(text);
  if (mod && typeof mod.tokenize === 'function') return mod.tokenize(text);
  return defaultTokenize(text, allStopTokens());
}

// ── Single-prompt supersession check ─────────────────────────────────
// Returns { fired, language, markerSource } if any marker matches.
// Caller normalizes the prompt FIRST via this module's `normalize`
// (the language-detected normalize) so accent folding + transliteration
// have already happened.
function matchSupersession(text) {
  if (!text) return { fired: false };
  const lang = detectLanguage(text);
  const normalized = normalize(text, lang);
  // Run the global combined matcher — this catches mixed-language
  // prompts (e.g. "no actually αντί" — English start + Greek tail).
  const re = allSupersessionMarkers();
  if (re && re.test(normalized)) {
    return { fired: true, language: lang ? lang.code : null };
  }
  return { fired: false, language: lang ? lang.code : null };
}

module.exports = {
  MODULES,
  BY_CODE,
  detectLanguage,
  allSupersessionMarkers,
  allStopTokens,
  normalize,
  tokenize,
  matchSupersession
};
