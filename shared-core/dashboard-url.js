// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One answer to "where is the dashboard".
//
// Three places printed http://localhost:8000/ui as a literal — the CLI help,
// the init walkthrough, and the message shown when no engine answered. The
// proxy moves off its port when that port is taken, and the operator can set
// host and port in config, so on any machine that had moved, every one of
// those instructions sent the reader to a dead tab. Nothing here probes the
// network: it reports what the operator configured, which is what the proxy
// starts from.
const fs = require('fs');
const os = require('os');
const path = require('path');

function readConfig() {
  try {
    const p = process.env.TROTH_CONFIG_PATH ||
      path.join(process.env.HOME || os.homedir(), '.troth', 'config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) { return {}; }
}

/** { host, port } as configured, with the historical defaults. */
function dashboardAddress() {
  const c = readConfig();
  const envUrl = String(process.env.TROTH_PROXY_URL || '').trim();
  if (envUrl) {
    const m = envUrl.match(/^https?:\/\/([^:/]+)(?::(\d+))?/);
    if (m) return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 80 };
  }
  return {
    host: (typeof c.host === 'string' && c.host) ? c.host : 'localhost',
    port: parseInt(c.port, 10) || 8000,
  };
}

// e.g. http:// + host + port + /ui — pass a path to append.
function dashboardUrl(suffix) {
  const { host, port } = dashboardAddress();
  return 'http://' + host + ':' + port + (suffix || '/ui');
}

// The proxy's base URL for code that talks to it rather than links to it.
// Five call sites each wrote `TROTH_PROXY_URL || 'http://127.0.0.1:8000'`,
// which honours the env the app sets but ignores the host and port the operator
// put in config — so a configured or displaced proxy was reachable by the app
// and unreachable by everything else.
//
// The fallback is the loopback LITERAL, not the name. `localhost` resolves to
// ::1 before 127.0.0.1 on macOS, and the proxy binds 127.0.0.1 only, so a
// connection by name reaches a port nobody is listening on. A browser retries
// the other family and a person never notices; an HTTP client takes the first
// answer and fails. dashboardUrl() may say localhost — it is read by a human.
// This is dialled by a program, so it says the address.
// The ports a proxy actually HOLDS right now. The proxy writes
// proxy-<port>.pid at bind and unlinks it on exit; a pid that still
// answers signal-0 marks a living proxy. Every SNAPSHOT of the address
// (spawn env, saved config, adopted-at-boot cells) each went stale across
// consecutive boots (field-verified 2026-08-15) — races handed daemons a port that died a
// second later, and every engine read as offline. The pid file is written
// by the bound process itself; it cannot lie about where the proxy lives.
function liveProxyPorts() {
  const out = [];
  try {
    const dir = path.join(process.env.HOME || os.homedir(), '.troth');
    for (const f of fs.readdirSync(dir)) {
      const m = /^proxy-(\d+)\.pid$/.exec(f);
      if (!m) continue;
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(path.join(dir, f), 'utf8'), 10); } catch (_) { continue; }
      if (!pid) continue;
      try { process.kill(pid, 0); out.push(parseInt(m[1], 10)); } catch (_) { /* stale pid file */ }
    }
  } catch (_) { /* no dir / unreadable — fall through to snapshots */ }
  return out.sort((a, b) => a - b);
}

function proxyBaseUrl() {
  const fromEnv = String(process.env.TROTH_PROXY_URL || '').trim().replace(/\/+$/, '');
  const live = liveProxyPorts();
  if (fromEnv) {
    const m = /:(\d+)(?:\/|$)/.exec(fromEnv);
    const envPort = m ? parseInt(m[1], 10) : null;
    // An env URL whose port is actually held wins — explicit choice,
    // verified alive. An env URL pointing at a DEAD port while a living
    // proxy exists is last boot's snapshot: follow the living.
    if (!live.length || (envPort && live.indexOf(envPort) !== -1)) return fromEnv;
    return 'http://127.0.0.1:' + live[0];
  }
  if (live.length) return 'http://127.0.0.1:' + live[0];
  const c = readConfig();
  const host = (typeof c.host === 'string' && c.host) ? c.host : '127.0.0.1';
  const port = parseInt(c.port, 10) || 8000;
  return 'http://' + host + ':' + port;
}

module.exports = { dashboardAddress, dashboardUrl, proxyBaseUrl };
