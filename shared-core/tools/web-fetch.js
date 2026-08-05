// SPDX-License-Identifier: AGPL-3.0-only
// web-fetch.js — L4 fetcher's read-only window to the open web.
//
// The web-fetch design: substrate-side
// tool that fetches a single HTTPS resource from the allowlist, extracts
// readable text, and returns it tagged with provenance so any downstream
// engram_record inherits audience='external' rather than 'partner_internal'.
//
// Hardening:
//   Allowlist gate (web-allowlist.isAllowed) — default-deny by the default-deny rule.
//   HTTPS only.
//   Redirect cap (3) with re-allowlist check at every hop. A redirect to
//     an off-allowlist host is a refusal — we don't shadow-extend the list.
//   Size cap (default 1 MiB). Stream is destroyed past the cap.
//   Timeout (default 15s) on the request socket.
//   No cookies, no auth headers, no body, no compression (we don't need
//     the bytes-saving and brotli/gzip adds an attack surface).
//   HTML → plaintext: strip <script>/<style>/<noscript> + tags, collapse
//     whitespace, trim. We deliberately don't run a real HTML parser; the
//     fetcher returns text for the LLM to summarize, not a DOM.
//
// Result envelope is the audience-tagging contract:
//   {
//     ok: bool, url, status, content_type, bytes, truncated,
//     text, redirected_chain: [url], audience: 'external',
//     provenance: { source: 'web_fetch:<url>', fetched_ts, tier: 'untrusted' }
//   }
// On refusal:
//   { ok: false, refused: true, reason, url }

const https = require('https');
const { URL } = require('url');
const allowlist = require('./web-allowlist.js');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES  = 1024 * 1024; // 1 MiB
const MAX_REDIRECTS      = 3;
const USER_AGENT         = 'troth-l4-fetcher/1.0 (+https://troth.one)';

function _stripHtml(html) {
  if (typeof html !== 'string') return '';
  let s = html;
  // Drop entire script/style/noscript blocks first — their *contents* are
  // never text we want.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ');
  // HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level tags → newline so paragraphs stay separated.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|article|section|header|footer|main|blockquote|pre)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // All remaining tags → space.
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode the handful of HTML entities we'll encounter most.
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&apos;/g, "'");
  // Numeric entities — best effort, ignore failures.
  s = s.replace(/&#(\d+);/g, (_m, n) => {
    const c = parseInt(n, 10);
    return Number.isFinite(c) && c >= 32 && c < 0x10ffff ? String.fromCodePoint(c) : ' ';
  });
  // Collapse whitespace; preserve paragraph breaks.
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}


// Which of the caller's headers may survive a redirect.
//
// Credentials are scoped to the host they were meant for. A redirect can
// point anywhere, so anything that authenticates is dropped the moment the
// origin changes; a same-origin hop keeps everything, because that is a path
// change, not a change in who is being trusted. The allowlist already refuses
// off-list hosts at every hop, so this is the second lock rather than the
// only one: two allowlisted hosts are still two different parties.
const CREDENTIAL_HEADERS = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

function _headersForHop(fromUrl, toUrl, headers) {
  if (!headers || typeof headers !== 'object') return headers;
  let sameOrigin;
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    sameOrigin = from.protocol === to.protocol && from.host === to.host;
  } catch (_) {
    sameOrigin = false;   // cannot tell, so treat it as a different party
  }
  if (sameOrigin) return headers;
  const kept = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.test(k)) { dropped++; continue; }
    kept[k] = v;
  }
  return dropped ? kept : headers;
}

function _doRequest(targetUrl, opts, hopsLeft, chain) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (_) {
      return resolve({ ok: false, refused: true, reason: 'invalid_url', url: targetUrl });
    }
    if (!allowlist.isAllowed(targetUrl)) {
      return resolve({
        ok: false, refused: true,
        reason: 'not_in_allowlist',
        url: targetUrl,
        detail: 'add the domain via `troth config web allowlist add ' + parsed.hostname + '` if appropriate'
      });
    }
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept':     'text/html,text/plain;q=0.9,*/*;q=0.5',
      // No cookies by default, no compression. Caller may inject specific
      // headers (e.g. Authorization for vault-credential auth) via
      // opts.extra_headers — those override defaults, which is fine
      // because the credential vault is operator-curated.
      'Accept-Encoding': 'identity'
    };
    if (opts.extra_headers && typeof opts.extra_headers === 'object') {
      for (const [k, v] of Object.entries(opts.extra_headers)) {
        if (typeof v === 'string' && v.length) headers[k] = v;
      }
    }
    const reqOpts = {
      method:  'GET',
      host:    parsed.hostname,
      port:    parsed.port || 443,
      path:    parsed.pathname + (parsed.search || ''),
      headers,
      timeout: opts.timeout_ms
    };
    const req = https.request(reqOpts, (res) => {
      // Redirect handling.
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        res.resume(); // drain
        if (hopsLeft <= 0) {
          return resolve({ ok: false, refused: true, reason: 'too_many_redirects', url: targetUrl, redirected_chain: chain });
        }
        let next;
        try { next = new URL(res.headers.location, targetUrl).toString(); }
        catch (_) { return resolve({ ok: false, refused: true, reason: 'invalid_redirect', url: targetUrl, redirected_chain: chain }); }
        chain.push(next);
        // Credentials are scoped to the host they were meant for. A redirect
        // can point anywhere, including at a server the operator never chose,
        // so anything that authenticates is dropped the moment the origin
        // changes. Same-origin hops keep them: that is a path change, not a
        // change of who is being trusted.
        const hopHeaders = _headersForHop(targetUrl, next, opts && opts.extra_headers);
        const hopOpts = hopHeaders === (opts && opts.extra_headers)
          ? opts
          : Object.assign({}, opts, { extra_headers: hopHeaders });
        return resolve(_doRequest(next, hopOpts, hopsLeft - 1, chain));
      }
      const status = res.statusCode;
      const contentType = (res.headers['content-type'] || '').toLowerCase();
      let total = 0;
      let truncated = false;
      const chunks = [];
      res.on('data', (c) => {
        if (truncated) return;
        total += c.length;
        if (total > opts.max_bytes) {
          truncated = true;
          chunks.push(c.slice(0, c.length - (total - opts.max_bytes)));
          try { req.destroy(); } catch (_) {}
          try { res.destroy(); } catch (_) {}
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => _finish());
      res.on('close', () => _finish());
      res.on('error', (e) => _finish(e));
      let finished = false;
      function _finish(err) {
        if (finished) return; finished = true;
        const buf = Buffer.concat(chunks);
        const raw = buf.toString('utf8');
        let text = raw;
        if (contentType.indexOf('text/html') >= 0 || contentType.indexOf('application/xhtml') >= 0) {
          text = _stripHtml(raw);
        } else if (contentType.indexOf('text/') < 0 && contentType.indexOf('json') < 0 && contentType.indexOf('xml') < 0) {
          // Non-text content (image, pdf, etc) — we don't surface bytes; LLM
          // can't use them and they'd just waste context. Note in result.
          text = '';
        }
        resolve({
          ok: !err && status >= 200 && status < 300,
          url: targetUrl,
          status,
          content_type: contentType,
          bytes: buf.length,
          truncated,
          text,
          redirected_chain: chain.slice(),
          audience: 'external',
          provenance: {
            source:     'web_fetch:' + targetUrl,
            fetched_ts: Date.now(),
            tier:       'untrusted',
            redirected: chain.length > 1
          },
          error: err ? (err.message || String(err)) : null
        });
      }
    });
    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
    });
    req.on('error', (e) => {
      resolve({ ok: false, refused: false, error: e && e.message || String(e), url: targetUrl, redirected_chain: chain });
    });
    req.end();
  });
}

async function fetchUrl(url, opts) {
  opts = opts || {};
  const timeout_ms = typeof opts.timeout_ms === 'number' && opts.timeout_ms > 0 && opts.timeout_ms < 60000
                       ? opts.timeout_ms : DEFAULT_TIMEOUT_MS;
  const max_bytes  = typeof opts.max_bytes === 'number' && opts.max_bytes > 0 && opts.max_bytes <= 10 * 1024 * 1024
                       ? opts.max_bytes : DEFAULT_MAX_BYTES;
  return _doRequest(url, { timeout_ms, max_bytes, extra_headers: opts.extra_headers }, MAX_REDIRECTS, [url]);
}

module.exports = {
  _headersForHop,
  fetchUrl,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
  // exposed for tests
  _stripHtml
};
