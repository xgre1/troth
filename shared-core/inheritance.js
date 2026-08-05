// SPDX-License-Identifier: AGPL-3.0-only
// End-of-life inheritance.
//
// Operator-death case. Operator pre-sealed an inheritance_directive at
// init (implementation step extension to bootstrap.js): successor public key +
// dormancy_threshold_ms. When operator's presence_proof goes stale past
// threshold, the substrate_not_dormant STVC predicate refuses all
// novel intents — partner enters dormant state.
//
// claimSuccession is how the successor re-anchors:
//   1. Successor restores their pre-authorized keypair (operator gave
//      them the key + passphrase before death, or it lived in offline
//      backup with operator's will)
//   2. Successor runs `troth inheritance claim --key-dir <path>`
//   3. This flow: reads inheritance_directive → unlocks successor signer
//      → verifies their key matches the directive's pubkey → generates
//      NEW primary keypair for successor → writes new operator_key:active
//      signed by the inheritance key. integration point multi-pubkey chain accepts
//      the inheritance key as verifier (implementation step extension).
//   4. Old operator_key:active is superseded (tier-constrained supersedes
//      via operator_confirmed → operator_confirmed works).
//   5. Successor records a fresh presence_proof → substrate exits dormant.
//
// Distinct from recovery (Phase 1.4b): recovery is for live-operator
// key-loss. Inheritance is for operator-death + successor handoff.
// Code is structurally similar; the trigger condition and the directive
// engram differ.

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');
const boot   = require('./bootstrap.js');

function runClaim(opts) {
  opts = opts || {};
  if (!opts.successor_passphrase) return { ok: false, error: 'successor_passphrase_required' };
  if (!opts.successor_key_dir)    return { ok: false, error: 'successor_key_dir_required' };
  if (!opts.new_passphrase)       return { ok: false, error: 'new_passphrase_required' };
  if (!opts.new_key_dir)          return { ok: false, error: 'new_key_dir_required' };

  // 1. inheritance_directive must exist.
  const directive = boot.getActiveInheritanceDirective();
  if (!directive) {
    return { ok: false, error: 'no_inheritance_directive',
             detail: 'substrate has no active inheritance_directive engram; pass --inheritance-pubkey at init to enable' };
  }
  // If dissolve_on_dormant is set, refuse claim — operator chose
  // dissolution over succession.
  if (directive.dissolve_on_dormant) {
    return { ok: false, error: 'directive_set_to_dissolve',
             detail: 'inheritance_directive.dissolve_on_dormant=true; partner is set to die with operator' };
  }
  // 2. Successor key files must exist.
  if (!opKey.exists({ key_dir: opts.successor_key_dir })) {
    return { ok: false, error: 'successor_key_files_missing',
             detail: 'no operator-key files at successor_key_dir; restore from offline backup first' };
  }
  // 3. Unlock the successor signer.
  let successorSigner;
  try {
    successorSigner = opKey.unlock(opts.successor_passphrase, { key_dir: opts.successor_key_dir });
  } catch (e) {
    return { ok: false, error: 'successor_unlock_failed', detail: e && e.message || String(e) };
  }
  // 4. Sanity check: unlocked key must match the directive's pinned pubkey.
  if (successorSigner.public_key_pem.trim() !== directive.inheritance_public_key_pem.trim()) {
    try { successorSigner.lock(); } catch (_) {}
    return { ok: false, error: 'successor_key_mismatch',
             detail: 'unlocked successor key does not match the pubkey pinned in the active inheritance_directive' };
  }
  // 5. Find current operator_key:active (to supersede).
  const activeRows = engram.listEngrams({
    principal: null, audience: 'all', scope: boot.OPERATOR_KEY_SCOPE, limit: 1
  }) || [];
  const oldActiveId = activeRows.length ? activeRows[0].id : null;

  // 6. Generate the new primary keypair for the successor.
  let newInit;
  try {
    newInit = opKey.initKeypair(opts.new_passphrase, {
      key_dir:  opts.new_key_dir,
      scrypt_n: opts.scrypt_n
    });
  } catch (e) {
    try { successorSigner.lock(); } catch (_) {}
    return { ok: false, error: 'new_keypair_init_failed', detail: e && e.message || String(e) };
  }
  // 7. Sign + write new operator_key:active with successor's authority.
  //    integration point multi-pubkey chain accepts the inheritance_directive's
  //    pubkey (implementation step extension) → write lands.
  try {
    const statement = 'operator authority transferred via inheritance to successor';
    const extra_output = {
      public_key_id:  newInit.public_key_id,
      public_key_pem: newInit.public_key_pem,
      inherited_from_directive_id: directive.id,
      inherited_at_ms: Date.now(),
      lifetime: oldActiveId ? { supersedes: oldActiveId, reason: 'inheritance_succession' } : undefined
    };
    const canon = opKey.canonicalEngramBody({
      statement,
      scope: boot.OPERATOR_KEY_SCOPE,
      source_authority: 'operator_confirmed',
      extra_output
    });
    const signature = successorSigner.sign(canon);
    const newKeyEngramId = engram.recordEngram({
      agent_id: opts.agent_id || 'inheritance-claim',
      cwd:      opts.cwd || null,
      user_id:  opts.user_id || 'successor',
      statement,
      source:   'inheritance.runClaim',
      source_authority: 'operator_confirmed',
      scope:    boot.OPERATOR_KEY_SCOPE,
      signature,
      extra_output,
      auto_verify: false
    });
    if (!newKeyEngramId) {
      return { ok: false, error: 'new_key_engram_refused' };
    }
    // 8. Record a fresh presence_proof under the successor so the
    //    substrate exits dormant immediately.
    try {
      const presence = require('./presence.js');
      // Unlock the NEW key briefly to write the presence proof. The
      // operator-key file just got written, so the new key is now
      // unlockable with new_passphrase + new_key_dir.
      const newSigner = opKey.unlock(opts.new_passphrase, { key_dir: opts.new_key_dir });
      try {
        presence.recordPresenceProof(newSigner, { note: 'auto via inheritance.runClaim' });
      } finally { try { newSigner.lock(); } catch (_) {} }
    } catch (_) { /* presence write best-effort */ }
    return {
      ok: true,
      new_public_key_id:        newInit.public_key_id,
      new_operator_key_engram_id: newKeyEngramId,
      old_operator_key_engram_id: oldActiveId,
      inheritance_directive_id: directive.id
    };
  } finally {
    try { successorSigner.lock(); } catch (_) {}
  }
}

module.exports = {
  runClaim
};
