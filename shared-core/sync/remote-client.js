// SPDX-License-Identifier: AGPL-3.0-only
// The satellite side of substrate sync.
//
// When ~/.troth/config.json carries sync.host + sync.deviceId +
// sync.deviceToken, this install's mind lives on another machine. Mind-
// writes route here from the ENTRANCE of the same implementation modules
// every surface already calls: each becomes a journal event in the local
// outbox — in the caller's own breath, so nothing is lost to a dead
// network — and the flusher ships events to the hub strictly in dev_seq
// order. Reads that can await ask the hub directly; there is no local
// replica in this mode (that is the replica phase), so offline means
// recall goes honestly dark, never silently stale.
//
// The envelope a device POSTs is byte-identical to the journal record the
// hub stores — the wire format IS the journal format, which is what keeps
// the replica phase (devices replaying these same events locally) an
// addition instead of a rewrite.
'use strict';

const state  = require('../state.js');
const hlcMod = require('./hlc.js');

let _flushing = null;
const _outcomes = new Map(); // event_id -> hub response, for write-through callers
let _postImpl = _request;    // swappable for tests

function _cfg() {
  try {
    const fs = require('fs');
    const p = require('../config-file.js').configPath();
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = cfg && cfg.sync;
    if (s && typeof s.host === 'string' && s.host && s.deviceId && s.deviceToken) return s;
  } catch (_) { /* no config, or unreadable — not a satellite */ }
  return null;
}

function active() {
  if (process.env.TROTH_SYNC_DISABLE === '1') return false;
  return !!_cfg();
}

// ── local scalar state ───────────────────────────────────────────────────

function _kvGet(db, k) {
  try { const r = db.prepare('SELECT v FROM sync_client_state WHERE k = ?').get(k); return r ? r.v : null; }
  catch (_) { return null; }
}
function _kvSet(db, k, v) {
  db.prepare('INSERT INTO sync_client_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, String(v));
}

function _nextSeq(db) {
  const kv = parseInt(_kvGet(db, 'dev_seq') || '0', 10) || 0;
  let mx = 0;
  try { mx = (db.prepare('SELECT MAX(dev_seq) AS m FROM sync_outbox').get() || {}).m || 0; } catch (_) {}
  const seq = Math.max(kv, mx) + 1;
  _kvSet(db, 'dev_seq', seq);
  return seq;
}

function _lastGseq(db) {
  const v = parseInt(_kvGet(db, 'last_gseq') || '0', 10) || 0;
  return v > 0 ? v : null;
}

function _nextHlc(db, node) {
  const stamp = hlcMod.next(_kvGet(db, 'hlc'), node);
  _kvSet(db, 'hlc', stamp);
  return stamp;
}

function _appVersion() {
  try { return require('../../package.json').version; } catch (_) { return null; }
}

function _jsonSafe(x) {
  try { return JSON.parse(JSON.stringify(x || {})); } catch (_) { return {}; }
}

// ── the outbox ───────────────────────────────────────────────────────────

// Journal the write locally and return at once; the flusher ships it. The
// envelope row and the dev_seq advance commit together (transactional
// outbox) — a crash cannot strand a counter without its event.
function queueWrite(op, args, ctx) {
  const s = _cfg();
  if (!s) throw new Error('sync_not_configured');
  const actionRec = require('../action-record.js');
  const db = state.db();
  const envelope = db.transaction(() => {
    const seq = _nextSeq(db);
    const env = {
      v: 1,
      event_id: actionRec.uuidv7(),
      device_id: s.deviceId,
      dev_seq: seq,
      parent_gseq: _lastGseq(db),
      op,
      op_v: 1,
      args: _jsonSafe(args),
      ctx: {
        agent_id: (ctx && ctx.agent_id) || null,
        user_id:  (ctx && ctx.user_id)  || 'default',
        cwd:      (ctx && ctx.cwd)      || null
      },
      hlc_ts: _nextHlc(db, s.deviceId),
      app_version: _appVersion()
    };
    db.prepare('INSERT INTO sync_outbox (dev_seq, event_id, envelope, created_at) VALUES (?, ?, ?, ?)')
      .run(seq, env.event_id, JSON.stringify(env), Date.now());
    return env;
  })();
  setImmediate(() => { flush().catch(() => {}); });
  return { ok: true, queued: true, id: envelope.event_id, event_id: envelope.event_id, dev_seq: envelope.dev_seq };
}

// Ship pending events, oldest first, one at a time. Any answer WITHOUT a
// gseq means the hub does not hold the event (unreachable, gap, version
// refusal) — the row stays and the flusher stops so order is preserved.
async function flush() {
  if (_flushing) return _flushing;
  _flushing = _flushLoop().finally(() => { _flushing = null; });
  return _flushing;
}

async function _flushLoop() {
  const s = _cfg();
  if (!s) return { flushed: 0 };
  const db = state.db();
  let n = 0;
  for (;;) {
    let row;
    try { row = db.prepare('SELECT dev_seq, event_id, envelope FROM sync_outbox WHERE sent_at IS NULL ORDER BY dev_seq LIMIT 1').get(); }
    catch (_) { return { flushed: n, blocked: 'outbox_unreadable' }; }
    if (!row) break;
    const res = await _postImpl(s, 'POST', '/api/sync/event', JSON.parse(row.envelope));
    _remember(row.event_id, res);
    if (!res || res.transport_error || !res.gseq) {
      return { flushed: n, blocked: (res && res.error) || 'unreachable', expected: res && res.expected };
    }
    db.transaction(() => {
      db.prepare('UPDATE sync_outbox SET sent_at = ?, gseq = ? WHERE dev_seq = ?').run(Date.now(), res.gseq, row.dev_seq);
      _kvSet(db, 'last_gseq', String(res.gseq));
    })();
    n++;
  }
  return { flushed: n };
}

function _remember(event_id, res) {
  _outcomes.set(event_id, res);
  if (_outcomes.size > 200) {
    const first = _outcomes.keys().next().value;
    _outcomes.delete(first);
  }
}

// Queue, flush, and hand back what the hub actually said — for interactive
// writes (rules) whose caller needs the real answer (similar_rules_exist).
// Offline, the answer is an honest "queued": the write is safe, the
// conversation about it happens when the mind machine returns.
async function writeThrough(op, args, ctx) {
  const q = queueWrite(op, args, ctx);
  const f = await flush();
  const res = _outcomes.get(q.event_id);
  if (res && res.gseq) {
    if (res.ok && res.result && typeof res.result === 'object') return res.result;
    return { ok: false, error: res.error || 'op_failed', detail: res.detail || null };
  }
  return {
    ok: false, queued: true, error: 'substrate_host_unreachable',
    detail: 'the mind machine is unreachable; the write is queued locally and ships when it answers',
    blocked: (f && f.blocked) || 'unreachable'
  };
}

// ── reads ────────────────────────────────────────────────────────────────

// Ask the hub. Errors come back as a value, not a throw — every caller is
// a tool surface that must render SOMETHING, and "the mind is unreachable"
// is the honest something.
async function readRemote(op, args, ctx) {
  const s = _cfg();
  if (!s) return { error: 'sync_not_configured' };
  const a = _jsonSafe(args);
  delete a.embedding_host;
  const res = await _postImpl(s, 'POST', '/api/sync/query', {
    op, args: a,
    ctx: {
      agent_id: (ctx && ctx.agent_id) || null,
      user_id:  (ctx && ctx.user_id)  || 'default',
      cwd:      (ctx && ctx.cwd)      || null
    }
  });
  if (res && res.ok) return res.result;
  return { error: (res && res.error) || 'substrate_host_unreachable' };
}

async function hello() {
  const s = _cfg();
  if (!s) return { error: 'sync_not_configured' };
  return await _postImpl(s, 'GET', '/api/sync/hello', null);
}

function status() {
  const s = _cfg();
  let pending = 0;
  try { pending = (state.db().prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE sent_at IS NULL').get() || {}).n || 0; }
  catch (_) {}
  return {
    active: active(),
    host: s ? s.host : null,
    device_id: s ? s.deviceId : null,
    pending,
    last_gseq: s ? _lastGseq(state.db()) : null
  };
}

// Pairing, satellite side: persist the hub coordinates, then prove them
// with a hello round-trip so a typo dies here and not at first recall.
async function connect(host, deviceId, deviceToken) {
  require('../config-file.js').patchConfig({ sync: { host, deviceId, deviceToken } });
  return await hello();
}

// Pairing by CODE — the one-string road. Decode, refuse pairing a machine
// with itself, then walk the candidate addresses until the mind answers;
// only an address that answered is written to config. The operator typed
// one paste, learned nothing, configured everything.
async function connectWithCode(code) {
  const pairing = require('./pairing.js');
  const p = pairing.decode(code);
  if (!p) return { ok: false, error: 'bad_pairing_code' };
  const mine = pairing.localIps();
  const foreign = p.hosts.filter((h) => {
    try { return !mine.has(new URL(h).hostname); } catch (_) { return false; }
  });
  if (!foreign.length) return { ok: false, error: 'self_pair', detail: 'this code points at THIS machine — it belongs on the other device' };
  for (const h of foreign) {
    const probe = await _postImpl({ host: h, deviceToken: p.token }, 'GET', '/api/sync/hello', null);
    if (probe && probe.ok) {
      require('../config-file.js').patchConfig({ sync: { host: h, deviceId: p.device_id, deviceToken: p.token } });
      return { ok: true, host: h, protocol: probe.protocol, latest_gseq: probe.latest_gseq };
    }
  }
  return { ok: false, error: 'no_host_answered', tried: foreign };
}

// ── transport ────────────────────────────────────────────────────────────

function _request(s, method, pathName, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(pathName, s.host); } catch (_) { return resolve({ transport_error: true, detail: 'bad_host' }); }
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const data = body == null ? null : JSON.stringify(body);
    const headers = { authorization: 'Bearer ' + s.deviceToken };
    if (data != null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const req = mod.request({
      method, hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, headers, timeout: 10000
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (_) { resolve({ transport_error: true, status: res.statusCode }); }
      });
      res.on('error', () => resolve({ transport_error: true }));
    });
    req.on('error', () => resolve({ transport_error: true }));
    req.on('timeout', () => { req.destroy(); resolve({ transport_error: true, detail: 'timeout' }); });
    if (data != null) req.write(data);
    req.end();
  });
}

function __setTransportForTests(fn) { _postImpl = fn || _request; }

module.exports = {
  active, queueWrite, writeThrough, flush, readRemote, hello, status, connect, connectWithCode,
  __setTransportForTests
};
