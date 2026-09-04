// SPDX-License-Identifier: AGPL-3.0-only
// Decision Engine — C2 of Substrate-as-Entity v0.1.
//
// Pure function: takes the current substrate-derived view + the inbound
// event, returns the next action. No side effects, no LLM calls — the
// runtime dispatches whatever this returns.
//
// Action vocabulary (kept tiny; expand only with cause):
//   { kind: 'noop' }                          — drop, nothing to do
//   { kind: 'wait' }                          — yield, wait for more input
//   { kind: 'respond_directly', text }        — deterministic user reply
//   { kind: 'llm', prompt, expected, options }— summon language faculty
//   { kind: 'tool', name, args }              — substrate-side tool call
//   { kind: 'escalate', question }            — ask user, substrate stuck
//
// Rules are declarative match/predicate functions evaluated in order.
// First match wins. Tail rule is `wait` so the loop is always defined.
//
// Default rules cover the foundational anti-patterns so the entity acts
// reasonably out of the box. Callers compose additional rules via
// makeEngine([...rules, ...defaultRules]).

const disagreement = require('./disagreement.js');

const DEFAULT_TEXT_PASSTHROUGH_LIMIT = 280;
const DISAGREEMENT_KINDS = ['anchor', 'hard', 'hypothesis', 'opinion', 'methodology'];

// ── Built-in rules ──────────────────────────────────────────────────────

const ruleStateQuery = {
  name: 'state_query_passthrough',
  match: (view, event) => {
    if (!event || event.type !== 'state_query') return null;
    return { kind: 'state_snapshot', reason: 'state_query_event' };
  }
};

const ruleGoalEvent = {
  name: 'goal_event_passthrough',
  match: (view, event) => {
    if (!event || typeof event.type !== 'string') return null;
    if (!event.type.startsWith('goal_')) return null;
    // goal_add | goal_update | goal_advance | goal_remove
    const op = event.type.slice('goal_'.length);
    return { kind: 'goal_mutate', op, payload: event.input || {}, reason: 'goal_event' };
  }
};

const ruleHonorRefusal = {
  name: 'honor_active_refusal',
  match: (view, event) => {
    if (!event || !event.input || !event.input.text) return null;
    const text = String(event.input.text);
    const refusals = activeCommitmentsByType(view.mind, 'refusal');
    for (const r of refusals) {
      const trigger = r.trigger_pattern;
      if (!trigger) continue;
      try {
        if (new RegExp(trigger, 'i').test(text)) {
          return {
            kind: 'respond_directly',
            text: r.refusal_text || 'I cannot do that here. ' + (r.statement || ''),
            reason: 'refusal_triggered',
            commitment_id: r.id
          };
        }
      } catch (_) { /* bad regex; skip */ }
    }
    return null;
  }
};

const ruleEchoForShortInput = {
  name: 'short_text_passthrough',
  match: (view, event) => {
    // Cheap deterministic shortcut: if input looks like a tiny ack, the
    // entity replies with its own canonical ack. Saves an LLM call for
    // 'ok', 'thanks', emoji-only inputs etc. Keeps loop responsive when
    // there is genuinely nothing to think about.
    if (!event || !event.input || typeof event.input.text !== 'string') return null;
    const text = event.input.text.trim();
    if (text.length === 0) return { kind: 'noop' };
    if (text.length > DEFAULT_TEXT_PASSTHROUGH_LIMIT) return null;
    if (/^(ok|okay|thanks|thank you|cheers|got it|sounds good|sgtm)\.?\!?$/i.test(text)) {
      return { kind: 'respond_directly', text: 'Acknowledged.', reason: 'ack_passthrough' };
    }
    return null;
  }
};

// memory dispatch. A memory-shaped question whose recall is
// CONFIDENT is answered by the substrate itself: the mind speaks, no
// language faculty summoned. The runtime attaches pre-fetched recall to
// the event (this engine stays pure — no I/O in a rule); confidence is
// structural, not numeric, because per-class recall scores share no
// calibrated scale: the top hit must DOMINATE its runner-up (≥1.5×) and
// be lexically GROUNDED in the question (≥1/2 of its content tokens
// present). Anything less falls through to the llm road, which mounts
// the same memories as context — the fallback loses nothing.
const ruleMemoryDispatch = {
  name: 'memory_dispatch',
  match: (view, event) => {
    if (!event || event.type === 'tool_result') return null;
    if (!event.input || typeof event.input.text !== 'string') return null;
    const hits = event.recall && Array.isArray(event.recall.hits) ? event.recall.hits : null;
    if (!hits || !hits.length) return null;
    let shaped;
    try { shaped = require('./memory-shaped.js'); } catch (_) { return null; }
    const text = event.input.text;
    if (!shaped.isMemoryShaped(text)) return null;
    const top = hits[0];
    if (!top || !top.statement) return null;
    const second = hits[1];
    if (second && second.score && !(top.score >= 1.5 * second.score)) return null;
    if (shaped.queryOverlap(text, top.statement) < 0.5) return null;
    return {
      kind: 'respond_directly',
      text: String(top.statement) + '\n— recalled from substrate (' + (top.class || 'memory') + ')',
      reason: 'memory_dispatch',
      recall_class: top.class || null,
      recall_source: top.source || null
    };
  }
};

// structural disagreement. When the user's text contradicts an
// active commitment, the substrate prepends a stance preface forcing
// the LLM into push-back-or-formally-revise mode rather than silent
// agreement. Placed BEFORE ruleNeedsLanguage so the augmented prompt
// wins; placed AFTER ruleHonorRefusal so hard policy still short-
// circuits to a deterministic refusal text without LLM involvement.
const ruleStructuralDisagreement = {
  name: 'structural_disagreement',
  match: (view, event) => {
    if (!event || event.type === 'tool_result') return null;
    if (!event.input || typeof event.input.text !== 'string') return null;
    const text = event.input.text;
    // Pull eligible commitments from the same projection surface that
    // ruleHonorRefusal uses — keeps the substrate's mind view as the
    // single source of truth.
    const commitments = [];
    for (const k of DISAGREEMENT_KINDS) {
      const list = activeCommitmentsByType(view.mind, k);
      for (const c of list) commitments.push(c);
    }
    if (!commitments.length) return null;
    const detection = disagreement.detect(text, commitments);
    if (!detection.contradicts) return null;
    const preface = disagreement.composeStancePreface(detection);
    return {
      kind: 'llm',
      prompt: preface + '\n\n' + composeLanguagePrompt(view, event),
      expected: 'response_text',
      options: { stream: true, max_fragments: 5 },
      reason: detection.proposes_revision ? 'disagreement_revision_proposed' : 'disagreement_pushback',
      disagreement: {
        proposes_revision: detection.proposes_revision,
        top_commitment_id: detection.hits[0] && detection.hits[0].commitment_id,
        hits: detection.hits.length
      }
    };
  }
};

const ruleNeedsLanguage = {
  name: 'route_to_language_faculty',
  match: (view, event) => {
    if (!event || event.type === 'tool_result') return null;
    if (!event.input || typeof event.input.text !== 'string') return null;
    // Propagate caller-supplied event.options through to the action so
    // downstream gates (auto_write, agentic, source, transport_hint…)
    // honor the submitter's intent. Without this, every user_input
    // collapsed to {stream:true, max_fragments:5} and any auto_write /
    // agentic flag set by the submitter was silently dropped — which
    // made operator-signed control:chat unable to actually execute
    // writes even though the chat handler set auto_write=true.
    const callerOpts = (event.options && typeof event.options === 'object') ? event.options : {};
    // Classify the raw user text (cheap synchronous heuristic) and attach it so
    // the dispatch surface can choose single-turn vs long-horizon goal-pursuit.
    // Metadata only — routing/kind is unchanged; consumers that don't read these
    // fields ignore them.
    let goalMeta = {};
    try {
      const c = require('./goal-class-classifier.js').classify(text);
      goalMeta = { goal_text: text, goal_class: c && c.class, goal_confidence: c && c.confidence };
    } catch (_) { /* classification best-effort; absence just keeps single-turn */ }
    return Object.assign({
      kind: 'llm',
      prompt: composeLanguagePrompt(view, event),
      expected: 'response_text',
      options: Object.assign({ stream: true, max_fragments: 5 }, callerOpts)
    }, goalMeta);
  }
};

const ruleDefault = {
  name: 'default_wait',
  match: () => ({ kind: 'wait' })
};

const DEFAULT_RULES = [
  ruleStateQuery,
  ruleGoalEvent,
  ruleHonorRefusal,
  ruleEchoForShortInput,
  ruleMemoryDispatch,
  ruleStructuralDisagreement,
  ruleNeedsLanguage,
  ruleDefault
];

// ── Engine factory ──────────────────────────────────────────────────────

function makeEngine(rules) {
  const ruleSet = Array.isArray(rules) && rules.length ? rules : DEFAULT_RULES;
  return function decide(view, event) {
    for (const rule of ruleSet) {
      const action = rule.match(view, event);
      if (action) {
        action._rule = rule.name;
        return action;
      }
    }
    return { kind: 'wait', _rule: 'fallback' };
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function activeCommitmentsByType(mind, type) {
  if (!mind || !Array.isArray(mind.active_projects)) return [];
  const out = [];
  for (const p of mind.active_projects) {
    if (!p) continue;
    const list = Array.isArray(p.constraints) ? p.constraints : [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (c.commitment_type === type) out.push(c);
    }
  }
  return out;
}

function composeLanguagePrompt(view, event) {
  // Compose the user turn. Identity + retrieved context already live in
  // the system prefix; here we just pass through the user's words.
  //
  // Earlier versions appended a trailing imperative — "Reply concisely.
  // Honor any active commitments surfaced by the substrate." — which
  // empirically backfired: Qwen3.6 read any prefix item as an active
  // commitment to address, pivoting away from the actual question
  // (Sharma et al. ICLR 2024: direct anti-sycophancy imperatives
  // backfire; Anthropic dropped ~70 percent of explicit guardrails in
  // Claude Code between March-April 2026 for the same reason — modern
  // models are not steered by negative-instruction stacking).
  //
  // Letting the user's turn stand on its own gives the model a clean
  // attention focus. Identity tone is carried by the system prefix.
  const userText = event.input && event.input.text || '';
  return String(userText);
}

module.exports = {
  makeEngine,
  DEFAULT_RULES,
  // Exported so callers can compose new rule sets that reuse pieces.
  rules: {
    stateQuery:               ruleStateQuery,
    honorRefusal:             ruleHonorRefusal,
    shortPassthrough:         ruleEchoForShortInput,
    memoryDispatch:           ruleMemoryDispatch,
    structuralDisagreement:   ruleStructuralDisagreement,
    routeToLanguage:          ruleNeedsLanguage,
    defaultWait:              ruleDefault
  }
};
