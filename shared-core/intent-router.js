// SPDX-License-Identifier: AGPL-3.0-only
// intent-router — Hierarchical intent-aware axis weighting per MAGMA paper.
//
// MAGMA (UT Dallas / U Florida, arXiv:2601.03236, NeurIPS 2025) §3.2:
// "A hierarchical intent module classifies the query, then SELECTS the
// relevant relational views and weights them; downstream the system
// traverses each weighted axis independently and fuses the subgraphs."
//
// The substrate's `entity-axis.multiAxisQuery` already does the fusion
// step with a fixed default weight set (entity 0.40, temporal 0.25,
// causal 0.20, semantic 0.15). What was missing — and what the earlier router's
// "relevance-triggered prefix" stopped short of — is the intent-aware
// weight selector. Without it, every query gets the same weights, so
// "what did we do today" (temporal) and "fix bug in app.tsx" (entity)
// pull from the same flat ranking.
//
// This module classifies query intent via deterministic bilingual
// (English + Greek) regex patterns — same zero-LLM, zero-deps pattern as
// voice-triage.js — and returns the appropriate axis-weight set. Five
// intent classes:
//
//   chitchat   — greetings / acks / fillers       → SKIP retrieval entirely
//   epistemic  — date/time/math/units/weather     → SKIP retrieval entirely
//                (timeless trivia — substrate has no privileged answer; LLM
//                 should respond directly without dumping memory context)
//   episodic   — "what did we do", "yesterday"    → temporal 0.50 dominant
//   entity     — file paths, function refs        → entity 0.55 dominant
//   causal     — "why", "how did we decide"       → causal 0.50 dominant
//   semantic   — "remember", "is X true"          → semantic 0.55 dominant
//   default    — anything else (fallback)         → MAGMA stock weights
//
// Pure data layer. No I/O. Stateless. Tests live in tests/test-all.js
// under prefix INT-* (intent router).

'use strict';

// ── Pattern banks (compiled once, cached). Bilingual EL + EN. ───────────

let _patterns = null;
function patterns() {
  if (_patterns) return _patterns;
  _patterns = {
    // Greetings + single-word acks. Match utterance-PREFIX (caller already
    // gates with words.length <= 4), so "hi", "hello there", "thanks bro"
    // all hit. Greek patterns drop `\b` because JS RegExp word-boundaries
    // are ASCII-only — "γεια" → end-of-string + Greek letter doesn't fire
    // \b, falsely rejecting the match.
    chitchat: [
      /^\s*(?:hi|hello|hey|yo|sup|good\s+(?:morning|afternoon|evening)|gm|gn)\b/i,
      /^\s*(?:thanks?(?:\s+you)?|thx|ty|cheers|cool|nice|great|perfect|sweet|awesome|got\s+it|sounds\s+good|sgtm)\b/i,
      /^\s*(?:ok|okay|alright|sure|yes|yeah|yep|nope?|nah|maybe|hmm+|huh)\b/i,
      /^\s*(?:γεια|καλημέρα|καλησπέρα|χαίρετε|γειά)/i,
      /^\s*(?:ναι|όχι|οκ|εντάξει|ντάξει|ευχαριστώ|ευχαριστω|τέλεια|μπράβο)/i
    ],
    // Epistemic: timeless trivia the substrate has no privileged answer for.
    // Date/time, arithmetic, units, weather. Dumping memory on these is wrong
    // in both languages ("τι μέρα έχουμε σήμερα" must not pull a project
    // memory). LLM answers
    // from world knowledge, no retrieval block injected. Bilingual EL+EN.
    epistemic: [
      // Date / time / day-of-week — English. Cover both word orders:
      //   "what's the date" / "what is the time"
      //   "what date is today" / "what day is it"
      /\bwhat(?:'s|\s+is|\s+s)\s+(?:the\s+)?(?:date|day|time)(?:\s+today|\s+now)?\b/i,
      /\bwhat\s+(?:date|day|time)\s+(?:is\s+it|is\s+today|is\s+now|of\s+the\s+week)\b/i,
      /\bwhat\s+day\s+(?:is|of\s+the\s+week)\b/i,
      /\bwhat\s+time\s+is\s+it\b/i,
      // Math — symbolic arithmetic only. Natural-language word-operator
      // math ("what is 1 plus 1") is NOT pattern-matched here on purpose:
      // adding word-op regex is whack-a-mole (every language, every
      // synonym needs its own pattern). The real fix for "trivial query
      // leaks irrelevant engrams" is a prefix-provider memory taxonomy,
      // not more router patterns. Tracked separately.
      /\bwhat(?:'s|\s+is)\s+\d+(?:\.\d+)?\s*[+\-*/x×÷]\s*\d/i,
      /\b(?:calculate|compute|solve)\s+\d/i,
      // Units / conversions
      /\bhow\s+(?:many|much)\s+(?:[a-z]+s?\s+in\s+(?:a|an|one)\s+[a-z]+|\d)/i,
      /\bconvert\s+\d+(?:\.\d+)?\s+[a-z]+\s+to\s+[a-z]+\b/i,
      // Weather (LLM doesn't know either, but it's still not a memory call)
      /\b(?:what(?:'s|\s+is)\s+the\s+weather|how(?:'s|\s+is)\s+the\s+weather)\b/i,
      // Greek — date / time / day. Use whitespace/punct bounds (ASCII \b
      // unreliable on Greek letters, same pattern as episodic/causal).
      /(?:^|\s)(?:τι\s+(?:μέρα|ώρα|ημερομηνία)\s+(?:έχουμε|είναι|έχει))(?:$|\s|[.!?,])/i,
      /(?:^|\s)(?:πόσο\s+(?:κάνει|είναι)\s+\d+\s*[+\-*/x×]\s*\d)/i,
      // Greek word-operator math: "πόσο κάνει 1 συν 1", "5 επί 3 πόσο",
      // etc. Same prose-math gap as the English `plus / minus` pattern
      // above — without this, natural-language Greek math falls to
      // default intent and the prefix provider leaks irrelevant engrams.
      /(?:^|\s)πόσο\s+(?:κάνει|είναι)\s+\d+(?:\.\d+)?\s+(?:συν|πλην|επί|δια|στη(?:ν)?\s+δύναμη)\s+\d/i,
      /(?:^|\s)(?:πόσα|πόσες|πόσοι)\s+\S+\s+(?:έχει|έχουν)\s+\S+(?:$|\s|[.!?,])/i
    ],
    // Episodic recall: temporal anchors + recall verbs.
    episodic: [
      /\b(?:today|yesterday|tonight|this\s+(?:morning|afternoon|evening|week|month)|recently|just\s+now|earlier|last\s+(?:week|night|session|time))\b/i,
      /\bwhat\s+(?:did|have)\s+we\s+(?:do|done|been|talked|discussed|worked|built|fixed|tried)\b/i,
      /\b(?:remind\s+me|recap|summary|history|what(?:'s|s|\s+is)\s+the\s+(?:latest|status))\b/i,
      // Greek: drop \b — JS regex word-boundary is ASCII-only and would
      // reject Greek-letter neighbours. Use explicit space/punct bounds.
      /(?:^|\s)(?:πρόσφατα|σήμερα|χθες|προχτές|απόψε|τώρα\s+δα|πιο\s+πριν|αργότερα|παλιότερα)(?:$|\s|[.!?,])/i,
      /(?:^|\s)(?:τι\s+(?:κάναμε|είπαμε|φτιάξαμε|αλλάξαμε|δουλέψαμε)|θύμισέ\s+μου|σύνοψη|ιστορικό|κατάσταση)(?:$|\s|[.!?,])/i,
      // Greeklish (Latin-transliterated Greek). Bilingual operators write
      // heavily in this register; the Greek-script patterns above never match it, so recall
      // questions like "ti eipame gia to project" fell to default/dmn_slot.
      /(?:^|\s)(?:ti\s+(?:kaname|eipame|ipame|leme|elega|ftiaksame|allaksame|doulepsame|sizitisame|sizitusame)|thimise\s+mou|thymise\s+mou|synopsi|sinopsi|istoriko)(?:$|\s|[.!?,])/i
    ],
    // Causal: why / how-decide questions.
    causal: [
      /\bwhy\s+(?:did|do|does|is|are|was|were|would|should)\b/i,
      /\bhow\s+(?:did|do|does|come)\s+we\b/i,
      /\bwhat(?:'s|\s+is|\s+was)\s+the\s+reason\b/i,
      /\b(?:reasoning|rationale|because|justification|motivation)\b/i,
      // Greek: ASCII \b unreliable on Greek letters — bound on whitespace
      // / punct / line-edges instead.
      /(?:^|\s)γιατί\s+(?:το\s+)?(?:κάναμε|αποφασίσαμε|επιλέξαμε|πήραμε|δουλέψαμε)(?:$|\s|[.!?,])/i,
      /(?:^|\s)(?:γιατί|πώς|αιτία|λόγος|σκεπτικό)(?:$|\s|[.!?,])/i
    ],
    // Entity-anchored: file paths, function-call shapes, code references.
    // We let entity-axis.extractEntities do the deep extraction; here we
    // just detect the SHAPE of an entity query so the router fires.
    entity: [
      /\b[a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-.]+\b/,                  // path-shape
      /\b[a-zA-Z0-9_\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|c|cpp|h|hpp|json|md|yaml|yml|sh|sql|html|css|svelte|vue)\b/i,
      /\b[a-zA-Z_][a-zA-Z0-9_]{2,}\s*\(/,                          // funcCall(
      /\b(?:class|interface|struct|enum)\s+[A-Z][a-zA-Z0-9_]+/,
      /\b(?:fix|debug|patch|refactor|rewrite|implement|add|remove)\s+(?:the\s+)?(?:bug|function|class|method|module|component|hook|test|file)\b/i,
      // Greek: ASCII \b unreliable — bound on edges/whitespace.
      /(?:^|\s)(?:φτιάξε|διόρθωσε|κάνε|γράψε|προσθέσε|αφαίρεσε|αλλάξε)\s+(?:το\s+|την\s+|τον\s+)?(?:bug|function|file|class)/i
    ],
    // Semantic recall: "remember when", "do you know", knowledge queries.
    semantic: [
      /\b(?:do\s+you\s+(?:remember|know|recall)|recall\s+when|remember\s+when|do\s+we\s+(?:know|believe|think))\b/i,
      /\bwhat\s+(?:do|did)\s+(?:we|you)\s+(?:know|believe|think|say)\s+about\b/i,
      /\b(?:is|was|are|were)\s+.{3,40}\s+(?:true|correct|right|wrong|valid|the\s+case)\b/i,
      // Greek: ASCII \b unreliable — bound on edges/whitespace.
      /(?:^|\s)(?:θυμάσαι|θυμηθείς|ξέρεις|ξέρουμε|πιστεύουμε|νομίζουμε)(?:$|\s|[.!?,])/i,
      /(?:^|\s)τι\s+(?:ξέρουμε|πιστεύουμε|είπαμε)\s+για(?:$|\s|[.!?,])/i,
      // Greeklish (Latin-transliterated Greek) recall/knowledge verbs.
      /(?:^|\s)(?:thimasai|thimase|thymasai|thimizesai|ksereis|kserete|kseroume|kseris|pistevoume|nomizoume)(?:$|\s|[.!?,])/i,
      /(?:^|\s)ti\s+(?:kseroume|pistevoume|eipame|ipame)\s+gia(?:$|\s|[.!?,])/i
    ]
  };
  return _patterns;
}

// ── Axis-weight presets per intent class ────────────────────────────────
//
// Sum to 1.0 for interpretability (not strictly required by entity-axis;
// the fusion is monotonic and weights act as multipliers). Exact values
// are operator-tunable later — these defaults follow the MAGMA paper's
// "dominant-axis-by-intent" pattern (one axis ≥0.50, others tail off).

const WEIGHT_PRESETS = Object.freeze({
  // chitchat → ROUTER returns null weights as a sentinel; caller skips
  // retrieval entirely. Substrate stays quiet on greetings.
  chitchat: null,
  // epistemic → same sentinel. Substrate has no privileged answer for
  // timeless trivia (today's date, 2+2, miles→km). LLM answers from
  // world knowledge; we don't pollute the prompt with memory blocks.
  epistemic: null,

  episodic: Object.freeze({
    temporal: 0.50, causal: 0.20, semantic: 0.20, entity: 0.10
  }),
  entity: Object.freeze({
    entity:   0.55, semantic: 0.20, temporal: 0.15, causal: 0.10
  }),
  causal: Object.freeze({
    causal:   0.50, semantic: 0.25, entity: 0.15, temporal: 0.10
  }),
  semantic: Object.freeze({
    semantic: 0.55, entity: 0.25, causal: 0.10, temporal: 0.10
  }),
  // default: MAGMA stock weights (entity-axis.DEFAULT_WEIGHTS).
  default:  Object.freeze({
    entity:   0.40, temporal: 0.25, causal: 0.20, semantic: 0.15
  })
});

// ── Public API ──────────────────────────────────────────────────────────

// classifyIntent(text) → 'chitchat' | 'semantic' | 'episodic' | 'causal' |
//                        'entity' | 'default'
//
// First-match wins; order matters and reflects priority:
//   1. chitchat — short utterances, no real query
//   2. semantic — explicit recall verbs (remember / θυμάσαι / do you know)
//                 BEAT generic "what did we" (episodic). The signal "I
//                 want you to recall a specific fact" is more decisive
//                 than the signal "I want a recent-history summary".
//   3. episodic — temporal anchors / "what did we do" — recent activity
//   4. causal   — "why" / "how did we decide" — explicit reasoning ask
//   5. entity   — code refs / file paths — most code questions land here
//   6. default  — fallback (uses MAGMA stock weights)
//
// We check chitchat FIRST so a single "hi" doesn't classify as semantic
// (would otherwise match nothing and fall to default — cheap path is to
// skip retrieval entirely on greetings).
function classifyIntent(text) {
  const s = String(text || '').trim();
  if (!s) return 'chitchat';
  // Word count short-circuit for chitchat: <= 4 words AND matches one of
  // the chitchat patterns. Don't reject on length alone — "fix it" is
  // 2 words but a real work query.
  const words = s.split(/\s+/).filter(Boolean);
  const p = patterns();
  if (words.length <= 4) {
    for (const re of p.chitchat) if (re.test(s)) return 'chitchat';
  }
  // Epistemic checked BEFORE semantic/episodic — "what date is today"
  // contains the episodic anchor "today" but is really a date question.
  // Trivia precedence prevents false-positive memory dumps on the exact
  // failure mode flagged ("τι μέρα έχουμε σήμερα" must not pull memory).
  for (const re of p.epistemic) if (re.test(s)) return 'epistemic';
  for (const re of p.semantic)  if (re.test(s)) return 'semantic';
  for (const re of p.episodic)  if (re.test(s)) return 'episodic';
  for (const re of p.causal)    if (re.test(s)) return 'causal';
  for (const re of p.entity)    if (re.test(s)) return 'entity';
  return 'default';
}

// weightsForIntent(intent) → axis-weight object OR null (chitchat / epistemic).
// Caller passes the returned object as multiAxisQuery({weights}) when
// non-null; on null, caller skips the retrieval section entirely.
function weightsForIntent(intent) {
  if (!intent || !(intent in WEIGHT_PRESETS)) return WEIGHT_PRESETS.default;
  return WEIGHT_PRESETS[intent];
}

//  intent-routed MOUNTING policy.
//
// Earlier wiring let the prefix provider call multiAxisQuery on every
// non-chitchat intent. ~70% of prompts fall to `default` (Klinger /
// Andrews-Hanna pattern: real prompts rarely match a specific intent
// class), so MAGMA fired on near-everything and dumped noise into
// trivial queries. Now: intent maps to one of three mount policies.
//
//   null_mount    — skip retrieval entirely (greetings, trivia)
//   dmn_slot      — identity envelope only, no similarity search.
//                   Brain analog: Default Mode Network (Raichle 2001),
//                   self-referential + unresolved-relevance content,
//                   not recency-weighted similarity. Identity stays
//                   architecturally privileged (Northoff 2006 self-
//                   reference effect). MAGMA recall does NOT fire.
//   full_recall   — MAGMA 4-axis fusion with intent-weighted axes.
//                   Used for explicit recall verbs (semantic), temporal
//                   anchors (episodic), causal "why" questions, and
//                   entity-shaped queries (file paths / function refs).
//
// The substrate-as-mind thesis says a real brain has private internals
// and surfaces them selectively. dmn_slot is the "idle mode" that keeps
// identity always-on while NOT dumping the entire engram pool.
const MOUNT_POLICIES = Object.freeze({
  chitchat:  'null_mount',
  epistemic: 'null_mount',
  default:   'dmn_slot',
  episodic:  'full_recall',
  causal:    'full_recall',
  entity:    'full_recall',
  semantic:  'full_recall'
});

function mountPolicyForIntent(intent) {
  if (!intent || !(intent in MOUNT_POLICIES)) return 'dmn_slot';
  return MOUNT_POLICIES[intent];
}

// route(text) — convenience wrapper for callers that want all three at once.
// Returns { intent, weights, mount_policy }. weights === null means "skip
// retrieval for this class". mount_policy is the architectural decision:
// what KIND of memory section should attach to this turn (see comment above).
function route(text) {
  let intent = classifyIntent(text);
  // The memory-question classifier outranks the default bucket: left to
  // the default, most memory-shaped phrasings — including the most
  // natural Greek forms ("τι είχαμε πει", "πού είχαμε μείνει") — fall to
  // default/dmn_slot, so the turn reaches the model with NO query-driven
  // memory mounted and the model has to PULL via tools (or answer blind).
  // On owned lanes memory is PUSHED; the same classifier that forces
  // recall on the proxy lane and dispatches pre-LLM decides the mount
  // here — one source of truth, or the surfaces drift apart again.
  if (intent === 'default') {
    try {
      const shaped = require('./memory-shaped.js');
      if (shaped.isMemoryShaped(text)) intent = 'episodic';
    } catch (_) { /* classifier unavailable — keep the base class */ }
  }
  return {
    intent,
    weights: weightsForIntent(intent),
    mount_policy: mountPolicyForIntent(intent)
  };
}

module.exports = {
  classifyIntent,
  weightsForIntent,
  mountPolicyForIntent,
  route,
  WEIGHT_PRESETS,
  MOUNT_POLICIES,
  // Exposed so tests can assert pattern coverage without re-deriving:
  _patterns: patterns
};
