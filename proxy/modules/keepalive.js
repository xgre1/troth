// SPDX-License-Identifier: AGPL-3.0-only
// Keepalive heartbeat — refreshes Anthropic's 5-min ephemeral prompt cache
// during user idle so the next real request lands on a warm prefix.
//
//
// Economics (from research)
// ─────────────────────────
// A prompt-cache write costs 125–200% of base input tokens. A ping with
// a cached prefix + max_tokens=1 pays only for the 1 output token. Break-
// even at ~60 minutes idle (≈12–15 pings = 1 rewrite). Outside of idle
// windows this module does nothing.
//
// Safety rails
// ────────────
//   • Disabled by default. Opt-in via env `TROTH_KEEPALIVE=1` or
//     cfg.enabled=true. Billable background traffic must be consensual.
//   • API key held IN MEMORY ONLY, never written to disk. Process exit
//     drops it; keepalive cold-starts on restart.
//   • TPM cap: sliding 60s window of tokens pinged; if adding the next
//     ping would cross cfg.tpm_cap, skip it and log.
//   • Jitter ±cfg.jitter_s on every schedule so N parallel sessions don't
//     stampede the provider at the same second.
//   • Any provider error → back off with exponential delay, max 3 retries,
//     then stop tracking that session until a fresh request re-tracks it.
//
// Not included (intentional)
// ──────────────────────────
//   • Multi-backend TPM isolation — we use one cap for all providers.
//     Anyone routing to > 1 provider can set a conservative cap.
//   • Persistent sessions across restart — on purpose; in-memory only.

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const url = require('url');

// ── Config defaults ────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  idle_ms: 4.5 * 60 * 1000,   // 4.5 min — before Anthropic's 5-min TTL
  jitter_s: 15,                // ±15 s randomisation
  tpm_cap: 40000,              // conservative input-TPM budget for pings
  max_retries: 3,
  retry_base_ms: 2000,
  min_prefix_tokens: 1024,     // don't ping if the prefix is too short to cache
};

function readConfigFromEnv(overrides) {
  const cfg = Object.assign({}, DEFAULTS, overrides || {});
  if (process.env.TROTH_KEEPALIVE === '1' || process.env.TROTH_KEEPALIVE === 'true') {
    cfg.enabled = true;
  } else if (process.env.TROTH_KEEPALIVE === '0' || process.env.TROTH_KEEPALIVE === 'false') {
    cfg.enabled = false;
  }
  if (process.env.TROTH_KEEPALIVE_IDLE_MS) {
    const v = parseInt(process.env.TROTH_KEEPALIVE_IDLE_MS, 10);
    if (v > 0) cfg.idle_ms = v;
  }
  if (process.env.TROTH_KEEPALIVE_TPM_CAP) {
    const v = parseInt(process.env.TROTH_KEEPALIVE_TPM_CAP, 10);
    if (v > 0) cfg.tpm_cap = v;
  }
  return cfg;
}

// ── TPM ring buffer ────────────────────────────────────────────────────────

function createTpmWindow() {
  const entries = []; // { ts, tokens }
  function prune() {
    const cutoff = Date.now() - 60 * 1000;
    while (entries.length && entries[0].ts < cutoff) entries.shift();
  }
  return {
    add(tokens) {
      prune();
      entries.push({ ts: Date.now(), tokens: tokens | 0 });
    },
    current() {
      prune();
      return entries.reduce((s, e) => s + e.tokens, 0);
    },
    wouldExceed(cap, nextTokens) {
      return this.current() + (nextTokens | 0) > cap;
    },
    _reset() { entries.length = 0; },
  };
}

// ── Session fingerprint ────────────────────────────────────────────────────
// Derive a stable per-session key from the incoming request. Prefer the
// explicit session_id in metadata; fall back to a prefix hash so two
// concurrent flows on the same machine don't collide.
function deriveSessionKey(body, req) {
  if (!body) return null;
  const explicit = (body.metadata && (body.metadata.user_id || body.metadata.session_id)) || null;
  if (explicit) return String(explicit);
  const model = body.model || '';
  const sys = typeof body.system === 'string' ? body.system.slice(0, 200) : JSON.stringify(body.system || '').slice(0, 200);
  const tools = body.tools ? body.tools.map(t => t && t.name).filter(Boolean).sort().join(',') : '';
  return crypto.createHash('sha256').update(model + '|' + sys + '|' + tools).digest('hex').slice(0, 16);
}

// ── Keepalive manager ──────────────────────────────────────────────────────

function createManager(opts) {
  opts = opts || {};
  const cfg = readConfigFromEnv(opts.cfg);
  const tpm = createTpmWindow();
  const sessions = new Map(); // key → { snapshot, timer, retries, lastError }
  const counters = { scheduled: 0, fired: 0, sent: 0, skippedTpm: 0, skippedDisabled: 0, errors: 0 };

  // Injectable for tests. Default calls the real transport.
  const transmitFn = typeof opts.transmit === 'function' ? opts.transmit : realTransmit;

  function nextDelayMs() {
    const jitter = (Math.random() * 2 - 1) * cfg.jitter_s * 1000;
    return Math.max(1, cfg.idle_ms + jitter);
  }

  function track(sessionKey, snapshot) {
    if (!cfg.enabled) { counters.skippedDisabled++; return false; }
    if (!sessionKey || !snapshot) return false;

    // Don't bother keeping very short prefixes warm — they won't cache
    // anyway (below model threshold) and the ping is pure cost.
    if ((snapshot.estimatedTokens || 0) < cfg.min_prefix_tokens) return false;

    const prev = sessions.get(sessionKey);
    if (prev && prev.timer) clearTimeout(prev.timer);

    const delay = nextDelayMs();
    const timer = setTimeout(() => fire(sessionKey), delay);
    if (typeof timer.unref === 'function') timer.unref();

    sessions.set(sessionKey, {
      snapshot,
      timer,
      retries: 0,
      scheduled_at: Date.now(),
      fires_at: Date.now() + delay,
    });
    counters.scheduled++;
    return true;
  }

  async function fire(sessionKey) {
    const sess = sessions.get(sessionKey);
    if (!sess) return;
    counters.fired++;
    sess.timer = null;

    // TPM guard. One ping ≈ input-prefix tokens (cache_read is 10% price
    // but the TPM *window* still counts full input). We use estimated
    // tokens from the snapshot as the worst-case charge.
    const cost = sess.snapshot.estimatedTokens || 0;
    if (tpm.wouldExceed(cfg.tpm_cap, cost)) {
      counters.skippedTpm++;
      // Reschedule later so we keep trying as the TPM window drains.
      const backoff = Math.min(cfg.idle_ms, 30 * 1000);
      sess.timer = setTimeout(() => fire(sessionKey), backoff);
      if (typeof sess.timer.unref === 'function') sess.timer.unref();
      sess.fires_at = Date.now() + backoff;
      return;
    }

    try {
      await transmitFn(sess.snapshot);
      counters.sent++;
      tpm.add(cost);
      sess.retries = 0;
      // Reschedule next keepalive.
      const delay = nextDelayMs();
      sess.timer = setTimeout(() => fire(sessionKey), delay);
      if (typeof sess.timer.unref === 'function') sess.timer.unref();
      sess.fires_at = Date.now() + delay;
    } catch (e) {
      counters.errors++;
      sess.lastError = e && e.message || String(e);
      sess.retries = (sess.retries || 0) + 1;
      if (sess.retries > cfg.max_retries) {
        // Give up on this session until the next real request re-tracks it.
        sessions.delete(sessionKey);
        return;
      }
      const delay = cfg.retry_base_ms * Math.pow(2, sess.retries - 1);
      sess.timer = setTimeout(() => fire(sessionKey), delay);
      if (typeof sess.timer.unref === 'function') sess.timer.unref();
      sess.fires_at = Date.now() + delay;
    }
  }

  function stop(sessionKey) {
    const sess = sessions.get(sessionKey);
    if (!sess) return false;
    if (sess.timer) clearTimeout(sess.timer);
    sessions.delete(sessionKey);
    return true;
  }

  function stopAll() {
    for (const sess of sessions.values()) {
      if (sess.timer) clearTimeout(sess.timer);
    }
    sessions.clear();
  }

  function stats() {
    return {
      enabled: cfg.enabled,
      idle_ms: cfg.idle_ms,
      tpm_current: tpm.current(),
      tpm_cap: cfg.tpm_cap,
      active_sessions: sessions.size,
      ...counters,
    };
  }

  // Internals surfaced for tests.
  return {
    cfg, track, fire, stop, stopAll, stats,
    _sessions: sessions, _tpm: tpm, _counters: counters,
  };
}

// ── Real transport ─────────────────────────────────────────────────────────
// Builds a 1-token ping from the session snapshot and sends it to the
// snapshot's backend URL with the snapshot's API key. Returns a promise
// that resolves on 2xx and rejects on everything else.
function realTransmit(snapshot) {
  return new Promise((resolve, reject) => {
    if (!snapshot || !snapshot.backend_url) return reject(new Error('no backend_url'));

    const body = buildPingBody(snapshot);
    const u = url.parse(snapshot.backend_url);
    const lib = u.protocol === 'http:' ? http : https;

    const headers = Object.assign({
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    }, snapshot.headers || {});

    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.path || '/v1/messages',
      headers,
      timeout: 10000,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { if (chunks.length < 8192) chunks += d.toString('utf8'); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(new Error('keepalive HTTP ' + res.statusCode + ' ' + chunks.slice(0, 200)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('keepalive timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Build the minimal ping body from the snapshot. Keeps tools + system
// identical (so the cached prefix still matches) and swaps the user
// message to a single-token nudge. `max_tokens: 1` means the response
// is throwaway.
function buildPingBody(snapshot) {
  const b = {
    model: snapshot.model,
    max_tokens: 1,
  };
  if (snapshot.tools) b.tools = snapshot.tools;
  if (snapshot.system) b.system = snapshot.system;
  b.messages = [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }];
  return JSON.stringify(b);
}

module.exports = {
  createManager,
  createTpmWindow,
  deriveSessionKey,
  buildPingBody,
  readConfigFromEnv,
  DEFAULTS,
};
