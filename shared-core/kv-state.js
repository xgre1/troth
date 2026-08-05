// SPDX-License-Identifier: AGPL-3.0-only
// KV State — llama-server slot save/restore (EXPERIMENTAL — decode-cache
// optimization, NOT substrate continuity).
//
//  honest demote. The substrate-as-mind
// thesis says continuity lives in substrate's own reads (engrams,
// dialogue, identity envelope, recall) — NOT in the model's KV cache.
// Earlier framing here ("physical persistence", "substrate continuity") was
// aspirational: the kv-state module is called only by demos and a CLI
// diagnostic — the real entity daemon never calls saveSlot/restoreSlot.
// Until wired into the daemon's session lifecycle, this remains a
// decode-time optimization, useful for cutting re-tokenization cost on
// long sticky conversations but NOT load-bearing for any substrate claim.
//
// What it actually does: llama.cpp's `llama-server` (started with
// `--slot-save-path <dir>`) exposes per-slot KV cache save/restore. The
// model's in-flight attention cache (not its weights, not its memory)
// can be serialized to disk and restored later, saving the prefill
// pass on the next request that reuses the same prefix. This is a
// performance optimization, not memory.
//
// API surface (passes through to llama-server):
//   POST /slots/{id}?action=save     {filename: "..."}
//   POST /slots/{id}?action=restore  {filename: "..."}
//   POST /slots/{id}?action=erase    (no body)
//
// Marked experimental until either (a) wired into bin/troth-entity.js
// session lifecycle so it actually delivers continuity benefit, OR (b)
// removed if the operator decides the prefill-savings aren't worth the
// llama-server config complexity.
//
// API surface (passes through to llama-server):
//   POST /slots/{id}?action=save     {filename: "..."}
//   POST /slots/{id}?action=restore  {filename: "..."}
//   POST /slots/{id}?action=erase    (no body)
//
// All operations are best-effort: they return {ok, status, error}
// objects rather than throwing, since substrate state continuity
// should degrade gracefully when the underlying server doesn't
// support the action (older builds, missing --slot-save-path, etc).

const http = require('http');
const https = require('https');
const { URL } = require('url');

function callOnce(host, slotId, action, body) {
  return new Promise((resolve) => {
    const url = new URL('/slots/' + slotId + '?action=' + action, host);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body || {});
    const req = lib.request({
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers:  {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(data),
        // Prevent the agent from reusing a stale keep-alive connection
        // that the server closed after a prior /v1/chat/completions
        // response — that pattern surfaces as "socket hang up" on the
        // next request and was the original failure mode.
        'connection':     'close'
      },
      // Force a fresh connection; do not let the global keep-alive
      // pool hand us a half-closed socket.
      agent:    false,
      timeout:  20000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) { parsed = buf; }
        resolve({ ok, status: res.statusCode, action, slot: slotId, body: parsed });
      });
    });
    req.on('error',   (e) => resolve({ ok: false, action, slot: slotId, error: e.message || String(e), code: e.code }));
    req.on('timeout', ()  => { req.destroy(); resolve({ ok: false, action, slot: slotId, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

// One transparent retry on connection-level errors. Server sometimes
// closes idle connections between the chat response and our subsequent
// slots request; a fresh attempt nearly always succeeds.
async function call(host, slotId, action, body) {
  const r1 = await callOnce(host, slotId, action, body);
  if (r1.ok) return r1;
  const transient = r1.code === 'ECONNRESET' || /hang up|reset|EPIPE/i.test(r1.error || '');
  if (!transient) return r1;
  await new Promise(res => setTimeout(res, 50));
  const r2 = await callOnce(host, slotId, action, body);
  return r2.ok ? r2 : { ...r2, retried: true };
}

function saveSlot(opts) {
  opts = opts || {};
  const host = opts.host;
  const slot = (opts.slot != null) ? opts.slot : 0;
  const filename = String(opts.filename || '').trim();
  if (!host || !filename) return Promise.resolve({ ok: false, error: 'host + filename required' });
  return call(host, slot, 'save', { filename });
}

function restoreSlot(opts) {
  opts = opts || {};
  const host = opts.host;
  const slot = (opts.slot != null) ? opts.slot : 0;
  const filename = String(opts.filename || '').trim();
  if (!host || !filename) return Promise.resolve({ ok: false, error: 'host + filename required' });
  return call(host, slot, 'restore', { filename });
}

function eraseSlot(opts) {
  opts = opts || {};
  const host = opts.host;
  const slot = (opts.slot != null) ? opts.slot : 0;
  if (!host) return Promise.resolve({ ok: false, error: 'host required' });
  return call(host, slot, 'erase', {});
}

// Substrate-owned filename namespacing. A KV file lives under the
// server's --slot-save-path directory; we want the substrate to
// own the namespace so two agents don't collide. Convention:
//   <agent_id>__<scope>__<slot>.kv
// Substrate maps logical scope (e.g., "default-conversation",
// "engram-session-") to physical filenames.
function filenameForScope(opts) {
  opts = opts || {};
  const agent_id = String(opts.agent_id || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const scope    = String(opts.scope    || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const slot     = (opts.slot != null) ? opts.slot : 0;
  return agent_id + '__' + scope + '__slot' + slot + '.kv';
}

module.exports = {
  saveSlot,
  restoreSlot,
  eraseSlot,
  filenameForScope
};
