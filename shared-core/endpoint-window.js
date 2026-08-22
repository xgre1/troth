// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const http = require('http');
const https = require('https');

const PROBE_PATHS = ['/props', '/api/v0/models', '/v1/models', '/api/tags', '/v1/model'];
const PROBE_TIMEOUT_MS = 1500;
const REPROBE_MS = 60000;

function firstPositive() {
  for (let i = 0; i < arguments.length; i++) {
    const n = Number(arguments[i]);
    if (n > 0) return n;
  }
  return 0;
}

function windowFromPayload(pathName, j) {
  if (!j || typeof j !== 'object') return 0;
  if (pathName === '/props') {
    return firstPositive((j.default_generation_settings || {}).n_ctx, j.n_ctx);
  }
  if (pathName === '/v1/model') return firstPositive(j.max_seq_len, j.max_model_len);
  const rows = j.data || j.models || [];
  if (!Array.isArray(rows)) return 0;
  let best = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const d = r.details || r.model_info || {};
    const n = firstPositive(
      r.loaded_context_length, r.max_context_length, r.max_model_len,
      r.context_length, d.context_length
    );
    if (n > best) best = n;
  }
  return best;
}

function getJson(opts, cb) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  try {
    const mod = opts.protocol === 'https:' ? https : http;
    const req = mod.get(opts, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let buf = '';
      res.on('data', (c) => { if (buf.length < 2 * 1024 * 1024) buf += c; });
      res.on('end', () => { try { finish(JSON.parse(buf)); } catch (_) { finish(null); } });
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  } catch (_) { finish(null); }
}

function probe(base, cb) {
  let i = 0;
  const next = () => {
    if (i >= PROBE_PATHS.length) { if (cb) cb(0); return; }
    const pathName = PROBE_PATHS[i++];
    getJson({
      protocol: base.protocol, host: base.host, port: base.port,
      path: pathName, timeout: PROBE_TIMEOUT_MS, headers: { accept: 'application/json' }
    }, (j) => {
      const n = windowFromPayload(pathName, j);
      if (n > 0) { if (cb) cb(n); return; }
      next();
    });
  };
  next();
}

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_PATH = path.join(process.env.HOME || os.homedir(), '.troth', 'endpoint-windows.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const _known = Object.create(null);
const _probedAt = Object.create(null);
let _saveTimer = null;

function keyOf(base) {
  return (base.protocol || 'http:') + '//' + base.host + ':' + base.port +
         '|' + String(base.model || '');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const now = Date.now();
    for (const k in raw) {
      const row = raw[k] || {};
      const n = Number(row.n) || 0;
      const at = Number(row.at) || 0;
      if (n > 0 && at && now - at <= CACHE_TTL_MS) _known[k] = n;
    }
  } catch (_) { /* absent or unreadable is not an error */ }
}

function save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const now = Date.now();
      const out = {};
      for (const k in _known) out[k] = { n: _known[k], at: now };
      const tmp = CACHE_PATH + '.tmp';
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, CACHE_PATH);
    } catch (_) { /* a cache that cannot be written is still a working cache */ }
  }, 1000);
  if (_saveTimer.unref) _saveTimer.unref();
}

load();

function windowFor(base) {
  if (!base || !base.host) return 0;
  const key = keyOf(base);
  const now = Date.now();
  if (now - (_probedAt[key] || 0) >= REPROBE_MS) {
    _probedAt[key] = now;
    try {
      probe(base, (n) => { if (n > 0 && _known[key] !== n) { _known[key] = n; save(); } });
    } catch (_) { /* an endpoint that will not answer keeps the last answer */ }
  }
  return _known[key] || 0;
}

module.exports = {
  PROBE_PATHS, CACHE_PATH,
  firstPositive, windowFromPayload, getJson, probe, windowFor
};
