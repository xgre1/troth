// SPDX-License-Identifier: AGPL-3.0-only
// Recovery flow.
//
// Re-anchors the substrate's operator authority when the primary key
// is lost. Without this, a forgotten passphrase or destroyed key file
// is permanent — the partner can never be issued operator-tier writes
// again, which kills its autonomy and eventually dormant-locks it.
//
// Pre-condition (set up at `troth init` time):
//   The operator passed --recovery-pubkey at init. bootstrap.runInit
//   wrote a sealed recovery_directive engram carrying that public key.
//   The corresponding PRIVATE key lives offline (paper backup, hardware
//   wallet, second laptop, etc) under the operator's control.
//
// Recovery flow:
//   1. Read the active recovery_directive — find the authorized
//      successor pubkey + id.
//   2. Generate a NEW primary keypair (new passphrase, new key dir).
//   3. Sign a new operator_key:active engram with the RECOVERY private
//      key. integration point verifies against the directive's pubkey (one of the
//      multi-candidate verifiers from Phase 1.4b) and accepts the write.
//   4. The new engram supersedes the old operator_key:active via
//      tier-constrained supersedes (integration point protects this — recovery key
//      is operator-tier authority, so it can retire the prior op-tier
//      key engram).
//   5. Subsequent operator-tier writes verify against the NEW primary
//      pubkey (substrate-first lookup short-circuits there).
//
// Threat model:
//   - Recovery private key compromise → attacker can re-anchor the
//     substrate to a key THEY hold. Mitigation: operator stores the
//     recovery private key offline + uses a different passphrase from
//     the primary; treats the recovery key like a hardware-token PIN.
//   - Recovery directive tampering at write time → blocked by integration point
//     when the directive engram was originally written.
//   - Stale recovery directive (operator rotated it but the engram
//     still references the old key) → operator should write a NEW
//     directive engram before destroying the new recovery key. Tier-
//     constrained supersedes lets a recovery write rotate the directive
//     too. Phase 1.4c will ship `troth recover --rotate-directive`.

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');
const boot   = require('./bootstrap.js');

// Run the recovery flow.
//
// opts:
//   recovery_passphrase  — REQUIRED. Passphrase that unlocks the
//                          recovery keypair on disk.
//   recovery_key_dir     — REQUIRED. Path to the recovery key's
//                          ~/.troth/operator-keys-style directory.
//                          MUST be different from the primary key dir.
//   new_passphrase       — REQUIRED. Passphrase for the new primary
//                          keypair (>= 8 chars).
//   new_key_dir          — REQUIRED. Path where the new primary key
//                          files will be written. MUST be empty / new.
//   scrypt_n             — Optional. Tests override.
//   agent_id, cwd, user_id — Provenance.
function runRecovery(opts) {
  opts = opts || {};
  if (!opts.recovery_passphrase) return { ok: false, error: 'recovery_passphrase_required' };
  if (!opts.recovery_key_dir)    return { ok: false, error: 'recovery_key_dir_required' };
  if (!opts.new_passphrase)      return { ok: false, error: 'new_passphrase_required' };
  if (!opts.new_key_dir)         return { ok: false, error: 'new_key_dir_required' };

  // 1. Confirm a recovery directive exists.
  const directive = boot.getActiveRecoveryDirective();
  if (!directive) {
    return {
      ok: false,
      error: 'no_recovery_directive',
      detail: 'substrate has no active recovery_directive engram; pass --recovery-pubkey at init to enable recovery'
    };
  }
  // 2. Unlock the recovery signer. The recovery key files must already
  //    exist at recovery_key_dir — operator restored from offline backup.
  if (!opKey.exists({ key_dir: opts.recovery_key_dir })) {
    return {
      ok: false,
      error: 'recovery_key_files_missing',
      detail: 'no operator-key files at recovery_key_dir; restore from offline backup first'
    };
  }
  let recoverySigner;
  try {
    recoverySigner = opKey.unlock(opts.recovery_passphrase, { key_dir: opts.recovery_key_dir });
  } catch (e) {
    return { ok: false, error: 'recovery_unlock_failed', detail: e && e.message || String(e) };
  }
  // 3. Sanity check: the recovery key the operator just unlocked must
  //    match the pubkey pinned in the directive. Otherwise this is
  //    not the key the operator pre-authorized — refuse to proceed.
  if (recoverySigner.public_key_pem.trim() !== directive.recovery_public_key_pem.trim()) {
    try { recoverySigner.lock(); } catch (_) {}
    return {
      ok: false,
      error: 'recovery_key_mismatch',
      detail: 'unlocked key does not match the pubkey pinned in the active recovery_directive'
    };
  }
  // 4. Find the current operator_key:active engram (to supersede).
  const activeRows = engram.listEngrams({
    principal: null, audience: 'all', scope: boot.OPERATOR_KEY_SCOPE, limit: 1
  }) || [];
  const oldActiveId = activeRows.length ? activeRows[0].id : null;
  // 5. Generate the new primary keypair.
  let newInit;
  try {
    newInit = opKey.initKeypair(opts.new_passphrase, {
      key_dir:  opts.new_key_dir,
      scrypt_n: opts.scrypt_n
    });
  } catch (e) {
    try { recoverySigner.lock(); } catch (_) {}
    return { ok: false, error: 'new_keypair_init_failed', detail: e && e.message || String(e) };
  }
  // 6. Sign + write a new operator_key:active engram. integration point's multi-
  //    pubkey chain accepts this because the directive's pubkey is in
  //    its candidate set. supersedes retires the old op-tier key engram.
  try {
    const statement = 'operator active public key re-anchored via recovery';
    const extra_output = {
      public_key_id:  newInit.public_key_id,
      public_key_pem: newInit.public_key_pem,
      re_anchored_from: oldActiveId,
      lifetime: oldActiveId ? { supersedes: oldActiveId, reason: 'recovery_re_anchor' } : undefined
    };
    const canon = opKey.canonicalEngramBody({
      statement,
      scope: boot.OPERATOR_KEY_SCOPE,
      source_authority: 'operator_confirmed',
      extra_output
    });
    const signature = recoverySigner.sign(canon);
    const newKeyEngramId = engram.recordEngram({
      agent_id: opts.agent_id || 'recover',
      cwd:      opts.cwd || null,
      user_id:  opts.user_id || 'operator',
      statement,
      source:   'troth-recover',
      source_authority: 'operator_confirmed',
      scope:    boot.OPERATOR_KEY_SCOPE,
      signature,
      extra_output,
      auto_verify: false
    });
    if (!newKeyEngramId) {
      return { ok: false, error: 'new_key_engram_refused' };
    }
    return {
      ok: true,
      new_public_key_id:        newInit.public_key_id,
      new_operator_key_engram_id: newKeyEngramId,
      old_operator_key_engram_id: oldActiveId,
      recovery_directive_id:    directive.id
    };
  } finally {
    try { recoverySigner.lock(); } catch (_) {}
  }
}

module.exports = {
  runRecovery
};
