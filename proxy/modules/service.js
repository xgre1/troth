// SPDX-License-Identifier: AGPL-3.0-only
// Login service management: run the proxy as a user-level service so troth
// is up from login without a terminal. launchd on macOS, systemd --user on
// Linux. Everything is user-scoped (LaunchAgents / systemd user units), no
// sudo anywhere. Shared by `troth service` and the dashboard's toggle, so
// the CLI and the switch can never disagree about what installed means.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'one.troth.proxy';

function paths() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return { kind: 'launchd', unit: path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist') };
  }
  if (process.platform === 'linux') {
    return { kind: 'systemd', unit: path.join(home, '.config', 'systemd', 'user', 'troth-proxy.service') };
  }
  return { kind: null, unit: null };
}

// macOS names a background item after the executable it runs; pointing
// launchd at the bare node binary made the alert say "node" can run in the
// background. The agent runs through this shim instead, so the item says
// troth. Linux does not need it: systemd shows the unit name.
function writeShim(node, server) {
  const dir = path.join(os.homedir(), '.troth', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'troth');
  fs.writeFileSync(shim,
    '#!/bin/sh\n' +
    '# troth login-service shim: gives the background item its real name.\n' +
    'exec "' + node + '" "' + server + '"\n');
  fs.chmodSync(shim, 0o755);
  return shim;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function install(opts) {
  opts = opts || {};
  const p = paths();
  if (!p.kind) return { ok: false, error: 'unsupported platform: ' + process.platform };
  const node = process.execPath;
  const server = path.join(__dirname, '..', 'server.js');
  const port = String(opts.port || process.env.GF_PORT || 8000);
  // The service used to run out of the operator's home directory, and the
  // boot-time project scan therefore walked their whole home tree. From a
  // terminal that is merely wasteful; from a launchd background agent it
  // hangs, because a background job has none of the folder permissions a
  // terminal has inherited, and the synchronous directory read blocks on the
  // first protected or cloud-backed folder it meets. The port was already
  // bound by then, so the proxy looked alive and answered nothing: the
  // operator had the service switched on and no working recall, saves, or
  // tools, with a green light and an empty log. Root the service in troth's
  // own directory, which is the only tree it has any business indexing.
  const workDir = path.dirname(server);
  const logPath = path.join(os.homedir(), '.troth', 'service.log');
  fs.mkdirSync(path.dirname(p.unit), { recursive: true });
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}
  // Pre-create the log 0600 and repair an existing one. launchd creates the
  // StandardOutPath file itself with a default umask — 644 — which made
  // service.log the one world-readable file in a directory where every
  // sibling secret is 600. The console redactor keeps secrets out of it on
  // the happy path, but a log's permissions must not depend on a redactor
  // never missing. Append-flag so an existing log is never truncated.
  try { fs.writeFileSync(logPath, '', { flag: 'a', mode: 0o600 }); fs.chmodSync(logPath, 0o600); } catch (_) {}
  if (p.kind === 'launchd') {
    // KeepAlive is unconditional, and it has to be. The previous setting
    // restarted only on an UNSUCCESSFUL exit, which sounds prudent and is
    // in fact fatal: this proxy answers SIGTERM by flushing stats and
    // calling process.exit(0). Every polite stop, including the one
    // `troth restart` performs and the one a sibling proxy sends at boot,
    // therefore looked like a job that had finished its work, so launchd
    // left it dead. The operator had switched the background service ON and
    // silently had no proxy: recall, saves, and every plugin tool that
    // routes through it stopped working with nothing to see. Always-on has
    // to mean always. Turning the service OFF is a separate, deliberate act
    // (uninstall below unloads the job), which is the honest place for it.
    const shim = writeShim(node, server);
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '  <key>Label</key><string>' + LABEL + '</string>\n' +
      '  <key>ProgramArguments</key><array>\n' +
      '    <string>' + xmlEscape(shim) + '</string>\n' +
      '  </array>\n' +
      '  <key>EnvironmentVariables</key><dict>\n' +
      '    <key>GF_PORT</key><string>' + xmlEscape(port) + '</string>\n' +
      '  </dict>\n' +
      '  <key>RunAtLoad</key><true/>\n' +
      '  <key>KeepAlive</key><true/>\n' +
      '  <key>StandardOutPath</key><string>' + xmlEscape(logPath) + '</string>\n' +
      '  <key>StandardErrorPath</key><string>' + xmlEscape(logPath) + '</string>\n' +
      '  <key>WorkingDirectory</key><string>' + xmlEscape(workDir) + '</string>\n' +
      '</dict></plist>\n';
    fs.writeFileSync(p.unit, plist);
    try { execFileSync('launchctl', ['unload', p.unit], { stdio: 'pipe' }); } catch (_) {}
    execFileSync('launchctl', ['load', '-w', p.unit], { stdio: 'pipe' });
    return { ok: true, kind: p.kind, unit: p.unit };
  }
  const unitText = '[Unit]\n' +
    'Description=troth proxy\n' +
    'After=network.target\n\n' +
    '[Service]\n' +
    'ExecStart="' + node + '" "' + server + '"\n' +
    'Environment=GF_PORT=' + port + '\n' +
    'Restart=on-failure\n' +
    'WorkingDirectory=' + workDir + '\n\n' +
    '[Install]\n' +
    'WantedBy=default.target\n';
  fs.writeFileSync(p.unit, unitText);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'troth-proxy.service'], { stdio: 'pipe' });
  // Without lingering a --user unit lives only inside a login session:
  // fine on a desktop, but a reboot nobody logs into (or a headless box)
  // would leave troth — and its memory upkeep — down until someone signs
  // in. enable-linger needs no sudo for one's own user on standard
  // logind; best-effort because containers and odd distros may lack it.
  let linger = false;
  try {
    execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'pipe' });
    linger = true;
  } catch (_) { /* stated in the result; the login-session scope still works */ }
  return { ok: true, kind: p.kind, unit: p.unit, linger: linger };
}

function uninstall() {
  const p = paths();
  if (!p.kind) return { ok: false, error: 'unsupported platform: ' + process.platform };
  if (p.kind === 'launchd') {
    try { execFileSync('launchctl', ['unload', '-w', p.unit], { stdio: 'pipe' }); } catch (_) {}
    try { fs.unlinkSync(p.unit); } catch (_) {}
    try { fs.unlinkSync(path.join(os.homedir(), '.troth', 'bin', 'troth')); } catch (_) {}
    return { ok: true, kind: p.kind };
  }
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'troth-proxy.service'], { stdio: 'pipe' }); } catch (_) {}
  try { fs.unlinkSync(p.unit); } catch (_) {}
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' }); } catch (_) {}
  return { ok: true, kind: p.kind };
}

function status() {
  const p = paths();
  if (!p.kind) return { supported: false, platform: process.platform, installed: false, loaded: false };
  const installed = !!(p.unit && fs.existsSync(p.unit));
  let loaded = false;
  try {
    if (p.kind === 'launchd') {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
      loaded = out.split('\n').some(function (l) { return l.indexOf(LABEL) !== -1; });
    } else {
      const out = execFileSync('systemctl', ['--user', 'is-active', 'troth-proxy.service'], { encoding: 'utf8' });
      loaded = out.trim() === 'active';
    }
  } catch (_) { loaded = false; }
  let linger = null;
  if (p.kind === 'systemd') {
    try {
      const out = execFileSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger'], { encoding: 'utf8' });
      linger = /Linger=yes/.test(out);
    } catch (_) { linger = null; }
  }
  // A unit survives the tree it points at (npm updates move installs,
  // uninstalled repos leave launchd respawning a ghost). Read the server
  // path back out of the unit/shim and check the disk, so `troth doctor`
  // can say "your login service points at a missing tree" instead of the
  // operator wondering why the port is dead with the service on.
  let target_exists = null;
  try {
    if (installed) {
      let body = fs.readFileSync(p.unit, 'utf8');
      if (p.kind === 'launchd') {
        const shim = path.join(os.homedir(), '.troth', 'bin', 'troth');
        if (fs.existsSync(shim)) body = fs.readFileSync(shim, 'utf8');
      }
      const m = body.match(/["' =]([^"'\n]*server\.js)/);
      target_exists = m ? fs.existsSync(m[1]) : null;
    }
  } catch (_) { target_exists = null; }
  return { supported: true, platform: process.platform, kind: p.kind, unit: p.unit, installed: installed, loaded: loaded, linger: linger, target_exists: target_exists };
}

// Restart the proxy THROUGH its manager, when it has one.
//
// `troth restart` used to shut the running proxy down and spawn a loose
// child of the caller's shell. On a machine with the background service
// installed that quietly evicted the managed instance and replaced it with
// one nobody supervises, so the next time it died the service that the
// operator had switched on did not bring anything back. Asking the manager
// to cycle its own job keeps a single supervised process on the port.
function restart() {
  const p = paths();
  if (!p.kind) return { ok: false, error: 'unsupported_platform' };
  const st = status();
  if (!st.loaded) return { ok: false, error: 'service_not_loaded' };
  try {
    if (p.kind === 'launchd') {
      execFileSync('launchctl', ['kickstart', '-k', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'pipe' });
    } else {
      execFileSync('systemctl', ['--user', 'restart', 'troth-proxy.service'], { stdio: 'pipe' });
    }
    return { ok: true, kind: p.kind, via: 'service' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { install, uninstall, status, restart, LABEL };
