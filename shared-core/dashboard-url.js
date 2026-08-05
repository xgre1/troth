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
function proxyBaseUrl() {
  const fromEnv = String(process.env.TROTH_PROXY_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const a = dashboardAddress();
  return 'http://' + a.host + ':' + a.port;
}

module.exports = { dashboardAddress, dashboardUrl, proxyBaseUrl };
