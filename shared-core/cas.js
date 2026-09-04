// SPDX-License-Identifier: AGPL-3.0-only
// cas.js — content-addressed store. Immutable blobs keyed by sha256.
//
// Atomic temp+rename write; dedup is free (same bytes -> same hash -> same
// path). The partner's "files" are CIDs in artifact engrams; this is the
// blob body behind those engrams (workspace as living image).
//
// Blobs live at ~/.troth/cas/ by default. Same operations and schema
// wherever the root is: set TROTH_DATA_DIR (or TROTH_CAS_DIR) to relocate it.
//
// API (substrate-internal): casPut / casGet / casHas / casRefcount.
// Consumed by dispatchers/cas-do.js.

'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

// Resolved at call time (not module load) so a test that sets
// TROTH_DATA_DIR before the first op still lands in its temp root.
function _dataDir() {
  return process.env.TROTH_DATA_DIR || path.join(os.homedir(), '.troth');
}
function _casDir() {
  return process.env.TROTH_CAS_DIR || path.join(_dataDir(), 'cas');
}

function _toBuffer(content, encoding) {
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content == null ? '' : String(content),
                     encoding === 'base64' ? 'base64' : 'utf8');
}

// hash arrives from tool args (LLM-controlled). Confine it to a sha256 hex
// string so a crafted value can never escape CAS_DIR via path.join.
function isValidHash(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
}

function blobPath(hash) {
  return path.join(_casDir(), hash.slice(0, 2), hash);
}

function casPut(content, encoding) {
  const buf  = _toBuffer(content, encoding);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const dest = blobPath(hash);
  if (fs.existsSync(dest)) return { hash, size: buf.length, created: false };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    // Lost a race to a concurrent writer of the same bytes — same hash, fine.
    if (fs.existsSync(dest)) return { hash, size: buf.length, created: false };
    throw e;
  }
  return { hash, size: buf.length, created: true };
}

function casGet(hash, encoding) {
  if (!isValidHash(hash)) return null;
  const p = blobPath(hash);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
}

function casHas(hash) {
  if (!isValidHash(hash)) return false;
  return fs.existsSync(blobPath(hash));
}

// Reference count = how many LIVE artifact engrams reference this CID, either
// as their own cid or in parent_cids. The dream-cycle GC deletes a
// blob once refcount hits 0 (every referencing artifact engram has expired and
// been reaped). cas-do.js encodes both the artifact's own cid and its
// parent_cids into the engram statement, so this counts via the public
// listEngrams projection without coupling to the engram output schema.
function casRefcount(hash) {
  if (!isValidHash(hash)) return 0;
  let engram;
  try { engram = require('./engram.js'); } catch (_) { return 0; }
  let rows;
  try {
    rows = engram.listEngrams({ scope: 'artifact', principal: null, audience: 'all', limit: 5000 }) || [];
  } catch (_) { return 0; }
  let n = 0;
  for (const r of rows) {
    if (r && typeof r.statement === 'string' && r.statement.indexOf(hash) >= 0) n++;
  }
  return n;
}

// Pinning surface — a cas_pin:<hash> engram (any audience) marks a blob as
// operator-pinned. casGC NEVER reaps a pinned blob, even when refcount=0.
// Use this for blobs the operator wants kept across artifact churn (golden
// fixtures, reference embeddings, etc).
function _pinnedHashes() {
  const out = new Set();
  let engram;
  try { engram = require('./engram.js'); } catch (_) { return out; }
  let rows;
  try {
    rows = engram.listEngrams({ scope: 'cas_pin', principal: null, audience: 'all', limit: 5000 }) || [];
  } catch (_) { return out; }
  for (const r of rows) {
    if (!r || typeof r.statement !== 'string') continue;
    const m = r.statement.match(/[0-9a-f]{64}/);
    if (m) out.add(m[0]);
  }
  // env override — comma-separated extra hashes (test + CI surface).
  const envPin = String(process.env.TROTH_CAS_PINNED || '');
  for (const h of envPin.split(',')) {
    const t = h.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(t)) out.add(t);
  }
  return out;
}

function casPin(hash) {
  if (!isValidHash(hash)) return { ok: false, error: 'bad_hash' };
  let engram;
  try { engram = require('./engram.js'); }
  catch (e) { return { ok: false, error: 'engram_unavailable: ' + e.message }; }
  const id = engram.recordEngram({
    agent_id: 'cas', user_id: 'operator', cwd: null,
    statement: 'cas_pin ' + hash,
    scope: 'cas_pin',
    source: 'cas.pin',
    source_authority: 'llm_inferred',
    auto_verify: false
  });
  return id ? { ok: true, id } : { ok: false, error: 'pin_write_refused' };
}

function isPinned(hash) {
  if (!isValidHash(hash)) return false;
  return _pinnedHashes().has(hash);
}

// Garbage-collect blobs whose refcount has fallen to zero. A pinned blob is
// never reaped, even at refcount=0. Returns {scanned, removed, kept, pinned,
// removed_hashes}. Safe to run repeatedly — idempotent.
function casGC(opts) {
  opts = opts || {};
  const dir = _casDir();
  const pinned = _pinnedHashes();
  if (Array.isArray(opts.extra_pinned)) {
    for (const h of opts.extra_pinned) {
      const t = String(h).toLowerCase();
      if (/^[0-9a-f]{64}$/.test(t)) pinned.add(t);
    }
  }
  let scanned = 0, removed = 0, kept = 0;
  const removed_hashes = [];
  if (!fs.existsSync(dir)) {
    return { scanned: 0, removed: 0, kept: 0, pinned: pinned.size, removed_hashes };
  }
  // Two-level layout: cas/<aa>/<full-hash>. Walk every shard dir.
  const shards = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{2}$/.test(n));
  for (const shard of shards) {
    const shardDir = path.join(dir, shard);
    let entries;
    try { entries = fs.readdirSync(shardDir); }
    catch (_) { continue; }
    for (const entry of entries) {
      if (!isValidHash(entry)) continue;
      scanned++;
      if (pinned.has(entry)) { kept++; continue; }
      const rc = casRefcount(entry);
      if (rc > 0) { kept++; continue; }
      try {
        fs.unlinkSync(path.join(shardDir, entry));
        removed++;
        removed_hashes.push(entry);
      } catch (_) {
        // Concurrent reaper raced us — count as kept (the other side handled).
        kept++;
      }
    }
    // Prune the shard dir if it's now empty — cheap housekeeping.
    try { fs.rmdirSync(shardDir); } catch (_) { /* not empty, fine */ }
  }
  return { scanned, removed, kept, pinned: pinned.size, removed_hashes };
}

module.exports = {
  casPut,
  casGet,
  casHas,
  casRefcount,
  casPin,
  isPinned,
  casGC,
  isValidHash,
  blobPath,
  _dataDir,
  _casDir
};
