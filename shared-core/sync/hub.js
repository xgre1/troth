// SPDX-License-Identifier: AGPL-3.0-only
// The hub side of substrate sync: sequence, apply, answer.
//
// This machine holds the mind; paired devices reach it as journal events
// over HTTP (the proxy carries the routes, this module is the contract):
//
//   - arrival order IS the order: every accepted event gets the next gseq;
//     nothing is ever spliced into the past by its timestamp. A late
//     offline event lands at the end, and the claims dispute lane — not
//     the clock — is what catches a stale write overtaking a newer one.
//   - per-device watermark: dev_seq at-or-below the watermark is a replay,
//     answered from the journal without re-applying; plus-one is accepted;
//     anything further is a gap the device must resend.
//   - a KNOWN op that fails still advances the watermark with its failure
//     recorded — otherwise the device would resend it forever.
//   - an UNKNOWN op (or a future op_v) advances nothing: the hub must be
//     taught a new op before any device may emit it, so the honest answer
//     is a typed refusal the device can show the operator.
//   - applies are serialized — one event at a time. The journal insert and
//     the watermark advance commit atomically; the outcome is written the
//     moment the op returns.
//
// Crash honesty: the outcome lands in a second step because op handlers may
// await (embedding enrichment happens here, on the mind machine). A crash
// between the two steps leaves outcome NULL; the device's resend re-runs
// the op and fills it. That is at-least-once healed by domain-level dedup
// (dialogue's content window, engram verify, rule similarity) — written
// down so nobody later mistakes it for exactly-once and removes those
// guards.
'use strict';

const state = require('../state.js');
const catalogue = require('./catalogue.js');
const hlc = require('./hlc.js');

const PROTOCOL_V = 1;
const HLC_FUTURE_CLAMP_MS = 5 * 60 * 1000;

let _chain = Promise.resolve();

// Serialize applies: state machine replication needs one writer, and the
// journal insert plus the op side-effects must never interleave.
function applyEvent(envelope) {
  const run = () => _apply(envelope);
  const p = _chain.then(run, run);
  _chain = p.then(() => {}, () => {});
  return p;
}

function _bad(error, extra) { return Object.assign({ ok: false, error }, extra || {}); }

async function _apply(env) {
  if (!env || typeof env !== 'object') return _bad('bad_envelope');
  const event_id  = typeof env.event_id === 'string' && env.event_id.length >= 8 ? env.event_id : null;
  const device_id = typeof env.device_id === 'string' && env.device_id ? env.device_id : null;
  const dev_seq   = Number.isInteger(env.dev_seq) && env.dev_seq >= 1 ? env.dev_seq : null;
  const op        = typeof env.op === 'string' && env.op ? env.op : null;
  if (!event_id || !device_id || !dev_seq || !op) return _bad('bad_envelope');
  const args = (env.args && typeof env.args === 'object' && !Array.isArray(env.args)) ? env.args : {};
  const ctx  = (env.ctx && typeof env.ctx === 'object') ? env.ctx : {};
  const op_v = Number.isInteger(env.op_v) ? env.op_v : 1;

  const db = state.db();
  const device = db.prepare('SELECT device_id, last_dev_seq, revoked_at FROM sync_devices WHERE device_id = ?').get(device_id);
  if (!device || device.revoked_at) return _bad('unknown_device');

  // Replay: answer from the journal. Re-run only to heal the crash window
  // (a reserved row whose outcome never landed).
  if (dev_seq <= device.last_dev_seq) {
    const prior = db.prepare(
      'SELECT gseq, event_id, op, op_v, args, ctx, outcome FROM sync_events WHERE device_id = ? AND dev_seq = ?'
    ).get(device_id, dev_seq);
    if (!prior) return _bad('watermark_ahead_of_journal', { dev_seq });
    if (prior.event_id !== event_id) return _bad('event_id_mismatch', { dev_seq });
    if (prior.outcome != null) {
      return Object.assign(JSON.parse(prior.outcome), { gseq: prior.gseq, replayed: true });
    }
    let pArgs = {}; let pCtx = {};
    try { pArgs = JSON.parse(prior.args) || {}; } catch (_) {}
    try { pCtx = prior.ctx ? (JSON.parse(prior.ctx) || {}) : {}; } catch (_) {}
    return _finish({ gseq: prior.gseq, op: prior.op, op_v: prior.op_v }, pArgs, pCtx, device_id, true, null);
  }
  if (dev_seq > device.last_dev_seq + 1) {
    return _bad('sequence_gap', { expected: device.last_dev_seq + 1 });
  }

  const resolved = catalogue.getOp(op, op_v);
  if (resolved.error) {
    return _bad(resolved.error, { versionType: resolved.versionType, op, supported: resolved.supported });
  }
  if (resolved.entry.kind !== 'write') return _bad('not_a_write_op', { op });

  // Intent-time sanity: a stamp from the future is recorded as suspect,
  // never rejected — the clock is metadata and must not gate the write.
  let hlc_flag = null;
  const stamp = typeof env.hlc_ts === 'string' ? hlc.parse(env.hlc_ts) : null;
  if (stamp && stamp.ms > Date.now() + HLC_FUTURE_CLAMP_MS) hlc_flag = 'future_stamp';

  // Reserve: journal row + watermark advance, atomically. From this point
  // the event EXISTS with its gseq and can never be accepted twice.
  const row = {
    event_id, device_id, dev_seq,
    parent_gseq: Number.isInteger(env.parent_gseq) ? env.parent_gseq : null,
    op, op_v,
    args: JSON.stringify(args),
    ctx:  JSON.stringify({
      agent_id: ctx.agent_id || null,
      user_id:  ctx.user_id  || null,
      cwd:      ctx.cwd      || null
    }),
    hlc_ts: typeof env.hlc_ts === 'string' ? env.hlc_ts : null,
    app_version: typeof env.app_version === 'string' ? env.app_version : null,
    received_at: Date.now()
  };
  let gseq;
  try {
    gseq = db.transaction(() => {
      const r = db.prepare(
        'INSERT INTO sync_events (event_id, device_id, dev_seq, parent_gseq, op, op_v, args, ctx, hlc_ts, app_version, received_at) ' +
        'VALUES (@event_id, @device_id, @dev_seq, @parent_gseq, @op, @op_v, @args, @ctx, @hlc_ts, @app_version, @received_at)'
      ).run(row);
      db.prepare('UPDATE sync_devices SET last_dev_seq = ? WHERE device_id = ?').run(dev_seq, device_id);
      return Number(r.lastInsertRowid);
    })();
  } catch (e) {
    return _bad('journal_insert_failed', { detail: String(e && e.message || e).slice(0, 300) });
  }

  return _finish({ gseq, op, op_v }, args, ctx, device_id, false, hlc_flag);
}

// Run the op and write its outcome onto the reserved journal row.
async function _finish(rowRef, args, ctx, device_id, replayed, hlc_flag) {
  const resolved = catalogue.getOp(rowRef.op, rowRef.op_v || 1);
  let outcome;
  if (resolved.error) {
    outcome = { ok: false, error: resolved.error };
  } else {
    try {
      const result = await resolved.entry.run(args, {
        agent_id: (ctx && ctx.agent_id) || ('device:' + device_id),
        user_id:  (ctx && ctx.user_id)  || 'default',
        cwd:      (ctx && ctx.cwd)      || null,
        device_id,
        event_id: null,
        embedding_host: _embeddingHost()
      });
      outcome = { ok: true, result };
    } catch (e) {
      outcome = { ok: false, error: 'op_failed', detail: String(e && e.message || e).slice(0, 500) };
    }
  }
  if (hlc_flag) outcome.hlc_flag = hlc_flag;
  try {
    state.db().prepare('UPDATE sync_events SET outcome = ? WHERE gseq = ?').run(JSON.stringify(outcome), rowRef.gseq);
  } catch (_) { /* the response still carries the outcome */ }
  return Object.assign({}, outcome, { gseq: rowRef.gseq, replayed: !!replayed });
}

function _embeddingHost() {
  try { return require('../transport-config.js').embeddingHost(); }
  catch (_) { return null; }
}

async function runQuery(op, args, ctx) {
  const resolved = catalogue.getOp(op, 1);
  if (resolved.error) return _bad(resolved.error, { op });
  if (resolved.entry.kind !== 'read') return _bad('not_a_read_op', { op });
  try {
    const result = await resolved.entry.run(args || {}, Object.assign({ user_id: 'default' }, ctx || {}));
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: 'query_failed', detail: String(e && e.message || e).slice(0, 500) };
  }
}

function hello() {
  let latest = 0;
  try {
    const r = state.db().prepare('SELECT MAX(gseq) AS g FROM sync_events').get();
    latest = (r && r.g) || 0;
  } catch (_) { /* fresh substrate — journal empty */ }
  return { ok: true, protocol: PROTOCOL_V, ops: catalogue.describe(), latest_gseq: latest };
}

// ── Device pairing — shared by the CLI and, later, the dashboard ─────────

function _hash(token) {
  return require('crypto').createHash('sha256').update(String(token)).digest('hex');
}

// The raw token exists exactly once, in this return value. Only its sha256
// touches disk.
function addDevice(name) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('base64url');
  const device_id = 'dev_' + crypto.randomBytes(4).toString('hex');
  state.db().prepare(
    'INSERT INTO sync_devices (device_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)'
  ).run(device_id, String(name || device_id).slice(0, 80), _hash(token), Date.now());
  return { device_id, token };
}

function authDevice(token) {
  if (!token) return null;
  try {
    const row = state.db().prepare(
      'SELECT device_id, name, revoked_at FROM sync_devices WHERE token_hash = ?'
    ).get(_hash(token));
    return row && !row.revoked_at ? row : null;
  } catch (_) { return null; }
}

function listDevices() {
  try {
    return state.db().prepare(
      'SELECT device_id, name, last_dev_seq, created_at, revoked_at FROM sync_devices ORDER BY created_at'
    ).all();
  } catch (_) { return []; }
}

function revokeDevice(device_id) {
  const r = state.db().prepare(
    'UPDATE sync_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL'
  ).run(Date.now(), device_id);
  return r.changes > 0;
}

module.exports = { applyEvent, runQuery, hello, addDevice, authDevice, listDevices, revokeDevice, PROTOCOL_V };
