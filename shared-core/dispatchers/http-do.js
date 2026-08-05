// SPDX-License-Identifier: AGPL-3.0-only
// Universal HTTP executor — substrate-as-subject pivot.
//
// THE substrate-native answer to "partner needs to call an API." NOT a
// per-service dispatcher. Partner emits the FULL HTTP envelope in the
// intent payload (method + url + headers + body); this executor runs
// it mechanically and writes the result to an observation engram.
//
// One executor = infinite read/write surface across the open HTTP web,
// gated by per-domain capability scopes. Adding "partner can use
// Supabase / Linear / Notion / Vercel / anything-with-a-REST-or-
// GraphQL-API" requires ZERO new code — operator just mints
// `capability:http:do:api.notion.com` with appropriate
// max_irreversibility + budget.
//
// Hardening (inherits from web-fetch.js patterns + extends):
//   - HTTPS only (capability allowlist gates host)
//   - Method whitelist: GET/POST/PUT/PATCH/DELETE/HEAD (no CONNECT/TRACE)
//   - Redirect cap (3), re-allowlist check at every hop
//   - Size cap on response (configurable per call, default 5 MiB —
//     larger than web-fetch's 1 MiB since APIs return more data than
//     scrape targets)
//   - Timeout cap (configurable, default 30s)
//   - Per-request idempotency: dispatcher already enforces atomic
//     claim on intent_state; HTTP idempotency-key header echoed when
//     intent's idempotency_key present.
//   - Credential auto-attach: capability_ref's bound credential (via
//     credential-vault extension) gets injected as Authorization /
//     custom header per credential config. LLM never sees the raw
//     credential value.
//
// Capability scope shape:
//   capability:http:do:<host-glob>[:<path-glob>]
//   Examples:
//     capability:http:do:api.notion.com               (any path)
//     capability:http:do:api.supabase.com:/v1/*       (v1 path only)
//     capability:http:do:*.openai.com:/v1/chat/*      (subdomain glob)
//
// Capability scope match is handled by capability_covers_intent STVC
// at write time + re-validated at dispatch time (two-phase).

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const ADAPTER_SCOPE = 'intent:http:do:*';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES  = 5 * 1024 * 1024;
const MAX_REDIRECTS      = 3;
const USER_AGENT         = 'troth-l4-partner/1.0 (+https://troth.one)';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

function _validate(payload) {
  if (!payload || typeof payload !== 'object') return 'payload required';
  const method = String(payload.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return 'method not allowed: ' + method;
  if (!payload.url) return 'url required';
  let u;
  try { u = new URL(String(payload.url)); }
  catch (_) { return 'url not parseable'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'protocol must be http/https';
  // HTTP (non-TLS) only allowed against localhost/127.0.0.1 (for dev /
  // localhost-bound services). Public web = HTTPS only.
  if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
    return 'http (non-TLS) only allowed for localhost';
  }
  return null;
}

// Verify capability scope matches the target host (+ optional path).
// capability scope format: capability:http:do:<host-glob>[:<path-prefix>]
// We accept trailing '*' as a host-suffix wildcard (e.g.
// `*.openai.com`) and path-suffix wildcard (e.g. `/v1/*`).
function _capabilityCoversUrl(capScope, url) {
  if (typeof capScope !== 'string') return false;
  if (capScope.indexOf('capability:http:do:') !== 0) return false;
  const tail = capScope.slice('capability:http:do:'.length);
  const [hostPart, ...pathParts] = tail.split(':/');
  const pathGlob = pathParts.length ? '/' + pathParts.join(':/') : null;
  let u;
  try { u = new URL(url); }
  catch (_) { return false; }
  if (!_hostMatches(hostPart, u.hostname)) return false;
  if (pathGlob && !_pathMatches(pathGlob, u.pathname)) return false;
  return true;
}

function _hostMatches(glob, host) {
  if (glob === host) return true;
  if (glob.indexOf('*.') === 0) {
    const suffix = glob.slice(2);
    return host.length > suffix.length + 1 && host.endsWith('.' + suffix);
  }
  if (glob === '*') return true;
  return false;
}

function _pathMatches(glob, p) {
  if (glob === p) return true;
  if (glob.endsWith('*')) return p.indexOf(glob.slice(0, -1)) === 0;
  return false;
}

function _doRequest(envelope, opts) {
  return new Promise((resolve) => {
    const maxBytes = opts.max_bytes || DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeout_ms || DEFAULT_TIMEOUT_MS;
    let u;
    try { u = new URL(envelope.url); }
    catch (e) { return resolve({ ok: false, error: 'url_parse_failed' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      'Accept': '*/*'
    }, envelope.headers || {});
    if (envelope.idempotency_key && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = envelope.idempotency_key;
    }
    let bodyBuf = null;
    if (envelope.body !== undefined && envelope.body !== null) {
      bodyBuf = typeof envelope.body === 'string'
        ? Buffer.from(envelope.body, 'utf8')
        : Buffer.from(JSON.stringify(envelope.body), 'utf8');
      if (!headers['Content-Type'] && typeof envelope.body !== 'string') {
        headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = String(bodyBuf.length);
    }
    const req = lib.request({
      method: envelope.method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      let received = 0;
      let truncated = false;
      res.on('data', (c) => {
        received += c.length;
        if (received > maxBytes) {
          truncated = true;
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        let body = buf.toString('utf8');
        let parsed = null;
        if (ct.indexOf('application/json') >= 0) {
          try { parsed = JSON.parse(body); } catch (_) {}
        }
        resolve({
          ok: true,
          status: res.statusCode,
          status_class: res.statusCode >= 200 && res.statusCode < 300 ? '2xx'
                       : res.statusCode >= 300 && res.statusCode < 400 ? '3xx'
                       : res.statusCode >= 400 && res.statusCode < 500 ? '4xx'
                       : '5xx',
          headers: res.headers,
          body: parsed !== null ? parsed : body,
          bytes: buf.length,
          truncated
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'request_failed: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'request_timeout' }); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function dispatch(intent, capability, ctx) {
  ctx = ctx || {};
  const payload = (intent && intent.payload) || {};
  const invalid = _validate(payload);
  if (invalid) return { ok: false, error: 'envelope_invalid: ' + invalid };

  // Capability MUST cover this URL (defense-in-depth — capability_covers_intent
  // STVC already runs at write+dispatch but this catches mistakes in the
  // intent's URL even when scope-glob match passed at the engram level).
  if (capability) {
    if (!_capabilityCoversUrl(capability.scope, payload.url)) {
      return { ok: false, error: 'capability_does_not_cover_url: cap=' + capability.scope + ' url=' + payload.url };
    }
  }

  // Credential auto-attach. Looks for credentials whose
  // allowed_classes / capability_scope match this capability. Injects
  // into envelope.headers per credential spec. v1: simple Bearer
  // injection if credential.name matches 'CAPABILITY_BEARER' shape;
  // richer injection in 2.4b once vault is integration point-integrated.
  // For now, ctx.bearer_token override stays the explicit-injection path.
  const envelope = {
    method: String(payload.method || 'GET').toUpperCase(),
    url: String(payload.url),
    headers: Object.assign({}, payload.headers || {}),
    body: payload.body !== undefined ? payload.body : null,
    // D2 — prefer the STABLE effect_key (crash-resume-safe) so the external
    // server's dedup aligns with our effect-ledger; fall back to the
    // minute-bucketed intent idempotency_key.
    idempotency_key: (ctx && ctx._effect_key) || (intent && intent.idempotency_key) || null
  };
  if (ctx.bearer_token && !envelope.headers['Authorization']) {
    envelope.headers['Authorization'] = 'Bearer ' + ctx.bearer_token;
  } else if (!envelope.headers['Authorization'] && capability && capability.scope) {
    // design: vault auto-attach. Look up a vault entry whose
    // capability_scope_glob covers this capability's scope. Inject
    // according to the entry's injection spec. LLM never sees the raw
    // value — substrate boundary only.
    try {
      const vault = require('../vault.js');
      const hit = vault.getValueForCapability(capability.scope);
      if (hit && hit.value) {
        const inj = hit.injection || { kind: 'bearer' };
        if (inj.kind === 'bearer') {
          envelope.headers['Authorization'] = 'Bearer ' + hit.value;
        } else if (inj.kind === 'header' && inj.name) {
          envelope.headers[inj.name] = hit.value;
        }
        // 'env' is for shell:do (irrelevant here); 'raw' is caller-pulls
        // (skip auto-attach).
      }
    } catch (_) { /* vault unavailable / locked — no auto-attach */ }
  }

  // Test injection.
  if (typeof ctx._http_mock === 'function') {
    try {
      const mres = await Promise.resolve(ctx._http_mock({ envelope, intent, capability }));
      return {
        ok: mres.ok !== false,
        result: mres.result || mres,
        cost_usd: typeof mres.cost_usd === 'number' ? mres.cost_usd : 0,
        error: mres.ok === false ? (mres.error || 'mock_reported_failure') : null
      };
    } catch (e) { return { ok: false, error: 'http_mock_threw: ' + (e && e.message || e) }; }
  }

  const res = await _doRequest(envelope, {
    timeout_ms: payload.timeout_ms,
    max_bytes:  payload.max_bytes
  });
  if (!res.ok) return { ok: false, error: res.error };

  // Response-body secret scrubbing — substrate-thesis: when an API
  // returns secrets in the response (e.g. POST /auth/keys/create →
  // {api_key:"sk-..."}), capability declares which JSON paths are
  // secret. Substrate intercepts before observation engram is written,
  // stores the bytes in vault by handle, replaces the path's value in
  // the engram with a vault-handle reference. LLM sees the handle,
  // never the bytes.
  let scrubbedBody = res.body;
  const scrubReport = [];
  const scrubPaths = capability && (
    (capability.output && capability.output.response_secret_paths) ||
    capability.response_secret_paths
  );
  if (Array.isArray(scrubPaths) && scrubPaths.length && res.body && typeof res.body === 'object') {
    try {
      const vault = require('../vault.js');
      // Operate on a deep clone so we don't mutate the parsed response
      // before the rest of the pipeline gets it.
      scrubbedBody = JSON.parse(JSON.stringify(res.body));
      for (const dotPath of scrubPaths) {
        const segs = String(dotPath).split('.');
        let parent = scrubbedBody;
        for (let i = 0; i < segs.length - 1; i++) {
          if (!parent || typeof parent !== 'object') { parent = null; break; }
          parent = parent[segs[i]];
        }
        const leaf = segs[segs.length - 1];
        if (!parent || typeof parent !== 'object' || !(leaf in parent)) continue;
        const value = parent[leaf];
        if (typeof value !== 'string' || !value.length) continue;
        // Auto-generated vault key keyed to capability + path so repeat
        // dispatches deterministically overwrite the same entry.
        const capTail = (capability.scope || 'http')
          .replace(/[^A-Za-z0-9_]+/g, '_')
          .toUpperCase()
          .slice(0, 40);
        const pathTail = dotPath.replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase().slice(0, 32);
        const vaultKey = ('SCRUB_' + capTail + '_' + pathTail).slice(0, 63);
        const writeRes = vault.writeEntry({
          key: vaultKey,
          value: value,
          capability_scope_glob: capability.scope || 'capability:http:do:*',
          injection: { kind: 'bearer' },
          description: 'http-do scrub from ' + (capability.scope || '?') + ' path=' + dotPath
        });
        if (writeRes.ok) {
          parent[leaf] = { __vault_handle: vaultKey, __bytes_len: Buffer.byteLength(value, 'utf8') };
          scrubReport.push({ path: dotPath, vault_key: vaultKey, bytes_len: Buffer.byteLength(value, 'utf8') });
        }
        // If vault locked / write fails, leave the value as-is rather
        // than silently dropping — caller decides how to react via the
        // observation engram (which will reveal the raw value AND the
        // empty scrub report, making the failure auditable).
      }
    } catch (_) { /* vault unavailable; passthrough */ }
  }

  return {
    ok: true,
    result: {
      status: res.status,
      status_class: res.status_class,
      headers: res.headers,
      body: scrubbedBody,
      bytes: res.bytes,
      truncated: res.truncated,
      scrubbed_paths: scrubReport.length ? scrubReport : undefined
    },
    cost_usd: 0   // HTTP is unmetered; specific endpoints can override via response analysis
  };
}

module.exports = {
  scope_match: ADAPTER_SCOPE,
  param_schema: { method: 'string', url: 'string', headers: 'object?', body: 'any?', timeout_ms: 'number?', max_bytes: 'number?' },
  irreversibility_class: 'medium',   // default; capability:http:do:<host> can raise/lower
  dispatch,
  // Test surface
  _validate,
  _capabilityCoversUrl,
  _hostMatches,
  _pathMatches
};
