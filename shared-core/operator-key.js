// SPDX-License-Identifier: AGPL-3.0-only
// Operator key.
//
// Closes the gap that made the authority gradient theater. Before this,
// any caller of engram.write could pass opts.source_authority='operator_
// confirmed' and the engram landed at top tier. The 4-tier ladder
// (operator_confirmed > plr_evolved > llm_inferred > regex_extracted)
// only worked if you trusted the in-process caller — which we no longer
// do, because LLM-faculty code paths share the same process.
//
// Fix: operator-tier engrams MUST carry an Ed25519 signature over their
// canonical form. The signature_verifies STVC predicate runs at write
// time and refuses unsigned/forged operator-tier writes. Tier-constrained
// supersedes (integration point) protects the override flow; this protects the
// write flow.
//
// Threat model:
//   LLM faculty in-process attempts to forge operator_confirmed →
//     refused (no valid signature)
//   Stolen public key + canonical form → verify-only, cannot sign
//   Stolen encrypted private-key file w/o passphrase → cannot decrypt
//   Live process w/ unlocked signer → in-memory key exists for session
//     (acceptable; same threat model as ssh-agent / gpg-agent)
//
// Storage layout (~/.troth/operator-keys/):
//   active.pub      — Ed25519 public key, SPKI/PEM
//   active.id       — public key id (gck-op:<16hex>)
//   active.key.enc  — Ed25519 private key (PKCS8/PEM), AES-256-GCM
//                     encrypted with scrypt-derived key from passphrase
//   active.kdf.json — { salt, iv, tag } for decryption (NOT secret)
//
// Why scrypt and not Argon2id:
//   Argon2id is the modern best practice but requires a native module
//   (no Node builtin). scrypt is built into Node's crypto module since
//   v10, memory-hard, RFC 7914, audited, used by Bitcoin/Ethereum for
//   similar passphrase-derived-key use cases. Acceptable v1.
//   Can swap to argon2 native module if/when we accept the build cost.
//
// Why AES-256-GCM:
//   Authenticated encryption — protects against bit-flipping the
//   ciphertext to coerce a different private key out. Node builtin.

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const KEY_DIR_DEFAULT = path.join(process.env.HOME || require('os').homedir(), '.troth', 'operator-keys');
const KEY_NAME        = 'active';

// scrypt cost: N=2^17 (~130MB ram, ~150ms on a 2024 laptop). Strong
// enough to make passphrase brute-force impractical without becoming
// painful at session unlock. Bump N upward when CPUs get faster.
//
// Tests / hermetic init benchmarks can pass opts.scrypt_n to dial it
// down — value is RECORDED into the per-keypair kdf.json so unlock
// always uses the same N that was used at init. Production callers
// must NOT pass scrypt_n; the default is the security parameter.
const SCRYPT_N_DEFAULT = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;     // AES-256 key
const SCRYPT_SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
// Lower bound — refuse anything weaker than 2^10 even in test mode to
// avoid an accidental production call with a zero/garbage opt smuggled
// in. 2^10 is ~1ms, fine for tests, still computationally meaningful.
const SCRYPT_N_MIN = 1 << 10;

function _keyDir(opts) {
  return (opts && opts.key_dir)
    || process.env.TROTH_OPERATOR_KEY_DIR
    || KEY_DIR_DEFAULT;
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function _paths(opts) {
  const dir = _keyDir(opts);
  return {
    dir,
    pub:  path.join(dir, KEY_NAME + '.pub'),
    id:   path.join(dir, KEY_NAME + '.id'),
    enc:  path.join(dir, KEY_NAME + '.key.enc'),
    kdf:  path.join(dir, KEY_NAME + '.kdf.json')
  };
}

function exists(opts) {
  const p = _paths(opts);
  return fs.existsSync(p.pub) && fs.existsSync(p.enc) && fs.existsSync(p.kdf) && fs.existsSync(p.id);
}

function _deriveAesKey(passphrase, salt, N) {
  const n = (typeof N === 'number' && N >= SCRYPT_N_MIN) ? N : SCRYPT_N_DEFAULT;
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, SCRYPT_KEYLEN, {
    N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024
  });
}

// Init: generate Ed25519 keypair, encrypt private key with passphrase,
// persist. Idempotent failure if key already exists (use rotate for that).
function initKeypair(passphrase, opts) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('operator-key.initKeypair: passphrase must be a string >= 8 chars');
  }
  const p = _paths(opts);
  if (exists(opts)) throw new Error('operator-key.initKeypair: key already exists at ' + p.dir + ' — refusing to overwrite');
  _ensureDir(p.dir);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem  = publicKey.export({ type: 'spki',  format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const id = 'gck-op:' + crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);

  const N = (opts && typeof opts.scrypt_n === 'number' && opts.scrypt_n >= SCRYPT_N_MIN)
    ? opts.scrypt_n : SCRYPT_N_DEFAULT;
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const iv   = crypto.randomBytes(GCM_IV_BYTES);
  const aes  = _deriveAesKey(passphrase, salt, N);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const ctBuf  = Buffer.concat([cipher.update(privPem, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();

  fs.writeFileSync(p.pub, pubPem, { mode: 0o644 });
  fs.writeFileSync(p.id,  id + '\n', { mode: 0o644 });
  fs.writeFileSync(p.enc, ctBuf, { mode: 0o600 });
  fs.writeFileSync(p.kdf, JSON.stringify({
    kdf: 'scrypt', N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'),
    cipher: 'aes-256-gcm'
  }) + '\n', { mode: 0o600 });

  return { public_key_id: id, public_key_pem: pubPem };
}

// Unlock: decrypt the private key with the passphrase and return a
// signer object. Caller keeps signer alive for session duration, calls
// signer.sign(data) per operation, signer.lock() at end. Wrong passphrase
// triggers GCM auth failure — explicit error, NOT silent garbage.
function unlock(passphrase, opts) {
  const p = _paths(opts);
  if (!exists(opts)) throw new Error('operator-key.unlock: no key at ' + p.dir + ' — run init first');
  const kdf = JSON.parse(fs.readFileSync(p.kdf, 'utf8'));
  if (kdf.kdf !== 'scrypt' || kdf.cipher !== 'aes-256-gcm') {
    throw new Error('operator-key.unlock: unsupported kdf/cipher in ' + p.kdf);
  }
  const salt = Buffer.from(kdf.salt, 'base64');
  const iv   = Buffer.from(kdf.iv,   'base64');
  const tag  = Buffer.from(kdf.tag,  'base64');
  const N    = (typeof kdf.N === 'number' && kdf.N >= SCRYPT_N_MIN) ? kdf.N : SCRYPT_N_DEFAULT;
  const ct   = fs.readFileSync(p.enc);
  const aes  = _deriveAesKey(passphrase, salt, N);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aes, iv);
  decipher.setAuthTag(tag);
  let privPem;
  try {
    privPem = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('operator-key.unlock: decryption failed (wrong passphrase or corrupted key file)');
  }
  const privateKey = crypto.createPrivateKey({ key: privPem, format: 'pem', type: 'pkcs8' });
  const publicPem  = fs.readFileSync(p.pub, 'utf8');
  const id         = fs.readFileSync(p.id,  'utf8').trim();

  let locked = false;
  return {
    public_key_id: id,
    public_key_pem: publicPem,
    sign(data) {
      if (locked) throw new Error('operator-key.signer: already locked');
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      return crypto.sign(null, buf, privateKey).toString('base64');
    },
    lock() {
      // Best-effort: drop the reference; GC reclaims. Node KeyObject does not expose
      // explicit zeroize. For higher assurance use hardware-backed keys.
      locked = true;
    }
  };
}

// Verify: pure function. Verifier needs only the public PEM + canonical
// data + signature. No session state. Used by STVC predicate.
function verify(publicKeyPem, data, signatureBase64) {
  if (!publicKeyPem || !data || !signatureBase64) return false;
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const sig = Buffer.from(String(signatureBase64), 'base64');
    return crypto.verify(null, buf, crypto.createPublicKey(publicKeyPem), sig);
  } catch (_) {
    return false;
  }
}

// Read the active public key (no passphrase needed). Used by
// signature_verifies STVC predicate when an operator_key:active engram
// is not yet shipped — bootstrap fallback to filesystem during init.
function getActivePublicKey(opts) {
  const p = _paths(opts);
  if (!fs.existsSync(p.pub) || !fs.existsSync(p.id)) return null;
  return {
    public_key_id:  fs.readFileSync(p.id,  'utf8').trim(),
    public_key_pem: fs.readFileSync(p.pub, 'utf8')
  };
}

// Canonical form for engrams. Stable JSON key ordering. Excludes the
// signature field itself (signature signs the body without itself) plus
// any transient fields a writer might attach post-sign.
function canonicalize(obj, excludeKeys) {
  const exclude = new Set(excludeKeys || ['signature', 'signed_at']);
  function _sort(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(_sort);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (exclude.has(k)) continue;
      out[k] = _sort(v[k]);
    }
    return out;
  }
  return JSON.stringify(_sort(obj));
}

// Stable canonical body for engram signing. The signature commits to
// the AUTHORITATIVE CONTENT of an engram-to-be-written: statement,
// scope, source_authority, and caller-provided extra_output. Substrate-
// derived fields (audience, memory_class, truth_score, tier, project_id)
// are NOT in the signed body because the operator cannot know them in
// advance — they're stamped by the substrate at write time.
//
// Contract: caller signs canonicalEngramBody({statement, scope,
// source_authority, extra_output}); engram.js re-canonicalizes the same
// shape from incoming args and verifies. Any tamper between sign and
// write fails verification.
function canonicalEngramBody(parts) {
  parts = parts || {};
  // Strip signature out of extra_output before canonicalizing so the
  // signature does not commit to itself.
  const xo = Object.assign({}, parts.extra_output || {});
  delete xo.signature;
  delete xo.signed_at;
  return canonicalize({
    statement:        parts.statement || null,
    scope:            parts.scope     || null,
    source_authority: parts.source_authority || 'regex_extracted',
    extra_output:     xo
  });
}

// Change the passphrase that wraps the existing Ed25519 private key.
// Same keypair, new scrypt salt + AES-GCM iv + tag derived from the
// new passphrase. Atomic: writes new ciphertext + kdf.json to.tmp
// then renames over the live files in one step (both files must
// succeed or the substrate keeps reading the OLD encrypted blob).
//
// Wrong old passphrase = AES-GCM auth fail = explicit error, no write
// happens. New passphrase must be ≥ 8 chars (same policy as init).
//
// Public key, key id, and signing identity are UNCHANGED — all existing
// operator-signed engrams continue to verify. This is a passphrase
// change, not a key rotation (which would invalidate prior signatures).
function changePassphrase(oldPassphrase, newPassphrase, opts) {
  opts = opts || {};
  if (!newPassphrase || typeof newPassphrase !== 'string' || newPassphrase.length < 8) {
    throw new Error('operator-key.changePassphrase: new passphrase must be ≥ 8 chars');
  }
  if (oldPassphrase === newPassphrase) {
    throw new Error('operator-key.changePassphrase: new passphrase identical to old');
  }
  const p = _paths(opts);
  if (!exists(opts)) {
    throw new Error('operator-key.changePassphrase: no key at ' + p.dir + ' — run init first');
  }
  // 1. Decrypt with old passphrase to recover the PKCS8 PEM. Wrong old
  // passphrase explodes here with the standard "decryption failed" error.
  const signer = unlock(oldPassphrase, opts);
  // unlock() doesn't expose the raw PEM, only signing. Re-derive via
  // the same KDF/cipher path so we get back the cleartext PKCS8.
  const kdf = JSON.parse(fs.readFileSync(p.kdf, 'utf8'));
  const saltOld = Buffer.from(kdf.salt, 'base64');
  const ivOld   = Buffer.from(kdf.iv,   'base64');
  const tagOld  = Buffer.from(kdf.tag,  'base64');
  const Nold    = (typeof kdf.N === 'number' && kdf.N >= SCRYPT_N_MIN) ? kdf.N : SCRYPT_N_DEFAULT;
  const ctOld   = fs.readFileSync(p.enc);
  const aesOld  = _deriveAesKey(oldPassphrase, saltOld, Nold);
  const decOld  = crypto.createDecipheriv('aes-256-gcm', aesOld, ivOld);
  decOld.setAuthTag(tagOld);
  const pkcs8Pem = Buffer.concat([decOld.update(ctOld), decOld.final()]).toString('utf8');

  // 2. Re-encrypt with the new passphrase. Fresh salt + iv per rewrap.
  const Nnew = (opts && typeof opts.scrypt_n === 'number' && opts.scrypt_n >= SCRYPT_N_MIN)
    ? opts.scrypt_n : SCRYPT_N_DEFAULT;
  const saltNew = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const ivNew   = crypto.randomBytes(GCM_IV_BYTES);
  const aesNew  = _deriveAesKey(newPassphrase, saltNew, Nnew);
  const cipher  = crypto.createCipheriv('aes-256-gcm', aesNew, ivNew);
  const ctNew   = Buffer.concat([cipher.update(pkcs8Pem, 'utf8'), cipher.final()]);
  const tagNew  = cipher.getAuthTag();

  // 3. Atomic two-file write. Stage to.tmp, then rename. If the second
  // rename fails we have an inconsistent state (new enc, old kdf) — fix
  // by reverse-renaming. The actual failure window is tiny (two rename
  // syscalls) but we cap it as best-effort.
  const encTmp = p.enc + '.tmp';
  const kdfTmp = p.kdf + '.tmp';
  const newKdfObj = {
    kdf: 'scrypt', N: Nnew, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN,
    salt: saltNew.toString('base64'),
    iv:   ivNew.toString('base64'),
    tag:  tagNew.toString('base64'),
    cipher: 'aes-256-gcm'
  };
  fs.writeFileSync(encTmp, ctNew, { mode: 0o600 });
  fs.writeFileSync(kdfTmp, JSON.stringify(newKdfObj) + '\n', { mode: 0o600 });
  // Stash old as a backup we can roll back to if the second rename fails.
  const encBak = p.enc + '.bak';
  const kdfBak = p.kdf + '.bak';
  fs.renameSync(p.enc, encBak);
  fs.renameSync(p.kdf, kdfBak);
  try {
    fs.renameSync(encTmp, p.enc);
    fs.renameSync(kdfTmp, p.kdf);
  } catch (e) {
    // Roll back: put the old files back, surface error.
    try { fs.renameSync(encBak, p.enc); } catch (_) {}
    try { fs.renameSync(kdfBak, p.kdf); } catch (_) {}
    try { signer.lock(); } catch (_) {}
    throw new Error('operator-key.changePassphrase: rename failed mid-write, rolled back: ' + (e && e.message || String(e)));
  }
  // The credential vault derives its own key from the same passphrase and is
  // stored separately, so a key rewrap alone leaves it openable only by the
  // OLD secret: the app would accept the new passphrase while the dashboard
  // vault page rejected it. Re-wrap it here, inside the same operation, and
  // roll the key files back if it fails so the two can never diverge.
  try {
    require('./vault.js').rekey(oldPassphrase, newPassphrase, opts);
  } catch (e) {
    try { fs.unlinkSync(p.enc); } catch (_) {}
    try { fs.unlinkSync(p.kdf); } catch (_) {}
    try { fs.renameSync(encBak, p.enc); } catch (_) {}
    try { fs.renameSync(kdfBak, p.kdf); } catch (_) {}
    try { signer.lock(); } catch (_) {}
    throw new Error('operator-key.changePassphrase: vault rewrap failed, passphrase unchanged: ' + (e && e.message || e));
  }
  // Success — drop the backups.
  try { fs.unlinkSync(encBak); } catch (_) {}
  try { fs.unlinkSync(kdfBak); } catch (_) {}
  try { signer.lock(); } catch (_) {}
  return { public_key_id: signer.public_key_id };
}

// ───────────────────────────────────────────────────────────────────────
// Session-scoped signer cache — the design work.
//
// Problem: every CLI subcommand prompts for the operator passphrase
// (17 _readPassphraseSync sites in bin/troth.js). Operator-as-sysadmin
// UX. Addendum specs: operator unlocks once → cached for session
// duration → subsequent operator-tier actions use the cached signer
// without re-prompting.
//
// Constraint: CLI invocations are short-lived processes. In-process
// cache won't survive across calls. So the cache lives on disk under
// the same operator-keys/ directory, mode 0600, with a TTL.
//
// Security:
//   session.bin = the PKCS8 PEM, re-encrypted with an ephemeral
//                   session key (NOT the operator's passphrase).
//   session.key = the ephemeral session key (mode 0600, never the
//                   passphrase itself; cannot be brute-forced because
//                   it's random 256-bit, not passphrase-derived).
//   session.meta = { expires_at } so we know when to refuse + wipe.
//
// Threat model: anyone with read of operator's $HOME files can also
// read the ENCRYPTED key file + intercept passphrase prompts. The
// session cache does NOT weaken that — it's equivalent to ssh-agent /
// gpg-agent behaviour. Hardware-key path remains a future option.
//
// Operator controls:
//   troth unlock [--ttl-hours N]   → unlockSession + persist
//   troth lock                     → lockSession (wipe all 3 files)
//   Any other CLI cmd                → unlockFromSession first, fall back
//                                       to passphrase prompt
//
// High-stakes seals can still demand fresh passphrase via opts.fresh.

const SESSION_DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;   // 8h, same as vault

function _sessionPaths(opts) {
  const p = _paths(opts);
  return {
    dir:  p.dir,
    bin:  path.join(p.dir, 'session.bin'),
    key:  path.join(p.dir, 'session.key'),
    meta: path.join(p.dir, 'session.meta')
  };
}

// Unlock with passphrase + persist a session cache so subsequent CLI
// calls can re-acquire the signer without re-prompting until TTL.
// Returns { ok, expires_at, public_key_id }.
function unlockSession(passphrase, opts) {
  opts = opts || {};
  const ttlMs = (typeof opts.ttl_ms === 'number' && opts.ttl_ms > 0)
    ? opts.ttl_ms
    : SESSION_DEFAULT_TTL_MS;
  // Decrypt the operator key via the existing unlock path. This proves
  // the operator entered the right passphrase. We then re-export the
  // PKCS8 PEM and re-encrypt under a fresh random session key.
  const signer = unlock(passphrase, opts);
  // Recover the cleartext PKCS8 PEM via the same KDF/cipher path used
  // by unlock — unlock() doesn't expose the PEM directly because it
  // returns only the signing wrapper.
  const p = _paths(opts);
  const kdf = JSON.parse(fs.readFileSync(p.kdf, 'utf8'));
  const salt = Buffer.from(kdf.salt, 'base64');
  const iv   = Buffer.from(kdf.iv,   'base64');
  const tag  = Buffer.from(kdf.tag,  'base64');
  const N    = (typeof kdf.N === 'number' && kdf.N >= SCRYPT_N_MIN) ? kdf.N : SCRYPT_N_DEFAULT;
  const ct   = fs.readFileSync(p.enc);
  const aes  = _deriveAesKey(passphrase, salt, N);
  const dec  = crypto.createDecipheriv('aes-256-gcm', aes, iv);
  dec.setAuthTag(tag);
  const pkcs8Pem = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');

  // Generate fresh session key + iv. Re-encrypt PKCS8 under session key.
  const sessionKey = crypto.randomBytes(SCRYPT_KEYLEN);    // 32 bytes / AES-256
  const sessionIv  = crypto.randomBytes(GCM_IV_BYTES);
  const cipher     = crypto.createCipheriv('aes-256-gcm', sessionKey, sessionIv);
  const sessionCt  = Buffer.concat([cipher.update(pkcs8Pem, 'utf8'), cipher.final()]);
  const sessionTag = cipher.getAuthTag();

  const expires_at = Date.now() + ttlMs;
  const sp = _sessionPaths(opts);
  _ensureDir(sp.dir);
  fs.writeFileSync(sp.bin, JSON.stringify({
    iv:  sessionIv.toString('base64'),
    tag: sessionTag.toString('base64'),
    ct:  sessionCt.toString('base64')
  }), { mode: 0o600 });
  fs.writeFileSync(sp.key, sessionKey, { mode: 0o600 });
  fs.writeFileSync(sp.meta, JSON.stringify({
    expires_at,
    public_key_id: signer.public_key_id
  }), { mode: 0o600 });

  try { signer.lock(); } catch (_) {}
  return { ok: true, expires_at, public_key_id: signer.public_key_id };
}

// Try to load a cached signer from session files. Returns a signer
// (same shape as unlock()) OR null if no session OR session expired.
// Wipes the session files on detected expiry so the next call doesn't
// hit the same stale state.
function unlockFromSession(opts) {
  opts = opts || {};
  const sp = _sessionPaths(opts);
  if (!fs.existsSync(sp.bin) || !fs.existsSync(sp.key) || !fs.existsSync(sp.meta)) {
    return null;
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(sp.meta, 'utf8')); }
  catch (_) { return null; }
  if (!meta || typeof meta.expires_at !== 'number' || Date.now() >= meta.expires_at) {
    // Expired — wipe + return null.
    lockSession(opts);
    return null;
  }
  let sessionKey, blob;
  try {
    sessionKey = fs.readFileSync(sp.key);
    blob       = JSON.parse(fs.readFileSync(sp.bin, 'utf8'));
  } catch (_) { return null; }
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== SCRYPT_KEYLEN) return null;
  if (!blob || !blob.iv || !blob.tag || !blob.ct) return null;

  let pkcs8Pem;
  try {
    const iv  = Buffer.from(blob.iv,  'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const ct  = Buffer.from(blob.ct,  'base64');
    const dec = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
    dec.setAuthTag(tag);
    pkcs8Pem = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  } catch (_) {
    // Tampered or corrupt session — wipe + refuse.
    lockSession(opts);
    return null;
  }
  const p = _paths(opts);
  const publicPem = fs.existsSync(p.pub) ? fs.readFileSync(p.pub, 'utf8') : null;
  const id        = fs.existsSync(p.id)  ? fs.readFileSync(p.id,  'utf8').trim() : meta.public_key_id;
  if (!publicPem || !id) return null;
  const privateKey = crypto.createPrivateKey({ key: pkcs8Pem, format: 'pem', type: 'pkcs8' });

  let locked = false;
  return {
    public_key_id:  id,
    public_key_pem: publicPem,
    expires_at:     meta.expires_at,
    from_session:   true,
    sign(data) {
      if (locked) throw new Error('operator-key.signer: already locked');
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      return crypto.sign(null, buf, privateKey).toString('base64');
    },
    lock() { locked = true; }   // doesn't wipe session — that's an explicit lockSession()
  };
}

function lockSession(opts) {
  const sp = _sessionPaths(opts);
  for (const path of [sp.bin, sp.key, sp.meta]) {
    try { if (fs.existsSync(path)) fs.unlinkSync(path); } catch (_) {}
  }
  return { ok: true };
}

function sessionStatus(opts) {
  const sp = _sessionPaths(opts);
  if (!fs.existsSync(sp.meta)) return { unlocked: false };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(sp.meta, 'utf8')); }
  catch (_) { return { unlocked: false, error: 'session_meta_corrupt' }; }
  if (!meta || typeof meta.expires_at !== 'number') return { unlocked: false };
  if (Date.now() >= meta.expires_at) {
    return { unlocked: false, expired: true, expired_at: meta.expires_at };
  }
  return {
    unlocked: true,
    public_key_id: meta.public_key_id || null,
    expires_at: meta.expires_at,
    ttl_remaining_ms: meta.expires_at - Date.now()
  };
}

module.exports = {
  initKeypair,
  changePassphrase,
  unlock,
  unlockSession,
  unlockFromSession,
  lockSession,
  sessionStatus,
  verify,
  getActivePublicKey,
  canonicalize,
  canonicalEngramBody,
  exists,
  SESSION_DEFAULT_TTL_MS,
  // Test surface
  _deriveAesKey,
  _paths,
  _sessionPaths,
  KEY_NAME
};
