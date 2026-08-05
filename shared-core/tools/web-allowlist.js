// SPDX-License-Identifier: AGPL-3.0-only
// web-allowlist.js — operator-deliberate allowlist for the L4 web fetcher.
//
// the web-fetch design: web fetcher MUST default-deny.
// Untrusted web content is the #1 prompt-injection vector for an autonomous
// partner. The allowlist lives in its own file (not config.json's l4 key,
// not engram) so changes are explicit operator actions that survive engram
// drift and partial-config recovery.
//
// Storage: ~/.troth/web-allowlist.json — { domains: [string], updated_ts }.
// Domains can be exact ("github.com") or wildcard ("*.anthropic.com").
// Wildcards match any single-or-multi-label subdomain prefix.
//
// API:
//   listAllowed()         → array of domain patterns
//   isAllowed(url)        → boolean (parses url, matches host against patterns)
//   addDomain(pattern)    → updated array (idempotent, atomic write)
//   removeDomain(pattern) → updated array
//   resetToSeed()         → updated array (operator escape hatch)
//   path                  → resolved file path (for diagnostics)
//   SEED                  → readonly seed list

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME           = process.env.HOME || os.homedir();
const ALLOWLIST_DIR  = process.env.TROTH_CONFIG_DIR ||
                       path.join(HOME, '.troth');
const ALLOWLIST_PATH = process.env.TROTH_WEB_ALLOWLIST_PATH ||
                       path.join(ALLOWLIST_DIR, 'web-allowlist.json');

// 10-domain seed per the autonomy design. Technical / reference only —
// no social, no commerce, no entertainment. Wildcards limited to vendor doc
// subdomains so user-content subdomains don't slip in.
const SEED = Object.freeze([
  'arxiv.org',
  'github.com',
  'wikipedia.org',
  'developer.mozilla.org',
  'stackoverflow.com',
  'news.ycombinator.com',
  '*.anthropic.com',
  '*.openai.com',
  '*.deepmind.google.com',
  'docs.python.org'
]);

function _readRaw() {
  try {
    const txt = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && Array.isArray(obj.domains)) return obj;
  } catch (_) {}
  return null;
}

function _writeAtomic(obj) {
  if (!fs.existsSync(ALLOWLIST_DIR)) fs.mkdirSync(ALLOWLIST_DIR, { recursive: true });
  const tmp = ALLOWLIST_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, ALLOWLIST_PATH);
}

// First call creates the file from SEED. Subsequent calls just read.
// We materialize on first read (not at module load) so test harnesses
// pointing TROTH_WEB_ALLOWLIST_PATH at a tmp dir don't leak.
function _ensureLoaded() {
  const raw = _readRaw();
  if (raw) return raw;
  const seed = { domains: SEED.slice(), updated_ts: Date.now(), source: 'seed' };
  try { _writeAtomic(seed); } catch (_) {}
  return seed;
}

function listAllowed() {
  return _ensureLoaded().domains.slice();
}

// Match a host against a pattern. Exact match OR wildcard (*.domain) where
// the wildcard absorbs any non-empty subdomain prefix.
function _patternMatchesHost(pattern, host) {
  if (!pattern || !host) return false;
  pattern = String(pattern).toLowerCase().trim();
  host    = String(host).toLowerCase().trim();
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2); // 'anthropic.com'
    // Reject the bare suffix — '*.anthropic.com' should NOT match 'anthropic.com'.
    // Operator must list both if they want both. Conservative; mirrors RFC 6125.
    if (host === suffix) return false;
    return host.endsWith('.' + suffix);
  }
  return false;
}

function isAllowed(url) {
  if (typeof url !== 'string' || !url) return false;
  let host;
  try {
    const u = new URL(url);
    // Only https. http MitM risk is real; we don't accept it for fetcher.
    if (u.protocol !== 'https:') return false;
    host = u.hostname;
  } catch (_) { return false; }
  if (!host) return false;
  const patterns = listAllowed();
  for (const p of patterns) {
    if (_patternMatchesHost(p, host)) return true;
  }
  return false;
}

function _validatePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('web-allowlist: pattern must be a non-empty string');
  }
  pattern = pattern.trim().toLowerCase();
  // Strip scheme / path if operator pasted a full URL.
  pattern = pattern.replace(/^https?:\/\//, '').split('/')[0];
  // Strip trailing dot.
  pattern = pattern.replace(/\.$/, '');
  // Allow leading '*.' wildcard plus dotted labels. Each label: a-z0-9-.
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]{0,62}\.)+[a-z]{2,63}$/.test(pattern)) {
    throw new Error('web-allowlist: pattern must be a domain like "example.com" or "*.example.com"');
  }
  return pattern;
}

function addDomain(pattern) {
  const clean = _validatePattern(pattern);
  const cur = _ensureLoaded();
  if (cur.domains.indexOf(clean) >= 0) return cur.domains.slice();
  cur.domains.push(clean);
  cur.updated_ts = Date.now();
  cur.source = 'operator';
  _writeAtomic(cur);
  return cur.domains.slice();
}

function removeDomain(pattern) {
  const clean = _validatePattern(pattern);
  const cur = _ensureLoaded();
  const idx = cur.domains.indexOf(clean);
  if (idx < 0) return cur.domains.slice();
  cur.domains.splice(idx, 1);
  cur.updated_ts = Date.now();
  cur.source = 'operator';
  _writeAtomic(cur);
  return cur.domains.slice();
}

function resetToSeed() {
  const next = { domains: SEED.slice(), updated_ts: Date.now(), source: 'operator_reset' };
  _writeAtomic(next);
  return next.domains.slice();
}

module.exports = {
  listAllowed,
  isAllowed,
  addDomain,
  removeDomain,
  resetToSeed,
  SEED,
  path: ALLOWLIST_PATH,
  // exposed for tests
  _patternMatchesHost,
  _validatePattern
};
