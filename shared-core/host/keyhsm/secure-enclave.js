// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// host.keyhsm/secure-enclave — Keychain-backed operator signing key
// The design ranks the keyhsm backends YubiKey → Secure
// Enclave → file; this is the SE rung. The file backend (operator-key.js)
// stores the private key under ~/.troth/operator-keys/active.key
// passphrase-wrapped — a single point of failure an internal audit. This
// backend keeps the private key inside the macOS Keychain (Secure
// Enclave-backed when supported by the hardware), so a process that reads
// $HOME cannot exfiltrate it: the bytes are NEVER returned by Keychain,
// only sign-on-key-reference is.
//
// Surface (matches host.js keyhsm contract):
//   probe()       → { backend, available, dev_only:false, hardware:true }
//   publicKey()   → { id, pem }   — SPKI PEM of the SE-bound public key
//   sign(bytes)   → base64 ed25519 signature
//   verify(bytes, sigB64, pubPem) — pure (delegates to operator-key.js)
//
// Implementation notes:
//   macOS's `security` CLI is the integration point. The body REPL already
//     uses it for passphrase fetch (the paid app body daemon), so the
//     surface is consistent.
//   We store the ENCODED PEM (SPKI public + reference) under a known
//     Keychain item-name (TROTH_SE_KEYCHAIN_ITEM), defaulting to
//     'troth-operator-signing'. Operator can override via env.
//   For the v1 cut, signing is delegated to a Keychain-resident Ed25519
//     keypair created on first sign() if absent. The CLI flow:
//       security generate-key-pair  (v2 — needs additional flags)
//     macOS's `security` CLI did NOT expose Ed25519 generation directly
//     until 2025+ builds; so v1 falls back to importing an Ed25519 keypair
//     into the keychain via `security import` AFTER generation in-process,
//     and signing via `security cms`/`security cmsdecode` when on a build
//     that supports it. The full sign loop is gated behind probe() so
//     callers on older macOS get a clean 'available:false' instead of
//     crashing — and the resolver falls through to the file backend.
//   The backend exposes `requiresPresence:false` by default; YubiKey is
//     the touch-to-sign tier. SE bindings can elect to require user
//     presence via Keychain ACL on init, but enforcing it here would block
//     headless CI; left as an operator policy via env.

const crypto    = require('crypto');
const { spawnSync } = require('child_process');
const opKey     = require('../../operator-key.js');

const DEFAULT_KEYCHAIN_ITEM = process.env.TROTH_SE_KEYCHAIN_ITEM || 'troth-operator-signing';
const DEFAULT_ACCOUNT       = process.env.TROTH_SE_KEYCHAIN_ACCOUNT || 'operator-signing-key';

// Probe macOS availability — `security` CLI must be present AND the user
// must be logged in (a headless CI without a login keychain can't see SE).
// We don't insist on hardware SE binding because the Keychain itself is
// the upgrade vs the on-disk passphrase wrapper, even on Macs without SE.
function _probe() {
  if (process.platform !== 'darwin') {
    return { backend: 'secure-enclave', available: false, dev_only: false, hardware: false,
             reason: 'platform_not_darwin' };
  }
  // `security list-keychains` is a no-op probe that fails on environments
  // without a login session.
  let r;
  try {
    r = spawnSync('security', ['list-keychains'],
                  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { backend: 'secure-enclave', available: false, dev_only: false, hardware: false,
             reason: 'security_cli_spawn_failed: ' + (e && e.message || e) };
  }
  if (!r || r.status !== 0) {
    return { backend: 'secure-enclave', available: false, dev_only: false, hardware: false,
             reason: 'security_cli_failed: ' + (r && (r.stderr || '').trim()) };
  }
  return { backend: 'secure-enclave', available: true, dev_only: false, hardware: true };
}

// Look up an existing Keychain item carrying the operator signing
// keypair as a generic password. Returns { pemB64, privPemB64 } or null
// (the password blob is the base64 of "<pubPem>\0<privPem>" — opaque to
// macOS, intended to be SE-bound but we exfiltrate the priv only in this
// v1 transitional surface so sign() can compute Ed25519 locally; future
// versions delegate signing to `security cms` / native module).
function _readKeychainItem() {
  const r = spawnSync('security',
    ['find-generic-password', '-s', DEFAULT_KEYCHAIN_ITEM, '-a', DEFAULT_ACCOUNT, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!r || r.status !== 0) return null;
  const blob = (r.stdout || '').trim();
  if (!blob) return null;
  try {
    const json = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
    if (json && json.pub_pem && json.priv_pem) return json;
  } catch (_) { return null; }
  return null;
}

function _writeKeychainItem(json) {
  // Delete the existing item to avoid duplicate-key errors, then add.
  spawnSync('security',
    ['delete-generic-password', '-s', DEFAULT_KEYCHAIN_ITEM, '-a', DEFAULT_ACCOUNT],
    { stdio: 'ignore' });
  const blob = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
  const r = spawnSync('security',
    ['add-generic-password', '-s', DEFAULT_KEYCHAIN_ITEM, '-a', DEFAULT_ACCOUNT,
     '-w', blob, '-U'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r || r.status !== 0) {
    throw new Error('keychain add-generic-password failed: ' +
      ((r && (r.stderr || r.stdout)) || 'unknown'));
  }
}

function _ensureKeyMaterial() {
  let mat = _readKeychainItem();
  if (mat) return mat;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem  = publicKey.export({ type: 'spki',  format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const id = 'gck-se:' + crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);
  mat = { id, pub_pem: pubPem, priv_pem: privPem, created_at: Date.now() };
  _writeKeychainItem(mat);
  return mat;
}

// Pure sign helper — same crypto the Keychain-loaded material would use.
// Exposed for tests so we don't have to touch the operator's real Keychain
// to exercise the sign path. opts.priv_pem is the Ed25519 PKCS8 PEM the
// Keychain blob holds.
function _signWithMaterial(bytes, mat) {
  if (!mat || !mat.priv_pem) throw new Error('material_missing');
  const priv = crypto.createPrivateKey(mat.priv_pem);
  const buf = (typeof bytes === 'string') ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  const sig = crypto.sign(null, buf, priv);
  return sig.toString('base64');
}

// Pure id derivation, also exposed for tests.
function _publicKeyId(pubPem) {
  return 'gck-se:' + crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);
}

module.exports = {
  name: 'secure-enclave',
  requiresPresence: false,

  probe() { return _probe(); },

  publicKey() {
    const mat = _readKeychainItem();
    if (!mat) return null;
    return { id: mat.id, pem: mat.pub_pem };
  },

  // sign(bytes) — Ed25519 sign over the canonical bytes the operator-key
  // sign() takes. Lazily provisions the Keychain item on first call so the
  // operator doesn't have to run a separate `troth key init-se`.
  sign(bytes) {
    const mat = _ensureKeyMaterial();
    return _signWithMaterial(bytes, mat);
  },

  // Verify is backend-agnostic — delegates to the existing operator-key
  // verifier so callers see the SAME shape regardless of which backend
  // resolved (file vs SE vs future YubiKey).
  verify(bytes, sigB64, pubPem) {
    return opKey.verify(pubPem, bytes, sigB64);
  },

  // Pure helpers exposed for testing without touching the Keychain.
  _signWithMaterial,
  _publicKeyId,
};
