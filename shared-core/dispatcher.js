// SPDX-License-Identifier: AGPL-3.0-only
// Dispatcher infrastructure.
//
// The substrate-native L4 build pattern terminates here: validated
// intent engrams are picked up by thin dispatcher adapters that call
// external services and write observation engrams. NO LLM in the
// dispatch loop. NO retries baked in. Failure → observation engram
// with error → partner's next conversation tick reasons about it.
//
// Two-phase STVC:
//   1. Write-time. writeIntent (intent.js) runs the predicate set
//      before persisting. Refused intents never create intent_state.
//   2. Dispatch-time. Before adapter.dispatch fires, this module re-
//      runs the same predicate set. TOCTOU defense: capability could
//      have been revoked, budget could have drained, global_pause
//      could have triggered between write and dispatch.
//
// Adapter contract (one file per service-action, see ./dispatchers/):
//   module.exports = {
//     scope_match: 'intent:stripe:read:customers',  // exact or trailing-*
//     param_schema: { customer_id: 'string' },      // for log clarity
//     irreversibility_class: 'low',                 // adapter's max
//     async dispatch(intent, capability, context) {
//       // returns { ok, result?, error? }
//       // NO retries, NO LLM, NO reasoning.
//     }
//   };
//
// The dispatcher writes the observation engram on the adapter's
// behalf, so adapters stay focused on the external service call.

'use strict';

const state    = require('./state.js');
const engram   = require('./engram.js');
const intentMod = require('./intent.js');

const OBSERVATION_SCOPE = 'observation';

// Registry. Adapters self-register at module load via registerAdapter
// or are loaded explicitly by callers. Tests can override / inject
// mocks via registerAdapter — useful for stripe:read without hitting
// the real Stripe API.
const _REGISTRY = new Map();

function registerAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('dispatcher.registerAdapter: object required');
  if (typeof adapter.scope_match !== 'string') throw new Error('dispatcher.registerAdapter: scope_match required');
  if (typeof adapter.dispatch !== 'function') throw new Error('dispatcher.registerAdapter: dispatch fn required');
  _REGISTRY.set(adapter.scope_match, adapter);
  return adapter;
}

function unregisterAdapter(scope_match) {
  _REGISTRY.delete(scope_match);
}

function listAdapters() {
  return Array.from(_REGISTRY.values()).map(a => ({
    scope_match: a.scope_match,
    param_schema: a.param_schema || null,
    irreversibility_class: a.irreversibility_class || 'low'
  }));
}

function _findAdapter(intentScope) {
  // Exact match first; then trailing-* prefix.
  if (_REGISTRY.has(intentScope)) return _REGISTRY.get(intentScope);
  for (const [key, adapter] of _REGISTRY.entries()) {
    if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      if (intentScope.indexOf(prefix) === 0) return adapter;
    }
  }
  return null;
}

// Run the four intent STVC predicates inline (same set writeIntent
// runs at write time). Re-validation at dispatch time catches state
// changes that happened between write and dispatch.
//
// Returns { ok, refusal_reason? }.
function _revalidateIntent(intentRow) {
  try {
    const sm = require('./state-machine.js');
    const PREDICATE_KINDS = sm.PREDICATE_KINDS || {};
    // Convert intent listEngrams row → the proposed shape predicates expect.
    const proposed = {
      type: 'commitment',
      id: intentRow.id,
      scope: intentRow.scope,
      output: {
        scope:                 intentRow.scope,
        grounded_in:           intentRow.grounded_in,
        capability_ref:        intentRow.capability_ref,
        irreversibility_class: intentRow.irreversibility_class,
        seals:                 intentRow.seals,
        idempotency_key:       intentRow.idempotency_key
      }
    };
    const ctx = { proposed };
    const checks = [
      'grounded_in_sealed',
      'capability_covers_intent',
      'irreversibility_sealed',
      'not_globally_paused'
    ];
    for (const kind of checks) {
      const fn = PREDICATE_KINDS[kind];
      if (typeof fn !== 'function') continue;
      const reason = fn({ kind }, ctx);
      if (reason) return { ok: false, refusal_reason: kind + ': ' + reason };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, refusal_reason: 'revalidate_threw: ' + (e && e.message || e) };
  }
}

// Write an observation engram tied to an intent. Used by the dispatcher
// to record adapter outcomes. Lower-tier (llm_inferred) so they don't
// need cryptographic signatures — observations are facts the substrate
// records about its own actions, not operator-anchored claims.
function _writeObservation(intentRow, result, error) {
  return engram.recordEngram({
    agent_id: 'dispatcher',
    user_id:  'operator',
    cwd:      null,
    statement: 'observation for intent ' + intentRow.id +
               (error ? ' (error)' : ' (ok)'),
    source:   'dispatcher.dispatch',
    source_authority: 'llm_inferred',
    scope:    OBSERVATION_SCOPE,
    extra_output: {
      observes_intent: intentRow.id,
      observed_scope:  intentRow.scope,
      result:          result || null,
      error:           error ? String(error.message || error).slice(0, 1000) : null,
      observed_at_ms:  Date.now()
    },
    auto_verify: false
  });
}

// Dispatch one intent end-to-end:
//   1. Resolve intent engram + capability engram via listEngrams.
//   2. Re-validate via STVC predicates (two-phase).
//   3. Atomic claim via state.claimIntent → flips status validated→dispatched.
//      Loses the race (returns null) → no-op.
//   4. Call adapter.dispatch(intent, capability, context).
//   5. Write observation engram with the result.
//   6. Mark intent observed / failed in intent_state.
//
// Returns { ok, status, observation_id?, refusal_reason? }.
async function dispatchOne(intent_engram_id, opts) {
  opts = opts || {};
  if (!intent_engram_id) return { ok: false, refusal_reason: 'intent_id_required' };

  const intentRow = intentMod.getIntent(intent_engram_id);
  if (!intentRow) return { ok: false, refusal_reason: 'intent_not_found' };
  if (typeof intentRow.scope !== 'string' || intentRow.scope.indexOf('intent:') !== 0) {
    return { ok: false, refusal_reason: 'not_an_intent' };
  }

  // Resolve capability — needed for adapter + STVC re-validation.
  let capability = null;
  if (intentRow.capability_ref) {
    const pool = engram.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
    capability = pool.find(e => e.id === intentRow.capability_ref) || null;
  }

  // Two-phase STVC: dispatch-time re-validate.
  const recheck = _revalidateIntent(intentRow);
  if (!recheck.ok) {
    state.markIntentFailed(intent_engram_id, 'dispatch_revalidate_failed: ' + recheck.refusal_reason);
    return { ok: false, refusal_reason: recheck.refusal_reason };
  }

  // Cost circuit breaker — the seam, not the guarantee. It checks rolling
  // spend windows against operator-configured caps and refuses dispatch when
  // already over, so a runaway loop on a paid provider cannot bleed a wallet
  // unattended.
  //
  // READ THIS BEFORE RELYING ON IT: both halves live in the closed autonomy
  // overlay and are absent from this tree. Without them the lookup below finds
  // no caps and this block does nothing, which is consistent, because there is
  // no unattended spending here to cap: nothing in the open tree dispatches
  // without you. If you build your own autonomous loop on this dispatcher, you
  // are responsible for your own spend limit; do not read this block as one.
  try {
    const l4cfg  = (function(){try{return require('./l4-config.js')}catch(e){return {isEnabled:()=>false,DEFAULTS:{},getL4Config:()=>({enabled:false}),getBudgetForClass:()=>1000,getTransparencyForClass:()=>'show'}}}());
    const breaker = require('./cost-circuit-breaker.js');
    const caps = (l4cfg.getL4Config() || {}).cost_caps || null;
    if (caps && (caps.hourly_usd || caps.daily_usd || caps.weekly_usd || caps.per_domain)) {
      const trip = breaker.chargeOrTrip({
        caps,
        charge_usd: 0,                             // pre-dispatch check only
        goal_id:    intentRow.parent_goal_id || null,
        goal_class: intentRow.goal_class || null
      });
      if (trip && trip.refused) {
        state.markIntentFailed(intent_engram_id,
          'cost_circuit_tripped: ' + (trip.broken || []).join(','));
        return {
          ok: false,
          refusal_reason: 'cost_circuit_tripped: ' + (trip.broken || []).join(','),
          broken:        trip.broken,
          details:       trip.details,
          request_id:    trip.request_id
        };
      }
    }
  } catch (_) { /* circuit breaker is best-effort; never block dispatch on its own failure */ }

  // Find an adapter for this scope.
  const adapter = _findAdapter(intentRow.scope);
  if (!adapter) {
    state.markIntentFailed(intent_engram_id, 'no_adapter_for_scope: ' + intentRow.scope);
    return { ok: false, refusal_reason: 'no_adapter_for_scope: ' + intentRow.scope };
  }

  // Atomic claim. If status is not 'validated' (already dispatched,
  // already observed, refused, etc.) → no-op.
  const claim = state.claimIntent(intent_engram_id);
  if (!claim) {
    return { ok: false, refusal_reason: 'claim_lost_or_wrong_status' };
  }

  // D2 — effect-ledger dedup. For NON-reversible side-effects, derive a STABLE
  // effect_key; if a prior run already completed THIS exact side-effect, SKIP
  // the adapter and reference the prior outcome — a crash-resume must NEVER
  // re-create an account / re-submit a form. 'low' (reversible) ops skip the
  // ledger entirely (cheap + safe to repeat; no dedup overhead).
  const _irrev = intentRow.irreversibility_class || 'low';
  const _effectKey = (_irrev !== 'low')
    ? intentMod.computeEffectKey(intentRow.scope, intentRow.payload, _irrev)
    : null;
  if (_effectKey) {
    let prior = null;
    try { prior = state.getEffect(_effectKey); } catch (_) {}
    if (prior && prior.status === 'done') {
      const observationId = _writeObservation(intentRow, {
        ok: true,
        result: { deduped: true, external_id: prior.external_id || null,
          note: 'effect already completed in a prior run (D2 effect-ledger) — re-dispatch skipped' }
      }, null);
      state.markIntentObserved(intent_engram_id, observationId);
      return {
        ok: true, status: 'observed', deduped: true,
        observation_id: observationId,
        external_id: prior.external_id || null,
        result: { deduped: true, external_id: prior.external_id || null }
      };
    }
  }

  // Adapter call. The adapter is THIN — no retries, no LLM, no
  // reasoning. Errors are normal and surface as observation engrams.
  let adapterResult = null;
  let adapterError  = null;
  try {
    const t0 = Date.now();
    const ctxArg = Object.assign({
      _t_start: t0,
      _intent_engram_id: intent_engram_id,
      _effect_key: _effectKey   // D2 — adapters (http-do) align external Idempotency-Key to it
    }, opts.context || {});
    adapterResult = await Promise.resolve(adapter.dispatch(intentRow, capability, ctxArg));
    if (adapterResult && adapterResult.ok === false) {
      adapterError = new Error(adapterResult.error || 'adapter_reported_failure');
    }
  } catch (e) {
    adapterError = e;
  }

  // Always write an observation engram (success OR failure — no silent
  // failures, the partner reasons about both kinds of outcomes).
  const observationId = _writeObservation(intentRow, adapterResult, adapterError);

  if (adapterError) {
    state.markIntentFailed(intent_engram_id,
      adapterError.message || String(adapterError));
    return {
      ok: false,
      status: 'failed',
      observation_id: observationId || null,
      refusal_reason: 'adapter_error: ' + (adapterError.message || String(adapterError))
    };
  }

  // D2 — record the completed side-effect (stable effect_key) so a future
  // crash-resume recognises it as done and skips re-dispatch. Best-effort: the
  // observation is already persisted; a ledger-write miss only loses dedup.
  if (_effectKey) {
    try {
      const _res = (adapterResult && adapterResult.result !== undefined) ? adapterResult.result : adapterResult;
      const _ext = adapterResult && (adapterResult.external_id != null
        ? adapterResult.external_id
        : (adapterResult.result && adapterResult.result.id != null ? adapterResult.result.id : null));
      let _rhash = null;
      try { _rhash = require('crypto').createHash('sha256').update(JSON.stringify(_res || null)).digest('hex'); } catch (_) {}
      state.recordEffect({
        effect_key:  _effectKey,
        intent_id:   intent_engram_id,
        goal_id:     (opts.context && opts.context.goal_id) || null,
        scope:       intentRow.scope,
        external_id: _ext,
        result_hash: _rhash,
        status:      'done'
      });
    } catch (_) { /* ledger write best-effort */ }
  }

  state.markIntentObserved(intent_engram_id, observationId);
  return {
    ok: true,
    status: 'observed',
    observation_id: observationId,
    result: adapterResult && adapterResult.result !== undefined
      ? adapterResult.result
      : adapterResult
  };
}

// Dispatch all validated intents (drain the queue). Polling-based
// for v1; SQLite update_hook → in-memory queue can be added later
// without changing this interface.
async function dispatchPending(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(100, opts.limit || 25));
  const rows  = state.listIntentStates({ status: 'validated', limit });
  const results = [];
  for (const row of rows) {
    /* eslint-disable no-await-in-loop */
    const r = await dispatchOne(row.intent_engram_id, opts);
    results.push({ intent_engram_id: row.intent_engram_id, ...r });
  }
  return { ran: results.length, results };
}

module.exports = {
  registerAdapter,
  unregisterAdapter,
  listAdapters,
  dispatchOne,
  dispatchPending,
  OBSERVATION_SCOPE,
  // Test surface
  _revalidateIntent,
  _findAdapter
};
