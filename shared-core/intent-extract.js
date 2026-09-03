// SPDX-License-Identifier: AGPL-3.0-only
// Zero-LLM intent extraction — pure-JS heuristic pipeline.
//
// Turns a free-form user prompt into a structured intent ActionRecord
// schema fragment: { goal, constraint?, acceptance_criteria?,
// source_message_hash, alternatives_considered? }.
//
// Design choice (per the intent-extraction design): start with pure-regex
// heuristics, no Wink/Transformers.js. Zero deps, zero downloads, runs in
// <5ms. If precision on the smoke fixture falls below 80% we add Wink
// later — measurably justified per the spec.
//
// 12-step pipeline:
//   1. Normalize whitespace + strip code fences.
//   2. Reject if too short / slash command / chitchat.
//   3. SHA256 the (normalized) prompt for source_message_hash.
//   4. Detect imperative verb (canonical list).
//   5. Detect direct object (NP after verb, capped at 8 tokens).
//   6. Compose goal = verb + ' ' + object.
//   7. Detect file paths → acceptance_criteria.
//   8. Detect constraints (must/should/without/don't/never/always/...).
//   9. Detect alternatives (or/either/instead of/rather than).
//  10. Detect acceptance criteria (tests pass/builds/under Nms/...).
//  11. Compute confidence score.
//  12. Return { ok, confidence, intent, reason }.
//
// Threshold for "good enough to write": confidence >= 0.6 (caller checks).

const crypto = require('crypto');

// ── Canonical imperative verbs (lower-case, sorted by typical frequency) ──
// Drawn from coding-task vocabulary. Add domain-specific verbs via the
// EXTRA_VERBS env var (comma-separated, lowercased at load).
const CANONICAL_VERBS = [
  'add', 'fix', 'implement', 'create', 'update', 'remove', 'delete',
  'refactor', 'rename', 'move', 'extract', 'inline', 'replace',
  'test', 'debug', 'build', 'review', 'optimize', 'profile', 'benchmark',
  'wire', 'hook', 'gate', 'expose', 'document', 'verify', 'measure',
  'investigate', 'integrate', 'migrate', 'deprecate', 'audit', 'analyze',
  'check', 'inspect', 'rerun', 'restart', 'reset', 'clean', 'scaffold',
  'install', 'uninstall', 'configure', 'enable', 'disable', 'toggle',
  // Decision-language verbs so mind supersession-marker
  // prompts like "use OAuth instead of JWT" pass the verb gate.
  'use', 'switch', 'choose', 'pick', 'adopt', 'prefer', 'evaluate',
  'consider', 'try', 'swap', 'drop', 'keep', 'ship', 'lock', 'go',
  'avoid', 'block', 'allow', 'serve', 'route', 'cache', 'compress'
];
const EXTRA_VERBS = (process.env.TROTH_INTENT_EXTRA_VERBS || '')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const VERBS = Array.from(new Set([...CANONICAL_VERBS, ...EXTRA_VERBS]));
const VERB_RE = new RegExp('\\b(' + VERBS.join('|') + ')\\b', 'i');

// Chitchat / non-actionable prompts — explicit reject list.
// Chitchat = the prompt is JUST the acknowledgment token, with optional
// punctuation. Anchored end so prompts that START with these tokens but
// continue with substantive content (e.g. "no actually use OAuth instead
// of JWT" — a mind supersession-marker prompt) are NOT rejected.
//
// Multilingual: top languages Claude Code users actually code-switch in.
// English | Greek (ναι/όχι/ντάξει) | Spanish (sí/vale/gracias) |
// French (oui/non/d'accord) | German (ja/nein/ok) | Italian (sì/no/ok) |
// Portuguese (sim/não/obrigado) | Japanese (はい/いいえ).
const CHITCHAT_RE = /^(yes|no|y|n|ok|okay|cool|nice|continue|next|go|done|thanks|thx|ty|please|sure|yep|nope|alright|good|great|perfect|got it|understood|maybe|hmm|wait|stop|halt|pause|cancel|abort|ναι|όχι|οκ|ντάξει|εντάξει|ευχαριστώ|ευχαριστω|μπράβο|sí|si|vale|gracias|claro|bueno|oui|non|d'accord|merci|bien|ja|nein|gut|danke|ach|sì|certo|grazie|sim|não|obrigado|tudo bem|はい|いいえ|ありがとう|ok)[!.?,\s]*$/i;

// Constraint cues — clauses headed by these usually express must/must-not.
// We capture the cue word + an optional `not` modifier + the content so
// negation isn't silently dropped from the rendered clause.
const CONSTRAINT_CUES = [
  /\b(must|should|need to|needs to|require[ds]?)(\s+not)?\s+([^.;,!?\n]{3,80})/gi,
  /\b(without|don'?t|do not|never|avoid|except)()\s+([^.;,!?\n]{3,80})/gi,
  /\b(make sure|ensure|guarantee)()\s+(?:that\s+)?([^.;,!?\n]{3,80})/gi
];

// Alternative cues.
const ALT_CUES = [
  /\b(or|either)\s+([^.;,!?\n]{3,60})/gi,
  /\b(instead of|rather than|alternatively)\s+([^.;,!?\n]{3,60})/gi
];

// Acceptance criteria cues.
const ACCEPT_CUES = [
  /\b(tests?\s+(?:pass|green))\b/i,
  /\b(builds?\s+(?:pass|green|cleanly))\b/i,
  /\b(deploys?\s+cleanly)\b/i,
  /\b(merges?\s+cleanly)\b/i,
  /\b(under\s+\d+\s*(?:ms|s|min|seconds?|minutes?))\b/i,
  /\b(≤|>=|<=|≥)\s*\d+/,
  /\b(coverage\s*(?:>|≥|>=)\s*\d+%?)/i
];

// File-path detection. Matches typical extensions; trims trailing punctuation.
const FILE_PATH_RE = /(?:[\w./-]+\/)?[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|yml|yaml|toml|html|css|scss|vue|svelte)\b/g;

// ── Step 1: normalize ─────────────────────────────────────────────────────
function _normalize(prompt) {
  if (typeof prompt !== 'string') return '';
  // Strip fenced code blocks (we don't extract intent from code).
  let s = prompt.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Recall / meta-question patterns. These are prompts that ASK ABOUT prior
// work rather than ask FOR new work, so capturing them as intents pollutes
// the substrate with self-referential goals. Surfaced  by
// cross-session-recall.mjs T3.01 — a recall prompt mentioning a directory
// path produced a "clean -test-" false-positive intent.
const RECALL_QUESTION_RE = /\b(what (?:goals?|intents?|work) (?:did|have|was)|i'?m checking what work happened|list every distinct (?:goal|intent)|use only mcp tools|recall what)\b/i;

// ── Step 2: reject obvious non-intent prompts ─────────────────────────────
function _shouldReject(s) {
  // 15 chars is the language-agnostic floor: CJK scripts encode more
  // meaning per codepoint (Japanese "代わりにOAuthを使って認証する" = 17
  // codepoints, fully substantive), so 30 was English-biased. Real
  // noise ("ok now", "go", "yes please") stays below 15.
  if (!s || s.length < 15) return 'too_short';
  if (s.startsWith('/')) return 'slash_command';
  if (CHITCHAT_RE.test(s)) return 'chitchat';
  if (RECALL_QUESTION_RE.test(s)) return 'recall_question';
  return null;
}

// ── Step 3: hash ──────────────────────────────────────────────────────────
function _hash(s) {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// ── Step 4: detect verb ───────────────────────────────────────────────────
// An imperative opens the message or follows a lead-in ("please", "can
// you", "now", a clause break). A verb met mid-sentence is a word of the
// sentence, in whatever language the sentence is in.
const LEAD_IN_RE = /(?:^|[.;:!?,\-\u2014(]\s*|\b(?:please|pls|plz|now|then|also|and|so|ok|okay|first|next|finally|just|to|me|us|you|it|kindly|go|let'?s|lets|can you|could you|would you|will you|i want you to|i need you to|need to|want to|have to|should|must|help me|try to|go ahead and)\s+)$/i;
const VERB_RE_ALL = new RegExp(VERB_RE.source, 'gi');
function _detectVerb(s) {
  VERB_RE_ALL.lastIndex = 0;
  let m;
  while ((m = VERB_RE_ALL.exec(s)) !== null) {
    if (LEAD_IN_RE.test(s.slice(0, m.index))) return { verb: m[1].toLowerCase(), index: m.index };
  }
  return { verb: null, index: -1 };
}

// A pasted transcript or log is somebody else's words: lines with a
// timestamp or a speaker prefix, or a long block of many lines.
const CHAT_LINE_RE = /^\s*(?:\[?\d{1,2}[\/.:-]\d{1,2}[^\]\n]{0,24}\]?\s*)?[^\n:]{1,40}:\s\S/;
const TIMESTAMP_LINE_RE = /^\s*\[?\d{1,2}[\/.:-]\d{1,2}(?:[\/.:-]\d{2,4})?[, ]/;
function _isPasted(prompt) {
  const raw = typeof prompt === 'string' ? prompt : '';
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length >= 3) {
    let shaped = 0;
    for (const l of lines) if (TIMESTAMP_LINE_RE.test(l) || CHAT_LINE_RE.test(l) || /^\s*[>|]/.test(l)) shaped++;
    if (shaped >= 2 && shaped >= Math.ceil(lines.length / 3)) return true;
  }
  return raw.length > 1200 && lines.length >= 8;
}

// ── Step 5: detect object after verb ──────────────────────────────────────
// NP heuristic: words after the verb until a stop-cue or sentence break.
// Capped at 8 tokens, stripped of leading articles.
const STOP_CUES = /\b(but|because|while|so|then|when|if|unless|though|although|with|using|via|to|in order to|for|because|since)\b/i;
function _detectObject(s, verbIndex) {
  if (verbIndex < 0) return null;
  // Slice from after the verb's word.
  const tail = s.slice(verbIndex);
  const afterVerb = tail.replace(VERB_RE, '').trim();
  if (!afterVerb) return null;
  // Cut at first stop-cue or end of sentence.
  const stopMatch = afterVerb.match(STOP_CUES);
  let span = stopMatch ? afterVerb.slice(0, stopMatch.index) : afterVerb;
  span = span.split(/[.;,!?\n]/)[0] || span;
  // Strip leading articles + filler.
  span = span.replace(/^(the|a|an|some|any|this|that|these|those|my|our|your)\s+/i, '');
  // Cap at 8 tokens.
  const tokens = span.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.join(' ');
}

// ── Step 7: detect file paths ─────────────────────────────────────────────
function _detectFilePaths(s) {
  const found = s.match(FILE_PATH_RE) || [];
  // Dedupe + cap.
  return Array.from(new Set(found)).slice(0, 5);
}

// ── Step 8: detect constraints ────────────────────────────────────────────
function _detectConstraints(s) {
  const out = [];
  for (const re of CONSTRAINT_CUES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      // m[1]=cue, m[2]=optional ' not', m[3]=clause body
      const clause = (m[1] + (m[2] || '') + ' ' + m[3]).trim().replace(/\s+/g, ' ');
      if (clause && !out.includes(clause)) out.push(clause);
      if (out.length >= 5) break;
    }
    if (out.length >= 5) break;
  }
  return out;
}

// ── Step 9: detect alternatives ───────────────────────────────────────────
function _detectAlternatives(s) {
  const out = [];
  for (const re of ALT_CUES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const alt = m[2].trim().replace(/\s+/g, ' ');
      if (alt && !out.includes(alt)) out.push(alt);
      if (out.length >= 4) break;
    }
    if (out.length >= 4) break;
  }
  return out;
}

// ── Step 10: detect acceptance criteria ───────────────────────────────────
function _detectAcceptCriteria(s, filePaths) {
  const cues = [];
  for (const re of ACCEPT_CUES) {
    const m = s.match(re);
    if (m) cues.push(m[0]);
    if (cues.length >= 3) break;
  }
  if (filePaths.length > 0) cues.push('changes touch: ' + filePaths.join(', '));
  return cues.length ? cues.join('; ') : null;
}

// ── Step 11: confidence ───────────────────────────────────────────────────
function _confidence(verb, object, hasCriteria, hasConstraints) {
  let c = 1.0;
  if (!verb)            c -= 0.4;
  if (!object)          c -= 0.3;
  if (!hasCriteria)     c -= 0.05;
  if (!hasConstraints)  c -= 0.05;
  return Math.max(0, Math.min(1, c));
}

// ── Public API ────────────────────────────────────────────────────────────
function extractIntent(prompt) {
  if (_isPasted(prompt)) return { ok: false, confidence: 0, intent: null, reason: 'pasted_text' };
  const s = _normalize(prompt);
  const reject = _shouldReject(s);
  if (reject) return { ok: false, confidence: 0, intent: null, reason: reject };

  const { verb, index } = _detectVerb(s);
  const object = verb ? _detectObject(s, index) : null;
  const filePaths = _detectFilePaths(s);
  const constraints = _detectConstraints(s);
  const alternatives = _detectAlternatives(s);
  const criteria = _detectAcceptCriteria(s, filePaths);
  const confidence = _confidence(verb, object, !!criteria, constraints.length > 0);

  // Language-agnostic fallback: when the English-coupled verb/object
  // regex extractor fails, we DO NOT reject the prompt. Real-world
  // Claude Code usage spans Greek, greeklish, mixed-language code-
  // switching — the agent understands all of them, so this layer must
  // not gate on English regex. Instead, downgrade confidence and use
  // the cleaned prompt itself as the goal. The verb extraction becomes
  // a confidence booster, not a gate.
  if (!verb || !object) {
    const fallbackGoal = s.toLowerCase().slice(0, 240);
    if (!fallbackGoal || fallbackGoal.length < 10) {
      return { ok: false, confidence: 0, intent: null, reason: 'too_short_after_normalize' };
    }
    const intent = {
      input: {
        goal: fallbackGoal,
        source_message_hash: _hash(s),
        extraction: 'fallback_no_verb' // tag so downstream can distinguish quality
      },
      output: { chosen_path: fallbackGoal }
    };
    if (constraints.length)  intent.input.constraint = constraints;
    if (criteria)            intent.input.acceptance_criteria = criteria;
    if (alternatives.length) intent.output.alternatives_considered = alternatives;
    // Fixed mid-confidence: passes the default 0.6 threshold so the
    // intent makes it into the substrate, but stays below the 0.9
    // high-confidence band so consumers know the structure is loose.
    return { ok: true, confidence: 0.7, intent, reason: 'fallback' };
  }

  const intent = {
    input: {
      goal: (verb + ' ' + object).toLowerCase(),
      source_message_hash: _hash(s),
      extraction: 'verb_object'
    },
    output: {
      // chosen_path is the agent's commitment; at capture time we don't
      // know which path the agent will pick, so we mirror the goal as a
      // placeholder. The agent's first downstream action will refine this
      // (Tier 3 will add explicit chosen-path resolution).
      chosen_path: (verb + ' ' + object).toLowerCase()
    }
  };
  if (constraints.length)  intent.input.constraint = constraints;
  if (criteria)            intent.input.acceptance_criteria = criteria;
  if (alternatives.length) intent.output.alternatives_considered = alternatives;

  return { ok: true, confidence, intent, reason: null };
}

module.exports = {
  extractIntent,
  _isPasted,
  // Exposed for tests + downstream tooling (negative-knowledge fingerprinting in P16.5).
  _normalize,
  _shouldReject,
  _detectVerb,
  _detectObject,
  _detectFilePaths,
  _detectConstraints,
  _detectAlternatives,
  _detectAcceptCriteria,
  _confidence,
  CANONICAL_VERBS,
  VERBS
};
