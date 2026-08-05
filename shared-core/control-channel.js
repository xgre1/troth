// SPDX-License-Identifier: AGPL-3.0-only
// Control channel — a signed-engram listener.
//
// An HTTP listener on loopback (TLS is deferred until there are
// Keychain-issued certs to use). It accepts signed engram envelopes,
// verifies each signature against the operator public key it was started
// with, and emits the engram into substrate through the normal
// engram.recordEngram path.
//
// Wire shape:
//   POST / HTTP/1.1
//   Content-Type: application/json
//   { "engram": { ...full engram body... },
//     "signature": "<base64 ed25519 over the canonical engram body>",
//     "operator_pubkey_id": "gck-op:<16hex>" }
//
// Auth: ed25519 against the operator pubkey handed to start(). A mismatch
// is a 401 plus a log line plus an audit engram at substrate-internal
// scope, so a rejected caller never reaches the model. Rate limit is 60
// messages per minute per signing key, burst 10; exceeding it is a 429
// plus an audit engram.
//
// Control scopes carried over this channel:
//   control:unlock_vault       payload: {passphrase}
//   control:request_snapshot   payload: {}
//   control:request_backup     payload: {}
//   control:halt               payload: {}
//   control:emit_intent        payload: <intent envelope>
//   control:get_state          payload: {}
//
// The shape of the thing: every control action IS a signed engram
// entering substrate. There is no control "API" with operations of its
// own. Substrate processes signed engrams, and some of them happen to
// arrive over this listener.
//
// Nothing starts this by default. bin/troth-entity.js binds it only when
// TROTH_BODY_CONTROL_CHANNEL=1, which is set when the entity runs inside
// the sandboxed body.

'use strict';

const http   = require('http');
const crypto = require('crypto');

const PORT_DEFAULT = 7777;
const BIND_HOST    = '127.0.0.1';   // loopback only; never 0.0.0.0
const MAX_BODY     = 1024 * 64;     // 64 KB; engram payloads are tiny

// MA-4 — per-verb-class rate limits. The autonomous control:tool path is
// high-volume (a multi-hour run = thousands of actions); the old 60/min monolith
// throttled it (5000 actions ≈ 83 min just waiting on the limiter). Action verbs
// get a raised ceiling; the get_state liveness probe stays modest. Still per
// pubkey-id, in-memory (single body process; restart resets).
const RATE_WINDOW_MS = 60 * 1000;
const RATE = {
  action: { limit: 600, burst: 60 },   // control:tool/bash/fs/http/browser_do
  probe:  { limit: 120, burst: 20 },   // control:get_state
};
function _verbClass(scope) {
  return (scope === 'control:get_state') ? 'probe' : 'action';
}
const rateBuckets = new Map();   // `${pubkey_id}:${class}` -> {tokens, last_refill}

function _refill(bucket, limit) {
  const now  = Date.now();
  const elapsed = now - bucket.last_refill;
  const refill  = Math.floor(elapsed / RATE_WINDOW_MS * limit);
  if (refill > 0) {
    bucket.tokens     = Math.min(limit, bucket.tokens + refill);
    bucket.last_refill = now;
  }
}
function _checkRate(pubkeyId, verbClass) {
  const cls = RATE[verbClass] ? verbClass : 'action';
  const cfg = RATE[cls];
  const key = pubkeyId + ':' + cls;
  let b = rateBuckets.get(key);
  if (!b) {
    b = { tokens: cfg.burst, last_refill: Date.now() };
    rateBuckets.set(key, b);
  }
  _refill(b, cfg.limit);
  if (b.tokens <= 0) return false;
  b.tokens--;
  return true;
}

// MA-4 — replay / freshness defense. nonce + ts are SIGNED fields inside the
// engram body; the verifier rejects stale (|now - ts| > FRESHNESS_MS) and
// replayed (nonce already seen within the window) envelopes. Host VM + body
// share the Apple-VZ host clock so skew is ~0; 60s is a generous window. A nonce
// older than the window can't be replayed (its ts is already stale), so the
// cache only retains the last window's worth (+ a hard cap as belt-and-braces).
const FRESHNESS_MS = 60 * 1000;
const NONCE_TTL_MS = FRESHNESS_MS;
const MAX_NONCES   = 5000;
const seenNonces = new Map();   // nonce(string) -> ts(number)

function _sweepNonces(now) {
  for (const [n, t] of seenNonces) {
    if (now - t > NONCE_TTL_MS) seenNonces.delete(n);
  }
  if (seenNonces.size > MAX_NONCES) {
    let over = seenNonces.size - MAX_NONCES;
    for (const n of seenNonces.keys()) { seenNonces.delete(n); if (--over <= 0) break; }
  }
}
function _seenNonce(nonce) { return seenNonces.has(nonce); }
function _recordNonce(nonce, ts) { _sweepNonces(Date.now()); seenNonces.set(nonce, ts); }
function _resetNonces() { seenNonces.clear(); rateBuckets.clear(); }

// Canonical JSON: sort keys at every depth, no whitespace. The signer and
// the verifier have to serialise the same bytes or every signature fails,
// so this function IS the contract. Any other implementation of it, in any
// language, must be byte-identical to this one.
function _canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(_canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonical(obj[k])).join(',') + '}';
}

// Verify an Ed25519 signature against a raw 32-byte pubkey (base64).
// Returns true on match. Uses Node's crypto.verify which takes a
// KeyObject; we wrap the raw 32 bytes in an SPKI prefix to satisfy
// createPublicKey's strict parser.
function _verifyEd25519(pubkeyB64, data, sigB64) {
  try {
    const rawPub = Buffer.from(pubkeyB64, 'base64');
    if (rawPub.length !== 32) return false;
    // SPKI prefix for Ed25519: 0x302a300506032b6570032100 + 32 raw bytes
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spki = Buffer.concat([spkiPrefix, rawPub]);
    const keyObj = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sig    = Buffer.from(sigB64, 'base64');
    return crypto.verify(null, Buffer.from(data, 'utf8'), keyObj, sig);
  } catch (_) { return false; }
}

// Substrate-side dispatch. handlers is a map: scope-string -> async(payload, ctx) -> result.
// Embedder (troth-entity.js) provides these so this module stays
// thin + testable.
function makeHandler(opts) {
  opts = opts || {};
  const pubkeyB64 = opts.operator_pubkey_b64;
  const pubkeyId  = opts.operator_pubkey_id;
  const handlers  = opts.handlers || {};
  const audit     = opts.audit || function () {};   // (kind, fields) -> void

  if (!pubkeyB64) throw new Error('control-channel: operator_pubkey_b64 required');

  return async function (req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed\n');
      return;
    }

    // Read body with size cap.
    const chunks = [];
    let size = 0;
    let abort = false;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { abort = true; break; }
      chunks.push(c);
    }
    if (abort) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('body too large\n');
      audit('control_channel.body_too_large', { remote: req.socket.remoteAddress });
      return;
    }

    let envelope;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad json\n');
      audit('control_channel.bad_json', { remote: req.socket.remoteAddress });
      return;
    }

    const eng = envelope && envelope.engram;
    const sig = envelope && envelope.signature;
    const eid = envelope && envelope.operator_pubkey_id;
    if (!eng || !sig || !eid) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('missing engram/signature/operator_pubkey_id\n');
      audit('control_channel.malformed_envelope', { remote: req.socket.remoteAddress });
      return;
    }

    // Key-id pre-check: we only trust our baked pubkey. Other ids
    // skipped before any crypto work.
    if (pubkeyId && eid !== pubkeyId) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unknown operator_pubkey_id\n');
      audit('control_channel.unknown_key_id', { remote: req.socket.remoteAddress, given: eid });
      return;
    }

    // Rate limit BEFORE crypto so signature-flood attacks don't burn CPU.
    if (!_checkRate(eid, _verbClass(eng.scope))) {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('rate limit\n');
      audit('control_channel.rate_limit_hit', { key_id: eid });
      return;
    }

    // MA-4 — freshness (cheap, pre-crypto). ts + nonce are SIGNED, so a tamper
    // breaks the signature anyway; range-checking here sheds obvious stale
    // replays before spending crypto and bounds the nonce cache. nonce-not-seen
    // is checked AFTER verify (so unsigned garbage can't poison the cache).
    // Fail-closed: a missing/NaN ts or missing nonce REFUSES the verb.
    const ts = eng.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESHNESS_MS) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('stale or missing timestamp\n');
      audit('control_channel.stale_ts', { remote: req.socket.remoteAddress, scope: eng.scope || null });
      return;
    }
    if (typeof eng.nonce !== 'string' || eng.nonce.length === 0) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('missing nonce\n');
      audit('control_channel.missing_nonce', { remote: req.socket.remoteAddress, scope: eng.scope || null });
      return;
    }

    // Verify signature over canonical-JSON of the engram body.
    const canon = _canonical(eng);
    if (!_verifyEd25519(pubkeyB64, canon, sig)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('bad signature\n');
      audit('control_channel.bad_signature', { remote: req.socket.remoteAddress, scope: eng.scope || null });
      return;
    }

    // MA-4 — replay defense. A verbatim re-send of a signed envelope carries the
    // SAME nonce. Checked AFTER verify so an attacker can't poison the cache with
    // unsigned/garbage nonces (DoS-by-fill). Fail-closed.
    if (_seenNonce(eng.nonce)) {
      res.writeHead(409, { 'content-type': 'text/plain' });
      res.end('replayed nonce\n');
      audit('control_channel.replay_nonce', { remote: req.socket.remoteAddress, scope: eng.scope || null });
      return;
    }
    _recordNonce(eng.nonce, ts);

    // Dispatch by scope. Unknown scopes get 404 + audit so we see them.
    const scope = eng.scope || '';
    const handler = handlers[scope];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no handler for scope: ' + scope + '\n');
      audit('control_channel.unknown_scope', { scope });
      return;
    }

    try {
      const result = await handler(eng.payload || {}, { engram: eng });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: result || null }) + '\n');
      audit('control_channel.dispatched', { scope, ok: true });
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + '\n');
      audit('control_channel.handler_threw', { scope, err: String(e && e.message || e) });
    }
  };
}

// Start the listener. Returns { server, port } for the caller to
// shut down at exit. Binds to 127.0.0.1 only — never 0.0.0.0.
function start(opts) {
  opts = opts || {};
  const port = opts.port || PORT_DEFAULT;
  const handler = makeHandler(opts);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      try {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error\n');
      } catch (_) {}
      (opts.audit || function () {})('control_channel.unhandled', { err: String(e && e.message || e) });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      resolve({ server, port, host: BIND_HOST });
    });
  });
}

module.exports = {
  start,
  makeHandler,
  // Exposed for tests that want to construct envelopes + verify
  // without spinning a real listener.
  _canonical,
  _verifyEd25519,
  PORT_DEFAULT,
  BIND_HOST,
  // MA-4 — exposed for tests (round-trip / replay / stale / cache-bound)
  FRESHNESS_MS,
  _seenNonce,
  _recordNonce,
  _resetNonces
};
