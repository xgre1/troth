// SPDX-License-Identifier: AGPL-3.0-only
// Mind discovery on the local network — the AirPods moment.
//
// A machine that keeps its own mind announces itself with a tiny UDP
// broadcast every few seconds; every troth install listens. The Network
// card then shows "minds near you" as rows with a Follow button instead
// of asking a person to know an IP. Pairing codes remain the road BETWEEN
// networks (a broadcast does not cross a tailnet); this is the road
// WITHIN one.
//
// The beacon carries a name and a port — never a token, never memory.
// Hearing a beacon grants nothing: following still goes through the
// operator's explicit approval on the mind machine.
'use strict';

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = parseInt(process.env.TROTH_SYNC_DISCOVERY_PORT || '47800', 10);
const BEACON_MS = 5000;
const PEER_TTL_MS = 16000;

let _sock = null;
let _beaconTimer = null;
const _peers = new Map(); // host -> { name, host, port, seen }

function _localIps() {
  const set = new Set(['127.0.0.1', '::1']);
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces)) for (const a of ifaces[n] || []) if (a.address) set.add(a.address);
  return set;
}

function encodeBeacon(name, port) {
  return Buffer.from(JSON.stringify({ t: 'troth-mind', v: 1, name: String(name).slice(0, 40), port: port | 0 }), 'utf8');
}

function parseBeacon(buf) {
  try {
    const m = JSON.parse(buf.toString('utf8'));
    if (!m || m.t !== 'troth-mind' || m.v !== 1 || !m.port) return null;
    return { name: String(m.name || 'troth'), port: m.port | 0 };
  } catch (_) { return null; }
}

function noteBeacon(msg, fromHost, selfIps) {
  const b = parseBeacon(msg);
  if (!b) return false;
  if ((selfIps || _localIps()).has(fromHost)) return false; // our own echo
  _peers.set(fromHost, { name: b.name, host: fromHost, port: b.port, seen: Date.now() });
  return true;
}

function nearby() {
  const now = Date.now();
  const out = [];
  for (const [host, p] of _peers) {
    if (now - p.seen > PEER_TTL_MS) { _peers.delete(host); continue; }
    out.push({ name: p.name, host: p.host, port: p.port, seen_ms_ago: now - p.seen });
  }
  out.sort((a, b) => a.seen_ms_ago - b.seen_ms_ago);
  return out;
}

// start({ name, port, shouldBeacon }) — always listens; beacons only while
// shouldBeacon() answers true (a satellite has no mind to announce, and a
// loopback-bound proxy has no reachable door to announce).
function start(opts) {
  if (_sock) return { ok: true, already: true };
  const name = (opts && opts.name) || os.hostname().replace(/\.local$/, '');
  const port = (opts && opts.port) || 8000;
  const shouldBeacon = (opts && opts.shouldBeacon) || (() => false);
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => { try { sock.close(); } catch (_) {} if (_sock === sock) _sock = null; });
    sock.on('message', (msg, rinfo) => { noteBeacon(msg, rinfo.address); });
    sock.bind(DISCOVERY_PORT, () => {
      try { sock.setBroadcast(true); } catch (_) {}
    });
    _sock = sock;
    _beaconTimer = setInterval(() => {
      if (!_sock) return;
      let on = false;
      try { on = !!shouldBeacon(); } catch (_) { on = false; }
      if (!on) return;
      const b = encodeBeacon(name, port);
      try { _sock.send(b, 0, b.length, DISCOVERY_PORT, '255.255.255.255'); } catch (_) {}
    }, BEACON_MS);
    if (_beaconTimer.unref) _beaconTimer.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function stop() {
  if (_beaconTimer) { clearInterval(_beaconTimer); _beaconTimer = null; }
  if (_sock) { try { _sock.close(); } catch (_) {} _sock = null; }
  _peers.clear();
}

module.exports = { start, stop, nearby, encodeBeacon, parseBeacon, noteBeacon, DISCOVERY_PORT };
