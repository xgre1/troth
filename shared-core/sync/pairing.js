// SPDX-License-Identifier: AGPL-3.0-only
// The pairing code — everything a device needs to join its mind, as ONE
// string. The operator never learns what a device_id or a token is: the
// mind machine mints this code, the device swallows it whole. Inside:
// every candidate address the mind machine answers on (found here, not by
// the operator), the minted device identity, and the one-time token. The
// same string becomes a QR in the app; the format is versioned for that
// day.
//
//   troth1.<base64url of {"v":1,"h":[hosts...],"d":device_id,"t":token}>
'use strict';

const os = require('os');

const PREFIX = 'troth1.';

function encode(opts) {
  const body = {
    v: 1,
    h: Array.isArray(opts.hosts) ? opts.hosts.slice(0, 8) : [],
    d: String(opts.device_id || ''),
    t: String(opts.token || '')
  };
  return PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function decode(code) {
  const s = String(code || '').trim();
  if (!s.startsWith(PREFIX)) return null;
  try {
    const body = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (!body || body.v !== 1 || !body.d || !body.t || !Array.isArray(body.h) || !body.h.length) return null;
    return { hosts: body.h.map(String), device_id: String(body.d), token: String(body.t) };
  } catch (_) { return null; }
}

// Every address this machine answers on, best first: the VPN mesh address
// (Tailscale's CGNAT range) travels with the operator, so it leads; LAN
// ranges work at home; anything else trails. Loopback never qualifies —
// a pairing code full of 127.0.0.1 pairs a device with itself.
function candidateHosts(port) {
  const p = port || 8000;
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.internal || a.family !== 'IPv4' || !a.address) continue;
      out.push(a.address);
    }
  }
  const rank = (ip) => {
    const [o1, o2] = ip.split('.').map(Number);
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return 0;                  // Tailscale / CGNAT mesh
    if (o1 === 192 && o2 === 168) return 1;                              // home LAN
    if (o1 === 10) return 1;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a) - rank(b));
  return out.map((ip) => 'http://' + ip + ':' + p);
}

// The self-pair guard's ground truth: is this hostname one of OUR addresses?
function localIps() {
  const set = new Set(['127.0.0.1', 'localhost', '::1']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.address) set.add(a.address);
    }
  }
  return set;
}

module.exports = { encode, decode, candidateHosts, localIps, PREFIX };
