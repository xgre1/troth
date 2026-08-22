// SPDX-License-Identifier: AGPL-3.0-only
// chromium-daemon — ensure a Chrome/Chromium is running with CDP enabled so the
// CDP browser path (browser-do.js "Mode 2" + browser-observer) actually activates
// on the HOST, WITHOUT Playwright.
//
// The missing piece: the L4 body/VM init was meant to spawn the
// always-on Chromium daemon and export CHROMIUM_CDP_PORT → TROTH_BROWSER_CDP_PORT.
// But on the host / chat surface there is no body init, so TROTH_BROWSER_CDP_PORT
// was never set → browser:do fell through to the rejected Playwright fallback
// (which isn't even installed → no-op). The operator built the CDP architecture
// precisely to avoid Playwright; this module connects the launcher so that path
// runs everywhere.
//
// ensure(): (1) if a Chrome is already listening on the CDP port — including the
// operator's own browser started with --remote-debugging-port — ATTACH to it;
// (2) otherwise spawn the user's real Chrome with a dedicated troth profile +
// --remote-debugging-port; (3) export TROTH_BROWSER_CDP_PORT so the existing CDP
// dispatcher + perception observer light up. Zero new deps (uses node http +
// child_process). Headful by default so the "body" is visible; TROTH_BROWSER_HEADLESS=1
// for background.

'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
// PRIVATE Troth CDP port — NOT Chrome's well-known 9222. Security:
// on 9222, ensure() would silently ATTACH to whatever Chrome already listens there
// including the operator's REAL browser (every logged-in session) or another
// agent's instance — a confused-deputy attach. A private port means: a live
// instance on it is OURS, so
// attach is safe. To DELIBERATELY drive the operator's own browser ("do a job in
// my account"), set TROTH_BROWSER_CDP_PORT=9222 explicitly — that, and only that,
// is the opt-in path to the real session. (Mode-2 VM body uses 19222; host
// Mode-1 daemon uses 18222 so they never collide.)
const DEFAULT_PORT = parseInt(process.env.TROTH_BROWSER_CDP_PORT || '18222', 10);

// The agent's own browser directory. Exported because it is the one thing
// that tells the agent's browser apart from the operator's: the idle reaper
// has to know which of the two it is looking at before it may collect one, and
// a second copy of this path in the reaper is a second place to get it wrong.
function defaultProfileDir() {
  return path.join(process.env.HOME || os.homedir(), '.troth', 'agent-browser-profile');
}

// Chromium-family browsers, in preference order. CDP is identical across them.
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findBrowser() {
  const override = process.env.TROTH_BROWSER_BIN;
  if (override) { try { if (fs.existsSync(override)) return override; } catch (_) {} }
  for (const c of CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

// Chrome on macOS binds the DevTools port on IPv6 [::1] even when given
// --remote-debugging-address=127.0.0.1 (the flag is honored inconsistently across
// headless=new builds). So we probe BOTH families and report which one answers,
// so callers connect to the right host.
const HOST_CANDIDATES = ['127.0.0.1', '::1'];

function _probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ method: 'GET', host, port, path: '/json/version', family: host.includes(':') ? 6 : 4, timeout: timeoutMs || 1500 }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.end();
  });
}

// Returns the host string that answers CDP on this port, or null.
async function aliveHost(port, timeoutMs) {
  for (const h of HOST_CANDIDATES) {
    if (await _probe(h, port, timeoutMs)) return h;
  }
  return null;
}

// Back-compat boolean probe.
async function alive(port, timeoutMs) { return (await aliveHost(port, timeoutMs)) != null; }

let _spawning = null;

// ensure({ port?, headless?, user_data_dir?, timeout_ms? }) → { ok, port, host, attached|spawned, error? }
// Idempotent + concurrency-safe. Sets process.env.TROTH_BROWSER_CDP_PORT on success.
// last-use stamp — lets the proxy's idle reaper tell "busy" from "abandoned".
// See shared-core/local-reranker.js for why: detached children here have no
// exit path of their own, so something long-lived has to retire them.
function _touchUse(port) {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const dir = path.join(os.homedir(), '.troth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lastuse-' + port + '.txt'), String(Date.now()));
  } catch (_) {}
}

async function ensure(opts) {
  try { _touchUse(parseInt(process.env.TROTH_BROWSER_CDP_PORT || '18222', 10)); } catch (_) {}
  opts = opts || {};
  const port = opts.port || DEFAULT_PORT;

  const existing = await aliveHost(port);
  if (existing) {
    process.env.TROTH_BROWSER_CDP_PORT = String(port);
    process.env.TROTH_BROWSER_CDP_HOST = existing;
    return { ok: true, port, host: existing, attached: true };
  }
  if (_spawning) return _spawning;

  _spawning = (async () => {
    const bin = findBrowser();
    if (!bin) {
      return { ok: false, error: 'no_chromium_browser_found',
        detail: 'no Chrome/Chromium/Brave/Edge found — install one or set TROTH_BROWSER_BIN' };
    }
    // PRIVATE profile, the twin of the private port above — NEVER
    // ~/.troth/chrome-profile, the directory the operator's own opt-in
    // browser uses: sharing it quietly hands the agent every session that
    // operator was logged into: mail, bank, everything, with nobody having
    // agreed to it. Worse, both instances fought over one profile lock, and
    // reaping one could kill a window a human was typing in.
    //
    // The agent's browser now owns its own directory and starts signed out of
    // everything. Sessions reach it one of two deliberate ways: the operator
    // seals a credential in the vault and the agent signs itself in, or the
    // operator points it at port 9222, their real browser, on purpose.
    const profile = opts.user_data_dir || defaultProfileDir();
    try { fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); } catch (_) {}

    const headless = opts.headless != null ? !!opts.headless : (process.env.TROTH_BROWSER_HEADLESS === '1');
    const args = [
      '--remote-debugging-port=' + port,
      '--remote-debugging-address=' + HOST,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      'about:blank',          // guarantees a page target exists for connectFirstPage
    ];
    if (headless) args.unshift('--headless=new');

    let child;
    try {
      const logPath = path.join(process.env.HOME || os.homedir(), '.troth', 'desktop', 'chromium-daemon.log');
      try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}
      let fd = 'ignore';
      try { fd = fs.openSync(logPath, 'a'); } catch (_) {}
      child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
    } catch (e) {
      return { ok: false, error: 'spawn_failed: ' + (e && e.message || e) };
    }

    const deadline = Date.now() + (opts.timeout_ms || 15000);
    while (Date.now() < deadline) {
      const h = await aliveHost(port, 1000);
      if (h) {
        process.env.TROTH_BROWSER_CDP_PORT = String(port);
        process.env.TROTH_BROWSER_CDP_HOST = h;
        return { ok: true, port, host: h, spawned: true, pid: child.pid, headless, bin };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok: false, error: 'cdp_not_ready', detail: 'browser spawned but CDP port did not answer in time' };
  })().finally(() => { _spawning = null; });

  return _spawning;
}

module.exports = { ensure, alive, aliveHost, findBrowser, DEFAULT_PORT, defaultProfileDir };
