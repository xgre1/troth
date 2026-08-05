// SPDX-License-Identifier: AGPL-3.0-only
// codex-token-store — file-backed persistence for ChatGPT subscription
// OAuth tokens (Step 8a — Anthropic-side reversal + OpenAI-side openness
// May 2026). Tokens are obtained via shared-core/codex-auth.js (PKCE
// flow against auth.openai.com) and consumed by
// shared-core/transports/codex-oauth.js (POSTs to chatgpt.com/backend-api
// with Bearer + chatgpt-account-id headers).
//
// Storage: ~/.troth/codex-token.json, mode 0600 (same permissions as
// config.json). Plaintext on disk — keychain integration is a future
// step; for now matches how the rust voice app handles its
// anthropic_api_key when keychain is unavailable. The file is in the
// troth config dir so a single `rm ~/.troth/codex-token.json` revokes.
//
// Token shape (what we persist):
//   {
//     access_token:  string,
//     refresh_token: string,
//     expires_at:    number (ms epoch — absolute, not relative),
//     account_id:    string|null (chatgpt_account_id from JWT claim),
//     id_token:      string|null (raw OIDC id_token if returned),
//     obtained_at:   number (ms epoch — when we received this),
//     scope:         string  (echoed from OAuth response)
//   }
//
// Why expires_at as absolute ms (not seconds-from-now): clock drift across
// process restarts. The OAuth response gives `expires_in` (seconds); we
// convert at save time and store the wall-clock deadline so isExpired()
// is a single Date.now() comparison, not a relative-to-when math game.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TOKEN_PATH = path.join(os.homedir(), '.troth', 'codex-token.json');
const DEFAULT_REFRESH_SKEW_MS = 60 * 1000;  // refresh 1 minute before expiry

function tokenPath() { return TOKEN_PATH; }

// Returns the token object on success, null when no file or unparseable.
// Never throws — callers treat null as "not signed in" and trigger the
// OAuth flow. Permission errors are surfaced via the returned null
// (logged to stderr so silent install issues are visible).
function load() {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
    const tok = JSON.parse(raw);
    if (!tok || !tok.access_token || !tok.refresh_token) return null;
    return tok;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { process.stderr.write('codex-token-store: load failed (' + e.code + ')\n'); } catch (_) {}
    }
    return null;
  }
}

// Persist a token object. Creates ~/.troth if missing, writes 0600.
// Throws on failure — caller decides whether the OAuth flow rolls back.
function save(tok) {
  if (!tok || !tok.access_token || !tok.refresh_token) {
    throw new Error('codex-token-store: refusing to save token without access_token + refresh_token');
  }
  const dir = path.dirname(TOKEN_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 2) + '\n');
  fs.chmodSync(TOKEN_PATH, 0o600);
}

// Remove the token file. Idempotent — silent if already gone. Used by
// `troth codex logout` and by the auth flow on rotate-failure.
function clear() {
  try { fs.unlinkSync(TOKEN_PATH); }
  catch (e) { if (e && e.code !== 'ENOENT') throw e; }
}

// True when access_token is past its expiry (or within `skewMs` of it,
// so the caller can refresh BEFORE the token actually dies). Tokens
// without expires_at are treated as expired — forces a refresh on the
// first call after an upgrade from a buggy save that omitted the field.
function isExpired(tok, skewMs) {
  if (!tok || typeof tok.expires_at !== 'number') return true;
  const skew = typeof skewMs === 'number' ? skewMs : DEFAULT_REFRESH_SKEW_MS;
  return Date.now() + skew >= tok.expires_at;
}

// Build a token object from an OAuth response payload. The OAuth server
// returns `expires_in` (seconds-from-now); we convert to absolute ms
// here so isExpired() doesn't need to remember when the response was
// received. account_id + id_token are optional — present only when the
// scope includes openid (which this flow requires).
function fromOAuthResponse(payload, jwtClaim) {
  if (!payload || !payload.access_token) {
    throw new Error('codex-token-store: malformed OAuth response (missing access_token)');
  }
  const now = Date.now();
  const expiresInSec = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  return {
    access_token:  String(payload.access_token),
    refresh_token: String(payload.refresh_token || ''),
    expires_at:    now + expiresInSec * 1000,
    account_id:    (jwtClaim && jwtClaim.chatgpt_account_id) || null,
    id_token:      payload.id_token ? String(payload.id_token) : null,
    obtained_at:   now,
    scope:         String(payload.scope || '')
  };
}

module.exports = {
  load,
  save,
  clear,
  isExpired,
  fromOAuthResponse,
  tokenPath,
  DEFAULT_REFRESH_SKEW_MS
};
