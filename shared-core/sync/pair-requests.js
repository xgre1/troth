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

module.exports = { create, listPending, approve, deny, statusFor, _resetForTests };
