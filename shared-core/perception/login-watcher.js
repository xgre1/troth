// SPDX-License-Identifier: AGPL-3.0-only
// Login watcher: notices when a human signs in inside the AGENT'S browser and
// offers to seal that login in the vault, so the partner can sign itself in
// later without ever being told the password.
//
// Why this exists at all: a session cookie only proves you already logged in.
// It expires, it cannot switch accounts, and it does not travel to a fresh
// profile or another machine. A credential can do all three. So the vault is
// the thing that makes the partner able to work unattended, and this file is
// the least annoying honest way to fill it.
//
// WHERE THE TRUST BOUNDARY SITS (the whole design turns on this):
// the agent reads hostile pages by design, so anything running in the page's
// own JS world is attacker-controlled. A first draft signalled consent with a
// console marker or a global, and a page could simply write that itself and
// make us seal whatever it liked. So:
//
//   * our script runs in a NAMED ISOLATED WORLD. Verified: the page gets a
//     TypeError calling our binding, and our variables read back undefined.
//   * consent arrives over Runtime.addBinding bound to that world alone, so
//     the signal cannot be forged from the page.
//   * the password field is captured BY REFERENCE at detection time and held
//     in our world. We never re-query the DOM after consent, because between
//     the click and the read a page could swap in a field of its choosing.
//   * the click must be isTrusted and must land on our own element, checked
//     against elementFromPoint, so an overlay cannot borrow the gesture.
//
// The DOM is still shared, which the isolated world does not change: a page
// can see, restyle or remove our banner. It cannot forge the answer, and a
// removed banner just means no offer was made. That is the residual risk and
// it is the acceptable direction to fail in.
//
// This never touches the operator's own browser. It is pointed at the agent's
// private profile, and nothing here spawns or attaches to port 9222.

const cdp = require('./cdp-client.js');

// The world name is also the binding's contract: Runtime.addBinding with
// executionContextName exposes the function ONLY where our script runs.
const WORLD = 'troth_login_watch';
const BINDING = '__trothLoginConsent';

// Injected into every document in the agent's browser, in our world only.
// Kept dependency-free and defensive: it runs on pages that actively fight it.
const PAGE_SCRIPT = `(function () {
  var held = null;          // the password field, by reference
  var heldUser = null;      // the username field, by reference
  var offered = false;
  var banner = null;

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // The username is conventionally the last text-ish field before the
  // password, which beats guessing at names across a thousand login forms.
  function userFieldFor(pw) {
    var all = [].slice.call(document.querySelectorAll('input'));
    for (var i = all.indexOf(pw) - 1; i >= 0; i--) {
      var t = (all[i].type || '').toLowerCase();
      if (t === 'text' || t === 'email' || t === 'tel') return all[i];
    }
    return null;
  }

  function dismiss() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function offer(pw) {
    if (offered || !pw || !pw.value) return;
    offered = true;
    held = pw;
    heldUser = userFieldFor(pw);

    var hostEl = document.createElement('div');
    hostEl.setAttribute('data-troth', 'login-offer');
    hostEl.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
    // Closed shadow root: the page cannot walk into our markup to read or
    // rewrite the wording of what the operator is agreeing to.
    var root = hostEl.attachShadow ? hostEl.attachShadow({ mode: 'closed' }) : null;
    if (!root) { offered = false; return; }

    var wrap = document.createElement('div');
    wrap.style.cssText = [
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'background:#111', 'color:#fff', 'border:1px solid #333',
      'border-radius:10px', 'padding:14px 16px', 'max-width:300px',
      'box-shadow:0 10px 30px rgba(0,0,0,0.5)'
    ].join(';');

    var title = document.createElement('div');
    title.textContent = 'Save this login to troth?';
    title.style.cssText = 'font-weight:600;margin-bottom:4px';

    var sub = document.createElement('div');
    var who = (heldUser && heldUser.value) ? heldUser.value : 'this account';
    sub.textContent = who + ' on ' + location.host;
    sub.style.cssText = 'color:#9aa3ad;font-size:12px;margin-bottom:10px;word-break:break-all';

    var why = document.createElement('div');
    why.textContent = 'Your partner will be able to sign in as you later. It never sees the password itself.';
    why.style.cssText = 'color:#9aa3ad;font-size:11.5px;margin-bottom:12px';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px';

    var yes = document.createElement('button');
    yes.textContent = 'Save it';
    yes.style.cssText = 'flex:0 0 auto;background:#fff;color:#111;border:0;border-radius:7px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer';

    var no = document.createElement('button');
    no.textContent = 'Not now';
    no.style.cssText = 'flex:0 0 auto;background:transparent;color:#9aa3ad;border:1px solid #333;border-radius:7px;padding:7px 14px;font:inherit;cursor:pointer';

    yes.addEventListener('click', function (ev) {
      // A real finger, on our button, with our button actually on top.
      if (!ev.isTrusted) return;
      var mid = hostEl.getBoundingClientRect();
      var top = document.elementFromPoint(mid.left + mid.width / 2, mid.top + mid.height / 2);
      if (top !== hostEl) { dismiss(); return; }
      try {
        __BINDING__(JSON.stringify({
          host: location.host,
          username: (heldUser && heldUser.value) || '',
          hasPassword: !!(held && held.value)
        }));
      } catch (e) { /* no watcher attached; the offer simply does nothing */ }
      dismiss();
    });
    no.addEventListener('click', function (ev) { if (ev.isTrusted) dismiss(); });

    row.appendChild(yes); row.appendChild(no);
    wrap.appendChild(title); wrap.appendChild(sub); wrap.appendChild(why); wrap.appendChild(row);
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(hostEl);
    banner = hostEl;
  }

  function scan(ev) {
    var pw = null;
    var inputs = document.querySelectorAll('input[type=password]');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].value && isVisible(inputs[i])) { pw = inputs[i]; break; }
    }
    if (pw) offer(pw);
  }

  // Classic forms fire submit. Single-page logins often do not, so a filled
  // password field losing focus is treated as the same intent.
  document.addEventListener('submit', scan, true);
  document.addEventListener('focusout', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'INPUT' && (t.type || '').toLowerCase() === 'password' && t.value) scan();
  }, true);

  // Read back the held credential. Only ever called by the watcher over CDP,
  // in this world, after a verified consent signal.
  window.__trothTakeHeld = function () {
    if (!held) return null;
    return JSON.stringify({
      host: location.host,
      username: (heldUser && heldUser.value) || '',
      password: held.value
    });
  };
})();`.replace('__BINDING__', BINDING);

// One attached page. Kept small: the watcher owns a set of these.
class WatchedPage {
  constructor(session, onCredential) {
    this.session = session;
    this.onCredential = onCredential;
    this.contexts = [];
  }

  async arm() {
    const s = this.session;
    s.on('Runtime.executionContextCreated', (p) => {
      if (p && p.context && p.context.name === WORLD) this.contexts.push(p.context);
    });
    s.on('Runtime.executionContextsCleared', () => { this.contexts = []; });
    s.on('Runtime.bindingCalled', (p) => {
      if (!p || p.name !== BINDING) return;
      this._consented(p).catch(() => {});
    });
    await s.send('Page.enable', {});
    await s.send('Runtime.enable', {});
    await s.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    await s.send('Page.addScriptToEvaluateOnNewDocument', { worldName: WORLD, source: PAGE_SCRIPT });
  }

  // The isolated world for the CURRENT document is the most recent one; older
  // ids belong to documents that have already been navigated away from.
  _world() {
    return this.contexts.length ? this.contexts[this.contexts.length - 1] : null;
  }

  async _consented(ev) {
    let announced = {};
    try { announced = JSON.parse(ev.payload || '{}'); } catch (_) {}
    const ctx = this._world();
    if (!ctx) return;
    // The payload only says "the operator agreed". The credential itself is
    // read here, from the reference our world has been holding since the
    // login was detected, so the page cannot substitute a field in between.
    const r = await this.session.send('Runtime.evaluate', {
      expression: 'window.__trothTakeHeld && window.__trothTakeHeld()',
      contextId: ctx.id,
      returnByValue: true,
    });
    const raw = r && r.result && r.result.value;
    if (!raw) return;
    let cred = null;
    try { cred = JSON.parse(raw); } catch (_) { return; }
    if (!cred || !cred.password || !cred.host) return;
    // The host we act on is the one our own world reported, never the one in
    // the consent payload, which merely travelled through a page event.
    if (announced.host && announced.host !== cred.host) return;
    await this.onCredential({ host: cred.host, username: cred.username || '', password: cred.password });
  }

  close() { try { this.session.close(); } catch (_) {} }
}

// start({ host, port, onCredential }) -> { stop() }
// Attaches to every page in the agent's browser and keeps up with new tabs.
// onCredential({host, username, password}) is called only after a verified
// in-page consent. It must not return the password anywhere.
async function start(opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  const port = parseInt(opts.port, 10) || 18222;
  if (port === 9222) throw new Error('login-watcher refuses port 9222: the operator\'s own browser is never watched');
  const onCredential = opts.onCredential;
  if (typeof onCredential !== 'function') throw new Error('login-watcher requires onCredential');

  const attached = new Map();   // targetId -> WatchedPage
  let stopped = false;

  async function sweep() {
    if (stopped) return;
    let targets = [];
    try { targets = await cdp.listTargets(host, port); } catch (_) { return; }
    const live = new Set();
    for (const t of targets) {
      if (t.type !== 'page' || !t.webSocketDebuggerUrl) continue;
      live.add(t.id);
      if (attached.has(t.id)) continue;
      try {
        const s = new cdp.CdpSession(t.webSocketDebuggerUrl);
        await s.open();
        const wp = new WatchedPage(s, onCredential);
        await wp.arm();
        attached.set(t.id, wp);
      } catch (_) { /* a tab we cannot attach to is simply not watched */ }
    }
    for (const [id, wp] of attached) {
      if (!live.has(id)) { wp.close(); attached.delete(id); }
    }
  }

  await sweep();
  // Tabs open and close constantly and there is no browser-wide event stream
  // on a per-page connection, so the set is reconciled on a slow timer.
  const timer = setInterval(() => { sweep().catch(() => {}); }, 2000);
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const [, wp] of attached) wp.close();
      attached.clear();
    },
    get watching() { return attached.size; },
  };
}

module.exports = { start, WORLD, BINDING };
