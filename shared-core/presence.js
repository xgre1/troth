// SPDX-License-Identifier: AGPL-3.0-only
// Operator presence proof.
//
// "Operator is principal" is meaningless if anyone with keyboard access
// IS the principal. The presence_proof engram is a signed assertion
// that the operator was bodily present at a specific moment. STVC
// gates that need real-operator-presence (high-irreversibility seal,
// recovery init, capability minting) check that a presence_proof
// exists newer than max_age_ms.
//
// In v1 this is enforced at CLI level: `troth presence` writes a
// fresh presence_proof when the operator runs it interactively, OR an
// auto-refresh kicks in on any signed operator action (init/confirm/
// pause/resume/recover). Future hardening: hardware-key tap requirement,
// per-irreversibility-class freshness windows.
//
// Engram shape:
//   class:  commitment (engram default)
//   scope:  'presence_proof'
//   source_authority: 'operator_confirmed' (signed)
//   extra_output: { proof_ts, max_age_ms?, note? }

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');

const PRESENCE_PROOF_SCOPE = 'presence_proof';
const DEFAULT_MAX_AGE_MS   = 8 * 60 * 60 * 1000;   // 8h default freshness window

// Write a fresh presence_proof. signer must already be unlocked.
// Returns { ok, id } or { ok:false, error }.
function recordPresenceProof(signer, opts) {
  opts = opts || {};
  if (!signer || typeof signer.sign !== 'function') {
    return { ok: false, error: 'unlocked_signer_required' };
  }
  const now = Date.now();
  const extra_output = {
    proof_ts:   now,
    max_age_ms: typeof opts.max_age_ms === 'number' ? opts.max_age_ms : DEFAULT_MAX_AGE_MS,
    note:       opts.note ? String(opts.note).slice(0, 200) : null
  };
  const statement = 'operator presence proven at ' + new Date(now).toISOString();
  const canon = opKey.canonicalEngramBody({
    statement,
    scope: PRESENCE_PROOF_SCOPE,
    source_authority: 'operator_confirmed',
    extra_output
  });
  const signature = signer.sign(canon);
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'operator',
    user_id:  opts.user_id  || 'operator',
    cwd:      opts.cwd      || null,
    statement,
    source:   opts.source   || 'presence.recordPresenceProof',
    source_authority: 'operator_confirmed',
    scope:    PRESENCE_PROOF_SCOPE,
    signature,
    extra_output,
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'presence_proof_refused' };
  return { ok: true, id, proof_ts: now };
}

// Find the most recent presence_proof. Returns the projected row or null.
function activePresenceProof() {
  try {
    const rows = engram.listEngrams({
      principal: null, audience: 'all',
      scope: PRESENCE_PROOF_SCOPE, limit: 1
    }) || [];
    return rows.length ? rows[0] : null;
  } catch (_) { return null; }
}

// Is presence fresh? Uses the proof's own max_age_ms when present,
// else DEFAULT_MAX_AGE_MS. Returns:
//   { fresh: true, age_ms, max_age_ms, id }
//   { fresh: false, reason: 'no_proof' | 'expired', age_ms?, max_age_ms? }
function presenceFreshness(maxAgeOverrideMs) {
  const proof = activePresenceProof();
  if (!proof) return { fresh: false, reason: 'no_proof' };
  // Projection's `ts` is the engram timestamp; proof_ts inside extra_output
  // matches it for self-written proofs but ts is the authoritative ms.
  const ts = (typeof proof.ts === 'number') ? proof.ts : 0;
  // max_age_ms in extra_output isn't in the projection by default; we
  // accept the override if caller passed one, otherwise use the default.
  const maxAge = (typeof maxAgeOverrideMs === 'number' && maxAgeOverrideMs > 0)
    ? maxAgeOverrideMs
    : DEFAULT_MAX_AGE_MS;
  const age = Date.now() - ts;
  if (age > maxAge) {
    return { fresh: false, reason: 'expired', age_ms: age, max_age_ms: maxAge, id: proof.id };
  }
  return { fresh: true, age_ms: age, max_age_ms: maxAge, id: proof.id };
}

module.exports = {
  recordPresenceProof,
  activePresenceProof,
  presenceFreshness,
  PRESENCE_PROOF_SCOPE,
  DEFAULT_MAX_AGE_MS
};
