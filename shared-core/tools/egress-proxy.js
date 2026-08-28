// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// egress-proxy.js — the one road out of an install jail.
//
// The kernel profile can grant a single loopback port and nothing else
// (measured both ways: the grant connects, a live listener one port over is
// refused). This module is what listens on that port: a minimal HTTP proxy —
// CONNECT tunnels for TLS, absolute-URI forwarding for plain HTTP — that
// admits the package registries and refuses everything else by host. It
// lives INSIDE the host process, where the jail cannot reach it, starts with
// the process and dies with it: policy in memory, no daemon, no config the
// jailed child could edit.
//
// No interception happens inside a tunnel: the client's TLS runs end to end
// to the registry. What this filters is WHERE a connection may go, which is
// exactly the boundary the jail's kernel rule cannot express per host.
//
// The proxy itself must not become the way back in: a jailed child asking
// the proxy for a loopback or private-range target would undo the jail's
// own network wall from the outside, so targets are resolved FIRST and
// refused when the address lands in a range the jail exists to protect —
// whatever name carried it there.

const net = require('net');
const dns = require('dns');

// The registries the default install allowlist admits. Host names only —
// a name admits ports 443 and 80; a 'host:port' entry admits that port.
const DEFAULT_REGISTRY_HOSTS = Object.freeze([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'crates.io', 'static.crates.io', 'index.crates.io',
  'repo.packagist.org'
]);

const HEAD_CAP = 16 * 1024;

function _privateAddress(ip) {
  if (typeof ip !== 'string') return true;
  if (ip.indexOf(':') !== -1) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
    if (v6.startsWith('::ffff:')) return _privateAddress(v6.slice(7));
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  return false;
}

// Exact entry, or '*.suffix' matching on a label boundary — 'evil-npmjs.org'
// is not under '*.npmjs.org' and never will be. Entries may pin a port.
function hostAllowed(host, port, allow) {
  if (typeof host !== 'string' || !host.length) return false;
  const h = host.toLowerCase();
  for (const raw of allow || []) {
    const entry = String(raw).toLowerCase();
    const cut = entry.lastIndexOf(':');
    const entryHost = (cut > 0 && /^\d+$/.test(entry.slice(cut + 1))) ? entry.slice(0, cut) : entry;
    const entryPort = entryHost === entry ? null : Number(entry.slice(cut + 1));
    const portOk = entryPort === null ? (port === 443 || port === 80) : port === entryPort;
    if (!portOk) continue;
    if (entryHost === h) return true;
    if (entryHost.startsWith('*.') && (h === entryHost.slice(2) || h.endsWith(entryHost.slice(1)))) return true;
  }
  return false;
}

function _writeRefusal(socket) {
  try { socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); }
  catch (_) { try { socket.destroy(); } catch (_2) {} }
}

// startEgressProxy({ allow, allowLoopbackTargets, onRefusal })
//   → Promise<{ port, close(), refusalsSince(ts) }>
// The listener binds loopback on an ephemeral port. Refusals are kept in a
// bounded ring with timestamps so a caller can attach "what was refused
// while this command ran" to the command's own result.
function startEgressProxy(opts) {
  opts = opts || {};
  const allow = Array.isArray(opts.allow) ? opts.allow.slice() : DEFAULT_REGISTRY_HOSTS.slice();
  const refusals = [];
  const note = (host) => {
    refusals.push({ host: String(host).slice(0, 200), ts: Date.now() });
    if (refusals.length > 200) refusals.shift();
    if (typeof opts.onRefusal === 'function') { try { opts.onRefusal(host); } catch (_) {} }
  };

  // A name is not a place. The allowlist admits the NAME; every resolved
  // address is then vetted, and the connection goes to a vetted address
  // only — never back through the resolver, which would reopen the window
  // between the check and the connect. Dual-stack names answer on either
  // family, so the vetted addresses are tried in turn, IPv4 first.
  const admit = (host, port, cb) => {
    if (!hostAllowed(host, port, allow)) return cb(false);
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err || !Array.isArray(addrs) || !addrs.length) return cb(false);
      const vetted = addrs
        .filter((a) => !_privateAddress(a.address) || opts.allowLoopbackTargets === true)
        .sort((a, b) => a.family - b.family)
        .map((a) => a.address);
      if (!vetted.length) return cb(false);
      cb(true, vetted);
    });
  };

  const connectVetted = (addresses, port, onOpen, onFail) => {
    const next = (i) => {
      if (i >= addresses.length) return onFail();
      const up = net.connect({ host: addresses[i], port }, () => onOpen(up));
      up.on('error', () => { try { up.destroy(); } catch (_) {} next(i + 1); });
    };
    next(0);
  };

  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    let done = false;
    client.on('error', () => {});
    client.on('data', (chunk) => {
      if (done) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > HEAD_CAP) { done = true; client.destroy(); }
        return;
      }
      done = true;
      client.pause();
      const rest = head.slice(end + 4);
      const lines = head.slice(0, end).toString('latin1').split('\r\n');
      const m = /^(\S+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(lines[0] || '');
      if (!m) { client.destroy(); return; }
      const method = m[1].toUpperCase();

      if (method === 'CONNECT') {
        const t = /^([^:\s]+):(\d+)$/.exec(m[2]);
        if (!t) { _writeRefusal(client); return; }
        const host = t[1], port = Number(t[2]);
        admit(host, port, (ok, addresses) => {
          if (!ok) { note(host + ':' + port); _writeRefusal(client); return; }
          connectVetted(addresses, port, (up) => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (rest.length) up.write(rest);
            client.pipe(up); up.pipe(client);
            client.resume();
            up.on('error', () => { try { client.destroy(); } catch (_) {} });
            client.on('close', () => { try { up.destroy(); } catch (_) {} });
          }, () => { try { client.destroy(); } catch (_) {} });
        });
        return;
      }

      // Plain-HTTP forwarding: absolute URI only, which is what a client
      // speaking THROUGH a proxy sends. The head is replayed verbatim to
      // the origin; the path stays absolute, which origins accept.
      const u = /^http:\/\/([^:\/\s]+)(?::(\d+))?(\/|$)/i.exec(m[2]);
      if (!u) { _writeRefusal(client); return; }
      const host = u[1], port = u[2] ? Number(u[2]) : 80;
      admit(host, port, (ok, addresses) => {
        if (!ok) { note(host + ':' + port); _writeRefusal(client); return; }
        connectVetted(addresses, port, (up) => {
          up.write(head.slice(0, end + 4));
          if (rest.length) up.write(rest);
          client.pipe(up); up.pipe(client);
          client.resume();
          up.on('error', () => { try { client.destroy(); } catch (_) {} });
          client.on('close', () => { try { up.destroy(); } catch (_) {} });
        }, () => { try { client.destroy(); } catch (_) {} });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => { try { server.close(); } catch (_) {} },
        refusalsSince: (ts) => refusals.filter((r) => r.ts >= ts).map((r) => r.host)
      });
    });
  });
}

module.exports = { startEgressProxy, hostAllowed, DEFAULT_REGISTRY_HOSTS, _privateAddress };
