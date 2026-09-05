// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The plugin the host runs follows this checkout on its own. The proxy is the
// process every install keeps alive and it runs with the operator's
// environment, so at boot it compares the plugin version this tree ships
// with the version the host has installed and, when the host is behind,
// runs the host's own updater (`claude plugin update <name>@<marketplace>`).
// Nothing is written into the host's plugin root by hand; the updater is the
// road. Sessions already open keep their hooks until they restart, and the
// log says so.
const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnPurpose = require('../../shared-core/tools/spawn-purpose.js');

const REPO = path.join(__dirname, '..', '..');

function _json(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function _cmp(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// What this tree ships and what the host has: { name, marketplace, shipped,
// installed, install_path } (installed null when the host has no entry).
function versions(opts) {
  opts = opts || {};
  const home = opts.home || process.env.HOME || os.homedir();
  const manifest = _json(path.join(opts.repo || REPO, 'plugin', '.claude-plugin', 'plugin.json')) || {};
  const market = _json(path.join(opts.repo || REPO, '.claude-plugin', 'marketplace.json')) || {};
  const name = manifest.name || 'troth';
  const marketplace = market.name || 'troth';
  const installed = _json(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) || {};
  const entries = (installed.plugins || {})[name + '@' + marketplace];
  const entry = Array.isArray(entries) ? entries[0] : (entries || null);
  return {
    name, marketplace, shipped: manifest.version || null,
    installed: entry ? (entry.version || null) : null,
    install_path: entry ? (entry.installPath || null) : null
  };
}

// The host's command line, wherever the operator keeps it: the login shell's
// answer first (the proxy under a service manager has a bare PATH), then the
// usual places.
function hostCommand(opts) {
  opts = opts || {};
  try {
    const out = spawnPurpose.execFileSync('plugin-update', '/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 8000 });
    const p = String(out || '').trim().split('\n')[0];
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  const home = opts.home || process.env.HOME || os.homedir();
  for (const c of [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Runs the updater when the host is behind. Resolves to { action, ...versions,
// output } where action is 'current', 'not_installed', 'no_host', 'updated' or
// 'failed'.
function checkAndUpdate(opts) {
  opts = opts || {};
  const v = versions(opts);
  return new Promise((resolve) => {
    if (!v.installed) return resolve(Object.assign({ action: 'not_installed' }, v));
    if (!v.shipped || _cmp(v.installed, v.shipped) >= 0) return resolve(Object.assign({ action: 'current' }, v));
    const cmd = opts.command || hostCommand(opts);
    if (!cmd) return resolve(Object.assign({ action: 'no_host' }, v));
    let out = '', done = false;
    let child = null;
    try {
      child = spawnPurpose.spawn('plugin-update', cmd, ['plugin', 'update', v.name + '@' + v.marketplace], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (e) {
      return resolve(Object.assign({ action: 'failed', output: String(e && e.message || e) }, v));
    }
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGKILL'); } catch (_) {} } }, opts.timeout_ms || 120000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ action: 'failed', output: String(e && e.message || e) }, v)); });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const after = versions(opts);
      const ok = code === 0 && after.installed && _cmp(after.installed, v.shipped) >= 0;
      resolve(Object.assign({ action: ok ? 'updated' : 'failed', output: out.trim().slice(-600) }, after));
    });
  });
}

module.exports = { versions, hostCommand, checkAndUpdate, _cmp };
