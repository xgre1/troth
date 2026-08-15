// SPDX-License-Identifier: AGPL-3.0-only
// codex-auth — ChatGPT subscription OAuth flow (PKCE) for the troth
// substrate transport. A standard OAuth 2.0
// authorization-code flow with PKCE (RFC 7636) against auth.openai.com,
// for an operator signing in with their own ChatGPT account, on their
// own machine, against their own subscription.
//
// Flow:
//   1. login() generates PKCE verifier+challenge (S256) and a CSRF state.
//   2. Spawns an HTTP server on http://localhost:1455 that listens for
//      the OAuth redirect at /auth/callback.
//   3. Opens the user's browser at auth.openai.com/oauth/authorize with
//      our client_id, scope, redirect_uri, code_challenge, state, and
//      the codex_cli_simplified_flow flag (the latter is what gates
//      ChatGPT-subscription auth vs API-key auth on OpenAI's side).
//   4. User signs in to ChatGPT in the browser; OpenAI redirects to
//      localhost:1455/auth/callback?code=...&state=....
//   5. We validate state (CSRF check), POST the code to the token
//      endpoint with the PKCE verifier, get back access + refresh +
//      id_token, decode the JWT for chatgpt_account_id, persist via
//      codex-token-store.save().
//   6. Browser shows a "you can close this tab" page; CLI returns.
//
// refresh() is called by the transport when isExpired() returns true.
// Same token endpoint, refresh_token grant type. Rotated token saved.
//
// Why no @openauthjs/openauth dep (which the reference uses): zero
// new npm deps is a hard rule for shared-core/* — same reason
// transports/anthropic.js does its own SSE parser instead of pulling
// the official SDK. PKCE is ~15 lines of Node crypto; no library
// needed.

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { exec } = require('child_process');

const tokenStore = require('./codex-token-store.js');

// ── Client identity: supplied by the operator, never bundled ──────────
//
// The OAuth client id and the `originator` header both answer the same
// question to the vendor's servers: which application is asking. Neither
// answer belongs to troth. Shipping the values the vendor's own CLI sends
// would make every install introduce itself as that CLI, and would decide
// on the operator's behalf that their subscription may be spent this way.
// That is their agreement to make with the vendor, not ours to make for
// them.
//
// So this path stays off until an operator entitled to those values
// supplies them. No other provider is affected.
//
//   export TROTH_CODEX_CLIENT_ID=...
//   export TROTH_CODEX_ORIGINATOR=...   (sent only when set; the endpoint
//                                        has been observed to require it)
//
// or, because a GUI app inherits no shell environment, one line each in
//
//   ~/.troth/codex-client-id
//   ~/.troth/codex-originator
//
// Resolved per call and never memoised, so dropping the file in takes
// effect on the next sign-in without restarting the daemon.
function configDir() { return path.join((process.env.HOME || os.homedir()), '.troth'); }

function _operatorValue(envName, fileName) {
  const fromEnv = String(process.env[envName] || '').trim();
  if (fromEnv) return fromEnv;
  try { return String(fs.readFileSync(path.join(configDir(), fileName), 'utf8')).trim(); }
  catch (_) { return ''; }
}

// These two name the APPLICATION to the vendor. They are not credentials
// and not secrets: a native client authenticates with PKCE (RFC 8252
// public client), so holding the id grants nothing, and this one ships in
// cleartext inside every Codex install and a dozen public repos. Who is
// asking, and whose quota is spent, is decided by the operator's own
// browser sign-in, never by these.
//
// They were removed on 2026-07-31 on the grounds that bundling them
// decided on the operator's behalf that their subscription may be spent
// this way. The objection was to deciding for them, so the answer is to
// ask them, not to leave a working feature dark on every machine but the
// one that happens to carry two hand-written files. Consent belongs in
// the sign-in surface; the identifier belongs here, overridable by
// anyone who would rather present a different one.
const DEFAULT_CLIENT_ID  = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_ORIGINATOR = 'codex_cli_rs';

// Precedence: environment, then the ~/.troth file, then the default above.
// Either source set to the literal `none` turns the provider off, which is
// how an operator declines without editing code: an empty string cannot
// mean "off" here, because an unset variable already reads as empty.
function _resolve(envName, fileName, fallback) {
  const raw = _operatorValue(envName, fileName);
  if (raw === 'none') return '';
  return raw || fallback;
}

function clientId()   { return _resolve('TROTH_CODEX_CLIENT_ID',  'codex-client-id',  DEFAULT_CLIENT_ID); }
function originator() { return _resolve('TROTH_CODEX_ORIGINATOR', 'codex-originator', DEFAULT_ORIGINATOR); }

// Kept as the single choke point: an operator who blanks the default with
// an empty override still gets a sentence rather than a bare 401.
function requireClientId() {
  const id = clientId();
  if (id) return id;
  const e = new Error(
    'codex-auth: no OAuth client id configured. Set TROTH_CODEX_CLIENT_ID ' +
    'or write ~/.troth/codex-client-id, or use one of the API-key ' +
    'providers instead.');
  e.code = 'codex_client_id_unset';
  throw e;
}

const AUTH_URL     = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL    = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE        = 'openid profile email offline_access';
const JWT_CLAIM    = 'https://api.openai.com/auth';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min for user to sign in

// ── PKCE ──────────────────────────────────────────────────────────────

// Base64url encode without padding — RFC 7636 §4.1 requires it for the
// challenge transport. Node's Buffer doesn't have a native base64url
// before 16.x; do the strip manually for portability.
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function makeState() {
  return crypto.randomBytes(16).toString('hex');
}

// ── JWT (no signature verification — we trust the TLS connection) ─────

// The id_token comes from auth.openai.com over TLS. We only decode the
// payload to read chatgpt_account_id; we don't verify the signature
// because we never re-emit the token to anyone — it's immediately
// consumed for one header value and discarded. crypto verification
// would need OpenAI's JWKS endpoint and key rotation handling for
// zero benefit here.
function decodeJwt(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const pad = '='.repeat((4 - parts[1].length % 4) % 4);
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) { return null; }
}

// Pull chatgpt_account_id from the nested claim. Reference impl uses
// the same path: decoded[JWT_CLAIM]?.chatgpt_account_id.
function extractAccountId(idToken) {
  const decoded = decodeJwt(idToken);
  if (!decoded) return null;
  const block = decoded[JWT_CLAIM];
  if (!block || typeof block !== 'object') return null;
  return block.chatgpt_account_id || null;
}

// ── Browser open (cross-platform) ─────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start ""'
            : 'xdg-open';
  exec(cmd + ' "' + url.replace(/"/g, '\\"') + '"', (err) => {
    if (err) {
      // Don't fail the flow — print URL so user can copy manually.
      try { process.stderr.write('codex-auth: could not auto-open browser; visit:\n  ' + url + '\n'); } catch (_) {}
    }
  });
}

// ── HTTP token exchange ───────────────────────────────────────────────

function postForm(urlStr, formObj) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const body = new URLSearchParams(formObj).toString();
    const req  = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'content-type':   'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'accept':         'application/json'
      }
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error('codex-auth: token endpoint http ' + res.statusCode + ': ' + buf.slice(0, 500));
          err.code = 'token_http_' + res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('codex-auth: token response not json: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Authorization URL builder ─────────────────────────────────────────

function buildAuthorizationUrl(state, codeChallenge) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('response_type',          'code');
  u.searchParams.set('client_id',              requireClientId());
  u.searchParams.set('redirect_uri',           REDIRECT_URI);
  u.searchParams.set('scope',                  SCOPE);
  u.searchParams.set('state',                  state);
  u.searchParams.set('code_challenge',         codeChallenge);
  u.searchParams.set('code_challenge_method',  'S256');
  // OpenAI-specific flag that gates the simplified ChatGPT-subscription
  // flow (vs the API-key org-pick flow). Required per reference impl.
  u.searchParams.set('codex_cli_simplified_flow', 'true');
  return u.toString();
}

// Success page shown in the user's browser after the redirect. Plain
// HTML, no external assets, single page — closes itself after 3s.
const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>troth \u00b7 signed in</title>' +
  '<style>body{font:14px -apple-system,system-ui,sans-serif;background:#0b0b0b;color:#e6e6e6;' +
  'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
  '.card{text-align:center;padding:32px;border:1px solid #1f1f1f;border-radius:12px;' +
  'background:#101010;max-width:380px}h1{font-size:18px;margin:0 0 8px;color:#9cffb3}' +
  'p{margin:0;color:#9a9a9a;line-height:1.5}</style></head><body>' +
  '<div class="card"><h1>Signed in to ChatGPT</h1>' +
  '<p>You can close this tab and return to troth.</p></div>' +
  '<script>setTimeout(function(){window.close()},3000)</script></body></html>';
const FAILURE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>troth \u00b7 sign-in failed</title>' +
  '<style>body{font:14px -apple-system,system-ui,sans-serif;background:#0b0b0b;color:#e6e6e6;' +
  'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
  '.card{text-align:center;padding:32px;border:1px solid #4a1f1f;border-radius:12px;' +
  'background:#181010;max-width:380px}h1{font-size:18px;margin:0 0 8px;color:#ff9a9a}' +
  'p{margin:0;color:#9a9a9a;line-height:1.5}</style></head><body>' +
  '<div class="card"><h1>Sign-in failed</h1>' +
  '<p>Return to troth for the error message.</p></div></body></html>';

// ── login() — full interactive flow ───────────────────────────────────

// Returns a Promise that resolves to the saved token object on success,
// rejects on timeout / browser cancel / token exchange failure. Caller
// (CLI) is responsible for printing UX messages — this function is
// silent except for browser-open fallback stderr.
// One login at a time: a retried sign-in supersedes the attempt still
// holding :1455 (otherwise every retry inside the 5-min window dies with
// EADDRINUSE — hit in onboarding QA).
//
// BURST DEDUPE — the symptom was the same sign-in page opening three or
// four times. Several surfaces can hit this endpoint in one gesture: the
// app command, the webview's own fetch, the dashboard button — and some
// HTTP layers silently RE-SEND a POST whose connection dropped before any
// response byte arrived (this endpoint holds the response open for up to 5
// minutes, so that race is routine, not exotic). Every extra call used to
// supersede the last attempt and open ANOTHER browser tab on a fresh PKCE
// state, so only the newest tab could ever succeed. Calls arriving while
// an attempt is younger than LOGIN_JOIN_MS now JOIN that attempt — one
// tab, every caller resolved by the one callback. An OLDER pending attempt
// still gets superseded: that is a human deliberately retrying a stuck
// sign-in, and they expect a fresh tab.
const LOGIN_JOIN_MS = 15000;
let _activeLoginCancel = null;
let _activeLogin = null;   // { promise, startedAt } while an attempt is pending

function login(opts) {
  opts = opts || {};
  if (_activeLogin && (Date.now() - _activeLogin.startedAt) < LOGIN_JOIN_MS) {
    return _activeLogin.promise;
  }
  const timeoutMs = opts.timeout_ms || LOGIN_TIMEOUT_MS;
  const port      = 1455;  // hardcoded — must match REDIRECT_URI

  const { verifier, challenge } = makePkce();
  const state = makeState();
  // An unconfigured client id is an answer, not a crash: reject so every
  // caller receives it down the same path as any other failed sign-in
  // (bin/cmd-codex.js attaches only a .catch, and a synchronous throw here
  // would sail straight past it).
  let authUrl;
  try { authUrl = buildAuthorizationUrl(state, challenge); }
  catch (e) { return Promise.reject(e); }

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (_activeLoginCancel === cancelSelf) _activeLoginCancel = null;
      if (_activeLogin && _activeLogin.promise === promise) _activeLogin = null;
      try { server.close(); } catch (_) {}
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const cancelSelf = () => finish(new Error('codex-auth: superseded by a newer sign-in attempt'));
    if (_activeLoginCancel) { try { _activeLoginCancel(); } catch (_) {} }
    _activeLoginCancel = cancelSelf;

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://localhost:' + port);
      if (u.pathname !== '/auth/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      const errParam = u.searchParams.get('error');
      if (errParam) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(FAILURE_HTML);
        return finish(new Error('codex-auth: oauth error: ' + errParam + ' / ' + (u.searchParams.get('error_description') || '')));
      }
      if (!code || gotState !== state) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(FAILURE_HTML);
        return finish(new Error('codex-auth: invalid callback (state mismatch or no code)'));
      }
      // Exchange code for tokens.
      try {
        const payload = await postForm(TOKEN_URL, {
          grant_type:    'authorization_code',
          client_id:     requireClientId(),
          code:          code,
          redirect_uri:  REDIRECT_URI,
          code_verifier: verifier
        });
        const accountId = extractAccountId(payload.id_token);
        const tok = tokenStore.fromOAuthResponse(payload, { chatgpt_account_id: accountId });
        tokenStore.save(tok);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(SUCCESS_HTML);
        finish(null, tok);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end(FAILURE_HTML);
        finish(e);
      }
    });

    let _binds = 0;
    let _evicted = false;
    server.on('error', (e) => {
      // The superseded attempt's close() can release :1455 a beat after we
      // try to bind — absorb that race instead of failing the fresh click.
      // And when a PARKED flow still owns the port (first click opened the
      // wrong browser, second click found the door locked — field report
      // 2026-08-15: the button just died silently), EVICT it once: the old
      // handler treats a mismatched state as a failed callback, answers 400
      // and closes its server, freeing the port for THIS click. A fresh
      // click must always win over an abandoned one.
      if (e && e.code === 'EADDRINUSE' && !settled) {
        if (!_evicted) {
          _evicted = true;
          try {
            const _req = http.request({ hostname: '127.0.0.1', port, path: '/auth/callback?code=x&state=__superseded__', method: 'GET', timeout: 2000 },
              (r) => { r.resume(); });
            _req.on('error', () => {});
            _req.on('timeout', () => { try { _req.destroy(); } catch (_) {} });
            _req.end();
          } catch (_) { /* eviction is best-effort; the retry loop still runs */ }
        }
        if (_binds < 10) {
          _binds++;
          setTimeout(() => { if (!settled) { try { server.listen(port, '127.0.0.1'); } catch (e2) { finish(e2); } } }, 250);
          return;
        }
      }
      finish(e);
    });
    let _browserOpened = false;
    server.on('listening', () => {
      if (_browserOpened) return;
      _browserOpened = true;
      // The dashboard flow passes onUrl so the PAGE can open/show the link:
      // this openBrowser runs on the PROXY's machine, and a headless box (or
      // one without xdg-open) opened nothing while the button said it had —
      // a first-day Ubuntu user clicked into silence on 2026-08-04. The URL
      // is only valid from THIS attempt (state + PKCE live in this closure),
      // which is why callers cannot rebuild it themselves.
      // Exactly ONE opener owns the URL. When a caller passes onUrl, the
      // caller's surface opens/shows it — opening here TOO sent the link
      // through the OS default handler, and macOS routes same-bundle URLs
      // to whichever Chrome instance is already running: on 2026-08-15
      // that was the managed CDP browser, and the operator's sign-in
      // landed in a profile with no ChatGPT session. Server-side open
      // remains ONLY for surfaces that cannot open a browser themselves
      // (CLI without onUrl), where it is the sole opener.
      if (typeof opts.onUrl === 'function') { try { opts.onUrl(authUrl); } catch (_) {} }
      else if (!opts.noBrowser) openBrowser(authUrl);
    });
    server.listen(port, '127.0.0.1');

    const timer = setTimeout(() => {
      finish(new Error('codex-auth: login timed out after ' + Math.round(timeoutMs / 1000) + 's (no callback received)'));
    }, timeoutMs);
  });
  _activeLogin = { promise, startedAt: Date.now() };
  return promise;
}

// ── refresh() — silent token rotation ─────────────────────────────────

// Called by the transport when isExpired(currentToken) is true. POSTs
// the refresh_token to the token endpoint, replaces the saved token
// with the rotated one. account_id is preserved from the prior token
// (the new id_token may not be returned on refresh; OpenAI's behavior
// is endpoint-specific). On failure, the caller should clear() and
// trigger a fresh login() — refresh tokens DO expire (typically after
// long inactivity).
async function refresh(currentToken) {
  if (!currentToken || !currentToken.refresh_token) {
    throw new Error('codex-auth: refresh called without a refresh_token');
  }
  const payload = await postForm(TOKEN_URL, {
    grant_type:    'refresh_token',
    client_id:     requireClientId(),
    refresh_token: currentToken.refresh_token,
    scope:         SCOPE
  });
  // Carry account_id forward — refresh response often omits id_token.
  const accountId = (payload.id_token && extractAccountId(payload.id_token)) || currentToken.account_id || null;
  // Some OAuth servers omit refresh_token on rotation; preserve the old.
  if (!payload.refresh_token) payload.refresh_token = currentToken.refresh_token;
  const tok = tokenStore.fromOAuthResponse(payload, { chatgpt_account_id: accountId });
  tokenStore.save(tok);
  return tok;
}

module.exports = {
  login,
  refresh,
  // Exposed for tests + the transport's lazy-refresh path.
  makePkce,
  makeState,
  decodeJwt,
  extractAccountId,
  buildAuthorizationUrl,
  clientId,
  originator,
  requireClientId,
  AUTH_URL,
  TOKEN_URL,
  REDIRECT_URI,
  SCOPE,
  JWT_CLAIM
};
