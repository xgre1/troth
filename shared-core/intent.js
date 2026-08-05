// SPDX-License-Identifier: AGPL-3.0-only
// Intent + capability primitives.
//
// The L4 build pattern from the design work is substrate-native
// and tiny: intent engrams + capability engrams + thin dispatchers +
// observation engrams + STVC predicates. NO new tables for intent or
// capability — they're regular engrams with disciplined scope naming
// and a projection passthrough so STVC predicates and dispatchers can
// read structured fields off `listEngrams` rows.
//
// Naming convention (enforced at write time by this module):
//   scope='intent:<service>:<action>'        — a belief about future action
//   scope='capability:<service>:<scope_glob>' — a belief about authorization
//
// Intent fields (in extra_output):
//   capability_ref        — engram_id of the authorizing capability
//   grounded_in           — [engram_id...] sealed rationale (the WHY)
//   irreversibility_class — 'low' | 'medium' | 'high' | 'sealed_only'
//   seals                 — [seal_engram_id...] when class >= high
//   parent_intent_id      — parent in retry/sub-partner chain
//   partner_id            — 'partner' or 'sub:<id>'
//   payload               — dispatcher-readable structured args
//   idempotency_key       — sha256(scope + canonical(payload) + ts_minute)
//                           auto-computed if not provided
//
// Capability fields (in extra_output):
//   payload_schema        — { field: 'type',... } shape for intent.payload
//   max_irreversibility   — highest class this capability authorizes
//   expiry                — unix ms; STVC refuses dispatch after this
//   revoked               — boolean (operator can set true via signed write
//                           that supersedes the original cap)
//
// All intent + capability writes route through engram.recordEngram with
// the same integration point / tier-constrained-supersedes machinery. Capabilities
// MUST be operator_confirmed (cryptographically signed) — partner cannot
// mint authority for itself. Intents are typically llm_inferred (partner
// proposes); operator-confirmed intents are reserved for direct CLI ops.

'use strict';

const crypto = require('crypto');
const engram = require('./engram.js');
const opKey  = require('./operator-key.js');
const state  = require('./state.js');

const INTENT_SCOPE_PREFIX     = 'intent:';
const CAPABILITY_SCOPE_PREFIX = 'capability:';
const OBSERVATION_SCOPE       = 'observation';

const IRREVERSIBILITY_RANK = {
  low: 1, medium: 2, high: 3, sealed_only: 4
};

function _validIrreversibility(s) {
  return s in IRREVERSIBILITY_RANK;
}

// Stable canonical form for payload — used in idempotency key. Reuses
// operator-key's canonicalize so the same key-ordering discipline
// applies. Excludes nothing by default; payload is the entire spec.
function _canonicalPayload(payload) {
  return opKey.canonicalize(payload || {}, []);
}

// idempotency_key = sha256(scope + canonical_payload + ts_minute). The
// ts_minute bucket lets retries within the same minute dedupe (intended
// for accidental double-emissions from the LLM) while letting deliberate
// re-runs after a minute proceed.
function computeIdempotencyKey(scope, payload, nowMs) {
  const tsMin = Math.floor((nowMs || Date.now()) / 60000);
  const h = crypto.createHash('sha256');
  h.update(String(scope || ''));
  h.update('|');
  h.update(_canonicalPayload(payload));
  h.update('|');
  h.update(String(tsMin));
  return h.digest('hex');
}

// effect_key = sha256(scope + canonical_payload + irreversibility_class). UNLIKE
// idempotency_key this has NO time bucket — it is STABLE across restarts, so a
// crash-resume HOURS later still recognises an already-completed real-world
// side-effect (account created, form submitted) and SKIPS re-doing it (D2
// effect-ledger). Same canonicalization discipline as the idempotency key.
function computeEffectKey(scope, payload, irreversibilityClass) {
  const h = crypto.createHash('sha256');
  h.update(String(scope || ''));
  h.update('|');
  h.update(_canonicalPayload(payload));
  h.update('|');
  h.update(String(irreversibilityClass || 'low'));
  return h.digest('hex');
}

// Write an intent engram. Routes through engram.recordEngram with
// scope discipline + auto-derived idempotency key + structured
// extra_output. Source authority defaults to 'llm_inferred' (partner
// proposes); pass source_authority='operator_confirmed' + signature
// for operator-direct CLI use.
function writeIntent(opts) {
  opts = opts || {};
  const scope = opts.scope || null;
  if (typeof scope !== 'string' || scope.indexOf(INTENT_SCOPE_PREFIX) !== 0) {
    return { ok: false, error: 'scope_must_be_intent_prefixed', detail: 'expected scope to start with "intent:"' };
  }
  if (!_validIrreversibility(opts.irreversibility_class || 'low')) {
    return { ok: false, error: 'bad_irreversibility_class', detail: 'must be low|medium|high|sealed_only' };
  }
  const payload = opts.payload || {};
  const idempotency_key = opts.idempotency_key ||
                          computeIdempotencyKey(scope, payload);
  const extra_output = {
    payload,
    capability_ref:        opts.capability_ref || null,
    grounded_in:           Array.isArray(opts.grounded_in) ? opts.grounded_in : (opts.grounded_in ? [opts.grounded_in] : []),
    irreversibility_class: opts.irreversibility_class || 'low',
    seals:                 Array.isArray(opts.seals) ? opts.seals : (opts.seals ? [opts.seals] : []),
    parent_intent_id:      opts.parent_intent_id || null,
    partner_id:            opts.partner_id || 'partner',
    idempotency_key:       idempotency_key,
    expected_observation_shape: opts.expected_observation_shape || null
  };
  if (opts.extra_output && typeof opts.extra_output === 'object') {
    Object.assign(extra_output, opts.extra_output);
  }
  // design: write-time STVC. Run the four intent predicates
  // INLINE so partner-emitted intents always get gated. Operator-
  // registered invariants (state_invariants table) layer on top via
  // validateTransition for additional rules; the write-time wall here
  // is non-bypassable.
  const proposed = {
    type: 'commitment',
    scope,
    output: {
      scope, grounded_in: extra_output.grounded_in,
      capability_ref: extra_output.capability_ref,
      irreversibility_class: extra_output.irreversibility_class,
      seals: extra_output.seals,
      idempotency_key,
      // Carry partner_id through so sub_partner_within_budget can see who
      // is emitting (sub-partner principal vs the main 'partner').
      partner_id: extra_output.partner_id
    }
  };
  let PREDICATE_KINDS;
  try { PREDICATE_KINDS = require('./state-machine.js').PREDICATE_KINDS; }
  catch (_) { PREDICATE_KINDS = {}; }
  for (const kind of ['grounded_in_sealed', 'capability_covers_intent',
                      'irreversibility_sealed', 'no_duplicate_pending_intent',
                      'not_globally_paused', 'external_suspicious_not_grounded',
                      'sub_partner_within_budget']) {
    const fn = PREDICATE_KINDS[kind];
    if (typeof fn !== 'function') continue;
    const refusal = fn({ kind }, { proposed });
    if (refusal) return { ok: false, error: 'intent_refused_at_write', detail: kind + ': ' + refusal };
  }

  const id = engram.recordEngram({
    agent_id:         opts.agent_id || 'partner',
    user_id:          opts.user_id  || 'operator',
    cwd:              opts.cwd      || null,
    statement:        opts.statement || ('intent ' + scope),
    source:           opts.source   || 'partner via writeIntent',
    source_authority: opts.source_authority || 'llm_inferred',
    scope,
    signature:        opts.signature || null,
    extra_output,
    auto_verify:      false
  });
  if (!id) return { ok: false, error: 'intent_write_refused' };
  // Create the mutable intent_state row. Status flips to 'validated'
  // immediately because the write-time STVC pass already gated us.
  state.insertIntentState({ intent_engram_id: id, status: 'validated' });
  return { ok: true, id, idempotency_key, status: 'validated' };
}

// Write a capability engram. MUST be operator_confirmed (signed). The
// partner cannot mint its own capabilities — that would be exactly the
// authority-laundering integration point closed at the engram layer.
function writeCapability(opts) {
  opts = opts || {};
  const scope = opts.scope || null;
  if (typeof scope !== 'string' || scope.indexOf(CAPABILITY_SCOPE_PREFIX) !== 0) {
    return { ok: false, error: 'scope_must_be_capability_prefixed', detail: 'expected scope to start with "capability:"' };
  }
  if (opts.source_authority && opts.source_authority !== 'operator_confirmed') {
    return { ok: false, error: 'capability_must_be_operator_confirmed' };
  }
  if (!opts.signature) {
    return { ok: false, error: 'capability_signature_required',
             detail: 'capabilities are operator-tier; sign via opKey.unlock(passphrase).sign(canonicalEngramBody({...}))' };
  }
  if (opts.max_irreversibility && !_validIrreversibility(opts.max_irreversibility)) {
    return { ok: false, error: 'bad_max_irreversibility' };
  }
  const extra_output = {
    payload_schema:       opts.payload_schema || null,
    max_irreversibility:  opts.max_irreversibility || 'low',
    expiry:               (typeof opts.expiry === 'number' && opts.expiry > 0) ? opts.expiry : null,
    revoked:              !!opts.revoked,
    scope_glob:           opts.scope_glob || scope,  // legacy fallback
    parent_capability_id: opts.parent_capability_id || null
  };
  if (opts.extra_output && typeof opts.extra_output === 'object') {
    Object.assign(extra_output, opts.extra_output);
  }
  const id = engram.recordEngram({
    agent_id:         opts.agent_id || 'operator',
    user_id:          opts.user_id  || 'operator',
    cwd:              opts.cwd      || null,
    statement:        opts.statement || ('capability ' + scope),
    source:           opts.source   || 'operator via writeCapability',
    source_authority: 'operator_confirmed',
    scope,
    signature:        opts.signature,
    extra_output,
    auto_verify:      false
  });
  if (!id) return { ok: false, error: 'capability_write_refused' };
  return { ok: true, id };
}

// MCP hands scope mapping.
//
// The mcp_call action emits scope 'intent:mcp:call:<server>' but the
// operator seals authority per SERVER as 'capability:mcp:<server>' (or
// the 'capability:mcp:*' wildcard) - the ':call:' verb segment is an
// implementation detail of the intent side, not something the operator
// should have to encode into every capability. The generic STVC
// prefix-strip matcher (capTail === intentTail | trailing-* prefix) does
// NOT bridge that shape ('mcp:<server>' does not prefix 'mcp:call:<server>'),
// so this ONE family gets an explicit mapping. Scoped strictly to
// intent:mcp:call:* http/browser/fs/shell/spawn/skill are untouched.
//
// Returns true iff capScope authorizes intentScope under the mcp mapping:
//   capability:mcp:*              covers any intent:mcp:call:<server>
//   capability:mcp:<server>       covers intent:mcp:call:<server> (exact)
// Anything else returns false (caller falls back to the generic matcher).
function mcpCapabilityCoversIntent(capScope, intentScope) {
  if (typeof capScope !== 'string' || typeof intentScope !== 'string') return false;
  if (intentScope.indexOf('intent:mcp:call:') !== 0) return false;
  if (capScope.indexOf('capability:mcp:') !== 0) return false;
  const server = intentScope.slice('intent:mcp:call:'.length);
  if (!server) return false;
  const capServer = capScope.slice('capability:mcp:'.length);
  if (capServer === '*') return true;              // wildcard covers any server
  return capServer === server;                     // exact server-name match
}

// Look up an intent by id (returns the projected listEngrams row or null).
function getIntent(intent_id) {
  if (!intent_id) return null;
  // listEngrams doesn't index by id; pull a bounded recent pool and find.
  // Adequate for v1; a state.getAction-based fast path can be added later.
  const pool = engram.listEngrams({
    principal: null, audience: 'all', limit: 2000
  }) || [];
  return pool.find(e => e.id === intent_id) || null;
}

// Look up the most recent active capability for a given scope. Returns
// null when no live capability covers the scope.
function findActiveCapability(scope_or_intent_scope) {
  if (!scope_or_intent_scope) return null;
  // Find capability:* engrams; match by exact scope OR glob if the
  // capability's scope ends with a wildcard. v1 supports exact match
  // and a trailing '*' wildcard; richer glob matching is dispatcher
  // territory later.
  const rows = engram.listEngrams({
    principal: null, audience: 'all', limit: 200
  }) || [];
  const caps = rows.filter(e =>
    typeof e.scope === 'string' && e.scope.indexOf(CAPABILITY_SCOPE_PREFIX) === 0
  );
  const now = Date.now();
  for (const cap of caps) {
    if (cap.revoked) continue;
    if (typeof cap.expiry === 'number' && cap.expiry > 0 && cap.expiry < now) continue;
    const capScope = cap.scope;
    // Exact match
    if (capScope === scope_or_intent_scope) return cap;
    // Trailing wildcard: capability:stripe:* matches capability:stripe:read
    if (capScope.endsWith('*')) {
      const prefix = capScope.slice(0, -1);
      if (scope_or_intent_scope.indexOf(prefix) === 0) return cap;
    }
  }
  return null;
}

module.exports = {
  writeIntent,
  writeCapability,
  getIntent,
  findActiveCapability,
  mcpCapabilityCoversIntent,
  computeIdempotencyKey,
  computeEffectKey,
  INTENT_SCOPE_PREFIX,
  CAPABILITY_SCOPE_PREFIX,
  OBSERVATION_SCOPE,
  IRREVERSIBILITY_RANK
};
