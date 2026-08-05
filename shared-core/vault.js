// SPDX-License-Identifier: AGPL-3.0-only
// L4 vault — integration point encrypted credential store with capability-scope
// auto-attach. implementation step of the substrate-as-subject pivot.
//
// Lives ALONGSIDE shared-core/tools/credential-vault.js (legacy,
// goal_class-scoped, plaintext at rest). This module is the L4
// architecture-native variant: capability-scope tagged + integration point
// encrypted via the SAME operator-key.js primitives that protect
// engram writes (Ed25519 + scrypt + AES-GCM).
//
// Threat model + design:
//   - File at rest: ~/.troth/vault.bin is fully encrypted. Stealing
//     the file without the passphrase gets you nothing.
//   - In-memory cache: while the operator session is unlocked, the
//     decrypted entries list lives in this module's closure. Dispatchers
//     `require('./vault.js')` and call getValueForCapability() during
//     dispatch — values flow into HTTP headers / SMTP / etc. at the
//     SUBSTRATE BOUNDARY, never into LLM context.
//   - Auto-attach: dispatcher (e.g. http:do) receives the active
//     capability engram; calls vault.getValueForCapability(capability.
//     scope). If a matching entry exists, value is injected. LLM never
//     sees raw secret — only the existence of authorization.
//   - Lock: operator runs `troth vault lock` or session expires
//     (default 8h) and the in-memory cache is zeroed.
//   - When locked: getValueForCapability returns null. Dispatchers that
//     require credentials surface "credential_unavailable" observations,
//     partner reasons about it (or escalates via operator_surface).
//
// Entry shape:
//   {
//     key:                    short label (e.g. "supabase_api_token")
//     value:                  the secret string (only ever in memory + ciphertext)
//     capability_scope_glob:  matches capability scope of dispatchers
//                             that may auto-attach this value (e.g.
//                             "capability:http:do:api.supabase.com" or
//                             "capability:http:do:*.supabase.com")
//     injection:              how the dispatcher should attach the value;
//                             default { kind: 'bearer' }. Options:
//                               {kind: 'bearer'}            → Authorization: Bearer <value>
//                               {kind: 'header', name: 'X'} → <name>: <value>
//                               {kind: 'env', name: 'X'}    → process env (shell:do)
//                               {kind: 'raw'}               → caller pulls + uses
//     description:            operator note
//     created_ts, updated_ts
//   }

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const opKey  = require('./operator-key.js');

const HOME_DIR = process.env.HOME || require('os').homedir();
const DEFAULT_VAULT_PATH = path.join(HOME_DIR, '.troth', 'vault.bin');

const SCRYPT_N_DEFAULT = 1 << 17;
const SCRYPT_N_MIN     = 1 << 10;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN     = 32;
const SCRYPT_SALT_BYTES = 16;
const GCM_IV_BYTES      = 12;
const DEFAULT_SESSION_MS = 8 * 60 * 60 * 1000;   // 8h, same as presence default

// In-memory session state. Lives for the lifetime of the process OR
// until lock() is called OR until session_expires_at passes.
let _session = null;
// Shape when unlocked:
//   {
//     entries:        [...],
//     aes_key:        Buffer (32 bytes) — held for re-encrypt on write
//     scrypt_n:       int — used for re-encrypt
//     session_expires_at: ms
//     vault_path:     resolved file path
//   }

function _vaultPath(opts) {
  return (opts && opts.vault_path) ||
         process.env.TROTH_VAULT_BIN_PATH ||
         DEFAULT_VAULT_PATH;
}

function _deriveAesKey(passphrase, salt, N) {
  const n = (typeof N === 'number' && N >= SCRYPT_N_MIN) ? N : SCRYPT_N_DEFAULT;
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, SCRYPT_KEYLEN, {
    N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024
  });
}

function _writeEncrypted(p, entries, aesKey, scryptN) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // New salt + iv per write. aesKey is constant for the session — the
  // operator passphrase didn't change. Salt+iv prevent ciphertext reuse
  // attacks across writes.
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const iv   = crypto.randomBytes(GCM_IV_BYTES);
  // Re-derive aesKey with the new salt so the file is self-decryptable
  // by anyone who knows the passphrase WITHOUT the prior aesKey.
  // (aesKey passed in is for the OLD salt; for write we mint a new pair.)
  // Caller passes passphrase via session — but session holds aes_key
  // not passphrase. We can't re-derive without the passphrase. So:
  // For v1, REUSE the session's salt+aesKey on writes. The salt is
  // stored once at first init and stays until a passphrase rotation
  // (troth vault rotate, future). This is acceptable — GCM's iv
  // randomization is the per-write defense, salt-reuse only helps an
  // attacker who already has the file AND a passphrase guess.
  // Read the existing salt from the file if present.
  const existing = _readRawIfExists(p);
  const writeSalt = existing && existing.salt ? Buffer.from(existing.salt, 'base64') : salt;
  // If we generated a fresh salt (first write), persist it.
  const writeAesKey = (existing && existing.salt) ? aesKey : aesKey;
  const cipher = crypto.createCipheriv('aes-256-gcm', writeAesKey, iv);
  const plaintext = Buffer.from(JSON.stringify({ entries, updated_ts: Date.now() }), 'utf8');
  const ctBuf = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag   = cipher.getAuthTag();
  const blob = {
    v: 1,
    kdf: 'scrypt', N: scryptN || SCRYPT_N_DEFAULT, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN,
    salt: writeSalt.toString('base64'),
    iv:   iv.toString('base64'),
    tag:  tag.toString('base64'),
    cipher: 'aes-256-gcm',
    ciphertext: ctBuf.toString('base64')
  };
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

function _readRawIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function exists(opts) {
  return fs.existsSync(_vaultPath(opts));
}

function isUnlocked() {
  if (!_session) return false;
  if (Date.now() > _session.session_expires_at) {
    lock();
    return false;
  }
  return true;
}

// Unlock the vault with the operator passphrase. Decrypts the file (or
// initializes an empty one if missing), caches entries + derived AES
// key in memory for the session.
function unlock(passphrase, opts) {
  opts = opts || {};
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('vault.unlock: passphrase must be a string >= 8 chars');
  }
  const p = _vaultPath(opts);
  const raw = _readRawIfExists(p);
  const scryptN = (opts.scrypt_n && opts.scrypt_n >= SCRYPT_N_MIN)
    ? opts.scrypt_n
    : (raw && raw.N) || SCRYPT_N_DEFAULT;
  let entries = [];
  let aesKey;
  if (raw && raw.ciphertext) {
    if (raw.cipher !== 'aes-256-gcm' || raw.kdf !== 'scrypt') {
      throw new Error('vault.unlock: unsupported file format (cipher=' + raw.cipher + ' kdf=' + raw.kdf + ')');
    }
    const salt = Buffer.from(raw.salt, 'base64');
    const iv   = Buffer.from(raw.iv, 'base64');
    const tag  = Buffer.from(raw.tag, 'base64');
    const ct   = Buffer.from(raw.ciphertext, 'base64');
    aesKey = _deriveAesKey(passphrase, salt, raw.N || scryptN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    let pt;
    try { pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'); }
    catch (e) { throw new Error('vault.unlock: decryption failed (wrong passphrase or corrupted vault)'); }
    const parsed = JSON.parse(pt);
    if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries;
  } else {
    // Fresh init — derive aesKey with new salt.
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
    aesKey = _deriveAesKey(passphrase, salt, scryptN);
    entries = [];
    // Persist the empty vault so the salt sticks.
    const iv  = crypto.randomBytes(GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const plaintext = Buffer.from(JSON.stringify({ entries: [], updated_ts: Date.now() }), 'utf8');
    const ctBuf = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = {
      v: 1, kdf: 'scrypt', N: scryptN, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN,
      salt: salt.toString('base64'),
      iv:   iv.toString('base64'),
      tag:  tag.toString('base64'),
      cipher: 'aes-256-gcm',
      ciphertext: ctBuf.toString('base64')
    };
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(blob), { mode: 0o600 });
  }
  const session_ms = (opts.session_ms && opts.session_ms > 0) ? opts.session_ms : DEFAULT_SESSION_MS;
  _session = {
    entries,
    aes_key:  aesKey,
    scrypt_n: scryptN,
    session_expires_at: Date.now() + session_ms,
    vault_path: p
  };
  return { ok: true, entry_count: entries.length, session_expires_at: _session.session_expires_at };
}

function lock() {
  if (_session && _session.aes_key && Buffer.isBuffer(_session.aes_key)) {
    try { _session.aes_key.fill(0); } catch (_) {}
  }
  _session = null;
}

// LLM-facing list — NEVER returns values, only metadata.
function listEntries() {
  if (!isUnlocked()) return { ok: false, error: 'vault_locked' };
  return {
    ok: true,
    entries: _session.entries.map(e => ({
      key:                   e.key,
      capability_scope_glob: e.capability_scope_glob,
      injection:             e.injection || { kind: 'bearer' },
      description:           e.description || null,
      created_ts:            e.created_ts || null,
      updated_ts:            e.updated_ts || null
    }))
  };
}

function writeEntry(opts) {
  if (!isUnlocked()) return { ok: false, error: 'vault_locked' };
  opts = opts || {};
  if (!opts.key || typeof opts.key !== 'string') return { ok: false, error: 'key_required' };
  if (!opts.value || typeof opts.value !== 'string') return { ok: false, error: 'value_required' };
  if (!opts.capability_scope_glob) return { ok: false, error: 'capability_scope_glob_required' };
  const inj = opts.injection || { kind: 'bearer' };
  if (!inj.kind || ['bearer', 'header', 'env', 'raw'].indexOf(inj.kind) < 0) {
    return { ok: false, error: 'bad_injection_kind' };
  }
  if ((inj.kind === 'header' || inj.kind === 'env') && !inj.name) {
    return { ok: false, error: 'injection_name_required_for_kind_' + inj.kind };
  }
  const now = Date.now();
  const idx = _session.entries.findIndex(e => e.key === opts.key);
  const next = {
    key:                   opts.key,
    value:                 opts.value,
    capability_scope_glob: opts.capability_scope_glob,
    injection:             inj,
    description:           opts.description || null,
    created_ts:            idx >= 0 ? _session.entries[idx].created_ts : now,
    updated_ts:            now
  };
  if (idx >= 0) _session.entries[idx] = next;
  else _session.entries.push(next);
  _writeEncrypted(_session.vault_path, _session.entries, _session.aes_key, _session.scrypt_n);
  return { ok: true, key: opts.key };
}

// Substrate-internal. Generate a random secret into the vault without
// the value ever being returned to the caller. Pattern: partner asks
// substrate to create a strong password for an account signup it's
// driving; vault stores the bytes; partner gets back ONLY the handle
// (vault key) it can use later via auto-attach. LLM never sees the
// generated bytes.
//
// charset:
//   'alnum'     [A-Za-z0-9]                   (default — broadly accepted)
//   'urlsafe'   [A-Za-z0-9_-]                 (base64url-style)
//   'hex'       [0-9a-f]
//   'printable' [A-Za-z0-9!@#$%^&*()_+-=]     (symbol-heavy passwords)
function generateInto(opts) {
  if (!isUnlocked()) return { ok: false, error: 'vault_locked' };
  opts = opts || {};
  const key     = opts.key;
  const length  = (typeof opts.length === 'number' && opts.length >= 8 && opts.length <= 256) ? Math.floor(opts.length) : 32;
  const charset = opts.charset || 'alnum';
  const capScope = opts.capability_scope_glob;
  const inj     = opts.injection || { kind: 'raw' };
  if (!key || typeof key !== 'string') return { ok: false, error: 'key_required' };
  if (!capScope) return { ok: false, error: 'capability_scope_glob_required' };
  const ALPHABETS = {
    'alnum':     'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    'urlsafe':   'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    'hex':       '0123456789abcdef',
    'printable': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-='
  };
  const alphabet = ALPHABETS[charset];
  if (!alphabet) return { ok: false, error: 'bad_charset' };
  // Rejection sampling to avoid modulo bias on the random bytes -> alphabet mapping.
  const out = Buffer.alloc(length);
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let written = 0;
  while (written < length) {
    const buf = crypto.randomBytes(length * 2);
    for (let i = 0; i < buf.length && written < length; i++) {
      const b = buf[i];
      if (b >= max) continue;
      out[written++] = alphabet.charCodeAt(b % alphabet.length);
    }
  }
  const generatedValue = out.toString('utf8');
  // Reuse writeEntry's discipline: it validates injection kind + persists
  // encrypted. We pass description noting substrate-generated provenance.
  const writeRes = writeEntry({
    key,
    value: generatedValue,
    capability_scope_glob: capScope,
    injection: inj,
    description: opts.description || 'substrate-generated (vault.generateInto)'
  });
  if (!writeRes.ok) return writeRes;
  // CRITICAL: never return generatedValue to caller. Return only the
  // handle (key) + metadata so the caller proves to substrate that the
  // secret exists and can be used via capability auto-attach later.
  return {
    ok: true,
    key,
    length,
    charset,
    capability_scope_glob: capScope,
    injection: inj
  };
}

function removeEntry(key) {
  if (!isUnlocked()) return { ok: false, error: 'vault_locked' };
  const idx = _session.entries.findIndex(e => e.key === key);
  if (idx < 0) return { ok: false, error: 'not_found' };
  _session.entries.splice(idx, 1);
  _writeEncrypted(_session.vault_path, _session.entries, _session.aes_key, _session.scrypt_n);
  return { ok: true, key };
}

// Substrate-internal scope-match. Dispatcher passes the active capability's
// scope (e.g. "capability:http:do:api.supabase.com"). We find the entry
// whose capability_scope_glob covers it.
//
// Glob match: exact OR trailing-* wildcard OR '*.' prefix wildcard.
function _scopeMatches(entryGlob, capScope) {
  if (typeof entryGlob !== 'string' || typeof capScope !== 'string') return false;
  if (entryGlob === capScope) return true;
  if (entryGlob.endsWith('*')) {
    const prefix = entryGlob.slice(0, -1);
    return capScope.indexOf(prefix) === 0;
  }
  // ':*.suffix' subdomain wildcard handling for http/browser scopes.
  // E.g. entryGlob='capability:http:do:*.supabase.com'
  //      capScope ='capability:http:do:api.supabase.com'
  // Match because the capability scope's host (api.supabase.com) ends
  // with '.supabase.com' AND the glob's host portion starts with '*.'
  const eDot = entryGlob.lastIndexOf(':*.');
  if (eDot >= 0) {
    const prefix = entryGlob.slice(0, eDot + 1);   // 'capability:http:do:'
    const suffix = entryGlob.slice(eDot + 3);      // 'supabase.com'
    if (capScope.indexOf(prefix) !== 0) return false;
    const capHostAndPath = capScope.slice(prefix.length);
    const capHostOnly = capHostAndPath.split(':')[0];
    return capHostOnly === suffix || capHostOnly.endsWith('.' + suffix);
  }
  return false;
}

// Substrate-internal. Lookup a specific vault entry by its key, gated
// by capability scope. Used by browser fill_from_vault when the step
// names a specific vault key (vs http-do which auto-attaches by scope
// match without caller naming a key).
//
// Capability gate: the requesting capability's scope MUST be covered
// by the entry's capability_scope_glob. Prevents a capability holder
// from using arbitrary vault entries by name — they can only use
// entries scoped to (or broader than) their own capability.
function getValueByKey(key, requesting_capability_scope) {
  if (!isUnlocked()) return null;
  if (!key || !requesting_capability_scope) return null;
  const entry = _session.entries.find(e => e.key === key);
  if (!entry) return null;
  if (!_scopeMatches(entry.capability_scope_glob, requesting_capability_scope)) return null;
  return { value: entry.value, injection: entry.injection || { kind: 'bearer' }, key: entry.key };
}

// Substrate-internal. Returns { value, injection } OR null.
// Dispatchers call this to get the auto-attach payload.
function getValueForCapability(capability_scope) {
  if (!isUnlocked()) return null;
  if (!capability_scope) return null;
  for (const e of _session.entries) {
    if (_scopeMatches(e.capability_scope_glob, capability_scope)) {
      return { value: e.value, injection: e.injection || { kind: 'bearer' }, key: e.key };
    }
  }
  return null;
}

function status(opts) {
  return {
    exists: exists(opts),
    unlocked: isUnlocked(),
    session_expires_at: _session ? _session.session_expires_at : null,
    entry_count: _session ? _session.entries.length : null
  };
}

// controlUnlock — control-channel adapter for unlock(). The channel's Ed25519
// operator-signature verification (run BEFORE this is reached) IS the
// authorization; the operator passphrase rides in the already-verified signed
// payload. Maps unlock()'s throw-on-bad/short-passphrase into a structured
// {ok:false,error} so the channel returns a clean error rather than a crash.
// NEVER echoes the passphrase back in the result.
function controlUnlock(payload, opts) {
  const pass = payload && payload.passphrase;
  if (!pass || typeof pass !== 'string') {
    return { ok: false, error: 'control:unlock_vault requires payload.passphrase (string)' };
  }
  const o = Object.assign({}, opts);
  if (payload.session_ms && payload.session_ms > 0) o.session_ms = payload.session_ms;
  try {
    const r = unlock(pass, o);
    return { ok: true, entry_count: r.entry_count, session_expires_at: r.session_expires_at };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = {
  unlock,
  controlUnlock,
  lock,
  isUnlocked,
  exists,
  status,
  listEntries,
  writeEntry,
  generateInto,
  removeEntry,
  getValueForCapability,
  getValueByKey,
  // Test surface
  _scopeMatches,
  _vaultPath,
  DEFAULT_SESSION_MS
};
