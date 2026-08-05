// SPDX-License-Identifier: AGPL-3.0-only
// Voice Triage — classify a voice-mode user prompt into one of four
// routes so the proxy can shape the response accordingly.
//
// Pure deterministic heuristic. No LLM call, no I/O. Runs once per
// voice-mode request before routing.
//
// Four classifications:
//
//   'quick_ack'     — pure greetings, acks, fillers (≤6 input words).
//                     Route: small fast model, no substrate inject,
//                     persona prompt with HARD ≤25 word ceiling.
//                     Examples: "hi", "thanks", "okay cool", "got it".
//
//   'brief_factual' — single-domain factual question, short, not code.
//                     Route: small fast model + read-only substrate,
//                     persona prompt with ≤50 word ceiling.
//                     Examples: "what time is it", "what model are
//                     we using".
//
//   'deep_work'     — code edits, multi-step reasoning, anything the
//                     full agent chain owns. Route: existing heavy
//                     pipeline. Output goes through persona shaper at
//                     the end (truncate-with-headline-and-offer).
//                     Examples: "fix the bug in app.tsx", "refactor X".
//
//   'show_text'     — user wants the answer ON SCREEN, not spoken.
//                     Route: heavy pipeline writes to chat panel; voice
//                     replies with a 6-word ack only.
//                     Examples: "show me X", "paste the result", "save
//                     the snippet", "give me the file path".
//
// Conservative on `deep_work` — false positive there only loses speed,
// never quality. Liberal on `quick_ack` only when input is genuinely
// short.

// Show-text intent: explicit request to PUT something on screen / on
// disk rather than HEAR it. These should not produce long voice replies.
const SHOW_PATTERNS = [
  /\bshow\s+(?:me|us)\b/i,
  /\bpaste\b/i,
  /\bwrite\s+(?:that|this|it)\s+down\b/i,
  /\bsave\s+(?:that|this|it|the)\b/i,
  /\bgive\s+me\s+the\s+(?:file|path|url|link|snippet|code)\b/i,
  /\bcopy\s+(?:that|this|it)\s+(?:to|into)\b/i,
  /\bopen\s+(?:the|that|this)\s+(?:file|panel|chat)\b/i
];

// Code / multi-step markers — punt to the heavy chain. We err on the
// side of routing here: a missed code prompt that goes to the fast
// path produces a low-quality answer, which is a worse failure mode
// than an extra second of latency.
const CODE_PATTERNS = [
  /\b(?:fix|debug|patch|refactor|rewrite|implement|build|add|remove|delete|create)\b.*\b(?:bug|function|class|method|file|test|api|endpoint|route|component|hook|module|script|migration|table|query|model)\b/i,
  /\b\w+\.(?:tsx?|jsx?|py|rs|go|rb|java|cs|cpp|c|h|hpp|md|json|yaml|yml|toml|sh|mjs|cjs)\b/i,    // file refs
  /\b(?:explain|describe|walk\s+(?:me\s+)?through)\b.*\b(?:code|function|file|class|hook|module|component|test|repo|architecture)\b/i,
  /\b(?:why|how)\s+(?:does|is|did)\b.*\b(?:test|build|fail|pass|error|crash|hang|loop|leak)\b/i,
  /\b(?:run|invoke|call|launch|start|stop|kill)\b.*\b(?:test|build|server|proxy|daemon|process|script|bench)\b/i,
  /\b(?:git|npm|cargo|pnpm|yarn|deno|bun|docker|kubectl|brew)\b/i,
  /\b(?:plan|architect|design)\s+(?:the|a|an|this)\b/i
];

// Brief-factual question shape: starts with a question word and is
// short, OR matches a known-factual template (time/date/state).
const FACTUAL_OPENERS = [
  /^\s*(?:what|when|where|who|which|how\s+many|how\s+long|is|are|do|does|did|can|could|should)\b/i
];
const FACTUAL_TEMPLATES = [
  /\bwhat\s+time\b/i,
  /\bwhat(?:'s|\s+is)\s+the\s+(?:date|day|weather|temperature|forecast)\b/i,
  /\bhow\s+many\s+(?:tests|files|errors|warnings|requests)\b/i,
  /\bis\s+the\s+(?:proxy|server|api|daemon|process|build)\s+(?:up|down|running|alive|ok)\b/i,
  /\bwhat\s+(?:model|provider|tier)\s+(?:are\s+we|am\s+i|is\s+this)\b/i
];

// Stop / interrupt / barge — never lecture. Always quick_ack.
const STOP_PATTERNS = [
  /^\s*(?:stop|wait|pause|hold\s+on|hang\s+on|never\s*mind|forget\s+it|cancel|abort)\s*[.!?]?\s*$/i,
  /^\s*(?:no|nope|nah|yes|yeah|yep|ok|okay|sure|thanks|thank\s+you|cool|nice|great)\s*[.!?]?\s*$/i,
  /^\s*(?:uh|um|er|hm+|huh)\s*[.!?]?\s*$/i
];

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

// triage(userText, opts) → { route, max_words, reason, signals }
//
// route: 'quick_ack' | 'brief_factual' | 'deep_work' | 'show_text'
// max_words: int — soft ceiling the proxy injects into the persona prompt
// reason: short string for telemetry / debug
// signals: which patterns fired (object) — for tuning
function triage(userText, opts) {
  opts = opts || {};
  const text = String(userText || '').trim();
  const words = wordCount(text);

  // Empty input — treat as quick_ack so we don't spin up the heavy chain
  // for what's likely a barge-in / mis-transcription.
  if (!text) {
    return { route: 'quick_ack', max_words: 25, reason: 'empty input', signals: {} };
  }

  const signals = {
    word_count: words,
    show: false,
    stop: false,
    code: false,
    factual_opener: false,
    factual_template: false
  };

  // Show-text wins over everything else. Even "show me how to fix the
  // bug" is a SHOW request — the user wants the patch on screen, not a
  // voice walkthrough.
  for (const pat of SHOW_PATTERNS) {
    if (pat.test(text)) { signals.show = true; break; }
  }
  if (signals.show) {
    //  show_text was originally "produce a 6-word voice ack
    // and write the body to a separate chat panel". The panel-write
    // plumbing on the Tauri side does not exist; with the strict
    // 6-word cap the model produced ONLY the ack, so the chat panel
    // showed "On screen." too — the persona was lying. Until we wire a
    // real silent-panel path, behave like a brevity-tightened deep_work:
    // the full content lands in the conversation (chat panel reads from
    // there) AND the spoken reply stays short via the persona shaper +
    // Tauri-side hard truncate.
    return {
      route: 'show_text',
      max_words: 35,
      reason: 'show/paste/save intent (collapsed to brevity-shaped deep_work)',
      signals
    };
  }

  // Stop / filler / single-word ack — always quick_ack, regardless of
  // any other matches.
  for (const pat of STOP_PATTERNS) {
    if (pat.test(text)) { signals.stop = true; break; }
  }
  if (signals.stop) {
    return {
      route: 'quick_ack',
      max_words: 25,
      reason: 'stop/filler/ack',
      signals
    };
  }

  // Code intent → deep_work. Check before the short-input path so
  // "fix bug in x.ts" (4 words) doesn't fall through to quick_ack.
  for (const pat of CODE_PATTERNS) {
    if (pat.test(text)) { signals.code = true; break; }
  }
  if (signals.code) {
    return {
      route: 'deep_work',
      max_words: 35,
      reason: 'code / multi-step keyword match',
      signals
    };
  }

  // Brief factual — opener AND ≤12 words, OR template match.
  for (const pat of FACTUAL_OPENERS) {
    if (pat.test(text)) { signals.factual_opener = true; break; }
  }
  for (const pat of FACTUAL_TEMPLATES) {
    if (pat.test(text)) { signals.factual_template = true; break; }
  }
  if (signals.factual_template || (signals.factual_opener && words <= 12)) {
    return {
      route: 'brief_factual',
      max_words: 50,
      reason: signals.factual_template ? 'factual template' : 'factual opener (short)',
      signals
    };
  }

  // Short input → quick_ack. Threshold 6 words per plan.
  if (words <= 6) {
    return {
      route: 'quick_ack',
      max_words: 25,
      reason: 'short input (≤6 words)',
      signals
    };
  }

  // Default: deep_work. Conservative — better one extra second than a
  // shallow answer to a real question.
  return {
    route: 'deep_work',
    max_words: 35,
    reason: 'default — no quick path matched',
    signals
  };
}

// PERSONA_PROMPTS removed — substrate-as-mind invariant. Voice formatting
// contracts (≤25 / ≤35 / ≤50 words, no markdown, headline-first) are
// owned by the substrate's identity layer (audio-mode anchors + the
// entity system-prompt builder), not by a parallel prompt path the proxy
// appends mid-flight. The route metadata (max_words) below is still
// emitted for downstream consumers (UI hint, telemetry, future
// substrate-side selection of identity engrams), but no prompt body is
// shipped from this module anymore. Removed  along with the
// proxy server.js append that consumed it.

module.exports = { triage };
