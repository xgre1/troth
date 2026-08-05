// SPDX-License-Identifier: AGPL-3.0-only
// Mind Q-DECISION-PATTERNS — intent-stream detector (v2).
//
// Pivot from chat-language detection to action-sequence detection.
// v1 (decision-patterns.js) looked for spec-style language ("P1:",
// "decided:", "πάμε με X") in user prompts — empirically captured 0%
// of real Claude Code conversations because users don't VOICE decisions,
// they ISSUE INTENTS that get fulfilled or refined or contradicted.
//
// v2 watches the existing intent stream (written by intent-capture.mjs
// on every UserPromptSubmit) and looks for two action-sequence signals:
//
//   SUPERSESSION  — a new intent has high keyword overlap with a recent
//                   intent AND contains a supersession marker
//                   ("no", "actually", "instead", "wait", "όχι", "αντί").
//                   Emits TWO decisions: rejected(old) + chosen(new).
//
//   CONFIRMATION  — an intent older than `promote_after_ms` that wasn't
//                   superseded AND has at least one follow-up intent
//                   (proxy for "user kept working on it") gets promoted
//                   to a confirmed mind_decision.
//
// What this does NOT do:
//   - I/O. Caller passes intents pre-fetched from the substrate.
//   - State persistence. Returns candidate records; caller writes.
//   - Token embeddings. Uses jaccard token overlap (cheap, deterministic).
//
// (Q-DECISION-PATTERNS, "leverages typed edges refines_intent,
// contradicts_prior, supersedes" — this is the leverage layer).

'use strict';

// Supersession markers across the languages Claude Code users actually
// code-switch in. Detector unicode-flag for non-Latin scripts (JA/CN).
//   EN: no, not, instead, actually, wait, stop, rather, scrap, forget, drop, nvm, never mind
//   GR: όχι, αντί, καλύτερα, περίμενε, ξέχνα, άσε
//   ES: no, en cambio, en lugar de, mejor, espera, olvida, deja
//   FR: non, au lieu, plutôt, attends, oublie, laisse
//   DE: nein, stattdessen, lieber, warte, vergiss, lass
//   IT: no, invece, piuttosto, aspetta, dimentica, lascia
//   PT: não, em vez, ao invés, melhor, espera, esquece
//   JA: いや, やっぱり, 待って, やめ, 代わり
//   CN: 不, 不要, 等等, 其实, 算了, 改用
// Language dispatch: markers/stopwords/normalize live in lang/* modules.
// SUPERSESSION_RE is built from the union of every module's markers.
// Adding a new language = create lang/<code>.js + register in lang/index.
const lang = require('./lang');
// Compatibility shim: the test suite patterns the regex by name.
const SUPERSESSION_RE = lang.allSupersessionMarkers();

// Tokens to drop before computing overlap — they appear in nearly every
// intent and would inflate jaccard artificially.
// Stopwords — unioned from every registered language module via lang/.
const STOP_TOKENS = lang.allStopTokens();

// Tokenize through the lang dispatch — language module's tokenize wins
// when defined, else the universal default (Latin word-split + CJK
// bigrams) with the unioned stopword filter.
function tokenize(text) {
  return lang.tokenize(text);
}

// Overlap coefficient (intersect / min) instead of jaccard. Asymmetric
// question: "does the new intent share meaningful topic with the old
// intent?" — not "are these two essentially the same set?". Critical
// for CJK bigram tokenization where union grows fast and jaccard
// artificially deflates real topic overlap.
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const denom = Math.min(a.size, b.size);
  return denom > 0 ? inter / denom : 0;
}

function intentGoal(rec) {
  return (rec && rec.input && (rec.input.goal || rec.input.constraint)) || '';
}

// Main entry. Caller passes intents in CHRONOLOGICAL ORDER (oldest first),
// scoped to a single cwd.
//
//   detectFromIntents(intents, opts)
//
//   intents          — array of intent ActionRecord objects (already
//                      hydrated via actionRec.fromRow)
//   opts.window_ms          — pairwise comparison window (default 30 min)
//   opts.promote_after_ms   — durability for confirmation (default 15 min)
//   opts.overlap_threshold  — jaccard floor for supersession (default 0.25)
//   opts.now                — clock override (default Date.now())
//   opts.captured_intent_ids — Set<string> of intent ids already promoted
//                              (dedup across runs)
//
// Returns array of { intent_id, kind, summary, rationale, supersedes }.
//   intent_id   — id of the intent this decision derives from
//   kind        — 'super_chosen' | 'super_rejected' | 'confirm'
//   supersedes  — array of intent ids superseded (only for super_chosen)
function detectFromIntents(intents, opts) {
  opts = opts || {};
  const window     = typeof opts.window_ms === 'number' ? opts.window_ms : 30 * 60 * 1000;
  const promoteAge = typeof opts.promote_after_ms === 'number' ? opts.promote_after_ms : 15 * 60 * 1000;
  // Two thresholds: with the marker present we can be much more lenient
  // because a supersession marker + any technical token overlap is high
  // confidence on its own. Without a marker (refinement detection) we
  // never even enter this code path right now — kept for symmetry.
  const overlapMin = typeof opts.overlap_threshold === 'number' ? opts.overlap_threshold : 0.10;
  const now        = typeof opts.now === 'number' ? opts.now : Date.now();
  const captured   = opts.captured_intent_ids instanceof Set ? opts.captured_intent_ids : new Set();

  if (!Array.isArray(intents) || intents.length === 0) return [];

  // Pre-compute normalized goal + tokens once per intent. Normalization
  // dispatches through the lang module that matches the goal's script
  // accent-folding, Greeklish→Greek transliteration, romaji→kana, etc.
  // happens HERE so both marker matching and overlap calculations work
  // against the same canonical form.
  const arr = intents
    .map(r => ({ rec: r, ts: r.timestamp || 0, goal: intentGoal(r) }))
    .filter(x => x.goal && x.goal.length >= 8 && !x.goal.startsWith('<'))
    .sort((a, b) => a.ts - b.ts);
  for (const x of arr) {
    x.normGoal = lang.normalize(x.goal);
    x.tokens = tokenize(x.normGoal);
  }

  const out = [];
  const supersededIds = new Set();
  const chosenIds     = new Set(); // intents that won a supersession — already strong decisions

  // Pass 1 — supersession scan. For each intent, look back inside the
  // window for an older intent with high overlap, fire if marker present.
  for (let i = 1; i < arr.length; i++) {
    const cur = arr[i];
    if (captured.has(cur.rec.id)) continue;
    if (!SUPERSESSION_RE.test(cur.normGoal)) continue;
    let bestJ = -1, bestOverlap = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = arr[j];
      if (cur.ts - prev.ts > window) break;
      if (supersededIds.has(prev.rec.id)) continue;
      const o = jaccard(cur.tokens, prev.tokens);
      if (o > bestOverlap) { bestOverlap = o; bestJ = j; }
    }
    if (bestJ < 0 || bestOverlap < overlapMin) continue;
    const prev = arr[bestJ];
    supersededIds.add(prev.rec.id);
    chosenIds.add(cur.rec.id);
    out.push({
      intent_id: cur.rec.id,
      kind: 'super_chosen',
      // Use normalized form for cleaning so accent-folded markers
      // (οχι/αντι in el, لا in ar, etc.) actually strip from the head.
      summary: 'Chose: ' + cleanGoalForChosen(cur.normGoal).slice(0, 240),
      rationale: 'Supersedes prior intent (overlap=' + bestOverlap.toFixed(2) + ', marker matched)',
      supersedes: [prev.rec.id]
    });
    out.push({
      intent_id: prev.rec.id,
      kind: 'super_rejected',
      summary: 'Rejected: ' + prev.goal.slice(0, 240),
      rationale: 'Superseded by intent ' + cur.rec.id.slice(0, 8),
      supersedes: []
    });
  }

  // Pass 2 — confirmation. Promote any intent older than promote_after_ms
  // that wasn't superseded AND wasn't already a super_chosen winner AND
  // has a follow-up intent (proxy for "user kept moving"). Skips orphans
  // and avoids double-counting strong decisions.
  for (let i = 0; i < arr.length - 1; i++) {
    const x = arr[i];
    if (captured.has(x.rec.id)) continue;
    if (supersededIds.has(x.rec.id)) continue;
    if (chosenIds.has(x.rec.id)) continue;
    if (now - x.ts < promoteAge) continue;
    out.push({
      intent_id: x.rec.id,
      kind: 'confirm',
      summary: 'Worked on: ' + x.goal.slice(0, 240),
      rationale: 'Confirmed via durability (age >= ' + Math.round(promoteAge / 60000) + 'min, follow-up activity)',
      supersedes: []
    });
  }

  return out;
}

// Strip the leading supersession marker from a chosen intent goal so the
// captured summary reads as the new direction, not the negation prefix.
// "no actually use OAuth instead of JWT" → "use OAuth instead of JWT"
// Strip leading supersession markers from the chosen text so the
// captured summary reads as the new direction. Uses the same global
// marker union as the detector (every language module's markers).
let _leadingMarkerRe = null;
function cleanGoalForChosen(goal) {
  if (!goal) return '';
  if (!_leadingMarkerRe) {
    // Same markers as allSupersessionMarkers but anchored at start of
    // string with optional repeated trims.
    const flat = [];
    for (const m of lang.MODULES) {
      if (Array.isArray(m.supersessionMarkers)) flat.push(...m.supersessionMarkers);
    }
    const escaped = flat.map(m => m instanceof RegExp ? m.source : String(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    _leadingMarkerRe = new RegExp('^\\s*(?:' + escaped.join('|') + ')[\\s,!.]*', 'iu');
  }
  let cleaned = String(goal);
  // Iteratively strip — in case of stacked markers like "no actually wait".
  let prev = null;
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(_leadingMarkerRe, '').trim();
  }
  return cleaned || goal;
}

module.exports = {
  detectFromIntents,
  _internal: {
    SUPERSESSION_RE, STOP_TOKENS, tokenize, jaccard, intentGoal
  }
};
