// SPDX-License-Identifier: AGPL-3.0-only
// Skill execute — dispatcher half of the substrate-as-
// subject engine.
//
// Partner emits ONE intent: { scope: 'intent:skill:execute',
//                              payload: { skill_id, parameters: {...} } }.
// This runner:
//   1. Resolves skill engram by id (from skill-compiler emit)
//   2. Builds a concrete intent from skill.template_payload_baked
//      + parameters (filling in the parameter slots)
//   3. Validates the bound payload covers all skill.parameters
//   4. Dispatches the concrete intent through the normal dispatcher
//      path — STVC walls intact at every step
//   5. Returns the underlying observation
//
// This is what makes the partner more leveraged over time. Year 1:
// partner reasons each step. Year 2: skill exists, partner emits ONE
// intent and a 14-step chain compresses to one observation.
//
// V1 supports single-step skills (the skill template fires ONE underlying
// intent). Multi-step skill templates (compose 5 intents into one
// orchestrated run) ship in 2.10b when we wire causal chain capture
// for parent_skill_execution_id.

'use strict';

const ADAPTER_SCOPE = 'intent:skill:execute';

async function dispatch(intent, _capability, ctx) {
  ctx = ctx || {};
  const payload = (intent && intent.payload) || {};
  if (!payload.skill_id) return { ok: false, error: 'skill_id_required' };

  // Resolve the skill engram.
  const eng = require('../engram.js');
  const pool = eng.listEngrams({
    principal: null, audience: 'all', limit: 2000
  }) || [];
  const skillEng = pool.find(e => e.id === payload.skill_id);
  if (!skillEng) return { ok: false, error: 'skill_not_found: ' + payload.skill_id };
  if (typeof skillEng.scope !== 'string' || skillEng.scope.indexOf('skill:') !== 0) {
    return { ok: false, error: 'engram_is_not_a_skill' };
  }
  // Pull skill body from raw output (template fields not projected).
  let skillBody = null;
  try {
    const state = require('../state.js');
    if (state.getAction) {
      const raw = state.getAction(skillEng.id);
      if (raw) {
        const o = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
        if (o) skillBody = o;
      }
    }
  } catch (_) {}
  if (!skillBody || !skillBody.template_intent_scope) {
    return { ok: false, error: 'skill_body_missing_template' };
  }

  // Bind parameters.
  const bindings = payload.parameters || {};
  const requiredParams = Array.isArray(skillBody.parameters) ? skillBody.parameters : [];
  const missing = requiredParams.filter(p => bindings[p] === undefined);
  if (missing.length) {
    return { ok: false, error: 'missing_skill_parameters: ' + missing.join(',') };
  }
  // Concrete payload = baked constants ⊕ bindings.
  const concretePayload = Object.assign({}, skillBody.template_payload_baked || {}, bindings);
  const concreteScope = skillBody.template_intent_scope;

  // Find a capability that covers the concrete scope. We can't reuse
  // the skill-execute intent's capability_ref (which authorizes
  // skill:execute, not the underlying domain). The partner must have
  // pre-emitted (or pre-recalled) a matching capability. v1: scan
  // active capabilities for scope coverage. If none, refuse — operator
  // must mint coverage.
  const intentMod = require('../intent.js');
  const targetCap = intentMod.findActiveCapability('capability' + concreteScope.slice(6));
  // intent:xxx → capability:xxx mapping via slice(6) ('intent:' length)
  if (!targetCap) {
    return { ok: false, error: 'no_capability_for_skill_target_scope: ' + concreteScope };
  }

  // Write the concrete intent. Grounded in this skill engram (it's an
  // operator/PLR-tier rationalization — wait, skill engrams are
  // llm_inferred tier). Grounded_in must include at least one
  // operator_confirmed|plr_evolved engram per grounded_in_sealed STVC.
  // The skill itself doesn't satisfy this — the partner must include
  // its own grounding ref (typically active_project or operator-confirmed
  // decision). For v1, accept payload.grounded_in passthrough.
  const grounded = payload.grounded_in;
  if (!Array.isArray(grounded) || !grounded.length) {
    return { ok: false, error: 'skill_execute_requires_grounded_in',
             detail: 'payload.grounded_in must reference at least one operator/PLR-tier engram (typically the active_project authorizing this skill)' };
  }
  const concreteWrite = intentMod.writeIntent({
    scope:                concreteScope,
    statement:            'skill ' + skillEng.scope + ' executed',
    payload:              concretePayload,
    capability_ref:       targetCap.id,
    grounded_in:          grounded,
    irreversibility_class: payload.irreversibility_class || 'low',
    seals:                payload.seals || [],
    parent_intent_id:     intent && intent.id,
    agent_id:             intent && intent.partner_id ? intent.partner_id : 'partner'
  });
  if (!concreteWrite.ok) {
    return { ok: false, error: 'concrete_intent_refused: ' + (concreteWrite.detail || concreteWrite.error) };
  }

  // Dispatch the concrete intent.
  const dispatcher = require('../dispatcher.js');
  const dr = await dispatcher.dispatchOne(concreteWrite.id, { context: ctx });
  return {
    ok: dr.ok,
    result: {
      skill_id: payload.skill_id,
      concrete_intent_id: concreteWrite.id,
      observation_id: dr.observation_id || null,
      underlying_result: dr.result || null
    },
    error: dr.ok ? null : dr.refusal_reason
  };
}

module.exports = {
  scope_match: ADAPTER_SCOPE,
  param_schema: { skill_id: 'string', parameters: 'object', grounded_in: 'array' },
  irreversibility_class: 'low',   // skill-execute itself is low; underlying intent's class enforces
  dispatch
};
