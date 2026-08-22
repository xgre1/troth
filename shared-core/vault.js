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
//   - Drop-box: the vault can RECEIVE while locked. seal() encrypts a
//     draft entry to an X25519 public key kept in plaintext next to the
//     vault file and appends it to vault-drops.jsonl; the matching
//     private key lives INSIDE the encrypted vault, so revealing still
//     takes the passphrase. Drops become real entries on the next unlock.
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

// Drop-box: reserved namespace for substrate-internal entries. writeEntry
// refuses these keys and list/get/remove never surface them, so a user
// entry cannot collide with (or read out) the drop-box private key.
const RESERVED_KEY_PREFIX = '__troth_';
const DROPBOX_ENTRY_KEY   = '__troth_dropbox_x25519__';
// Sentinel glob for reserved entries. No wildcard, never equal to a real
// capability scope, so scope matching skips them by shape as well as by
// the explicit reserved-key checks.
const RESERVED_SCOPE      = '__reserved__';
const DROPBOX_HKDF_INFO   = 'troth-vault-dropbox-v1';

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

// Drop-box files live NEXT TO the vault file, so per-test vault_path
// overrides keep everything hermetic without extra knobs.
function _dropboxPubPath(opts) {
  return path.join(path.dirname(_vaultPath(opts)), 'vault-dropbox.pub');
}
function _dropsPath(opts) {
  return path.join(path.dirname(_vaultPath(opts)), 'vault-drops.jsonl');
}

function _isReservedKey(key) {
  return typeof key === 'string' && key.indexOf(RESERVED_KEY_PREFIX) === 0;
}

// Every LLM-adjacent surface (list, count, lookup) sees only these.
function _visibleEntries() {
  return _session.entries.filter(e => !_isReservedKey(e.key));
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
  // A session key outlives the file it was derived from: another process
  // (or a passphrase change) can re-wrap the vault under a new salt while
  // this session still holds the old key. Writing then would encrypt with
  // the old key under the new salt and leave a file NEITHER passphrase can
  // open, so prove the held key still opens the current file first.
  if (existing && existing.ciphertext) {
    try {
      const check = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(existing.iv, 'base64'));
      check.setAuthTag(Buffer.from(existing.tag, 'base64'));
      Buffer.concat([check.update(Buffer.from(existing.ciphertext, 'base64')), check.final()]);
    } catch (_) {
      throw new Error('vault: stale session key — the vault was re-keyed elsewhere; unlock again before writing');
    }
  }
  // If we generated a fresh salt (first write), persist it.
  const writeAesKey = aesKey;
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
  // Mint the drop-box keypair on the first unlock after it shipped, then
  // fold in anything sealed while the vault sat locked. Failure here must
  // not cost the operator their unlock; it only postpones the drops.
  let drained = { drained: 0, failed: 0 };
  try { drained = _ensureDropbox(opts); }
  catch (e) {
    try { console.error('[vault] drop-box init failed: ' + (e && e.message || e)); } catch (_) {}
  }
  return {
    ok: true,
    entry_count: _visibleEntries().length,
    drops_drained: drained.drained,
    drops_failed: drained.failed,
    session_expires_at: _session.session_expires_at
  };
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
    entries: _visibleEntries().map(e => ({
      key:                   e.key,
      capability_scope_glob: e.capability_scope_glob,
      injection:             e.injection || { kind: 'bearer' },
      description:           e.description || null,
      created_ts:            e.created_ts || null,
      updated_ts:            e.updated_ts || null,
      last_used_ts:          e.last_used_ts || null,
      use_count:             e.use_count || 0
    }))
  };
}

function writeEntry(opts) {
  if (!isUnlocked()) return { ok: false, error: 'vault_locked' };
  opts = opts || {};
  if (!opts.key || typeof opts.key !== 'string') return { ok: false, error: 'key_required' };
  if (_isReservedKey(opts.key)) return { ok: false, error: 'key_reserved' };
  if (!opts.value || typeof opts.value !== 'string') return { ok: false, error: 'value_required' };
  if (!opts.capability_scope_glob || typeof opts.capability_scope_glob !== 'string') {
    return { ok: false, error: 'capability_scope_glob_required' };
  }
  const globErr = _scopeGlobRejection(opts.capability_scope_glob);
  if (globErr) return { ok: false, error: globErr };
  const inj = opts.injection || { kind: 'bearer' };
  if (!inj.kind || ['bearer', 'header', 'env', 'raw'].indexOf(inj.kind) < 0) {
    return { ok: false, error: 'bad_injection_kind' };
  }
  if ((inj.kind === 'header' || inj.kind === 'env') && !inj.name) {
    return { ok: false, error: 'injection_name_required_for_kind_' + inj.kind };
  }
  const now = Date.now();
  const idx = _session.entries.findIndex(e => e.key === opts.key);
  // Replacing is destructive (the old value is unrecoverable), so it takes
  // an explicit overwrite: true. A colliding write without it is refused,
  // and the caller decides: update in place, or keep both under new keys.
  if (idx >= 0 && opts.overwrite !== true) return { ok: false, error: 'key_exists' };
  const next = {
    key:                   opts.key,
    value:                 opts.value,
    capability_scope_glob: opts.capability_scope_glob.trim(),
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
    description: opts.description || 'substrate-generated (vault.generateInto)',
    // Forwarded so a deliberate regeneration can replace; default refuses.
    overwrite: opts.overwrite === true
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
  // The drop-box key is not the operator's to delete; losing it would
  // orphan every drop still waiting in vault-drops.jsonl.
  if (_isReservedKey(key)) return { ok: false, error: 'key_reserved' };
  if (idx < 0) return { ok: false, error: 'not_found' };
  _session.entries.splice(idx, 1);
  _writeEncrypted(_session.vault_path, _session.entries, _session.aes_key, _session.scrypt_n);
  return { ok: true, key };
}

// Substrate-internal scope-match. Dispatcher passes the active capability's
// scope (e.g. "capability:http:do:api.supabase.com"). We find the entry
// whose capability_scope_glob covers it.
//
// Glob match: exact, OR trailing-* standing for whole trailing sections,
// OR the ':*.suffix' subdomain wildcard.
function _scopeMatches(entryGlob, capScope) {
  if (typeof entryGlob !== 'string' || typeof capScope !== 'string') return false;
  if (entryGlob === capScope) return true;
  if (entryGlob.endsWith('*')) {
    const prefix = entryGlob.slice(0, -1);
    // The wildcard may only continue from a section edge (':' or '/'),
    // never mid-token: a raw prefix compare let 'instagram*' cover
    // 'instagram.evil.com'. A glob that stops mid-token matches nothing,
    // and so does a bare '*' (empty prefix).
    const edge = prefix.slice(-1);
    if (edge !== ':' && edge !== '/') return false;
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

// Write-time breadth gate for entry globs, shared by writeEntry and seal.
// An entry whose glob covers every scope turns auto-attach into "hand
// this credential to the first request toward ANY host", so breadth is
// refused while the operator is present, not discovered at use time.
// Wildcard shapes _scopeMatches can never satisfy are refused too: a
// dead entry looks sealed but will never fill anything.
// Returns null when acceptable, an error token otherwise.
function _scopeGlobRejection(glob) {
  if (typeof glob !== 'string' || !glob.trim()) return 'scope_too_broad';
  const g = glob.trim();
  const star = g.indexOf('*');
  if (star < 0) return null;   // exact scopes match by equality; nothing to police
  const eDot = g.lastIndexOf(':*.');
  if (eDot >= 0 && star === eDot + 1 && g.indexOf('*', star + 1) < 0) {
    // ':*.<host>' subdomain form: needs family + verb before it and a
    // concrete host after it. 'capability:*.com' pins nothing.
    const fam = g.slice(0, eDot).split(':');
    const host = g.slice(eDot + 3);
    if (fam.length < 3 || !fam[1] || !fam[2] || !host) return 'scope_too_broad';
    return null;
  }
  if (g.charAt(g.length - 1) !== '*' || star !== g.length - 1) {
    // A star that is neither ':*.<host>' nor trailing can never match.
    return 'scope_glob_unmatchable';
  }
  // Trailing star: the literal prefix must pin capability family, verb,
  // and at least one concrete target token. 'capability:http:do:*' fails;
  // 'capability:http:do:api.x.com:*' passes.
  const segs = g.slice(0, -1).split(':');
  if (segs.length < 4 || !segs[1] || !segs[2]) return 'scope_too_broad';
  if (!segs.slice(3).some(s => s && s.indexOf('*') < 0)) return 'scope_too_broad';
  // Same section-edge rule the matcher enforces; a mid-token wildcard
  // ('instagram*') would be sealed and then never match anything.
  const edge = g.charAt(g.length - 2);
  if (edge !== ':' && edge !== '/') return 'scope_glob_unmatchable';
  return null;
}

// Receipts: remember inside the encrypted blob that an entry was used.
// The value never leaves the vault; the fact of its use should — it is
// what the dashboard shows as "last used" next to each key.
function _noteUse(entry) {
  entry.last_used_ts = Date.now();
  entry.use_count = (entry.use_count || 0) + 1;
  try { _writeEncrypted(_session.vault_path, _session.entries, _session.aes_key, _session.scrypt_n); } catch (_) {}
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
  // Reserved entries are substrate plumbing; no capability may name them.
  if (_isReservedKey(key)) return null;
  const entry = _session.entries.find(e => e.key === key);
  if (!entry) return null;
  if (!_scopeMatches(entry.capability_scope_glob, requesting_capability_scope)) return null;
  _noteUse(entry);
  return { value: entry.value, injection: entry.injection || { kind: 'bearer' }, key: entry.key };
}

// Substrate-internal. Dispatchers call this to get the auto-attach
// payload. Returns { value, injection, key } when exactly ONE entry
// covers the scope, null when none does, and { ambiguous: true, keys }
// when several do. Two matching entries usually means two accounts on
// the same site; guessing would sign in as the wrong one, so the caller
// gets the candidate key names (metadata, the same surface listEntries
// exposes) and must name the account instead. Values never ride along.
function getValueForCapability(capability_scope) {
  if (!isUnlocked()) return null;
  if (!capability_scope) return null;
  const matches = _visibleEntries().filter(e => _scopeMatches(e.capability_scope_glob, capability_scope));
  if (!matches.length) return null;
  if (matches.length > 1) {
    return { ambiguous: true, keys: matches.map(e => e.key) };
  }
  const e = matches[0];
  _noteUse(e);
  return { value: e.value, injection: e.injection || { kind: 'bearer' }, key: e.key };
}

function status(opts) {
  return {
    exists: exists(opts),
    unlocked: isUnlocked(),
    session_expires_at: _session ? _session.session_expires_at : null,
    entry_count: _session ? _visibleEntries().length : null,
    // Countable while locked on purpose: the dashboard tells the operator
    // "N captured logins are waiting for you to unlock".
    pending_drops: _countPendingDrops(opts)
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

// ── Drop-box: receive while locked, reveal only with the passphrase ────
//
// One passphrase-derived key used to gate viewing, adding, AND agent use,
// so a locked vault could not even accept a freshly captured login. That
// pushed operators to leave it unlocked, which made the lock decorative.
// Asymmetric crypto splits the directions: an X25519 keypair minted on
// first unlock. The public half sits in plaintext next to the vault file
// (it is not a secret); the private half is a reserved entry INSIDE the
// encrypted vault. Anyone local can seal a draft entry to the public key
// while the vault is locked; only the passphrase gets it back out.

function _countPendingDrops(opts) {
  try {
    const p = _dropsPath(opts);
    if (!fs.existsSync(p)) return 0;
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  } catch (_) { return 0; }
}

// Works WITHOUT unlock; that is the point. Takes the same draft shape as
// writeEntry (plus unlock-style path opts as a second argument) and
// applies the same refusals here, while a caller is still present to
// react, rather than failing at unlock time. Appends one JSON line to
// vault-drops.jsonl: ephemeral X25519 public key, HKDF salt, GCM iv +
// tag, ciphertext. Fresh ephemeral keypair per drop, so no shared
// secret is ever reused across drops.
function seal(draft, opts) {
  const dOpts = draft || {};
  if (!dOpts.key || typeof dOpts.key !== 'string') return { ok: false, error: 'key_required' };
  if (_isReservedKey(dOpts.key)) return { ok: false, error: 'key_reserved' };
  if (!dOpts.value || typeof dOpts.value !== 'string') return { ok: false, error: 'value_required' };
  if (!dOpts.capability_scope_glob || typeof dOpts.capability_scope_glob !== 'string') {
    return { ok: false, error: 'capability_scope_glob_required' };
  }
  const globErr = _scopeGlobRejection(dOpts.capability_scope_glob);
  if (globErr) return { ok: false, error: globErr };
  const inj = dOpts.injection || { kind: 'bearer' };
  if (!inj.kind || ['bearer', 'header', 'env', 'raw'].indexOf(inj.kind) < 0) {
    return { ok: false, error: 'bad_injection_kind' };
  }
  if ((inj.kind === 'header' || inj.kind === 'env') && !inj.name) {
    return { ok: false, error: 'injection_name_required_for_kind_' + inj.kind };
  }
  const pubPath = _dropboxPubPath(opts);
  if (!fs.existsSync(pubPath)) {
    // No keypair yet means the vault has never been unlocked since the
    // drop-box shipped. Nothing to encrypt to; refuse loudly.
    return { ok: false, error: 'dropbox_not_initialized',
             detail: 'unlock the vault once on this machine, then sealing works while locked' };
  }
  let recipient;
  try { recipient = crypto.createPublicKey(fs.readFileSync(pubPath, 'utf8')); }
  catch (_) { return { ok: false, error: 'dropbox_pubkey_unreadable' }; }
  const eph    = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const salt   = crypto.randomBytes(16);
  const aes    = Buffer.from(crypto.hkdfSync('sha256', shared, salt, DROPBOX_HKDF_INFO, 32));
  const iv     = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const plain  = Buffer.from(JSON.stringify({
    key: dOpts.key,
    value: dOpts.value,
    capability_scope_glob: dOpts.capability_scope_glob.trim(),
    injection: inj,
    description: dOpts.description || null,
    sealed_ts: Date.now()
  }), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const line = JSON.stringify({
    v: 1,
    alg: 'x25519-hkdf-sha256/aes-256-gcm',
    epk:  eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    salt: salt.toString('base64'),
    iv:   iv.toString('base64'),
    tag:  cipher.getAuthTag().toString('base64'),
    ct:   ct.toString('base64')
  });
  try { shared.fill(0); aes.fill(0); plain.fill(0); } catch (_) {}
  const p = _dropsPath(opts);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(p, line + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  return { ok: true, key: dOpts.key, pending_drops: _countPendingDrops(opts) };
}

// Runs unlocked, right after _session is populated. Mints the keypair
// once; re-publishes the public key file if it went missing; then folds
// pending drops into real entries.
function _ensureDropbox(opts) {
  let priv = _session.entries.find(e => e.key === DROPBOX_ENTRY_KEY);
  const pubPath = _dropboxPubPath(opts);
  if (!priv) {
    const kp = crypto.generateKeyPairSync('x25519');
    priv = {
      key: DROPBOX_ENTRY_KEY,
      value: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      capability_scope_glob: RESERVED_SCOPE,
      injection: { kind: 'raw' },
      description: 'drop-box private key, substrate-reserved',
      created_ts: Date.now(),
      updated_ts: Date.now()
    };
    // Written directly: writeEntry refuses reserved keys by design.
    _session.entries.push(priv);
    _writeEncrypted(_session.vault_path, _session.entries, _session.aes_key, _session.scrypt_n);
    fs.writeFileSync(pubPath, kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(), { mode: 0o644 });
    try { fs.chmodSync(pubPath, 0o644); } catch (_) {}
  } else if (!fs.existsSync(pubPath)) {
    const pub = crypto.createPublicKey(crypto.createPrivateKey(priv.value));
    fs.writeFileSync(pubPath, pub.export({ type: 'spki', format: 'pem' }).toString(), { mode: 0o644 });
    try { fs.chmodSync(pubPath, 0o644); } catch (_) {}
  }
  return _drainDrops(priv, opts);
}

// Decrypt every pending drop and write it as a real entry. One bad line
// must not block the rest, and nothing is discarded silently: a drop
// that fails to decrypt or to write moves, still ciphertext, to a
// .failed sibling and is logged (reason only, never material).
function _drainDrops(privEntry, opts) {
  const out = { drained: 0, failed: 0 };
  const p = _dropsPath(opts);
  const claim = p + '.draining';
  const failedPath = p + '.failed';
  try {
    if (fs.existsSync(p)) {
      if (fs.existsSync(claim)) {
        // A drain crashed mid-way earlier; fold the new batch into the
        // leftover claim so both are processed together.
        fs.appendFileSync(claim, fs.readFileSync(p), { mode: 0o600 });
        fs.unlinkSync(p);
      } else {
        // Claim atomically so a seal landing mid-drain appends to a
        // fresh drops file instead of racing the removal below.
        fs.renameSync(p, claim);
      }
    }
    if (!fs.existsSync(claim)) return out;
    const lines = fs.readFileSync(claim, 'utf8').split('\n').filter(Boolean);
    const privKey = crypto.createPrivateKey(privEntry.value);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const epk = crypto.createPublicKey({
          key: Buffer.from(String(d.epk || ''), 'base64'), format: 'der', type: 'spki'
        });
        const shared = crypto.diffieHellman({ privateKey: privKey, publicKey: epk });
        const aes = Buffer.from(crypto.hkdfSync('sha256', shared,
          Buffer.from(String(d.salt || ''), 'base64'), DROPBOX_HKDF_INFO, 32));
        const dec = crypto.createDecipheriv('aes-256-gcm', aes, Buffer.from(String(d.iv || ''), 'base64'));
        dec.setAuthTag(Buffer.from(String(d.tag || ''), 'base64'));
        const draft = JSON.parse(Buffer.concat(
          [dec.update(Buffer.from(String(d.ct || ''), 'base64')), dec.final()]).toString('utf8'));
        try { shared.fill(0); aes.fill(0); } catch (_) {}
        let key = draft.key;
        let w = writeEntry({
          key,
          value: draft.value,
          capability_scope_glob: draft.capability_scope_glob,
          injection: draft.injection,
          description: draft.description
        });
        // Key collision: keep BOTH accounts by suffixing. Losing either
        // one is the single wrong answer here.
        for (let n = 2; w && w.error === 'key_exists' && n < 100; n++) {
          key = draft.key + '-' + n;
          w = writeEntry({
            key,
            value: draft.value,
            capability_scope_glob: draft.capability_scope_glob,
            injection: draft.injection,
            description: draft.description
          });
        }
        if (!w || !w.ok) throw new Error((w && w.error) || 'write_failed');
        out.drained++;
      } catch (e) {
        out.failed++;
        try { fs.appendFileSync(failedPath, line + '\n', { mode: 0o600 }); } catch (_) {}
        try {
          console.error('[vault] a drop could not be revealed (' + (e && e.message || e)
            + '); its ciphertext was kept at ' + failedPath);
        } catch (_) {}
      }
    }
    fs.unlinkSync(claim);
  } catch (e) {
    try { console.error('[vault] drop drain failed: ' + (e && e.message || e)); } catch (_) {}
  }
  return out;
}

// Re-wrap the vault under a new passphrase. The vault file carries its own
// scrypt salt and is decrypted by a key derived from the passphrase alone —
// so an operator-key passphrase change leaves this file readable only by the
// OLD secret unless it is re-wrapped here. Entries are decrypted with the old
// passphrase, re-encrypted under a fresh salt+iv derived from the new one,
// and swapped in atomically; the pre-rekey file is kept alongside so a failed
// change is always recoverable.
function rekey(oldPassphrase, newPassphrase, opts) {
  opts = opts || {};
  if (!newPassphrase || typeof newPassphrase !== 'string' || newPassphrase.length < 8) {
    throw new Error('vault.rekey: new passphrase must be a string >= 8 chars');
  }
  const p = _vaultPath(opts);
  const raw = _readRawIfExists(p);
  if (!raw || !raw.ciphertext) return { ok: true, rekeyed: false, reason: 'no_vault' };
  if (raw.cipher !== 'aes-256-gcm' || raw.kdf !== 'scrypt') {
    throw new Error('vault.rekey: unsupported file format (cipher=' + raw.cipher + ' kdf=' + raw.kdf + ')');
  }
  const scryptN = raw.N || SCRYPT_N_DEFAULT;
  const oldKey = _deriveAesKey(oldPassphrase, Buffer.from(raw.salt, 'base64'), scryptN);
  let entries;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', oldKey, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(raw.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    const parsed = JSON.parse(pt);
    entries = (parsed && Array.isArray(parsed.entries)) ? parsed.entries : [];
  } catch (e) {
    throw new Error('vault.rekey: decryption failed (wrong old passphrase or corrupted vault)');
  }
  const newSalt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const newKey = _deriveAesKey(newPassphrase, newSalt, scryptN);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', newKey, iv);
  const plaintext = Buffer.from(JSON.stringify({ entries, updated_ts: Date.now() }), 'utf8');
  const ctBuf = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = {
    v: 1, kdf: 'scrypt', N: scryptN, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN,
    salt: newSalt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    cipher: 'aes-256-gcm',
    ciphertext: ctBuf.toString('base64')
  };
  const backup = p + '.pre-rekey-' + Date.now();
  fs.copyFileSync(p, backup);
  try { fs.chmodSync(backup, 0o600); } catch (_) {}
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  if (_session && _session.vault_path === p) {
    _session.aes_key = newKey;
    _session.entries = entries;
  }
  return { ok: true, rekeyed: true, entry_count: entries.length, backup };
}

module.exports = {
  unlock,
  rekey,
  controlUnlock,
  lock,
  isUnlocked,
  exists,
  status,
  listEntries,
  writeEntry,
  generateInto,
  seal,
  removeEntry,
  getValueForCapability,
  getValueByKey,
  // Test surface
  _scopeMatches,
  _scopeGlobRejection,
  _vaultPath,
  _dropboxPubPath,
  _dropsPath,
  DROPBOX_ENTRY_KEY,
  DEFAULT_SESSION_MS
};
