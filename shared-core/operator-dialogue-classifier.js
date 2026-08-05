// SPDX-License-Identifier: AGPL-3.0-only
// operator-dialogue-classifier.js — substrate-side classical classifier
// for operator chat turns.
//
// Substrate-thesis: operator's conversation IS authorization. When
// operator types something directive-shaped, the substrate should
// auto-promote it to a draft active_project (engram-shape), surface it
// for one-tap confirm via session-cached signer, then activate. NO
// LLM in this path — pure classical pattern detection. The classifier
// is the input edge of that pipeline.
//
// Closes a gap found in review: operator typing a goal
// in chat went nowhere because no substrate code analyzed operator
// turns. Slash commands worked; natural conversation didn't. That's
// the agent-framework-shape that the dream rejects.
//
// API:
//   classify(operatorText, opts?) → {
//     detected: bool,
//     shape: 'imperative' | 'request' | 'declarative' | 'question' | null,
//     verb: string|null,
//     subject: string|null,
//     proposed_short_name: string|null,
//     proposed_purpose: string|null,
//     confidence: 0..1,
//     reasons: string[]
//   }
//
// Heuristic shape (v1):
//   Imperative-at-start verbs: research/draft/write/ship/build/...
//   - "let's <verb>", "i want you to <verb>", "please <verb>", "can you <verb>"
//   Multi-clause/multi-line messages: classify first sentence.
//   Question marks → shape='question', detected=false (questions are
//     conversation, not authorizations).
//   Confidence: starts 0.5 on bare verb match; +0.2 if work-noun subject
//     captured (not just "this"/"that"); +0.1 if explicit time cue
//     ("today"/"this week"/"by Friday"); cap at 0.95.
//
// Caller pipeline (in active-project.js proposeFromDialogue):
//   classify → if detected + confidence >= threshold → write draft
//   active_project + operator_surface engram for one-tap confirm.

'use strict';

// Imperative work-verbs the partner can plausibly pursue. Curated short
// list (extend operator-policy engram later).
const IMPERATIVE_VERBS = [
  'research', 'investigate', 'analyze', 'analyse', 'study', 'review',
  'draft', 'write', 'outline', 'summarize', 'summarise', 'compose',
  'ship', 'build', 'create', 'scaffold', 'prototype', 'bootstrap',
  'design', 'plan', 'sketch',
  'fix', 'debug', 'refactor', 'rewrite', 'patch',
  'find', 'locate', 'search', 'identify',
  'audit', 'check', 'verify', 'test',
  'document', 'explain'
];

// Polite-imperative wrappers — operator's phrasing that maps to an
// imperative verb in the second slot.
const REQUEST_PREFIXES = [
  /^let'?s\s+/i,
  /^let\s+us\s+/i,
  /^i\s+want\s+(?:you\s+)?to\s+/i,
  /^(?:please|pls)\s+/i,
  /^can\s+you\s+/i,
  /^could\s+you\s+/i,
  /^would\s+you\s+/i,
  /^we\s+(?:should|need\s+to)\s+/i
];

const TIME_CUES = [
  'today', 'tonight', 'tomorrow', 'this week', 'this weekend',
  'next week', 'next month',
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bby\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
  /\bbefore\s+/i,
  /\bin\s+\d+\s+(?:days|weeks|hours)\b/i
];

const VERB_RE = new RegExp('\\b(' + IMPERATIVE_VERBS.join('|') + ')\\b', 'i');

function _firstSentence(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  // First period/question/exclamation or newline.
  const m = trimmed.match(/^([^.?!\n]+[.?!\n]?)/);
  return (m ? m[1] : trimmed).trim();
}

function _stripRequestPrefix(s) {
  for (const re of REQUEST_PREFIXES) {
    const m = s.match(re);
    if (m) return { stripped: s.slice(m[0].length).trim(), prefix: m[0] };
  }
  return { stripped: s, prefix: null };
}

function _extractSubject(afterVerb) {
  if (!afterVerb) return null;
  // Strip leading "the/a/an/this/that/those/our/my" articles to surface
  // the meaningful noun phrase.
  const cleaned = afterVerb.replace(/^(the|a|an|this|that|those|these|our|my|some)\s+/i, '');
  // Stop at clause boundaries (comma, "and", "but", "so").
  const m = cleaned.match(/^([^,;\n]+?)(?:\s+(?:and|but|so|because|since|while|when|if|then)\b|[,;]|$)/i);
  const subject = (m ? m[1] : cleaned).trim();
  // Trivial / pronoun-only subjects don't anchor a project.
  if (!subject || subject.length < 3) return null;
  if (/^(it|this|that|them|us|those)$/i.test(subject)) return null;
  return subject;
}

function _hasTimeCue(text) {
  const lower = text.toLowerCase();
  for (const cue of TIME_CUES) {
    if (typeof cue === 'string' && lower.indexOf(cue) >= 0) return true;
    if (cue instanceof RegExp && cue.test(text)) return true;
  }
  return false;
}

// Convert "research the substrate thesis" → "research-substrate-thesis".
// Used as the proposed active_project short_name. Capped at 50 chars +
// stripped of non-[A-Za-z0-9_-] chars so it fits the scope grammar.
function _proposeShortName(verb, subject) {
  const v = (verb || '').toLowerCase();
  const s = (subject || '').toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  let name = (v && s) ? (v + '-' + s) : (v || s);
  if (name.length > 50) name = name.slice(0, 50).replace(/-+$/, '');
  return name || null;
}

function classify(operatorText, opts) {
  opts = opts || {};
  const reasons = [];
  const result = {
    detected: false,
    shape: null,
    verb: null,
    subject: null,
    proposed_short_name: null,
    proposed_purpose: null,
    confidence: 0,
    reasons
  };
  if (typeof operatorText !== 'string' || !operatorText.trim()) {
    reasons.push('empty_input');
    return result;
  }
  const first = _firstSentence(operatorText);
  if (!first) { reasons.push('no_first_sentence'); return result; }

  // Questions: shape captured, but NOT detected as an authorization.
  if (/\?\s*$/.test(first)) {
    result.shape = 'question';
    reasons.push('question_mark_terminator');
    return result;
  }

  // Strip request-prefix → look for an imperative verb on the remainder.
  const { stripped, prefix } = _stripRequestPrefix(first);
  result.shape = prefix ? 'request' : 'imperative';
  const verbMatch = stripped.match(new RegExp('^\\s*(' + IMPERATIVE_VERBS.join('|') + ')\\b', 'i'));
  if (!verbMatch) {
    // Fallback: verb anywhere in the first sentence is still a weak signal
    // but we don't auto-propose without it being sentence-initial.
    if (VERB_RE.test(first)) {
      reasons.push('verb_present_but_not_initial');
      result.shape = 'declarative';
    } else {
      reasons.push('no_imperative_verb');
    }
    return result;
  }
  const verb = verbMatch[1].toLowerCase();
  const afterVerb = stripped.slice(verbMatch[0].length).trim();
  const subject = _extractSubject(afterVerb);
  result.verb = verb;
  result.subject = subject;

  // Confidence build-up.
  let confidence = 0.5;
  reasons.push('imperative_verb_initial:' + verb);
  if (subject) {
    confidence += 0.2;
    reasons.push('subject_captured');
  }
  if (_hasTimeCue(first)) {
    confidence += 0.1;
    reasons.push('time_cue_present');
  }
  if (prefix) {
    // Polite-request shape is slightly less confidently a hard authorization
    // than a bare imperative ("let's research X" vs "research X").
    confidence -= 0.05;
    reasons.push('request_prefix_present:' + prefix.trim());
  }
  // Clamp
  if (confidence < 0) confidence = 0;
  if (confidence > 0.95) confidence = 0.95;
  result.confidence = confidence;
  // Threshold for detected=true; operator-policy may override later.
  const threshold = (typeof opts.confidence_threshold === 'number') ? opts.confidence_threshold : 0.55;
  result.detected = confidence >= threshold && !!subject;
  if (result.detected) {
    result.proposed_short_name = _proposeShortName(verb, subject);
    result.proposed_purpose = verb + ' ' + subject;
  }
  return result;
}

module.exports = {
  classify,
  IMPERATIVE_VERBS,
  REQUEST_PREFIXES,
  TIME_CUES,
  // exposed for tests
  _firstSentence,
  _stripRequestPrefix,
  _extractSubject,
  _hasTimeCue,
  _proposeShortName
};
