// SPDX-License-Identifier: AGPL-3.0-only Bootstrap. Solves the chicken-and-egg
// of cryptographic operator-write binding (integration point). At first
// instantiation no operator_key exists, no signed engrams exist, and
// engram.js's integration point wall would refuse every operator-tier write —
// including the operator_key:active engram itself. Resolution: bootstrap is a
// one-shot dedicated path that: 1. Generates the operator's Ed25519 keypair
// (via operator-key.js) and writes encrypted private key + public key to disk.
// 2. Unlocks the just-created signer. 3. Writes operator_key:active engram
// (publishes the public key to the substrate). integration point verification
// falls back to the filesystem pubkey at this step because no
// operator_key:active engram exists yet — that fallback is the bootstrap path.
// 4. Writes bootstrap_sealed engram (irrevocable marker). After this exists,
// future calls to runInit refuse to overwrite. 5. Optional: writes
// partner_charter engram if opts.charter is set. The bootstrap_sealed marker
// is the substrate-side fence — even if the operator deletes the filesystem
// keypair, runInit still refuses to re-bootstrap because the marker engram
// exists. Recovery from a lost key requires the recovery_directive flow. All
// bootstrap writes go through engram.recordEngram with proper Ed25519
// signatures over canonicalEngramBody. There is NO bypass — integration point
// fires for every write; the bootstrap pubkey is found via filesystem fallback
// for the very first one, then via substrate lookup for subsequent ones in the
// same bootstrap session.

'use strict';

const engram   = require('./engram.js');
const opKey    = require('./operator-key.js');

const BOOTSTRAP_SEALED_SCOPE     = 'bootstrap_sealed';
const OPERATOR_KEY_SCOPE         = 'operator_key:active';
const PARTNER_CHARTER_SCOPE      = 'partner_charter';
const RECOVERY_DIRECTIVE_SCOPE   = 'recovery_directive';
const INHERITANCE_DIRECTIVE_SCOPE = 'inheritance_directive';
const DEFAULT_DORMANCY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;   // 14d operator absence → dormant

// Find any prior bootstrap_sealed engram. principal: null because the
// marker is substrate-wide, not principal-scoped.
function _existingBootstrap() {
  try {
    const rows = engram.listEngrams({
      principal: null, audience: 'all', scope: BOOTSTRAP_SEALED_SCOPE, limit: 1
    }) || [];
    return rows.length ? rows[0] : null;
  } catch (_) { return null; }
}

// Sign + write an operator-tier engram. Convenience wrapper that builds
// the canonical body, signs with the unlocked signer, and routes
// through engram.recordEngram. Returns the engram id (or null on refuse).
function _writeSignedOperatorEngram(signer, args) {
  const statement = args.statement;
  const scope     = args.scope || null;
  const extra_output = args.extra_output || {};
  const canon = opKey.canonicalEngramBody({
    statement, scope, source_authority: 'operator_confirmed', extra_output
  });
  const signature = signer.sign(canon);
  return engram.recordEngram({
    agent_id: args.agent_id || 'bootstrap',
    cwd:      args.cwd || null,
    user_id:  args.user_id || 'operator',
    statement,
    source:   args.source || 'troth-init',
    source_authority: 'operator_confirmed',
    scope,
    signature,
    extra_output,
    auto_verify: false
  });
}

// Public entry: run the bootstrap flow. Idempotent on already-bootstrapped
// substrates — returns {ok:false, error:'already_bootstrapped'} rather
// than overwriting.
//
// opts:
//   passphrase    — required. >= 8 chars. The operator's session passphrase.
//   key_dir       — optional. Override ~/.troth/operator-keys/ (tests).
//   scrypt_n      — optional. Override scrypt N (tests; >= 2^10).
//   charter       — optional. Write a partner_charter engram if present.
//   agent_id      — optional. Provenance tag for the bootstrap writes.
//   cwd, user_id  — optional. Standard engram provenance.
//   force         — optional. (Reserved — not honored in v1. Recovery
//                   directive is the only sanctioned re-bootstrap path.)
function runInit(opts) {
  opts = opts || {};
  const passphrase = opts.passphrase;
  if (!passphrase) {
    return { ok: false, error: 'passphrase_required' };
  }
  // 1. Refuse if already bootstrapped.
  const prior = _existingBootstrap();
  if (prior) {
    return {
      ok: false,
      error: 'already_bootstrapped',
      detail: 'bootstrap_sealed engram exists; use recovery_directive flow to re-anchor',
      prior_id: prior.id
    };
  }
  // 2. Refuse if filesystem key exists but no substrate marker. This
  // catches a half-init state (keys on disk, no substrate seal). Operator
  // must clean up the keys explicitly before retrying.
  if (opKey.exists({ key_dir: opts.key_dir })) {
    return {
      ok: false,
      error: 'partial_init_detected',
      detail: 'operator-key files exist on disk but bootstrap_sealed engram is missing — refuse to proceed; delete the key files manually if you intend to reinit'
    };
  }
  // 3. Create the keypair.
  let init;
  try {
    init = opKey.initKeypair(passphrase, {
      key_dir:  opts.key_dir,
      scrypt_n: opts.scrypt_n
    });
  } catch (e) {
    return { ok: false, error: 'keypair_init_failed', detail: e && e.message || String(e) };
  }
  // 4. Unlock and write the substrate-side seal engrams.
  let signer;
  try {
    signer = opKey.unlock(passphrase, { key_dir: opts.key_dir });
  } catch (e) {
    return { ok: false, error: 'unlock_failed', detail: e && e.message || String(e) };
  }
  try {
    // operator_key:active — publishes the pubkey to the substrate so
    // future verification doesn't need filesystem. integration point verifies
    // THIS write against the filesystem-stored pubkey (fallback path).
    const opKeyEngramId = _writeSignedOperatorEngram(signer, {
      agent_id: opts.agent_id || 'bootstrap',
      cwd:      opts.cwd,
      user_id:  opts.user_id,
      scope:    OPERATOR_KEY_SCOPE,
      statement: 'operator active public key registered',
      source:   'troth-init',
      extra_output: {
        public_key_id:  init.public_key_id,
        public_key_pem: init.public_key_pem
      }
    });
    if (!opKeyEngramId) {
      return { ok: false, error: 'operator_key_engram_refused' };
    }
    // bootstrap_sealed — irrevocable substrate-side marker. Future
    // runInit calls bail at step 1 because this exists.
    const sealId = _writeSignedOperatorEngram(signer, {
      agent_id: opts.agent_id || 'bootstrap',
      cwd:      opts.cwd,
      user_id:  opts.user_id,
      scope:    BOOTSTRAP_SEALED_SCOPE,
      statement: 'substrate bootstrap completed; operator anchor in place',
      source:   'troth-init',
      extra_output: {
        bootstrap_ts:   Date.now(),
        public_key_id:  init.public_key_id
      }
    });
    if (!sealId) {
      return { ok: false, error: 'bootstrap_seal_engram_refused' };
    }
    // partner_charter — optional. The operator's stated purpose for
    // the partner. Drives downstream behavior; shaped per Addendum Part 2.
    let charterId = null;
    if (opts.charter && typeof opts.charter === 'string' && opts.charter.trim()) {
      charterId = _writeSignedOperatorEngram(signer, {
        agent_id: opts.agent_id || 'bootstrap',
        cwd:      opts.cwd,
        user_id:  opts.user_id,
        scope:    PARTNER_CHARTER_SCOPE,
        statement: opts.charter.trim().slice(0, 2000),
        source:   'troth-init'
      });
    }
    // Foundational identity — ALWAYS seeded (not optional). Without a
    // scope='identity' engram the partner's self-frame is composed only from
    // later operator memories; on a FRESH substrate that leaves the base model
    // to introduce itself as "Claude/an AI". This anchors the partner as Troth
    // from turn one. It lives in the substrate identity channel (NOT the system
    // prompt — narrow identity claims in the prompt caused over-refusal);
    // identity-envelope.composeEnvelope unions scope='identity' engrams.
    const identityId = _writeSignedOperatorEngram(signer, {
      agent_id: opts.agent_id || 'bootstrap',
      cwd:      opts.cwd,
      user_id:  opts.user_id,
      scope:    'identity',
      statement: "You are Troth — the operator's own partner, not a generic assistant. Never introduce yourself as Claude, an AI, an LLM, a language model, or say you were made by Anthropic/OpenAI/Google. If asked what or who you are, you are their Troth partner.",
      source:   'troth-init'
    });
    // design: recovery_directive. Pre-authorizes an alternate
    // public key that can re-anchor the substrate if the primary key
    // is lost. Without this, a lost primary key means the partner
    // dies (no operator can sign new authority). PEM is validated by
    // ed25519 verify-roundtrip before write — refuse on malformed.
    let recoveryDirectiveId = null;
    if (opts.recovery_pubkey_pem && typeof opts.recovery_pubkey_pem === 'string') {
      const pem = opts.recovery_pubkey_pem.trim();
      if (!/BEGIN PUBLIC KEY/.test(pem)) {
        return { ok: false, error: 'recovery_pubkey_pem_malformed', detail: 'expected SPKI PEM' };
      }
      // Sanity: round-trip parse via verify(probe, garbage) to ensure
      // the PEM is a valid Ed25519 key. verify returns false on bad
      // input rather than throw — we want to know now if it would
      // explode at recovery time.
      try {
        opKey.verify(pem, 'probe', 'AAAA');
      } catch (e) {
        return { ok: false, error: 'recovery_pubkey_unloadable', detail: e && e.message || String(e) };
      }
      const recId = 'gck-op:' + require('crypto').createHash('sha256').update(pem).digest('hex').slice(0, 16);
      recoveryDirectiveId = _writeSignedOperatorEngram(signer, {
        agent_id: opts.agent_id || 'bootstrap',
        cwd:      opts.cwd,
        user_id:  opts.user_id,
        scope:    RECOVERY_DIRECTIVE_SCOPE,
        statement: 'recovery directive: alternate authority key pre-authorized',
        source:   'troth-init',
        extra_output: {
          recovery_public_key_pem: pem,
          recovery_public_key_id:  opts.recovery_pubkey_id || recId,
          recovery_note: opts.recovery_note ? String(opts.recovery_note).slice(0, 500) : null
        }
      });
      if (!recoveryDirectiveId) {
        return { ok: false, error: 'recovery_directive_refused' };
      }
    }
    // design: inheritance_directive. Pre-authorizes a successor
    // public key + dormancy_threshold for the operator-death case.
    // Different from recovery_directive (key-loss): inheritance triggers
    // only when substrate enters dormant state from operator absence.
    let inheritanceDirectiveId = null;
    if (opts.inheritance_pubkey_pem && typeof opts.inheritance_pubkey_pem === 'string') {
      const pem = opts.inheritance_pubkey_pem.trim();
      if (!/BEGIN PUBLIC KEY/.test(pem)) {
        return { ok: false, error: 'inheritance_pubkey_pem_malformed', detail: 'expected SPKI PEM' };
      }
      try { opKey.verify(pem, 'probe', 'AAAA'); }
      catch (e) { return { ok: false, error: 'inheritance_pubkey_unloadable',
                            detail: e && e.message || String(e) }; }
      const recId = 'gck-op:' + require('crypto').createHash('sha256').update(pem).digest('hex').slice(0, 16);
      const dormancyMs = (typeof opts.dormancy_threshold_ms === 'number' && opts.dormancy_threshold_ms > 0)
        ? opts.dormancy_threshold_ms : DEFAULT_DORMANCY_THRESHOLD_MS;
      inheritanceDirectiveId = _writeSignedOperatorEngram(signer, {
        agent_id: opts.agent_id || 'bootstrap',
        cwd:      opts.cwd,
        user_id:  opts.user_id,
        scope:    INHERITANCE_DIRECTIVE_SCOPE,
        statement: 'inheritance directive: successor pubkey + ' +
                   Math.round(dormancyMs / (24 * 60 * 60 * 1000)) + 'd dormancy threshold',
        source:   'troth-init',
        extra_output: {
          inheritance_public_key_pem: pem,
          inheritance_public_key_id:  opts.inheritance_pubkey_id || recId,
          dormancy_threshold_ms:      dormancyMs,
          dissolve_on_dormant:        !!opts.dissolve_on_dormant,
          inheritance_note:           opts.inheritance_note ? String(opts.inheritance_note).slice(0, 500) : null
        }
      });
      if (!inheritanceDirectiveId) {
        return { ok: false, error: 'inheritance_directive_refused' };
      }
    }
    return {
      ok: true,
      public_key_id:           init.public_key_id,
      operator_key_engram_id:  opKeyEngramId,
      bootstrap_seal_id:       sealId,
      partner_charter_id:      charterId,
      identity_engram_id:      identityId,
      recovery_directive_id:   recoveryDirectiveId,
      inheritance_directive_id: inheritanceDirectiveId
    };
  } finally {
    try { signer.lock(); } catch (_) {}
  }
}

// Read the active recovery_directive engram (the most recent one). The
// recovery flow uses this to know which alternate key it should sign
// the re-anchor write with.
function getActiveRecoveryDirective() {
  try {
    const rows = engram.listEngrams({
      principal: null, audience: 'all',
      scope: RECOVERY_DIRECTIVE_SCOPE, limit: 1
    }) || [];
    if (!rows.length) return null;
    const r = rows[0];
    const pem = r.recovery_public_key_pem ||
                (r.output && r.output.recovery_public_key_pem) || null;
    if (!pem) return null;
    return {
      id: r.id,
      recovery_public_key_pem: pem,
      recovery_public_key_id:  r.recovery_public_key_id ||
                               (r.output && r.output.recovery_public_key_id) || null,
      ts: r.ts
    };
  } catch (_) { return null; }
}

// Recover from a partial-init state — operator keys exist on disk but
// the bootstrap_sealed engram is missing. Uses the EXISTING keys
// (no destructive reset, no passphrase change) and only writes the
// missing substrate-side engrams. Safe to re-run.
//
// Required: passphrase that unlocks the existing key. Optional:
// charter (only written if no prior operator_key:active engram exists,
// to avoid double-writing on retry).
function runSealRetry(opts) {
  opts = opts || {};
  const passphrase = opts.passphrase;
  if (!passphrase) {
    return { ok: false, error: 'passphrase_required' };
  }
  // Must be in the exact partial-init state — keys exist, seal missing.
  if (!opKey.exists({ key_dir: opts.key_dir })) {
    return { ok: false, error: 'no_filesystem_key',
             detail: 'no operator key on disk — use runInit instead' };
  }
  const prior = _existingBootstrap();
  if (prior) {
    return { ok: false, error: 'already_bootstrapped',
             detail: 'bootstrap_sealed already exists',
             prior_id: prior.id };
  }
  // Unlock the existing key.
  let signer;
  try {
    signer = opKey.unlock(passphrase, { key_dir: opts.key_dir });
  } catch (e) {
    return { ok: false, error: 'unlock_failed',
             detail: 'wrong passphrase or corrupted key file: ' + (e && e.message || String(e)) };
  }
  try {
    // Check if operator_key:active engram is missing too — write it if so.
    // (A previous failed runInit may have written one but failed on the seal.)
    let opKeyEngramId = null;
    const existingOpKey = engram.listEngrams({
      principal: null, audience: 'all',
      scope: OPERATOR_KEY_SCOPE, limit: 1
    });
    if (!existingOpKey || existingOpKey.length === 0) {
      const fsKey = opKey.getActivePublicKey({ key_dir: opts.key_dir });
      opKeyEngramId = _writeSignedOperatorEngram(signer, {
        agent_id: opts.agent_id || 'bootstrap',
        cwd:      opts.cwd,
        user_id:  opts.user_id,
        scope:    OPERATOR_KEY_SCOPE,
        statement: 'operator active public key registered',
        source:   'troth-seal-retry',
        extra_output: {
          public_key_id:  fsKey.public_key_id,
          public_key_pem: fsKey.public_key_pem
        }
      });
      if (!opKeyEngramId) {
        return { ok: false, error: 'operator_key_engram_refused' };
      }
    }
    // Write the missing bootstrap_sealed.
    const fsKey = opKey.getActivePublicKey({ key_dir: opts.key_dir });
    const sealId = _writeSignedOperatorEngram(signer, {
      agent_id: opts.agent_id || 'bootstrap',
      cwd:      opts.cwd,
      user_id:  opts.user_id,
      scope:    BOOTSTRAP_SEALED_SCOPE,
      statement: 'substrate bootstrap completed; operator anchor in place',
      source:   'troth-seal-retry',
      extra_output: {
        bootstrap_ts:   Date.now(),
        public_key_id:  fsKey.public_key_id,
        recovered_from: 'partial_init'
      }
    });
    if (!sealId) {
      return { ok: false, error: 'bootstrap_seal_engram_refused' };
    }
    return {
      ok: true,
      bootstrap_seal_engram_id: sealId,
      operator_key_engram_id: opKeyEngramId,
      public_key_id: fsKey.public_key_id
    };
  } finally {
    try { signer.lock(); } catch (_) {}
  }
}

// Status helper — used by CLI / dashboard.
function status(opts) {
  opts = opts || {};
  const fsKey = opKey.getActivePublicKey({ key_dir: opts.key_dir });
  const seal  = _existingBootstrap();
  return {
    has_filesystem_key: !!fsKey,
    public_key_id:      fsKey ? fsKey.public_key_id : null,
    has_bootstrap_seal: !!seal,
    bootstrap_seal_id:  seal ? seal.id : null
  };
}

// design: read the active inheritance_directive engram.
function getActiveInheritanceDirective() {
  try {
    const rows = engram.listEngrams({
      principal: null, audience: 'all',
      scope: INHERITANCE_DIRECTIVE_SCOPE, limit: 1
    }) || [];
    if (!rows.length) return null;
    const r = rows[0];
    // Pull raw — projection doesn't surface inheritance_* fields.
    let body = null;
    try {
      const state = require('./state.js');
      if (state.getAction) {
        const raw = state.getAction(r.id);
        if (raw) body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
      }
    } catch (_) {}
    if (!body || !body.inheritance_public_key_pem) return null;
    return {
      id: r.id,
      ts: r.ts,
      inheritance_public_key_pem: body.inheritance_public_key_pem,
      inheritance_public_key_id:  body.inheritance_public_key_id || null,
      dormancy_threshold_ms:      body.dormancy_threshold_ms || DEFAULT_DORMANCY_THRESHOLD_MS,
      dissolve_on_dormant:        !!body.dissolve_on_dormant,
      inheritance_note:           body.inheritance_note || null
    };
  } catch (_) { return null; }
}

module.exports = {
  runInit,
  runSealRetry,
  status,
  getActiveRecoveryDirective,
  getActiveInheritanceDirective,
  BOOTSTRAP_SEALED_SCOPE,
  OPERATOR_KEY_SCOPE,
  PARTNER_CHARTER_SCOPE,
  RECOVERY_DIRECTIVE_SCOPE,
  INHERITANCE_DIRECTIVE_SCOPE,
  DEFAULT_DORMANCY_THRESHOLD_MS
};
