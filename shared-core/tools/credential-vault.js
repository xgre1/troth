// SPDX-License-Identifier: AGPL-3.0-only
// credential-vault.js — operator-curated credential store for the L4
// autonomous partner.
//
// subsystem. The operator_request channel (operator-request subsystem) lets the partner ASK
// for a credential when it hits a real-world identity wall. This module is
// the second half: a place the operator can store the value, scoped to the
// goal classes that may USE it, with substrate-side access discipline so
// the LLM never sees the raw value — only the existence + scope.
//
// Storage: ~/.troth/credentials.json, mode 0600. Atomic writes via
// temp-file + rename. Plaintext for v1 (operator-machine local; v2 may
// add age/SOPS encryption + a per-substrate keychain). The 0600 perm is
// the OS-level boundary the operator already trusts for SSH keys.
//
// Shape:
//   { credentials: [ {name, value, allowed_classes, allowed_goal_ids?,
//                     description?, created_ts, updated_ts} ], updated_ts }
//
// API:
//   listCredentials({class?}) → array of {name, allowed_classes, description, created_ts}
//                                (NEVER includes value — this is the LLM-facing surface)
//   getCredentialValue(name, {class?, goal_id?}) → string | null
//                                (substrate-internal; check scope; tool dispatch only)
//   setCredential({name, value, allowed_classes?, description?}) → updated array
//   removeCredential(name) → updated array
//   path → resolved file path (for diagnostics)
//
// Scope rules:
//   - allowed_classes: array. Empty/missing = any class may use.
//                      Non-empty = strict allowlist; class must match exactly.
//   - allowed_goal_ids: optional explicit whitelist of goal_ids; when set,
//                       even matching class is rejected unless goal_id is in.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME      = process.env.HOME || os.homedir();
const VAULT_DIR = process.env.TROTH_CONFIG_DIR ||
                  path.join(HOME, '.troth');
const VAULT_PATH = process.env.TROTH_VAULT_PATH ||
                   path.join(VAULT_DIR, 'credentials.json');

// Credential-name regex. Mirrors common env-var conventions
// (UPPER_CASE_WITH_UNDERSCORES) so a vault entry can be injected as an
// env var or HTTP header value without rewriting the name. Forbids
// shell metachars + spaces.
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function _readRaw() {
  try {
    const txt = fs.readFileSync(VAULT_PATH, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && Array.isArray(obj.credentials)) return obj;
  } catch (_) {}
  return null;
}

function _writeAtomic(obj) {
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
  const tmp = VAULT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  // Re-chmod in case the file already existed with looser perms.
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, VAULT_PATH);
  try { fs.chmodSync(VAULT_PATH, 0o600); } catch (_) {}
}

function _ensureLoaded() {
  const raw = _readRaw();
  if (raw) return raw;
  const empty = { credentials: [], updated_ts: Date.now() };
  try { _writeAtomic(empty); } catch (_) {}
  return empty;
}

// Substrate-internal scope check: strict — used by getCredentialValue.
// Cred with allowed_classes=['code'] requires opts.class='code' to match.
// Cred with empty allowed_classes is any-class accessible.
function _scopeMatches(cred, opts) {
  opts = opts || {};
  if (Array.isArray(cred.allowed_classes) && cred.allowed_classes.length) {
    if (!opts.class || cred.allowed_classes.indexOf(opts.class) < 0) return false;
  }
  if (Array.isArray(cred.allowed_goal_ids) && cred.allowed_goal_ids.length) {
    if (!opts.goal_id || cred.allowed_goal_ids.indexOf(opts.goal_id) < 0) return false;
  }
  return true;
}

// LLM/operator-facing list. Two modes:
//   - opts.class set → strict filter (partner sees only creds it could use).
//   - opts.class unset → admin view, returns ALL credentials (operator UI).
// Either way, value is NEVER included.
function listCredentials(opts) {
  opts = opts || {};
  const v = _ensureLoaded();
  const filtered = opts.class
    ? v.credentials.filter(c => _scopeMatches(c, opts))
    : v.credentials.slice();
  return filtered.map(c => ({
      name:            c.name,
      allowed_classes: Array.isArray(c.allowed_classes) ? c.allowed_classes.slice() : [],
      allowed_goal_ids: Array.isArray(c.allowed_goal_ids) ? c.allowed_goal_ids.slice() : null,
      description:     c.description || null,
      created_ts:      c.created_ts || null,
      updated_ts:      c.updated_ts || null
    }));
}

// Substrate-internal. Tool dispatchers (e.g. web_fetch auth injection)
// call this with the goal class + id to retrieve a value. Caller MUST
// check that the value is used at the substrate boundary (HTTP header,
// env var) and never echoed back into model context.
function getCredentialValue(name, opts) {
  opts = opts || {};
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const v = _ensureLoaded();
  const cred = v.credentials.find(c => c.name === name);
  if (!cred) return null;
  if (!_scopeMatches(cred, opts)) return null;
  return typeof cred.value === 'string' ? cred.value : null;
}

function _validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('credential-vault: name must match ' + NAME_RE.source);
  }
}

function setCredential(opts) {
  opts = opts || {};
  _validateName(opts.name);
  if (typeof opts.value !== 'string' || !opts.value.length) {
    throw new Error('credential-vault: value must be a non-empty string');
  }
  const allowed_classes = Array.isArray(opts.allowed_classes) ? opts.allowed_classes.slice() : [];
  const allowed_goal_ids = Array.isArray(opts.allowed_goal_ids) ? opts.allowed_goal_ids.slice() : null;
  const v = _ensureLoaded();
  const now = Date.now();
  const existingIdx = v.credentials.findIndex(c => c.name === opts.name);
  const next = {
    name:             opts.name,
    value:            opts.value,
    allowed_classes,
    allowed_goal_ids,
    description:      opts.description || null,
    created_ts:       existingIdx >= 0 ? (v.credentials[existingIdx].created_ts || now) : now,
    updated_ts:       now
  };
  if (existingIdx >= 0) v.credentials[existingIdx] = next;
  else v.credentials.push(next);
  v.updated_ts = now;
  _writeAtomic(v);
  return listCredentials({}); // return metadata-only view
}

function removeCredential(name) {
  _validateName(name);
  const v = _ensureLoaded();
  const idx = v.credentials.findIndex(c => c.name === name);
  if (idx < 0) return listCredentials({});
  v.credentials.splice(idx, 1);
  v.updated_ts = Date.now();
  _writeAtomic(v);
  return listCredentials({});
}

module.exports = {
  listCredentials,
  getCredentialValue,
  setCredential,
  removeCredential,
  path: VAULT_PATH,
  NAME_RE,
  // exposed for tests
  _scopeMatches
};
