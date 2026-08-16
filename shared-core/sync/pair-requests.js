// SPDX-License-Identifier: AGPL-3.0-only
// Pairing requests — knocking on the mind's door.
//
// A device that found a mind nearby ASKS; the operator on the mind machine
// APPROVES; only then is a device credential minted, and the pairing code
// is handed back exactly once, to the asking address. Nothing about
// hearing a beacon or knocking grants anything: the human click is the
// gate. In-memory on purpose — a pending knock is worthless after ten
// minutes and should not survive a restart.
'use strict';

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5;
const MAX_PENDING_PER_IP = 2;

const _requests = new Map(); // id -> { id, name, from_ip, ts, status, code }

function _sweep() {
  const now = Date.now();
  for (const [id, r] of _requests) {
    if (now - r.ts > REQUEST_TTL_MS) _requests.delete(id);
  }
}

function create(name, from_ip) {
  _sweep();
  const pending = [..._requests.values()].filter((r) => r.status === 'pending');
  if (pending.length >= MAX_PENDING) return { error: 'too_many_pending' };
  if (pending.filter((r) => r.from_ip === from_ip).length >= MAX_PENDING_PER_IP) return { error: 'too_many_pending' };
  const id = require('../action-record.js').uuidv7();
  const r = {
    id,
    name: String(name || 'device').replace(/[^\w .-]/g, '').slice(0, 40) || 'device',
    from_ip: String(from_ip || ''),
    ts: Date.now(),
    status: 'pending',
    code: null
  };
  _requests.set(id, r);
  return { id };
}

function listPending() {
  _sweep();
  return [..._requests.values()]
    .filter((r) => r.status === 'pending')
    .map((r) => ({ id: r.id, name: r.name, from_ip: r.from_ip, ts: r.ts }));
}

// The operator said yes: mint the device and cut its pairing code. The code
// waits in the request for the asker's next status poll.
function approve(id, mint) {
  const r = _requests.get(id);
  if (!r || r.status !== 'pending') return { error: 'no_such_request' };
  const minted = mint(r.name);
  r.status = 'approved';
  r.code = minted.code;
  r.device_id = minted.device_id;
  return { ok: true, device_id: minted.device_id };
}

function deny(id) {
  const r = _requests.get(id);
  if (!r || r.status !== 'pending') return { error: 'no_such_request' };
  r.status = 'denied';
  return { ok: true };
}

// Answering a poll. The code leaves this store exactly once, and only
// toward the address that knocked.
function statusFor(id, from_ip) {
  _sweep();
  const r = _requests.get(id);
  if (!r) return { status: 'unknown' };
  if (r.from_ip && from_ip && r.from_ip !== from_ip) return { status: 'unknown' };
  if (r.status === 'approved' && r.code) {
    const code = r.code;
    r.code = null;
    return { status: 'approved', code };
  }
  return { status: r.status };
}

function _resetForTests() { _requests.clear(); }


// ── Invites — the mind knocks first ──────────────────────────────────────
//
// The mirror of a knock: the operator at the MIND machine sees a device
// nearby and invites it. The invite id is the approval itself (the human
// clicked Invite), so redeeming it mints the device credential in one
// step; it is one-time and it expires like a knock. The device side keeps
// the invites it has received so ITS operator gets the same human click
// (Join) before anything connects.

const _invites = new Map();         // mind side: id -> { ts, status }
const _receivedInvites = new Map(); // device side: id -> { mind_name, hosts, ts }

function createInvite() {
  for (const [id, inv] of _invites) if (Date.now() - inv.ts > REQUEST_TTL_MS) _invites.delete(id);
  if (_invites.size >= MAX_PENDING) return { error: 'too_many_pending' };
  const id = require('../action-record.js').uuidv7();
  _invites.set(id, { ts: Date.now(), status: 'open' });
  return { id };
}

// The device redeems: the invite IS the approval, so mint now — exactly once.
function redeemInvite(id, mint) {
  const inv = _invites.get(id);
  if (!inv || inv.status !== 'open' || Date.now() - inv.ts > REQUEST_TTL_MS) return { error: 'no_such_invite' };
  inv.status = 'redeemed';
  const minted = mint();
  return { ok: true, code: minted.code, device_id: minted.device_id };
}

function noteInvite(payload, from_ip) {
  for (const [id, inv] of _receivedInvites) if (Date.now() - inv.ts > REQUEST_TTL_MS) _receivedInvites.delete(id);
  if (_receivedInvites.size >= MAX_PENDING) return { error: 'too_many_pending' };
  const id = String(payload && payload.invite_id || '');
  const hosts = Array.isArray(payload && payload.hosts) ? payload.hosts.map(String).slice(0, 8) : [];
  if (!id || id.length < 8 || !hosts.length) return { error: 'bad_invite' };
  _receivedInvites.set(id, {
    invite_id: id,
    mind_name: String(payload.mind_name || 'a mind').replace(/[^\w .-]/g, '').slice(0, 40),
    hosts,
    from_ip: String(from_ip || ''),
    ts: Date.now()
  });
  return { ok: true };
}

function listInvites() {
  for (const [id, inv] of _receivedInvites) if (Date.now() - inv.ts > REQUEST_TTL_MS) _receivedInvites.delete(id);
  return [..._receivedInvites.values()];
}

function takeInvite(id) {
  const inv = _receivedInvites.get(id);
  if (inv) _receivedInvites.delete(id);
  return inv || null;
}

module.exports = { create, listPending, approve, deny, statusFor, createInvite, redeemInvite, noteInvite, listInvites, takeInvite, _resetForTests };

