// SPDX-License-Identifier: AGPL-3.0-only
// Dispatch — L4 of Substrate-as-Entity. Picks WHICH language faculty
// handles a given llm action. Substrate may have several wired:
// `llamacpp` for decode-time-constrained local inference, `ollama` for
// large local models that don't expose decode hooks, `anthropic` for
// hard reasoning over BYOK, `router` for the existing troth provider
// fleet. Selection is per-call, substrate-driven, deterministic.
//
// This is the entity's "which brain region speaks" decision. Just as a
// biological mind doesn't route every utterance through the same
// circuit, the substrate-as-entity doesn't pin every call to one
// faculty. The decision engine emits an llm action; this module
// translates that into a concrete transport name based on (a) explicit
// hints in the action, (b) substrate state, (c) availability.
//
// Keep pure. No side effects. No transport calls. The entity binary
// invokes this and uses the returned name to pick from its already-
// constructed transport map.

const DEFAULT_PRIORITY = [
  'llamacpp',  // decode-time precision available — preferred when present
  'router',    // multi-provider fallback chain
  'ollama',    // local but no decode hooks
  'anthropic', // BYOK external
  'echo',      // smoke test only
  'noop'       // last resort, deterministic placeholder
];

function makeDispatcher(opts) {
  opts = opts || {};
  const available = new Set(Array.isArray(opts.available) ? opts.available : []);
  if (!available.size) {
    throw new Error('dispatch: opts.available must list at least one faculty name');
  }
  const priority = Array.isArray(opts.priority) ? opts.priority : DEFAULT_PRIORITY;
  const rules    = Array.isArray(opts.rules) ? opts.rules : DEFAULT_RULES;

  function pick(action, view) {
    const ctx = { action: action || {}, view: view || {}, available };
    // An explicit transport_hint that names an UNWIRED faculty must not vanish
    // silently — a pane pinned to "Local" was being served by claude_cli with
    // no trace of the override. The hint still
    // loses (we can't serve what isn't wired) but the drop is annotated so the
    // dispatch event carries it.
    const _hint = ctx.action.options && ctx.action.options.transport_hint;
    const _dropped = (typeof _hint === 'string' && _hint && !available.has(_hint)) ? _hint : undefined;
    const _r = (faculty, ruleLabel) => {
      const out = { faculty, _rule: ruleLabel };
      if (_dropped) out._hint_dropped = _dropped;
      return out;
    };
    for (const rule of rules) {
      let name = null;
      try { name = (typeof rule === 'function' ? rule(ctx) : rule.match(ctx)); }
      catch (_) { name = null; }
      if (typeof name === 'string' && available.has(name)) {
        const ruleLabel = (rule && typeof rule === 'object' && rule.name)
          ? rule.name
          : (rule && rule.name) || 'unnamed';
        return _r(name, ruleLabel);
      }
    }
    // Priority-based fallback among available transports.
    for (const name of priority) {
      if (available.has(name)) return _r(name, 'priority_default');
    }
    // Last-resort: pick whichever single faculty is available.
    return _r(Array.from(available)[0], 'first_available');
  }

  return { pick };
}

// ── Built-in rules ──────────────────────────────────────────────────────
// Each rule returns a faculty name (string) or null. First match wins.
// Rules are evaluated against the full context {action, view, available}.

const ruleExplicitHint = {
  name: 'explicit_transport_hint',
  match: (ctx) => {
    const hint = ctx.action.options && ctx.action.options.transport_hint;
    if (typeof hint === 'string' && ctx.available.has(hint)) return hint;
    return null;
  }
};

// If the action arrives with substrate decode constraints attached
// (logit_bias / grammar / json_schema), only a faculty that honors
// them is meaningful. Today that means llamacpp.
const ruleDecodeConstraintsRequireLocal = {
  name: 'decode_constraints_require_llamacpp',
  match: (ctx) => {
    const opts = ctx.action.options || {};
    const dc = opts.substrate_decode_constraints || ctx.action.decode_constraints;
    if (!dc) return null;
    const hasConstraint =
      (Array.isArray(dc.bias_strings) && dc.bias_strings.length) ||
      (typeof dc.grammar === 'string' && dc.grammar.length) ||
      (dc.json_schema && Object.keys(dc.json_schema).length);
    if (!hasConstraint) return null;
    if (ctx.available.has('llamacpp')) return 'llamacpp';
    return null;
  }
};

// Substrate-level signal: action.options.difficulty === 'hard' nudges
// toward hosted faculties whose strongest tier exceeds local model
// capability. Subscription faculties (claude_cli, codex_oauth) are
// preferred first (flat-rate, highest quality), then paid Anthropic BYOK,
// then the router provider chain.
const ruleHardReasoningPrefersHosted = {
  name: 'hard_reasoning_prefers_hosted',
  match: (ctx) => {
    const diff = ctx.action.options && ctx.action.options.difficulty;
    if (diff !== 'hard') return null;
    // Prefer a SUBSCRIPTION (flat-rate) for hard reasoning before paid BYOK:
    // Claude sub -> GPT sub -> Kimi Code membership -> paid Anthropic API ->
    // cheap router chain. Each guarded on availability, so this is a no-op
    // unless the operator wired the sub as a faculty (entity-only; the proxy
    // dispatcher never has these). kimi_sub is a linked flat-rate membership,
    // so it ranks with the other subs and ahead of the raw anthropic key lane.
    if (ctx.available.has('claude_cli'))  return 'claude_cli';
    if (ctx.available.has('codex_oauth')) return 'codex_oauth';
    if (ctx.available.has('kimi_sub'))    return 'kimi_sub';
    if (ctx.available.has('anthropic'))   return 'anthropic';
    if (ctx.available.has('router'))      return 'router';
    return null;
  }
};

// For creative / brainstorming, the substrate often does NOT want
// hard suppressions — it wants the model's full distribution.
// Ollama (which can't apply our decode constraints) is fine here.
const ruleCreativePrefersUnconstrained = {
  name: 'creative_prefers_unconstrained',
  match: (ctx) => {
    const tag = ctx.action.options && ctx.action.options.intent;
    if (tag !== 'creative' && tag !== 'brainstorm') return null;
    if (ctx.available.has('ollama')) return 'ollama';
    return null;
  }
};

// Substrate's active project may carry a `preferred_faculty` field
// set by past decisions or by the user. Honor it when set.
const ruleViewActiveProjectFaculty = {
  name: 'project_preferred_faculty',
  match: (ctx) => {
    const projects = ctx.view && ctx.view.mind && ctx.view.mind.active_projects;
    if (!Array.isArray(projects) || !projects.length) return null;
    const top = projects[0];
    const pref = top && top.preferred_faculty;
    if (typeof pref === 'string' && ctx.available.has(pref)) return pref;
    return null;
  }
};

const DEFAULT_RULES = [
  ruleExplicitHint,
  ruleDecodeConstraintsRequireLocal,
  ruleHardReasoningPrefersHosted,
  ruleCreativePrefersUnconstrained,
  ruleViewActiveProjectFaculty
];

module.exports = {
  makeDispatcher,
  DEFAULT_RULES,
  DEFAULT_PRIORITY,
  rules: {
    explicitHint:                ruleExplicitHint,
    decodeConstraintsRequireLocal: ruleDecodeConstraintsRequireLocal,
    hardReasoningPrefersHosted:  ruleHardReasoningPrefersHosted,
    creativePrefersUnconstrained: ruleCreativePrefersUnconstrained,
    viewActiveProjectFaculty:    ruleViewActiveProjectFaculty
  }
};
