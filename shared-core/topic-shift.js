// SPDX-License-Identifier: AGPL-3.0-only
// Mind layer — topic-shift detector (P5 / Q6).
//
// Pure scoring function. Combines two signals into a single score:
//   - embedding_drop : (1 - similarity_to_recent_window)
//   - intent_change  : binary, 1 if current intent has new project_pointer
//
// Defaults are the Q6 bootstrap values: w_emb=0.6, w_intent=0.4,
// threshold=0.5. All configurable so callers can tune empirically.
//
// Q6 also flags Q-EMBEDDING-SOURCE as deferred — picking the actual
// embedding model is left to integration time. To ship v0.1 without
// adding an embedding dependency, this module uses a word-overlap
// (token Jaccard) similarity as the default. Callers that have access
// to a real embedding model can pass `similarity` (their own number)
// or `similarityFn` (a function) as overrides.
//
// Pure: no IO, no side effects. Returns a structured result so callers
// can decide whether to fire a topic-shift event (e.g. log to substrate,
// trigger mind/surface re-fetch) based on the score.

const DEFAULT_WEIGHTS = Object.freeze({
  embedding: 0.6,
  intent:    0.4
});
// Bumped  from 0.5 → 0.7 after measured 57% per-prompt fire
// rate in real Claude Code workflow. Word-overlap similarity saturates
// to score=1.0 when project mind-state is sparse (10 tokens) vs prompts
// (50+ tokens) — almost everything looks like "max drift". 0.7 keeps
// genuine topic switches firing while suppressing the saturation noise.
// Override via opts.threshold or plug in real embeddings (Q-EMBEDDING-
// SOURCE) to fix the underlying signal at the root.
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_WINDOW = 5; // last 5 messages form the rolling reference window

// ── Tokenization (stable, lowercase, punctuation-aware) ─────────────────
// Splits on whitespace + punctuation; lowercases; drops <2-char tokens
// to reduce noise from short stop-tokens. Same tokenizer used for both
// sides of the comparison so symmetry is preserved.
function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t && t.length >= 2);
}

// Jaccard similarity over token sets. 1.0 = identical tokens, 0.0 =
// fully disjoint. Symmetric. Used by the intent-goal comparison where
// both sides are short.
function jaccard(aTokens, bTokens) {
  if (!aTokens.length && !bTokens.length) return 1.0;
  if (!aTokens.length || !bTokens.length) return 0.0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// Overlap coefficient: |A ∩ B| / min(|A|, |B|). Asymmetric. Used for
// the recent-window vs current-message comparison because the window is
// typically much larger than a single message — Jaccard biases against
// that asymmetry and reports false topic shifts when the recent text is
// long. Overlap answers "are most of the new message's tokens present
// in the recent context?" which is what we actually want.
function overlapCoefficient(aTokens, bTokens) {
  if (!aTokens.length && !bTokens.length) return 1.0;
  if (!aTokens.length || !bTokens.length) return 0.0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const minSize = Math.min(a.size, b.size);
  return minSize === 0 ? 1.0 : intersection / minSize;
}

// ── Public API ──────────────────────────────────────────────────────────
// scoreTopicShift({
//   current_message,   // string  — the user's latest turn
//   recent_messages,   // string[] — last N messages BEFORE current (any role)
//   prev_intent,       // object  — last intent record (optional)
//   current_intent,    // object  — current intent record (optional)
//   weights,           // { embedding, intent } overrides
//   threshold,         // override (default 0.5)
//   window,            // override window size (default 5)
//   similarity,        // numeric override of computed similarity (skip Jaccard)
//   similarityFn       // function (a, b) => 0..1 to plug in embeddings later
// }) => { score, embedding_drop, intent_change_signal, fired, weights, threshold }
function scoreTopicShift(opts) {
  opts = opts || {};
  const weights = Object.assign({}, DEFAULT_WEIGHTS, opts.weights || {});
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  const windowSize = typeof opts.window === 'number' ? opts.window : DEFAULT_WINDOW;

  // ── Embedding-drop signal ────────────────────────────────────────────
  let embeddingDrop;
  if (typeof opts.similarity === 'number') {
    // Caller already computed similarity; just convert to drop.
    embeddingDrop = clamp01(1 - opts.similarity);
  } else {
    const recent = Array.isArray(opts.recent_messages) ? opts.recent_messages.slice(-windowSize) : [];
    const recentText = recent.join(' ');
    const current = typeof opts.current_message === 'string' ? opts.current_message : '';
    const sim = typeof opts.similarityFn === 'function'
      ? opts.similarityFn(recentText, current)
      : overlapCoefficient(tokenize(recentText), tokenize(current));
    embeddingDrop = clamp01(1 - (typeof sim === 'number' ? sim : 0));
  }

  // ── Intent-change signal ──────────────────────────────────────────────
  // Binary 1 when the current intent has a different project pointer
  // than the previous one. Falls back to comparing whole intent.input
  // shape if pointers aren't available.
  let intentChange = 0;
  const prev = opts.prev_intent || null;
  const curr = opts.current_intent || null;
  if (prev && curr) {
    const prevPtr = (prev.input && prev.input.project_pointer) || prev.project_pointer || null;
    const currPtr = (curr.input && curr.input.project_pointer) || curr.project_pointer || null;
    if (prevPtr !== null && currPtr !== null && prevPtr !== currPtr) intentChange = 1;
    // If pointers absent, compare goal text via overlap coefficient (the
    // same asymmetric measure used for the main embedding signal — same
    // reasoning: keyword overlap of short prompts shouldn't penalize
    // wording variation between same-topic messages). 0.15 threshold is
    // intentionally low — only flag truly disjoint goal vocabularies.
    if (!intentChange && (!prevPtr && !currPtr)) {
      const prevGoal = (prev.input && prev.input.goal) || prev.goal || '';
      const currGoal = (curr.input && curr.input.goal) || curr.goal || '';
      if (prevGoal && currGoal) {
        const sim = overlapCoefficient(tokenize(prevGoal), tokenize(currGoal));
        if (sim < 0.15) intentChange = 1;
      }
    }
  } else if (curr && !prev) {
    // First intent in session — not a "shift" by itself.
    intentChange = 0;
  }

  // ── Weighted combination ──────────────────────────────────────────────
  const score = clamp01(weights.embedding * embeddingDrop + weights.intent * intentChange);
  const fired = score > threshold;

  return {
    score,
    embedding_drop: embeddingDrop,
    intent_change_signal: intentChange,
    fired,
    weights,
    threshold,
    window: windowSize
  };
}

function clamp01(x) {
  if (typeof x !== 'number' || !isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

module.exports = {
  scoreTopicShift,
  // Exported for tests / introspection only.
  _internal: { tokenize, jaccard, overlapCoefficient, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD, DEFAULT_WINDOW }
};
