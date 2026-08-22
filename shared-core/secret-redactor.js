// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// secret-redactor - STRUCTURAL outbound secret redaction (R17: hard walls over
// soft instructions). Live find: a pane received a fresh secret in a
// tool result (Supabase hand) and pasted it into the chat reply. The vault
// already guarantees the model never sees STORED credentials (injection by
// NAME); this module closes the other half: a secret that transits a tool
// result cannot reach the operator-visible reply text, no matter what the
// model decides and no matter what an injected page tells it to do.
//
// Mechanism: harvest() runs over every tool result and collects
// secret-SHAPED literals (known key prefixes, credential-named fields, URL
// userinfo passwords, PEM private-key blocks). redact() replaces any stored
// literal that appears in outbound text with a withheld marker. The store is
// module-level FIFO (process lifetime), so a secret harvested in an earlier
// turn is still masked when the model echoes it from conversation history.
//
// Deliberately NOT harvested: generic high-entropy strings (git commit
// hashes, checksums, uuids are normal to repeat in replies). Precision over
// recall here: every pattern below is a positive credential shape.
//
// Streaming caveat (documented, v1): native-loop deltas are redacted
// per-chunk, so a secret split EXACTLY across two stream chunks can transit
// the live stream; the FINAL text (what is persisted and what the UI keeps)
// is always fully redacted. The backbone has no such gap: claude's assistant
// events carry whole text blocks.

const MAX_STORE = 300;
const MIN_LEN = 8;
const MARKER = '[secret withheld - stored values never print in chat; use the vault credential NAME]';

const _fifo = [];
const _set = new Set();

// Known credential prefixes / token shapes. Word-ish boundaries; each match is
// the secret itself.
const PREFIX_RE = new RegExp(
  '(?<![A-Za-z0-9_-])' +
  '(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|' +
  'ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|' +
  'xox[bpars]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|' +
  'AIza[0-9A-Za-z_-]{35}|sbp_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{10,}|' +
  'glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|' +
  'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})', 'g');

// scheme://user:PASSWORD@host - capture group 1 is the password.
const URL_CRED_RE = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@\/]+:([^\s@\/]{4,})@/gi;

// PEM private-key blocks (the whole block is the secret).
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// credential-named fields in JSON / env / yaml-ish text. Capture group 2 is
// the value. Name must CONTAIN a credential word; value must be a single
// unbroken token of >= MIN_LEN chars.
//
// Split in two on purpose. Folding the credential-word alternation INSIDE a
// [A-Za-z0-9_.-]* quantifier let the name part overlap its own alternation:
// every offset of a long unbroken token re-scanned the whole run, so cost was
// O(n^2). A ~1.3MB tool result pinned a core at 100% for ~40min inside a
// single exec(). The pair matcher below is linear: the lookbehind refuses to
// start mid-token, and the bounded {1,128} name caps backtracking. The word
// test then runs on the short captured name, not on the whole haystack.
const FIELD_PAIR_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,128})["']?\s*[:=]\s*["']?([A-Za-z0-9+\/_.=~-]{8,})/g;
const CRED_NAME_RE = /secret|token|passwd|password|api[_-]?key|apikey|service_role|access[_-]?key|private[_-]?key|credential|client[_-]?secret/i;

// Field VALUES that are clearly not secrets even when the field name matches
// (booleans, placeholders, vault references).
const VALUE_ALLOW_RE = /^(?:true|false|null|none|redacted|placeholder|changeme|<[^>]*>|\$vault[:.].*|\$\{[^}]*\})$/i;

function _add(v) {
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (s.length < MIN_LEN || _set.has(s)) return;
  if (VALUE_ALLOW_RE.test(s)) return;
  _fifo.push(s);
  _set.add(s);
  while (_fifo.length > MAX_STORE) { _set.delete(_fifo.shift()); }
}

/** Scan one tool-result (or any inbound) text for secret-shaped literals and
 *  remember them for redaction. Cheap no-op on non-strings. */
function harvest(text) {
  if (typeof text !== 'string' || !text) return 0;
  const before = _fifo.length;
  let m;
  PREFIX_RE.lastIndex = 0;
  while ((m = PREFIX_RE.exec(text)) !== null) _add(m[0]);
  URL_CRED_RE.lastIndex = 0;
  while ((m = URL_CRED_RE.exec(text)) !== null) _add(m[1]);
  PEM_RE.lastIndex = 0;
  while ((m = PEM_RE.exec(text)) !== null) _add(m[0]);
  FIELD_PAIR_RE.lastIndex = 0;
  while ((m = FIELD_PAIR_RE.exec(text)) !== null) { if (CRED_NAME_RE.test(m[1])) _add(m[2]); }
  return _fifo.length - before;
}

/** Replace every stored secret occurring in outbound text with the marker.
 *  Longest-first so a substring secret never partially unmasks a longer one. */
function redact(text) {
  if (typeof text !== 'string' || !text || !_fifo.length) return text;
  let out = text;
  const sorted = _fifo.slice().sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    if (out.indexOf(s) !== -1) out = out.split(s).join(MARKER);
  }
  return out;
}

/** True when at least one harvested secret is being tracked. */
function active() { return _fifo.length > 0; }

// Test hook: reset the store (hermetic suites only).
function _resetForTests() { _fifo.length = 0; _set.clear(); }

module.exports = { harvest, redact, active, MARKER, _resetForTests };
