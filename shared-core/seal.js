// SPDX-License-Identifier: AGPL-3.0-only
// Operator seal.
//
// Operator-signed approval of a SPECIFIC partner intent. Required for
// any intent with irreversibility_class >= high (irreversibility_sealed
// STVC predicate refuses without one). The seal IS the structural
// answer to "partner cannot take destructive action without operator
// review."
//
// Flow:
//   1. Partner emits an intent at high/sealed_only class with empty
//      seals[]. STVC refuses at write time (intent_refused_at_write).
//   2. Partner calls writeSealRequest(intent_descriptor) — this
//      writes an operator_surface engram (notify-tier) carrying the
//      intent's would-be shape so the operator can review.
//   3. Operator runs `troth seal <request_id>` → unlocks signer →
//      writeSeal({signer, sealed_intent_idempotency_key, payload_hash}).
//   4. Partner re-emits the intent with seals: [seal_id]. STVC now
//      accepts (irreversibility_sealed sees a valid seal binding to
//      this idempotency_key).
//
// Seal binding: a seal engram MUST carry sealed_intent_idempotency_key
// OR sealed_intent_id in its body. The irreversibility_sealed STVC
// predicate matches the seal against the proposed intent's
// idempotency_key — prevents seal reuse for different payloads.
//
// Engram shape (seal):
//   class: commitment
//   scope: 'seal'
//   source_authority: 'operator_confirmed' (signed)
//   extra_output: {
//     sealed_intent_idempotency_key: <hex>     // binds to a specific shape
//     sealed_intent_id: <engram_id?>           // optional, if intent already exists
//     scope_of_intent: 'intent:email:send'     // for audit clarity
//     note: <operator's reason text>
//     created_at_ms: <ts>
//   }

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');

const SEAL_SCOPE = 'seal';
const SEAL_REQUEST_SCOPE = 'operator_surface';   // seal requests live in operator_surface inbox

// Write an operator-signed seal. signer must be unlocked.
function writeSeal(opts) {
  opts = opts || {};
  if (!opts.signer || typeof opts.signer.sign !== 'function') {
    return { ok: false, error: 'unlocked_signer_required' };
  }
  if (!opts.sealed_intent_idempotency_key && !opts.sealed_intent_id) {
    return { ok: false, error: 'must_provide_idempotency_key_or_intent_id' };
  }
  const extra_output = {
    sealed_intent_idempotency_key: opts.sealed_intent_idempotency_key || null,
    sealed_intent_id:              opts.sealed_intent_id || null,
    scope_of_intent:               opts.scope_of_intent || null,
    note:                          opts.note ? String(opts.note).slice(0, 500) : null,
    created_at_ms:                 Date.now()
  };
  const statement = 'operator seal for intent ' +
    (opts.scope_of_intent || '<scope unspecified>');
  const canon = opKey.canonicalEngramBody({
    statement,
    scope: SEAL_SCOPE,
    source_authority: 'operator_confirmed',
    extra_output
  });
  const signature = opts.signer.sign(canon);
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'operator',
    user_id:  opts.user_id  || 'operator',
    cwd:      opts.cwd      || null,
    statement,
    source:   opts.source   || 'seal.writeSeal',
    source_authority: 'operator_confirmed',
    scope:    SEAL_SCOPE,
    signature,
    extra_output,
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'seal_write_refused' };
  return { ok: true, id };
}

// Find seals matching a given idempotency_key (the partner's primary
// way to find the right seal to attach to its re-emit). Returns the
// list of valid op-tier seal engrams.
function findSealsForIdempotencyKey(idempotency_key) {
  if (!idempotency_key) return [];
  try {
    const pool = engram.listEngrams({
      principal: null, audience: 'all',
      scope: SEAL_SCOPE, limit: 200
    }) || [];
    const matches = [];
    for (const e of pool) {
      if (e.source_authority !== 'operator_confirmed') continue;
      // Fall back to raw output for binding fields since projection
      // doesn't surface them.
      let bound = null;
      try {
        const state = require('./state.js');
        if (state.getAction) {
          const raw = state.getAction(e.id);
          if (raw) {
            const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
            if (out) bound = out.sealed_intent_idempotency_key || null;
          }
        }
      } catch (_) {}
      if (bound === idempotency_key) matches.push(e);
    }
    return matches;
  } catch (_) { return []; }
}

// Write a seal_request operator_surface engram — partner emits this
// when it wants an operator to seal a high-irreversibility intent.
//
// autonomous-mode step — also writes a row to l4_operator_requests so the dashboard
// inbox renders the seal request alongside allowlist/approval requests.
// The two writes are intentional: the engram is the substrate audit
// trail; the operator_request row is the dashboard projection that
// drives the UX (one-line "copy this troth seal command" affordance).
function writeSealRequest(opts) {
  opts = opts || {};
  if (!opts.proposed_intent_scope) return { ok: false, error: 'proposed_intent_scope_required' };
  if (!opts.proposed_idempotency_key) return { ok: false, error: 'proposed_idempotency_key_required' };
  const os = require('./operator-surface.js');
  const engramResult = os.recordOperatorSurface({
    urgency: 'notify',
    subject: 'seal request: ' + opts.proposed_intent_scope,
    body: opts.body || null,
    surface_kind: 'seal_request',
    intent_ref:   opts.proposed_intent_id || null,
    agent_id: opts.agent_id || 'partner',
    cwd:      opts.cwd      || null
  });
  // Dashboard projection — best-effort, never fail the seal_request just
  // because the row write was rejected (e.g. state.db readonly).
  try {
    const state = require('./state.js');
    state.recordOperatorRequest({
      kind: 'seal_request',
      urgency: 'normal',
      detail: {
        proposed_intent_scope:    opts.proposed_intent_scope,
        proposed_idempotency_key: opts.proposed_idempotency_key,
        proposed_intent_id:       opts.proposed_intent_id || null,
        engram_id:                (engramResult && engramResult.id) || null,
        body:                     opts.body || null
      }
    });
  } catch (_) { /* row projection optional */ }
  return engramResult;
}

module.exports = {
  writeSeal,
  writeSealRequest,
  findSealsForIdempotencyKey,
  SEAL_SCOPE
};
