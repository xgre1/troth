// SPDX-License-Identifier: AGPL-3.0-only
// Signed append-only audit chain.
//
// Per Chan et al. 2024 "Visibility into AI Agents":
//   Every action_record signed with ed25519. Verification: append-only
//   chain, hash chains back. Operator can `troth audit verify` to
//   confirm no tampering.
//
// Chain construction:
//   record_hash    = sha256( canonical_json(record) )
//   chain_hash[i]  = sha256( chain_hash[i-1] + record_hash[i] )
//   chain_hash[0]  = sha256( record_hash[0] )                  (genesis)
//   signature[i]   = ed25519_sign( chain_hash[i], private_key )
//
// Any tamper:
//   - changing record body → record_hash mismatch → chain_hash mismatch
//   - removing a row       → next row's prev_chain_hash mismatch
//   - forging a signature  → ed25519 verify fails against public key
//
// Key storage:
//   - macOS preferred: Secure Enclave via keychain (NOT implemented v1
//     would need native module). v1 falls back to file at
//     ~/.troth/audit-keys/active.{pub,key} with 0600 perms on key.
//   - Linux: same file fallback.
//
// Key rotation:
//   - Each signed row carries public_key_id. New key generation creates
//     a new id. Verifier looks up the right pubkey per row.
//
// design grounding:
//   - Chan et al. 2024 "Visibility into AI Agents" (signed action log
//     pattern)
//   - Merkle tree / hash chain (Merkle 1979) — tamper detection
//   - RFC 8032 ed25519
//   - design R23: chain is append-only; verifier refuses to accept
//     a chain that mutates prior rows
//   - design R17: signature verification is STRUCTURAL — operator
//     can prove tamper to a third party without trusting the substrate

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const state  = require('./state.js');

const KEY_DIR_DEFAULT = path.join(process.env.HOME || require('os').homedir(), '.troth', 'audit-keys');
const KEY_NAME_DEFAULT = 'active';

function _keyDir(opts) {
  return (opts && opts.key_dir) || KEY_DIR_DEFAULT;
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// Generate (or load) the active ed25519 keypair. Returns
//   { public_key_id, private_key_pem, public_key_pem }
//
// Cached per (dir, name) for the process lifetime: attestation now runs on
// EVERY action_records write, and three file reads + PEM parses per engram
// write is a tax with no threat model behind it. The hit is validated with
// one existsSync so rotation-by-rename (active.* → prev.*, regenerate) is
// still seen the moment it happens — the multikey rotation flow depends on
// exactly that.
const _keyCache = new Map();
function ensureKey(opts) {
  opts = opts || {};
  const dir = _keyDir(opts);
  const name = (opts && opts.key_name) || KEY_NAME_DEFAULT;
  const privPath = path.join(dir, name + '.key');
  const pubPath  = path.join(dir, name + '.pub');
  const idPath   = path.join(dir, name + '.id');
  const cacheKey = dir + '|' + name;
  const cached = _keyCache.get(cacheKey);
  if (cached) {
    if (fs.existsSync(privPath)) return cached;
    _keyCache.delete(cacheKey);   // rotated away underneath us
  }
  _ensureDir(dir);
  const _load = () => ({
    public_key_id:   fs.readFileSync(idPath, 'utf8').trim(),
    private_key_pem: fs.readFileSync(privPath, 'utf8'),
    public_key_pem:  fs.readFileSync(pubPath,  'utf8')
  });
  if (fs.existsSync(privPath) && fs.existsSync(pubPath) && fs.existsSync(idPath)) {
    const k = _load();
    _keyCache.set(cacheKey, k);
    return k;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem  = publicKey.export({ type: 'spki',  format: 'pem' });
  const id = 'gck:' + crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);
  // wx: exclusive create. Two processes generating on a virgin key dir used
  // to race — the loser kept signing with an in-memory key whose .pub was
  // just overwritten, and every one of its rows failed verification forever.
  // Losing the race now means adopting the winner's key instead.
  try {
    fs.writeFileSync(privPath, privPem, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(pubPath,  pubPem,  { mode: 0o644 });
    fs.writeFileSync(idPath,   id,      { mode: 0o644 });
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const k = _load();
      _keyCache.set(cacheKey, k);
      return k;
    }
    throw e;
  }
  const k = { public_key_id: id, private_key_pem: privPem, public_key_pem: pubPem };
  _keyCache.set(cacheKey, k);
  return k;
}

// Enumerate every public key currently stored under the key dir and
// derive its public_key_id. Returns { [id]: pem }. Used by verifyChain
// (multi-key verifier — C7 v2) so rotated keys still verify older rows.
// New keys can rotate in: drop the old {name}.{key,pub,id} triple in
// place (or rename), generate a new active, and any chain rows signed
// under the old id are still verifiable as long as the old .pub stays.
function loadAllPublicKeys(opts) {
  const dir = _keyDir(opts);
  _ensureDir(dir);
  const out = {};
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const f of names) {
    if (!f.endsWith('.pub')) continue;
    let pem;
    try { pem = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
    const id = 'gck:' + crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
    out[id] = pem;
  }
  return out;
}

// Canonical-JSON: sort keys, deterministic output. Spec follows
// JCS (RFC 8785 informational) — sufficient for hash stability.
function canonicalJson(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function _sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function _sign(privateKeyPem, chainHashHex) {
  const sig = crypto.sign(null,
    Buffer.from(chainHashHex, 'utf8'),
    crypto.createPrivateKey(privateKeyPem));
  return sig.toString('base64');
}

function _verify(publicKeyPem, chainHashHex, signatureB64) {
  try {
    return crypto.verify(null,
      Buffer.from(chainHashHex, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64'));
  } catch (_) { return false; }
}

// Sign one record and append to the chain.
//   opts.record         — the record to attest (object); canonical-JSON-hashed
//   opts.action_id      — id of the action (engram id, tool_call id)
//   opts.kind            — kind string
//   opts.key_dir        — override
//
// attestSync is the whole body and is deliberately synchronous — it runs
// inside state.recordAction on every engram write, where an await has no
// seat. The read-head + append pair goes through
// state.appendSignedAuditRowChained (one immediate transaction) because the
// old separate read-then-append let two processes see the same head and
// fork the chain: twin prev_chain_hash rows that verifyChain reports as
// tamper. The sign itself happens inside the build callback — the chain
// hash depends on the head, and the head is only trustworthy under the
// transaction's lock.
function attestSync(opts) {
  opts = opts || {};
  if (!opts.record || typeof opts.record !== 'object') {
    return { ok: false, reason: 'record_required' };
  }
  const key = ensureKey(opts);
  const recordHash = _sha256Hex(canonicalJson(opts.record));
  let chainHash = null;
  const rowId = state.appendSignedAuditRowChained((last) => {
    const prevChainHash = last && last.chain_hash || null;
    chainHash = _sha256Hex((prevChainHash || '') + recordHash);
    return {
      action_id:       opts.action_id || null,
      kind:            opts.kind || null,
      record_hash:     recordHash,
      prev_chain_hash: prevChainHash,
      chain_hash:      chainHash,
      signature:       _sign(key.private_key_pem, chainHash),
      public_key_id:   key.public_key_id
    };
  });
  return {
    ok: !!rowId,
    row_id:         rowId,
    record_hash:    recordHash,
    chain_hash:     chainHash,
    public_key_id:  key.public_key_id
  };
}

// Kept async for existing callers (control-audit fire-and-forgets it).
async function signAndAppend(opts) {
  return attestSync(opts);
}

// Verify the entire chain. Returns
//   { ok, rows_checked, first_tamper?: { row_id, reason } }
function verifyChain(opts) {
  opts = opts || {};
  const key = ensureKey(opts);
  // Multi-key verifier (C7 v2): build a {id → pem} map of every public key
  // currently stored under the key dir. The active key is always included.
  // Rotated keys verify older rows as long as the old .pub remains on disk.
  const keysById = loadAllPublicKeys(opts);
  keysById[key.public_key_id] = key.public_key_pem;

  const rows = state.listSignedAuditChain({ limit: opts.limit || 5000 });
  if (!rows.length) return { ok: true, rows_checked: 0, empty: true };
  let prevHash = null;
  for (const r of rows) {
    // Hash-chain consistency
    if ((r.prev_chain_hash || null) !== (prevHash || null)) {
      return {
        ok: false,
        rows_checked: rows.indexOf(r),
        first_tamper: { row_id: r.id, reason: 'prev_chain_hash_mismatch',
                        expected: prevHash, got: r.prev_chain_hash }
      };
    }
    const expected = _sha256Hex((r.prev_chain_hash || '') + r.record_hash);
    if (expected !== r.chain_hash) {
      return {
        ok: false,
        rows_checked: rows.indexOf(r),
        first_tamper: { row_id: r.id, reason: 'chain_hash_mismatch',
                        expected, got: r.chain_hash }
      };
    }
    // Signature — look up the per-row pubkey by id (multi-key).
    const pem = keysById[r.public_key_id];
    if (!pem) {
      return {
        ok: false,
        rows_checked: rows.indexOf(r),
        first_tamper: { row_id: r.id, reason: 'unknown_public_key_id',
                        got: r.public_key_id, active: key.public_key_id,
                        known_ids: Object.keys(keysById) }
      };
    }
    if (!_verify(pem, r.chain_hash, r.signature)) {
      return {
        ok: false,
        rows_checked: rows.indexOf(r),
        first_tamper: { row_id: r.id, reason: 'signature_invalid' }
      };
    }
    prevHash = r.chain_hash;
  }
  return { ok: true, rows_checked: rows.length, last_chain_hash: prevHash };
}

module.exports = {
  ensureKey,
  loadAllPublicKeys,
  signAndAppend,
  attestSync,
  verifyChain,
  canonicalJson,
  // tests
  _sha256Hex,
  _sign,
  _verify,
  KEY_DIR_DEFAULT
};
