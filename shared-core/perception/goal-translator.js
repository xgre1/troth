// SPDX-License-Identifier: AGPL-3.0-only Goal-to-action translator
// (substrate-side). Faculty emits a high-level intent:browser:goal {goal_text,
// success_criteria}. Substrate's translator turns it into a concrete step
// sequence (skill-lookup or conservative fallback). Faculty NEVER drives the
// browser at the selector level — it expresses intent at the goal layer. Why
// substrate-side: if faculty emits step sequences directly, drift sneaks in
// (faculty is "driving the browser"). Substrate-thesis correct: faculty wants
// something, substrate handles mechanics. v0: no compiled skill library.
// Pipeline: 1. Try skill lookup (matches goal_text against compiled skill
// patterns). If hit: emit compiled step sequence. 2. Conservative fallback:
// extract a starting URL from goal_text if obvious (look for explicit
// URLs/domains), navigate there, capture AX-tree as engram, suspend the goal
// pending faculty refinement. Iteration converges: next faculty wake reads the
// AX-tree engram and emits more specific goal OR refined steps.

'use strict';

const URL_REGEX = /https?:\/\/[^\s'"<>]+/i;
const DOMAIN_REGEX = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s'"<>]*)?)\b/i;

// Tiny skill registry. Operator can seed via operator-signed
// engrams (scope='skill:browser:*'); the dream cycle compiles
// new ones from successful action sequences.
const _skillRegistry = [];

function registerSkill(skill) {
  // skill: { name, match: function(goal_text)→bool, build: function(goal_text, ctx)→steps[] }
  if (!skill || typeof skill.match !== 'function' || typeof skill.build !== 'function') {
    throw new Error('skill must have match() + build()');
  }
  _skillRegistry.push(skill);
}

function _lookupSkill(goalText) {
  for (const s of _skillRegistry) {
    try { if (s.match(goalText)) return s; }
    catch (_) { /* skip broken skill */ }
  }
  return null;
}

function _extractStartUrl(goalText) {
  const t = String(goalText || '');
  const urlHit = t.match(URL_REGEX);
  if (urlHit) return urlHit[0];
  const domHit = t.match(DOMAIN_REGEX);
  if (domHit) return 'https://' + domHit[1].replace(/^https?:\/\//, '');
  return null;
}

// Main entry. Returns { steps, mode: 'skill'|'fallback'|'unresolved', skill_name? }.
// Caller (intent router or chat handler) takes the steps and dispatches
// via browser-do.js (which handles vault + CDP + observer-engram flow).
function translate(goalIntent) {
  const text = String((goalIntent && goalIntent.payload && goalIntent.payload.goal_text) || goalIntent.goal_text || '').trim();
  if (!text) return { steps: [], mode: 'unresolved', reason: 'empty_goal_text' };

  const skill = _lookupSkill(text);
  if (skill) {
    let steps;
    try { steps = skill.build(text, { goalIntent }); }
    catch (e) {
      return { steps: [], mode: 'unresolved', reason: 'skill_build_threw: ' + e.message, skill_name: skill.name };
    }
    if (Array.isArray(steps) && steps.length) {
      return { steps, mode: 'skill', skill_name: skill.name };
    }
  }

  // Conservative fallback: navigate + give faculty an observation
  // to read on next tick. extract_text on body provides the
  // semantic_summary engram body for refinement.
  const url = _extractStartUrl(text);
  if (!url) {
    return {
      steps: [],
      mode: 'unresolved',
      reason: 'no_skill_match_and_no_url_in_goal_text',
    };
  }
  return {
    steps: [
      { type: 'navigate', url, timeout_ms: 30000 },
      { type: 'wait_ms', ms: 1500 },
      { type: 'extract_text', selector: 'body' },
    ],
    mode: 'fallback',
  };
}

module.exports = {
  translate,
  registerSkill,
  // For tests / introspection.
  _registrySize: () => _skillRegistry.length,
  _clearRegistry: () => { _skillRegistry.length = 0; },
};
