// SPDX-License-Identifier: AGPL-3.0-only
// Generic API call substrate primitive.
//
// Substrate-side HTTP client that resolves a vault credential, injects
// it as the service's expected auth header (Bearer / x-api-key / basic),
// dispatches the request, and returns parsed JSON + status. The partner
// never sees the credential value.
//
// design grounding:
//   - design R17: credential never crosses the LLM boundary. Resolution
//     + injection are STRUCTURAL — substrate refuses arbitrary token
//     parameter passing.
//   - design R23: response is audience='external' (untrusted), same
//     class as web_fetch output. Synthesis into engrams requires
//     scope='synthesis_of_external'.
//   - CaMeL (Debenedetti arXiv 2503.18813): typed-value pattern for
//     untrusted inputs. v1 returns parsed JSON or text; v2 will tag
//     fields with capability types per CaMeL spec.
//   - Common practice (Stripe / GitHub / etc. SDK convention): per-
//     service auth shape is a fixed contract, not operator-configurable
//     at call time (avoids token-leak surface).
//
// Service registry (v1, expandable):
//   github / vercel / openai / anthropic / stripe / supabase / gmail
//   / twilio / cloudflare / notion
//
// Each entry:
//   { base_url, auth_shape, default_headers?, name }
//   auth_shape ∈ {
//     'bearer'                — Authorization: Bearer <token>
//     'x-api-key'             — x-api-key: <token>
//     'anthropic'             — x-api-key + anthropic-version header
//     'basic-account-token'   — basic (account_sid:auth_token); credential
//                               value MUST be 'account_sid:auth_token'
//     'apikey-header'         — apikey: <token>  (Supabase pattern)
//   }
//
// Out of scope for v1:
//   - Pagination (caller passes cursor in query)
//   - Retry-with-backoff (implementation step failure classifier picks up 5xx)
//   - Streaming responses (cap at 32KB; non-streaming JSON only)
//   - mTLS / certificate pinning
//   - OAuth refresh (extended tools module owns refresh flow)

'use strict';

const credentialVault = require('./credential-vault.js');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const SERVICE_REGISTRY = Object.freeze({
  github:     { base_url: 'https://api.github.com',          auth_shape: 'bearer',     default_headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
  vercel:     { base_url: 'https://api.vercel.com',          auth_shape: 'bearer' },
  stripe:     { base_url: 'https://api.stripe.com',          auth_shape: 'bearer' },
  openai:     { base_url: 'https://api.openai.com',          auth_shape: 'bearer' },
  anthropic:  { base_url: 'https://api.anthropic.com',       auth_shape: 'anthropic', default_headers: { 'anthropic-version': '2023-06-01' } },
  gmail:      { base_url: 'https://gmail.googleapis.com',    auth_shape: 'bearer' },
  twilio:     { base_url: 'https://api.twilio.com',          auth_shape: 'basic-account-token' },
  cloudflare: { base_url: 'https://api.cloudflare.com',      auth_shape: 'bearer' },
  notion:     { base_url: 'https://api.notion.com',          auth_shape: 'bearer', default_headers: { 'Notion-Version': '2022-06-28' } },
  supabase:   { base_url: null,                              auth_shape: 'apikey-header' }  // base_url required from caller (project ref)
});

function listServices() {
  return Object.keys(SERVICE_REGISTRY);
}

// stricter redaction. Prior shape (first4...last4) leaked
// 8 known-position chars and exposed the credential PREFIX (sk-ant-,
// ghp_, sk-, etc.) which family-identifies the credential — narrows
// attacker's offline search. Match Stripe/AWS/GitHub convention:
// trailing 4 chars only, never leak prefix. Short credentials fully
// opaque. Caller uses the preview ONLY for log-trace correlation.
function _redactToken(value) {
  if (typeof value !== 'string') return '<redacted>';
  if (value.length < 16) return '<redacted>';
  return '…' + value.slice(-4);
}

function _buildAuthHeaders(shape, value) {
  const headers = {};
  if (shape === 'bearer') {
    headers['Authorization'] = 'Bearer ' + value;
  } else if (shape === 'x-api-key') {
    headers['x-api-key'] = value;
  } else if (shape === 'anthropic') {
    headers['x-api-key'] = value;
  } else if (shape === 'basic-account-token') {
    // value must be 'account_sid:auth_token'
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    headers['Authorization'] = 'Basic ' + b64;
  } else if (shape === 'apikey-header') {
    headers['apikey']        = value;
    headers['Authorization'] = 'Bearer ' + value;
  }
  return headers;
}

function _buildUrl(baseUrl, path, query) {
  const u = new URL(path, baseUrl);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === null || v === undefined) continue;
      u.searchParams.append(k, String(v));
    }
  }
  return u;
}

function _safeHeaderSubset(rawHeaders) {
  // Strip Set-Cookie + anything that might re-expose credentials/PII.
  if (!rawHeaders) return {};
  const out = {};
  const allow = new Set([
    'content-type', 'content-length', 'date', 'etag', 'last-modified',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
    'x-request-id', 'request-id', 'idempotency-key',
    'x-github-request-id', 'cf-ray'
  ]);
  for (const k of Object.keys(rawHeaders)) {
    if (allow.has(k.toLowerCase())) out[k.toLowerCase()] = rawHeaders[k];
  }
  return out;
}

function _httpRequest(url, opts) {
  const lib = url.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method:   opts.method,
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers:  opts.headers,
      timeout:  opts.timeout_ms
    }, (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on('data', (c) => {
        if (truncated) return;
        chunks.push(c);
        total += c.length;
        if (total > MAX_RESPONSE_BYTES) {
          truncated = true;
          req.destroy();
        }
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status:  res.statusCode,
          headers: _safeHeaderSubset(res.headers),
          body_raw: buf.slice(0, MAX_RESPONSE_BYTES).toString('utf8'),
          truncated
        });
      });
      res.on('error', reject);
    });
    req.on('error', (e) => {
      // Truncation-via-destroy fires error after destroy; resolve from
      // the data path already accumulated rather than reject.
      if (e && e.code === 'ECONNRESET' && req.destroyed) {
        // already resolved via 'end'? if not, surface
      }
      reject(e);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('api_call_timeout')); });
    if (opts.body_bytes) req.write(opts.body_bytes);
    req.end();
  });
}

// Main entry. Returns:
//   { ok, status, headers, body, truncated, service, method, url_redacted,
//     refused?, reason?, detail? }
//
// Args:
//   service           — registry key OR null when base_url supplied
//   base_url          — override (required if service unknown OR
//                       service === 'supabase')
//   method            — GET|POST|PUT|PATCH|DELETE
//   path              — relative path
//   body              — object (JSON) or string
//   query             — object
//   credential_name   — vault credential NAME (substrate resolves value)
//   timeout_ms        — default 30s
//   extra_headers     — caller-side headers (NOT credentials)
async function apiCall(args, ctx) {
  args = args || {};
  ctx  = ctx  || {};

  const method = String(args.method || 'GET').toUpperCase();
  if (!VALID_METHODS.has(method)) {
    return { ok: false, refused: true, reason: 'invalid_method', detail: 'method must be one of ' + Array.from(VALID_METHODS).join(',') };
  }

  let service = typeof args.service === 'string' ? args.service.toLowerCase() : null;
  let svc = service ? SERVICE_REGISTRY[service] : null;
  if (service && !svc) {
    return { ok: false, refused: true, reason: 'unknown_service',
             detail: 'service "' + service + '" not in registry; known: ' + listServices().join(','),
             known_services: listServices() };
  }

  const baseUrl = args.base_url || (svc && svc.base_url);
  if (!baseUrl) {
    return { ok: false, refused: true, reason: 'base_url_required',
             detail: service === 'supabase'
               ? 'supabase requires explicit base_url (e.g. https://<project-ref>.supabase.co)'
               : 'no service in registry; pass base_url explicitly' };
  }

  if (!args.path || typeof args.path !== 'string') {
    return { ok: false, refused: true, reason: 'path_required' };
  }

  // Credential resolution (R17) — substrate-side ONLY.
  if (!args.credential_name || typeof args.credential_name !== 'string') {
    return { ok: false, refused: true, reason: 'credential_name_required',
             detail: 'pass credential_name (vault entry); substrate injects the value. Inline tokens are refused.' };
  }
  const credValue = credentialVault.getCredentialValue(args.credential_name, {
    class:   ctx.goal_class || null,
    goal_id: ctx.goal_id    || null
  });
  if (!credValue) {
    return { ok: false, refused: true, reason: 'credential_unavailable',
             detail: 'Credential "' + args.credential_name + '" not in vault OR not scoped to goal class "' + (ctx.goal_class || 'unknown') + '". Ask operator via operator_request{kind:credential, detail:{service:"' + (service || 'unknown') + '", scope:"' + (ctx.goal_class || 'unknown') + '"}}.' };
  }

  const authShape = svc ? svc.auth_shape : (args.auth_shape || 'bearer');
  const authHeaders = _buildAuthHeaders(authShape, credValue);

  const headers = Object.assign(
    { 'User-Agent': 'troth-l4/1', 'Accept': 'application/json' },
    (svc && svc.default_headers) || {},
    args.extra_headers || {},
    authHeaders
  );

  let bodyBytes = null;
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body === 'string') {
      bodyBytes = Buffer.from(args.body, 'utf8');
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    } else {
      bodyBytes = Buffer.from(JSON.stringify(args.body), 'utf8');
      headers['Content-Type'] = 'application/json';
    }
    headers['Content-Length'] = String(bodyBytes.length);
  }

  let url;
  try { url = _buildUrl(baseUrl, args.path, args.query); }
  catch (e) {
    return { ok: false, refused: true, reason: 'bad_url',
             detail: String(e && e.message || e) };
  }

  const timeoutMs = Math.min(60000, Math.max(1000, args.timeout_ms || DEFAULT_TIMEOUT_MS));

  let resp;
  try {
    resp = await _httpRequest(url, { method, headers, body_bytes: bodyBytes, timeout_ms: timeoutMs });
  } catch (e) {
    return { ok: false, refused: false, reason: 'request_failed',
             detail: String(e && e.message || e),
             service, method, url_redacted: url.origin + url.pathname };
  }

  // Parse body if JSON; else return text. Cap already at 32KB.
  let body = null;
  const ctype = (resp.headers['content-type'] || '').toLowerCase();
  if (ctype.indexOf('application/json') >= 0) {
    try { body = JSON.parse(resp.body_raw); }
    catch (_) { body = { _parse_error: 'invalid_json', _raw_preview: resp.body_raw.slice(0, 500) }; }
  } else {
    body = resp.body_raw;
  }

  const ok = resp.status >= 200 && resp.status < 300;
  return {
    ok,
    status:        resp.status,
    headers:       resp.headers,
    body,
    truncated:     resp.truncated,
    service:       service || null,
    method,
    url_redacted:  url.origin + url.pathname,
    audience:      'external',  // CaMeL: untrusted by default
    credential_used_preview: _redactToken(credValue)
  };
}

module.exports = {
  apiCall,
  listServices,
  SERVICE_REGISTRY,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  // exposed for tests
  _buildAuthHeaders,
  _buildUrl,
  _safeHeaderSubset,
  _redactToken
};
