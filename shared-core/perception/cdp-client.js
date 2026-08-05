// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Chrome DevTools Protocol client — pure Node 22 WebSocket,
// zero third-party deps. Connects to an always-on Chromium daemon on the
// port given by CHROMIUM_CDP_PORT (default 9222).
//
// The observer module (browser-observer.js) uses this to subscribe to
// Page.frameNavigated / DOM.documentUpdated / Accessibility.nodesUpdated
// without pulling in chrome-remote-interface or playwright as deps.
//
// Substrate-thesis discipline: NO synchronous "call browser, get value
// back" surface exposed to faculty. This client exists for the
// substrate-side perception observer to push engrams. Faculty interacts
// via intent engrams; substrate's action-dispatcher uses this client to
// translate intents to CDP commands.
//
// CDP wire protocol:
//   GET http://host:port/json/list → [{ webSocketDebuggerUrl, ... }, ...]
//   ws.send({id, method, params})  → ws.recv {id, result} or {id, error}
//   Events arrive as {method, params} without an id field.

'use strict';

const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
// Private Troth CDP port (see chromium-daemon.js) — NOT Chrome's 9222 — so we
// never silently connect to the operator's real browser. Only a fallback: callers
// normally pass the port the daemon resolved (TROTH_BROWSER_CDP_PORT).
const DEFAULT_PORT = 18222;

function _httpGetJson(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', host, port, path, timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('http ' + res.statusCode + ': ' + buf));
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('non-json response: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    req.end();
  });
}

// Fetch the list of debuggable Chromium targets. The browser-level
// target is at /json/version; per-page targets at /json/list.
async function listTargets(host, port) {
  host = host || DEFAULT_HOST;
  port = port || DEFAULT_PORT;
  return await _httpGetJson(host, port, '/json/list');
}

async function getBrowserWebSocketUrl(host, port) {
  host = host || DEFAULT_HOST;
  port = port || DEFAULT_PORT;
  const v = await _httpGetJson(host, port, '/json/version');
  return v.webSocketDebuggerUrl;
}

// Open a CDP session to one target's webSocketDebuggerUrl. Returns a
// client with .send(method, params) → Promise<result>, .on(event, cb),
// .close(). One client per target (or one per browser-level connection
// using Target domain to multiplex).
class CdpSession {
  constructor(wsUrl) {
    this._wsUrl = wsUrl;
    this._ws = null;
    this._nextId = 1;
    this._pending = new Map();        // id → {resolve, reject}
    this._listeners = new Map();      // method → Set<cb>
    this._onClose = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        // Built-in WebSocket landed in Node 22 (engines pins >=22); without
        // this guard a Node 20/21 run dies with a bare ReferenceError.
        throw new Error('browser perception needs Node >= 22 (built-in WebSocket); running ' + process.version);
      }
      const ws = new WebSocket(this._wsUrl);
      ws.addEventListener('open', () => { this._ws = ws; resolve(); });
      ws.addEventListener('error', (ev) => {
        if (!this._ws) reject(new Error('cdp open failed: ' + (ev.message || 'unknown')));
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => {
        for (const cb of this._onClose) { try { cb(); } catch (_) {} }
        // Reject in-flight commands.
        for (const [, p] of this._pending) { p.reject(new Error('cdp session closed')); }
        this._pending.clear();
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); }
    catch (_) { return; }
    if (msg.id != null && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error('cdp ' + (msg.error.message || JSON.stringify(msg.error))));
      else           p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const set = this._listeners.get(msg.method);
      if (set) { for (const cb of set) { try { cb(msg.params, msg); } catch (_) {} } }
      // Catch-all listeners under '*' get every event.
      const star = this._listeners.get('*');
      if (star) { for (const cb of star) { try { cb(msg.method, msg.params); } catch (_) {} } }
    }
  }

  send(method, params) {
    if (!this._ws || this._ws.readyState !== 1) return Promise.reject(new Error('cdp not open'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try { this._ws.send(JSON.stringify({ id, method, params: params || {} })); }
      catch (e) { this._pending.delete(id); reject(e); }
    });
  }

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event).delete(cb);
  }

  onClose(cb) { this._onClose.push(cb); }

  close() { try { this._ws && this._ws.close(); } catch (_) {} }
}

// Convenience: open browser-level session.
async function connectBrowser(host, port) {
  const url = await getBrowserWebSocketUrl(host, port);
  const s = new CdpSession(url);
  await s.open();
  return s;
}

// Convenience: open session to the first / newest page target. If the browser
// has NO debuggable page, CREATE one (browser-level Target.createTarget) and
// re-list — instead of failing. A freshly-launched / tab-less Chromium daemon
// has zero page targets, which silently killed EVERY web_search / web_fetch with
// "cdp_connect_failed: no page targets" (verified live  — the sovereign
// search was dead for this exact reason: the model called web_search, the daemon
// had no tab, connectFirstPage threw, the partner fell back to training-data and
// LARP'd the "research"). Defensive: only fires in the already-broken 0-page case.
async function connectFirstPage(host, port) {
  let pages = (await listTargets(host, port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) {
    let browser = null;
    try {
      browser = await connectBrowser(host, port);
      await browser.send('Target.createTarget', { url: 'about:blank' });
    } catch (e) {
      throw new Error('no page targets and could not create one via Target.createTarget: ' + (e && e.message || e));
    } finally {
      try { browser && browser.close(); } catch (_) {}
    }
    // The new target registers on /json/list within a tick; poll briefly.
    for (let i = 0; i < 15 && !pages.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pages = (await listTargets(host, port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }
    if (!pages.length) throw new Error('created a page target but it never appeared in /json/list');
  }
  const s = new CdpSession(pages[0].webSocketDebuggerUrl);
  await s.open();
  return s;
}

module.exports = {
  listTargets,
  getBrowserWebSocketUrl,
  connectBrowser,
  connectFirstPage,
  CdpSession,
};
