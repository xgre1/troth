// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// host.keyhsm fallback backend — the passphrase-decrypted file key.
// Wraps the existing shared-core/operator-key.js WITHOUT moving its logic, so
// this is a zero-behavior-change seam: every current operator-key path keeps
// working, and consumers can migrate to host.keyhsm.* incrementally.
//
// This is the FALLBACK tier an internal audit
// failure). The hardware backends (keyhsm/yubikey.js, keyhsm/secure-enclave.js)
// are a later tier and take priority once present.
const opKey = require('../../operator-key.js');

module.exports = {
  name: 'file',
  // File key requires no per-signature physical presence (a YubiKey would set
  // requiresPresence:true → touch-to-sign).
  requiresPresence: false,

  probe() {
    let available = false;
    try { available = !!opKey.exists(); } catch (_) {}
    return { backend: 'file', available, dev_only: false, hardware: false };
  },

  // Return the active operator public key as { id, pem } (SPKI PEM), matching
  // the host.keyhsm contract. Delegates to operator-key.getActivePublicKey().
  publicKey() {
    const pub = opKey.getActivePublicKey();
    if (!pub) return null;
    // getActivePublicKey returns the stored shape; normalize to {id,pem}.
    if (pub.pem || pub.id) return { id: pub.id || null, pem: pub.pem || pub.spki || null };
    return { id: null, pem: typeof pub === 'string' ? pub : null };
  },

  // Sign bytes with the operator key. The file backend needs an unlocked
  // signer: prefer an existing unlocked session; otherwise require a
  // passphrase in opts. Returns base64 signature.
  // opts: { passphrase?, key_dir? }
  sign(bytes, opts) {
    opts = opts || {};
    let signer = null;
    try { signer = opKey.unlockFromSession ? opKey.unlockFromSession(opts) : null; } catch (_) { signer = null; }
    if (!signer) {
      if (!opts.passphrase) {
        throw new Error('host.keyhsm(file).sign: no unlocked session and no passphrase provided');
      }
      signer = opKey.unlock(opts.passphrase, opts.key_dir ? { key_dir: opts.key_dir } : undefined);
    }
    const sig = signer.sign(bytes);
    return typeof sig === 'string' ? sig : Buffer.from(sig).toString('base64');
  },

  // Verify is backend-agnostic: no private key is involved, so the same
  // implementation serves every backend. The argument order differs from
  // this seam's (bytes, sig, pubkey) shape, and until  the three
  // were forwarded positionally as-is, which made every verification here
  // meaningless.
  verify(bytes, sigB64, pubPem) { return opKey.verify(pubPem, bytes, sigB64); },
};
