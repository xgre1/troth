// SPDX-License-Identifier: AGPL-3.0-only
// state-machine.js — State-Transition-Validated Cognition (STVC) gate.
//
// design: every proposed substrate transition passes a validation
// gate before being applied. The gate evaluates substrate-stored invariants
// (state_invariants table, shipped in schema v2) against the proposed
// record + optional context. Built-in evaluators cover the three predicate
// kinds operators register most often; custom evaluators can be wired by
// adding to PREDICATE_KINDS.
//
// Why this is its own module, not inline in recordAction:
//   Validation is read-heavy (scan all invariants, possibly walk parent
//     chain, possibly check goal_class_stats). Inlining would bloat the
//     write path for every existing caller that doesn't need it yet.
//   Coordinator (main coordinator loop, M11+) needs to call this BEFORE deciding
//     whether to dispatch or ask. recordAction-internal validation would
//     fire too late — the call has already left.
//   Tests need a stable seam to inject synthetic invariants without
//     touching the live substrate.
//
// API:
//   registerInvariant({ id, predicate, scope, severity, description, created_by })
//   listInvariants({ scope? })
//   validateTransition({ proposed, context? }) →
//     { ok, violations: [{ invariant_id, severity, reason, description }] }
//   registerPredicateKind(kind, evaluator)   // for extension
//
// Predicate shapes (v1):
//   { kind: 'field_required', field: 'audience' }
//   { kind: 'field_value', field: 'memory_class', op: 'oneOf', values: ['episodic','semantic'] }
//   { kind: 'field_value', field: 'transition_kind', op: 'equals', value: 'applied' }
//   { kind: 'tool_class_disallowed', tool_class: 'irreversible_external' }
//
// Severity:
//   'error' — blocks the transition (validateTransition returns ok:false)
//   'warn'  — recorded but transition allowed (audit trail)
//   'info'  — observability only

const crypto = require('crypto');
const state  = require('./state.js');

// Built-in predicate evaluators. Each returns null on PASS or a reason
// string on FAIL. Kept pure — no substrate writes, no LLM calls.
const PREDICATE_KINDS = {

  // field_required: the named field on the proposed record must be set
  // (not null, not undefined, not empty string).
  field_required(predicate, ctx) {
    const f = predicate.field;
    if (!f) return 'malformed_predicate: field_required missing field';
    const v = ctx.proposed && ctx.proposed[f];
    if (v === null || v === undefined || v === '') {
      return 'required_field_missing: ' + f;
    }
    return null;
  },

  // field_value: the named field's value must satisfy op against value(s).
  //   op='equals' uses predicate.value
  //   op='not_equals' uses predicate.value
  //   op='oneOf' uses predicate.values[]
  //   op='not_in' uses predicate.values[]
  field_value(predicate, ctx) {
    const f = predicate.field;
    if (!f) return 'malformed_predicate: field_value missing field';
    const got = ctx.proposed && ctx.proposed[f];
    const op = predicate.op || 'equals';
    if (op === 'equals') {
      if (got === predicate.value) return null;
      return 'field_value_mismatch: ' + f + '=' + JSON.stringify(got) + ' expected ' + JSON.stringify(predicate.value);
    }
    if (op === 'not_equals') {
      if (got !== predicate.value) return null;
      return 'field_value_forbidden: ' + f + '=' + JSON.stringify(got);
    }
    if (op === 'oneOf') {
      const arr = Array.isArray(predicate.values) ? predicate.values : [];
      if (arr.indexOf(got) >= 0) return null;
      return 'field_value_not_in_set: ' + f + '=' + JSON.stringify(got) + ' allowed ' + JSON.stringify(arr);
    }
    if (op === 'not_in') {
      const arr = Array.isArray(predicate.values) ? predicate.values : [];
      if (arr.indexOf(got) < 0) return null;
      return 'field_value_in_forbidden_set: ' + f + '=' + JSON.stringify(got);
    }
    return 'malformed_predicate: field_value unknown op=' + op;
  },

  // tool_class_disallowed: if the proposed record is a tool_call, check
  // its declared tool_class against the forbidden value. Skips silently
  // for non-tool_call records (other invariants handle non-tool checks).
  tool_class_disallowed(predicate, ctx) {
    const r = ctx.proposed || {};
    if (r.type !== 'tool_call') return null;
    const declared = (r.input && r.input.tool_class) || (r.tool_class || null);
    if (declared === predicate.tool_class) {
      return 'tool_class_forbidden: ' + predicate.tool_class;
    }
    return null;
  },

  // tool_args_substring: if the proposed record is a tool_call AND any
  // substring in predicate.phrases appears in the stringified args, fire.
  // Used by the /refuse slash command — operator says "/refuse drop table"
  // and we register a predicate with phrases=['drop table'] so any
  // future tool_call whose args mention that phrase is rejected pre-LLM.
  // Case-insensitive match; predicate.phrases may be a string or array.
  tool_args_substring(predicate, ctx) {
    const r = ctx.proposed || {};
    if (r.type !== 'tool_call') return null;
    const phrases = Array.isArray(predicate.phrases)
      ? predicate.phrases
      : (predicate.phrases ? [predicate.phrases] : []);
    if (!phrases.length) return 'malformed_predicate: tool_args_substring needs phrases';
    let argsBlob = '';
    try {
      const inJson = (r.input && r.input.args) || r.input || {};
      argsBlob = JSON.stringify(inJson).toLowerCase();
    } catch (_) { return null; }
    for (const p of phrases) {
      const lc = String(p).toLowerCase();
      if (argsBlob.indexOf(lc) >= 0) {
        return 'tool_args_contains_refused_phrase: "' + p + '"';
      }
    }
    return null;
  },

  // tool_args_regex: regex match against stringified tool_call args.
  // Used by the seed secret-leak invariant — operator can't reasonably
  // enumerate every credential string they might paste, but regex catches
  // the canonical shapes (API keys, AWS tokens, GitHub PATs,.env-style
  // assignments). predicate.patterns is an array of {pattern, flags?, name?}
  // entries so a single invariant can guard against multiple shapes.
  // Regex compile failures degrade to "skip this pattern" rather than
  // blocking the pipeline.
  tool_args_regex(predicate, ctx) {
    const r = ctx.proposed || {};
    if (r.type !== 'tool_call') return null;
    const patterns = Array.isArray(predicate.patterns)
      ? predicate.patterns
      : (predicate.pattern ? [{ pattern: predicate.pattern, flags: predicate.flags, name: predicate.name }] : []);
    if (!patterns.length) return 'malformed_predicate: tool_args_regex needs patterns';
    let argsBlob = '';
    try {
      const inJson = (r.input && r.input.args) || r.input || {};
      argsBlob = JSON.stringify(inJson);
    } catch (_) { return null; }
    for (const p of patterns) {
      if (!p || !p.pattern) continue;
      let re;
      try { re = new RegExp(p.pattern, p.flags || ''); }
      catch (_) { continue; /* malformed regex → silent skip */ }
      if (re.test(argsBlob)) {
        return 'tool_args_matched_regex: ' + (p.name || p.pattern);
      }
    }
    return null;
  },

  // thesis-anchored anti-drift check.
  // Predicate body: {
  //   kind: 'thesis_anchored_check',
  //   project_id: 'troth',
  //   forbidden_patterns: ['envelope', 'PROPOSE_*', 'operations-dispatcher'],
  //   forbidden_in_fields: ['statement','input.args','output.name'] (default
  //     ['statement', 'input.args.statement'])
  // }
  //
  // Scans the proposed record's statement + tool args for any forbidden
  // pattern. Default severity should be 'warn' (operator promotes to
  // 'error' per pattern when the false-positive rate is acceptable) —
  // this lets the substrate surface drift attempts without hard-blocking
  // legitimate code that happens to contain a flagged word.
  //
  // Designed for project_thesis discipline: when operator declares
  // 'we do NOT ship operations-dispatcher.js because it's agent-framework
  // copy', this predicate catches future writes mentioning that module
  // before they land. Substrate-native gate; no LLM judge in the loop.
  // autonomous step — signature_verifies.
  //
  // Cryptographic operator-write binding (integration point fix), exposed as an
  // STVC predicate so callers that gate via validateTransition (slash
  // commands, dispatcher dispatch-time re-validation, external auditors)
  // get the same wall as engram.js's inline check.
  //
  // The load-bearing fail-closed enforcement is INLINE in engram.js
  // (matches integration point pattern). This predicate is the explicit
  // STVC seam — registered via /invariants or operator-confirmed
  // invariant config to assert the same property at validateTransition
  // boundaries.
  //
  // Predicate body: { kind: 'signature_verifies' }  (no params needed)
  //
  // Semantics:
  //   source_authority != 'operator_confirmed'      → PASS (silent)
  //   operator_confirmed without signature          → FAIL
  //   operator_confirmed with bad signature         → FAIL
  //   operator_confirmed with verified signature    → PASS
  //   no operator key resolvable (pre-bootstrap)    → FAIL
  //
  // Accepts the engram record shape used by engram.recordEngram
  // (proposed.output.source_authority / proposed.output.statement /
  // proposed.output.scope / proposed.output.signature) AND the flatter
  // shape (proposed.source_authority / proposed.statement / etc.) used
  // by other validators in this file.
  signature_verifies(predicate, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const src = (out && out.source_authority) || r.source_authority || null;
    if (src !== 'operator_confirmed') return null; // not subject to this rule

    const sig = (out && out.signature) || r.signature || null;
    if (!sig) return 'signature_required_for_operator_confirmed';

    const statement = (out && out.statement) || r.statement || null;
    const scope     = (out && out.scope)     || r.scope     || null;
    // extra_output isn't a stable field on the proposed shape — strip
    // signature/signed_at from output to reconstruct the signed body.
    const xo = {};
    if (out) {
      for (const k of Object.keys(out)) {
        if (k === 'signature' || k === 'signed_at' ||
            k === 'statement' || k === 'scope' || k === 'source_authority') continue;
        xo[k] = out[k];
      }
    }

    // Resolve operator public key candidates. Same multi-pubkey chain as the
    // engram.js inline check: substrate-active primary + recovery_directive
    // successor + filesystem fallback. Lazy require both modules to avoid circular
    // load at module init.
    const opKeyMod = require('./operator-key.js');
    const pubCandidates = [];
    let eng = null;
    try { eng = require('./engram.js'); } catch (_) {}
    if (eng && eng.listEngrams) {
      try {
        const rows = eng.listEngrams({
          principal: null, audience: 'all', scope: 'operator_key:active', limit: 1
        }) || [];
        const r0 = rows[0];
        if (r0) {
          const p = (r0.public_key_pem) ||
                    (r0.output && r0.output.public_key_pem) || null;
          if (p) pubCandidates.push(p);
        }
      } catch (_) {}
      try {
        const recRows = eng.listEngrams({
          principal: null, audience: 'all', scope: 'recovery_directive', limit: 1
        }) || [];
        const r0 = recRows[0];
        if (r0) {
          const p = (r0.recovery_public_key_pem) ||
                    (r0.output && r0.output.recovery_public_key_pem) || null;
          if (p) pubCandidates.push(p);
        }
      } catch (_) {}
      // design: inheritance_directive pubkey accepted here too.
      try {
        const inhRows = eng.listEngrams({
          principal: null, audience: 'all', scope: 'inheritance_directive', limit: 1
        }) || [];
        const i0 = inhRows[0];
        if (i0) {
          const p = (i0.inheritance_public_key_pem) ||
                    (i0.output && i0.output.inheritance_public_key_pem) || null;
          if (p) pubCandidates.push(p);
        }
      } catch (_) {}
    }
    if (!pubCandidates.length) {
      try {
        const fsKey = opKeyMod.getActivePublicKey();
        if (fsKey) pubCandidates.push(fsKey.public_key_pem);
      } catch (_) {}
    }
    if (!pubCandidates.length) return 'signature_required_for_operator_confirmed: no_active_pubkey';

    const canonicalBody = opKeyMod.canonicalEngramBody({
      statement, scope, source_authority: 'operator_confirmed', extra_output: xo
    });
    let verified = false;
    for (const pem of pubCandidates) {
      if (opKeyMod.verify(pem, canonicalBody, sig)) { verified = true; break; }
    }
    if (!verified) return 'signature_required_for_operator_confirmed: signature_invalid';
    return null;
  },

  // autonomous step — grounded_in_sealed.
  //
  // Anti-drift wall. Every intent must reference at least one engram
  // in operator_confirmed or plr_evolved tier in its `grounded_in`
  // array. This forces the LLM-faculty to articulate the WHY of an
  // action against a real sealed authority — the structural answer to
  // "force other LLM operators to not be lazy about grounding before
  // generating" from the design session.
  //
  // Predicate body: { kind: 'grounded_in_sealed' }
  // Fires only on engrams whose scope starts with 'intent:' — silent
  // pass for non-intent transitions.
  grounded_in_sealed(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    const grounded = (out && out.grounded_in) || r.grounded_in || [];
    if (!Array.isArray(grounded) || !grounded.length) {
      return 'intent_must_be_grounded: empty grounded_in';
    }
    // Walk the references and check at least one is sealed-tier.
    let eng;
    try { eng = require('./engram.js'); }
    catch (_) { return 'grounded_in_sealed: engram_module_unavailable'; }
    const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
    const byId = new Map(pool.map(e => [e.id, e]));
    for (const ref of grounded) {
      const e2 = byId.get(ref);
      if (!e2) continue;
      const auth = e2.source_authority || 'regex_extracted';
      if (auth === 'operator_confirmed' || auth === 'plr_evolved') return null;
    }
    return 'intent_must_be_grounded: no grounded_in ref at operator_confirmed|plr_evolved tier';
  },

  // autonomous step — capability_covers_intent.
  //
  // Refuses intents that lack an active, non-revoked, non-expired
  // capability covering their scope + irreversibility class. The
  // capability is the partner's authorization; without one the intent
  // is unscoped action and dispatch must refuse.
  //
  // Predicate body: { kind: 'capability_covers_intent' }
  // Silent pass for non-intent transitions.
  capability_covers_intent(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    const capRef = (out && out.capability_ref) || r.capability_ref || null;
    if (!capRef) return 'intent_capability_missing: no capability_ref';
    let intentMod;
    try { intentMod = require('./intent.js'); }
    catch (_) { return 'capability_covers_intent: intent_module_unavailable'; }
    let eng;
    try { eng = require('./engram.js'); }
    catch (_) { return 'capability_covers_intent: engram_module_unavailable'; }
    const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
    const cap = pool.find(e => e.id === capRef);
    if (!cap) return 'intent_capability_missing: ref not found';
    if (typeof cap.scope !== 'string' || cap.scope.indexOf('capability:') !== 0) {
      return 'intent_capability_missing: ref is not a capability engram';
    }
    if (cap.revoked) return 'intent_capability_revoked';
    if (typeof cap.expiry === 'number' && cap.expiry > 0 && cap.expiry < Date.now()) {
      return 'intent_capability_expired';
    }
    // Scope coverage. Capability's scope MUST be the intent's
    // 'capability:<rest>' analogue of 'intent:<rest>' OR a trailing-
    // wildcard prefix.
    const intentTail = scope.slice('intent:'.length);
    const capTail    = cap.scope.slice('capability:'.length);
    let scopeMatch = false;
    if (capTail === intentTail) scopeMatch = true;
    else if (capTail.endsWith('*') && intentTail.indexOf(capTail.slice(0, -1)) === 0) scopeMatch = true;
    // MCP hands family mapping: 'capability:mcp:<server>'
    // authorizes 'intent:mcp:call:<server>' even though the generic tail
    // compare above doesn't bridge the ':call:' verb segment. Scoped strictly
    // to intent:mcp:call:* by mcpCapabilityCoversIntent - no other family is
    // affected. Kept as an ADD-ON branch so the generic path is unchanged.
    else if (intentMod.mcpCapabilityCoversIntent &&
             intentMod.mcpCapabilityCoversIntent(cap.scope, scope)) scopeMatch = true;
    if (!scopeMatch) return 'intent_capability_scope_mismatch: cap=' + cap.scope + ' intent=' + scope;
    // Irreversibility class check.
    const ranks = intentMod.IRREVERSIBILITY_RANK;
    const intentCls = (out && out.irreversibility_class) || r.irreversibility_class || 'low';
    const capMax    = cap.max_irreversibility || 'low';
    if ((ranks[intentCls] || 99) > (ranks[capMax] || 0)) {
      return 'intent_capability_irreversibility_exceeded: intent=' + intentCls + ' cap_max=' + capMax;
    }
    return null;
  },

  // autonomous step — irreversibility_sealed. High-stakes intents (class >=
  // high) MUST carry at least one valid operator-signed seal engram referencing
  // this intent. Without this, partner could dispatch destructive actions
  // without operator review. This predicate establishes the wall; the seal flow
  // lives beside it. Predicate body: { kind: 'irreversibility_sealed' } Silent
  // pass for non-intent + low/medium classes.
  irreversibility_sealed(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    const cls = (out && out.irreversibility_class) || r.irreversibility_class || 'low';
    if (cls !== 'high' && cls !== 'sealed_only') return null;
    const seals = (out && out.seals) || r.seals || [];
    if (!Array.isArray(seals) || !seals.length) {
      return 'irreversibility_sealed: no seals on ' + cls + ' intent';
    }
    let eng;
    try { eng = require('./engram.js'); }
    catch (_) { return 'irreversibility_sealed: engram_module_unavailable'; }
    const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
    const intentId  = r.id || (out && out.id) || null;
    const intentKey = (out && out.idempotency_key) || r.idempotency_key || null;
    // design tightening: each seal candidate must bind to THIS
    // intent's idempotency_key OR id. Prevents seal reuse against a
    // different payload. Falls back to state.getAction for raw output
    // since the projection doesn't surface seal binding fields.
    let state = null;
    try { state = require('./state.js'); } catch (_) {}
    for (const sealRef of seals) {
      const sealEng = pool.find(e => e.id === sealRef);
      if (!sealEng) continue;
      if (sealEng.source_authority !== 'operator_confirmed') continue;
      if (typeof sealEng.scope === 'string' && sealEng.scope !== 'seal') continue;
      let boundKey = null;
      let boundId  = null;
      try {
        if (state && state.getAction) {
          const raw = state.getAction(sealEng.id);
          if (raw) {
            const sout = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
            if (sout) {
              boundKey = sout.sealed_intent_idempotency_key || null;
              boundId  = sout.sealed_intent_id || null;
            }
          }
        }
      } catch (_) {}
      // Accept if the seal binds via idempotency_key OR id. If neither
      // binding is present, refuse — old seals without bindings are
      // pre-2.3 fixtures and don't match the production contract.
      if (intentKey && boundKey === intentKey) return null;
      if (intentId  && boundId  === intentId)  return null;
    }
    return 'irreversibility_sealed: no seal binds to this intent payload';
  },

  // autonomous step — no_duplicate_pending_intent.
  //
  // Race-condition wall. Refuses an intent whose idempotency_key matches
  // another intent written in the last 60 seconds. Without this, two
  // fast LLM ticks emitting the same intent (e.g., "send confirmation
  // email") would both dispatch — duplicate side effect.
  //
  // Predicate body: { kind: 'no_duplicate_pending_intent', window_ms?: number }
  // Silent pass for non-intent transitions.
  no_duplicate_pending_intent(predicate, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    const idempotency_key = (out && out.idempotency_key) || r.idempotency_key || null;
    if (!idempotency_key) return 'no_duplicate_pending_intent: idempotency_key required';
    const windowMs = (predicate && typeof predicate.window_ms === 'number')
      ? predicate.window_ms
      : 60 * 1000;
    let eng;
    try { eng = require('./engram.js'); }
    catch (_) { return 'no_duplicate_pending_intent: engram_module_unavailable'; }
    const since = Date.now() - windowMs;
    const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];
    const proposedId = r.id || (out && out.id) || null;
    for (const e2 of pool) {
      if (!e2 || e2.id === proposedId) continue;
      if (typeof e2.scope !== 'string' || e2.scope.indexOf('intent:') !== 0) continue;
      if (e2.idempotency_key !== idempotency_key) continue;
      if (typeof e2.ts === 'number' && e2.ts < since) continue;
      return 'no_duplicate_pending_intent: idempotency_key collision within ' + windowMs + 'ms';
    }
    return null;
  },

  // autonomous step — budget_remaining_in_scope.
  //
  // Refuses intents whose capability_ref's scope is over budget within
  // the capability's budget_window_ms. Computes spend by summing
  // observation engrams' reported cost_usd in the same scope/window.
  //
  // Predicate body: { kind: 'budget_remaining_in_scope' }
  // Silent pass for non-intent scopes OR capabilities without budgets.
  budget_remaining_in_scope(_pred, ctx) {
    try {
      const ap = require('./active-project.js');
      return ap.predicate(_pred, ctx);
    } catch (e) {
      return 'budget_remaining_in_scope: module_unavailable';
    }
  },

  // autonomous step (S4) — external_suspicious_not_grounded.
  //
  // The prompt-injection wall. The perception observer flags hidden/injected
  // page content at sanitization time by writing an engram with
  // scope='browser:external_suspicious' (perception/engram-schemas.js:124-138).
  // That tag was COSMETIC until now an internal audit: nothing stopped an intent
  // from GROUNDING in such an engram, so injected page text could justify an
  // action. This predicate makes the wall real: refuse any intent whose
  // grounded_in references an external_suspicious engram. Pre-LLM, structural,
  // unforgeable (S4).
  //
  // NOTE: the audience field is
  // NOT persisted for an unrecognized value like 'external_suspicious' — it
  // reads back undefined. The durable signal is SCOPE ('browser:external_
  // suspicious'), so the wall keys on scope (with audience/memory_class checked
  // too for forward-compat). Mirrors grounded_in_sealed's ref-walk structure.
  // Fires only on intent: scopes; silent pass otherwise.
  //
  // Predicate body: { kind: 'external_suspicious_not_grounded' }
  external_suspicious_not_grounded(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    const grounded = (out && out.grounded_in) || r.grounded_in || [];
    if (!Array.isArray(grounded) || !grounded.length) return null; // emptiness is grounded_in_sealed's job
    let eng;
    try { eng = require('./engram.js'); }
    catch (_) { return 'external_suspicious_not_grounded: engram_module_unavailable'; }
    const pool = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
    const byId = new Map(pool.map(e => [e.id, e]));
    for (const ref of grounded) {
      const e2 = byId.get(ref);
      if (!e2) continue;
      const suspicious =
        (typeof e2.scope === 'string' && e2.scope.indexOf('external_suspicious') >= 0) ||
        e2.audience === 'external_suspicious' ||
        e2.memory_class === 'external_suspicious';
      if (suspicious) {
        return 'external_suspicious_not_grounded: intent grounds in flagged-injection engram ' + ref;
      }
    }
    return null;
  },

  // autonomous step — does_not_contradict_active_lessons.
  //
  // Refuses intents that repeat known failure patterns. Reads
  // lesson:dont:* engrams compiled by lesson-compiler from failed
  // causal chains. Structural anti-loop wall — partner stops
  // repeating mistakes by ARCHITECTURE, not by remembering.
  //
  // Predicate body: { kind: 'does_not_contradict_active_lessons' }
  // Silent pass for non-intent scopes.
  does_not_contradict_active_lessons(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    const payload = (out && out.payload) || r.payload || {};
    const payloadKeys = Object.keys(payload);
    try {
      const lessons = require('./lesson-compiler.js').findLessonsMatchingIntent(scope, payloadKeys);
      if (!lessons.length) return null;
      // Lessons are llm_inferred by default. Operator-promoted (operator_
      // confirmed) lessons should BLOCK. llm_inferred-only lessons WARN
      // the partner is allowed to retry but should reason about why
      // it might be different now. For v1, both block; operator can
      // explicitly revoke a lesson by superseding it.
      return 'lesson_violation: ' + lessons[0].scope +
             ' (' + lessons[0].statement.slice(0, 100) + ')';
    } catch (_) { return null; }
  },

  // autonomous step — surface_urgency_within_capability.
  //
  // Gates which operator_surface urgency tier the partner can emit.
  // Default cap is 'notify'; interrupt + wake require explicit
  // operator_confirmed capability engrams (capability:operator_surface:
  // interrupt /:wake) so the partner can't escalate at 3am for
  // non-urgent things.
  //
  // Predicate body: { kind: 'surface_urgency_within_capability' }
  // Silent pass for non-operator_surface scopes.
  surface_urgency_within_capability(_pred, ctx) {
    try {
      const os = require('./operator-surface.js');
      return os.predicate(_pred, ctx);
    } catch (e) {
      return 'surface_urgency_within_capability: module_unavailable';
    }
  },

  // autonomous step — inbound_content_quoted_not_consumed.
  //
  // Refuses any engram whose scope starts with 'inbound_event:' but
  // whose body is NOT wrapped in the structural inbound_observation
  // tag (produced by inbound.recordInboundEvent / inbound.renderTagged).
  // Blocks bypass-by-direct-recordEngram of the inbound write surface.
  //
  // Without this, an attacker controlling any in-process caller could
  // write inbound_event engrams with raw consumed content — bypassing
  // integration-point-style structural tagging and turning recall into a prompt-
  // injection vector for senses that ship in implementation step.
  //
  // Predicate body: { kind: 'inbound_content_quoted_not_consumed' }
  // Silent pass for non-inbound scopes.
  inbound_content_quoted_not_consumed(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('inbound_event') !== 0) return null;
    try {
      const inbound = require('./inbound.js');
      if (inbound.bodyIsStructurallyTagged(r)) return null;
      return 'inbound_event_body_not_structurally_tagged';
    } catch (_) {
      return 'inbound_content_quoted_not_consumed: inbound_module_unavailable';
    }
  },

  // autonomous step — substrate_not_dormant.
  //
  // End-of-life dead-man-switch. When inheritance_directive is set
  // AND presence_proof is older than dormancy_threshold_ms, refuse
  // ALL novel intents (intent:*). Successor MUST run troth
  // inheritance claim to re-anchor the substrate before partner can
  // act again. Substrate dies with operator unless inheritance flow
  // executes.
  //
  // CAREFUL: this predicate refuses ONLY scope='intent:*' so the
  // successor's claim flow (which writes a new operator_key:active
  // engram — scope is operator_key:active, NOT intent:*) can still
  // succeed. Same exemption applies to seal/pause/resume writes which
  // are operator-tier engrams at non-intent scopes.
  //
  // Predicate body: { kind: 'substrate_not_dormant' }
  substrate_not_dormant(_pred, ctx) {
    const r = ctx.proposed || {};
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    const scope = (out && out.scope) || r.scope || null;
    if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
    try {
      const boot = require('./bootstrap.js');
      const directive = boot.getActiveInheritanceDirective && boot.getActiveInheritanceDirective();
      if (!directive) return null;   // no inheritance set up → no dormancy mechanism
      const presence = require('./presence.js').presenceFreshness(directive.dormancy_threshold_ms);
      if (presence.fresh) return null;
      return 'substrate_dormant: operator presence stale > ' +
             Math.round(directive.dormancy_threshold_ms / (24 * 60 * 60 * 1000)) +
             'd; successor must run `troth inheritance claim` to re-anchor';
    } catch (_) { return null; }
  },

  // autonomous step — operator_presence_fresh.
  //
  // Refuses transitions when no presence_proof engram exists newer
  // than max_age_ms. "Operator is principal" is meaningless without
  // proof the operator was bodily present recently — otherwise
  // anyone with keyboard access IS the principal.
  //
  // Predicate body: { kind: 'operator_presence_fresh', max_age_ms?: number }
  //   default max_age_ms: 8 hours (workday-shaped window)
  //
  // Lazy require to avoid circular load.
  operator_presence_fresh(predicate, _ctx) {
    try {
      const presence = require('./presence.js');
      const maxAge = (predicate && typeof predicate.max_age_ms === 'number')
        ? predicate.max_age_ms : undefined;
      const out = presence.presenceFreshness(maxAge);
      if (out.fresh) return null;
      return 'operator_presence_required: ' + (out.reason || 'unknown');
    } catch (_) {
      // Fail closed when the presence module is unavailable.
      return 'operator_presence_required: module_unavailable';
    }
  },

  // autonomous step — not_globally_paused.
  //
  // Operator-signed kill-switch wall. Refuses transitions when an
  // active global_pause engram exists (and no newer global_resume
  // supersedes it). Lazy require to avoid circular load with engram.js.
  //
  // Predicate body: { kind: 'not_globally_paused' }  (no params needed)
  //
  // Fails CLOSED if the kill-switch module is unavailable — safer to
  // refuse than to allow dispatch when the infrastructure is broken.
  not_globally_paused(pred, ctx) {
    try {
      const gp = require('./global-pause.js');
      return gp.predicate(pred, ctx);
    } catch (e) {
      return 'not_globally_paused: kill_switch_module_unavailable';
    }
  },

  // (milestone) — sub_partner_within_budget. Closes the "theater" at
  // the closed spawn path where TTL/intent caps were written into the
  // birth engram but never enforced. Refuses an intent emitted under a
  // sub-partner principal whose TTL has elapsed or whose intent budget is
  // exhausted. No-op when proposed.output.partner_id is the main partner
  // ('partner' or absent). Fails CLOSED if the module load throws — safer
  // to refuse than to let an unbudgeted sub-partner keep dispatching.
  //
  // Predicate body: { kind: 'sub_partner_within_budget' }  (no params)
  sub_partner_within_budget(_pred, ctx) {
    const partner_id = ctx && ctx.proposed && ctx.proposed.output && ctx.proposed.output.partner_id;
    try {
      const spb = require('./sub-partner-budget.js');
      return spb.evaluate(partner_id);
    } catch (e) {
      return 'sub_partner_within_budget: budget_module_unavailable';
    }
  },

  thesis_anchored_check(predicate, ctx) {
    const r = ctx.proposed || {};
    const forbidden = Array.isArray(predicate.forbidden_patterns)
      ? predicate.forbidden_patterns
      : [];
    if (!forbidden.length) return 'malformed_predicate: thesis_anchored_check needs forbidden_patterns';
    // Build the haystack from common content-bearing fields.
    const parts = [];
    if (r.output && typeof r.output === 'object') {
      if (r.output.statement) parts.push(String(r.output.statement));
      if (r.output.text)      parts.push(String(r.output.text));
      if (r.output.name)      parts.push(String(r.output.name));
    }
    if (r.input && typeof r.input === 'object') {
      try { parts.push(JSON.stringify(r.input.args || r.input)); } catch (_) {}
    }
    if (!parts.length) return null;
    const haystack = parts.join(' ').toLowerCase();
    for (const pat of forbidden) {
      const p = String(pat).toLowerCase();
      // Support glob-ish: '*' means "any chars". Convert to regex.
      if (p.indexOf('*') >= 0) {
        const re = new RegExp(p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
        if (re.test(haystack)) return 'thesis_drift: matched forbidden pattern "' + pat + '"';
      } else if (haystack.indexOf(p) >= 0) {
        return 'thesis_drift: contains forbidden phrase "' + pat + '"';
      }
    }
    return null;
  }
};

// S5 (PAC-bound) — the predicate set is fixed once the mind starts thinking.
// Boot-time code may register new predicate KINDS via registerPredicateKind;
// after sealPredicateKinds() runs (called at substrate boot, before the
// cognitive loop), the set is frozen and no in-loop self/faculty write can
// add, replace, or mutate a safety predicate. This is the structural answer
// to the statistically-unrecoverable self-modification trap
// (the design work).
let _predicatesSealed = false;

function registerPredicateKind(kind, evaluator) {
  if (_predicatesSealed) {
    throw new Error('state-machine.registerPredicateKind: predicate set is SEALED (S5 PAC-bound) — kinds may only be registered at boot, before sealPredicateKinds()');
  }
  if (typeof evaluator !== 'function') {
    throw new Error('state-machine.registerPredicateKind: evaluator must be a function');
  }
  PREDICATE_KINDS[kind] = evaluator;
}

// Freeze the predicate registry. Idempotent. Call once at substrate boot after
// all boot-time predicate registration is done. Returns true when sealed.
function sealPredicateKinds() {
  _predicatesSealed = true;
  Object.freeze(PREDICATE_KINDS);
  return true;
}

// Insert an invariant into state_invariants. Idempotent on id collision —
// callers who want to update an existing invariant should delete-then-add.
function registerInvariant(opts) {
  opts = opts || {};
  const id = opts.id || ('inv-' + crypto.randomBytes(8).toString('hex'));
  const predicate = opts.predicate;
  if (!predicate || typeof predicate !== 'object' || !predicate.kind) {
    throw new Error('state-machine.registerInvariant: predicate.kind required');
  }
  if (!PREDICATE_KINDS[predicate.kind]) {
    throw new Error('state-machine.registerInvariant: unknown predicate kind=' + predicate.kind);
  }
  const severity = opts.severity || 'error';
  if (['error', 'warn', 'info'].indexOf(severity) < 0) {
    throw new Error('state-machine.registerInvariant: severity must be error|warn|info');
  }
  try {
    state.db && state.db(); // ensure DB initialized (state exports db lazily inside)
  } catch (_) { /* fall through to prepared statement below */ }
  // Use raw better-sqlite3 via state's internals would be cleaner but state
  // does not export the connection. Fall back to opening directly with the
  // same path resolver state uses (env > default). Cheap — better-sqlite3
  // dedups connections at the C layer.
  const sqliteWrite = () => {
    const Database = require('better-sqlite3');
    const path = require('path');
    const os = require('os');
    const DB_PATH = process.env.STATE_DB_PATH ||
      path.join((process.env.HOME || os.homedir()), '.troth', 'state.db');
    const db = new Database(DB_PATH);
    // This connection is ours, and it may be pointing at a database state.js
    // has never opened: state.js resolves its path once at module load, and
    // STATE_DB_PATH can change afterwards (switching tenant does exactly
    // that). Bring it up to the same schema rather than assuming a table.
    // migrate() is CREATE TABLE IF NOT EXISTS throughout, so this is a no-op
    // on a database that is already current.
    try { if (typeof state.migrate === 'function') state.migrate(db); } catch (_) {}
    try {
      db.prepare(`
        INSERT OR IGNORE INTO state_invariants
        (id, predicate, scope, severity, description, created_ts, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        JSON.stringify(predicate),
        opts.scope || null,
        severity,
        opts.description || null,
        Date.now(),
        opts.created_by || null
      );
    } finally { db.close(); }
  };
  sqliteWrite();
  return { id, severity, scope: opts.scope || null };
}

// Read invariants from substrate. scope filter is optional; when set,
// returns both global (scope IS NULL) and scope-matching rows so a
// transition under a specific goal_class still gets the global checks.
function listInvariants(opts) {
  opts = opts || {};
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const os = require('os');
    const DB_PATH = process.env.STATE_DB_PATH ||
      path.join((process.env.HOME || os.homedir()), '.troth', 'state.db');
    // No substrate file yet means a first run with genuinely no invariants,
    // which is different from a substrate we cannot read. readonly:true turns
    // the first into an "unable to open" error indistinguishable from the
    // second, so it is settled here instead of in the catch.
    if (!require('fs').existsSync(DB_PATH)) return [];
    const db = new Database(DB_PATH, { readonly: true });
    let rows;
    if (opts.scope !== undefined && opts.scope !== null) {
      rows = db.prepare(`
        SELECT id, predicate, scope, severity, description, created_ts, created_by
        FROM state_invariants
        WHERE scope IS NULL OR scope = ?
      `).all(opts.scope);
    } else {
      rows = db.prepare(`
        SELECT id, predicate, scope, severity, description, created_ts, created_by
        FROM state_invariants
      `).all();
    }
    db.close();
    return rows.map(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.predicate); } catch (_) {}
      return Object.assign({}, r, { predicate: parsed });
    });
  } catch (e) {
    // A pre-migrate substrate genuinely has no invariants table, and no
    // invariants genuinely means nothing to violate. Any OTHER failure means
    // we could not read rules that may well exist, which is not the same as
    // there being none: validateTransition would approve with zero
    // violations either way, so an unreadable database silently disabled the
    // wall it is supposed to enforce.
    if (/no such table/i.test(String(e && e.message || e))) return [];
    const err = new Error('invariants_unreadable: ' + String(e && e.message || e));
    err.code = 'INVARIANTS_UNREADABLE';
    throw err;
  }
}

// Evaluate all applicable invariants against the proposed transition.
// Returns ok=true when no 'error'-severity violations fire. 'warn' and
// 'info' violations are reported but don't block.
function validateTransition(opts) {
  opts = opts || {};
  const proposed = opts.proposed || {};
  const context  = opts.context || {};
  const scope = opts.scope || context.scope || null;

  let invariants;
  try {
    invariants = listInvariants({ scope });
  } catch (e) {
    // Cannot read the rules, so cannot say the transition satisfies them.
    return {
      ok: false,
      violations: [{
        severity:    'error',
        reason:      'invariants_unreadable',
        description: String(e && e.message || e)
      }]
    };
  }
  const violations = [];

  for (const inv of invariants) {
    const pred = inv.predicate;
    if (!pred || !pred.kind) continue;
    const evaluator = PREDICATE_KINDS[pred.kind];
    if (!evaluator) {
      // Unknown predicate kind → treat as warning. A stale invariant
      // shouldn't break the live pipeline; surface it for cleanup.
      violations.push({
        invariant_id: inv.id,
        severity:     'warn',
        reason:       'unknown_predicate_kind: ' + pred.kind,
        description:  inv.description
      });
      continue;
    }
    // L1/L2 SECURITY HARDENING  — integration point fix.
    //
    // Per-evaluator try/catch. Unguarded, an exception from one evaluator
    // propagates to recordAction's outer catch (state.js:1367)
    // which swallowed it as fail-OPEN ("validator crash → fail open").
    // That was correct for telemetry predicates but disastrous for
    // refusal/safety predicates — a crafted input that crashed the
    // validator would bypass every STVC wall.
    //
    // New behavior: evaluator crash is treated as a VIOLATION whose
    // severity inherits from the invariant itself. severity='error'
    // invariants (the refusal/safety class) → crash counts as an error
    // violation → blocks the transition (fail-closed). severity='warn'
    // or 'info' invariants → crash becomes a warning/info entry
    // (fail-open is preserved for telemetry-grade checks).
    //
    // Outer state.js:1367 catch still exists for catastrophic module-
    // load failures (sm is null/undefined). Per-predicate failures are
    // now contained here and routed by invariant severity, not by
    // blanket fail-open.
    let reason;
    try {
      reason = evaluator(pred, { proposed, context });
    } catch (e) {
      reason = 'evaluator_threw: ' + (e && e.message || String(e)).slice(0, 200);
    }
    if (reason !== null && reason !== undefined) {
      violations.push({
        invariant_id: inv.id,
        severity:     inv.severity,
        reason,
        description:  inv.description
      });
    }
  }

  const ok = !violations.some(v => v.severity === 'error');
  return { ok, violations };
}

// Test/diagnostic helper: drop an invariant by id.
function deleteInvariant(id) {
  if (!id) return false;
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const os = require('os');
    const DB_PATH = process.env.STATE_DB_PATH ||
      path.join((process.env.HOME || os.homedir()), '.troth', 'state.db');
    const db = new Database(DB_PATH);
    const r = db.prepare('DELETE FROM state_invariants WHERE id = ?').run(id);
    db.close();
    return r.changes > 0;
  } catch (_) { return false; }
}

module.exports = {
  validateTransition,
  registerInvariant,
  listInvariants,
  deleteInvariant,
  registerPredicateKind,
  sealPredicateKinds,
  PREDICATE_KINDS
};
