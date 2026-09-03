// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Drives a real browser at the dashboard, through the CDP client this project
// already owns (shared-core/perception/cdp-client.js) — the same road the
// product's own browser tooling uses, so the test surface and the product
// surface cannot drift apart.
//
// Why a real browser and not a DOM simulation: the app's unit tests hand a
// component a hand-written list of two options and assert it renders them.
// That passes forever, including on the day the daemon starts sending the
// wrong list — which is exactly what happened. A page loaded from the running
// proxy has no such freedom: whatever it shows is what a person would see.
const path = require('path');

function load(root) {
  return require(path.join(root, 'shared-core', 'perception', 'cdp-client.js'));
}

// A browser of the run's OWN: headless Chrome on a private CDP port with a
// throwaway profile, spawned through the same chromium-daemon the product
// uses and killed when the run ends. The operator's browser is never
// attached, never navigated, never visible — a test that borrows the
// operator's Chrome (any port, any tab) turns every journey run into a
// window popping open on their desk, parked on a throwaway proxy's
// onboarding once the run's HOME dies. 18777 is journey-private: distinct
// from the product daemon's 18222 and the VM body's 19222, so a live
// instance on it can only be a previous run's leftover — safe to reuse,
// safe to kill.
const JOURNEY_CDP_PORT = parseInt(process.env.TROTH_JOURNEY_CDP_PORT || '18777', 10);

async function open(root) {
  const cdp = load(root);
  const daemon = require(path.join(root, 'shared-core', 'perception', 'chromium-daemon.js'));
  const fs = require('fs');
  const os = require('os');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-chrome-'));
  const up = await daemon.ensure({ port: JOURNEY_CDP_PORT, headless: true, user_data_dir: profile });
  if (!up || !up.ok) {
    throw new Error('no Chrome/Chromium to look with: ' + ((up && up.error) || 'chromium-daemon could not start one'));
  }
  const host = up.host || '127.0.0.1';
  const port = JOURNEY_CDP_PORT;
  const browser = await cdp.connectBrowser(host, port);
  let targetId = null;
  let page = null;
  try {
    const created = await browser.send('Target.createTarget', { url: 'about:blank' });
    targetId = created && created.targetId;
    let candidates = [];
    for (let i = 0; i < 20 && !candidates.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      candidates = (await cdp.listTargets(host, port))
        .filter((t) => t.id === targetId && t.webSocketDebuggerUrl);
    }
    if (!candidates.length) throw new Error('created a journey tab but it never appeared in /json/list');
    page = new cdp.CdpSession(candidates[0].webSocketDebuggerUrl);
    await page.open();
  } catch (e) {
    if (targetId) { try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {} }
    try { browser.close(); } catch (_) {}
    throw e;
  }
  await page.send('Page.enable', {});
  await page.send('Runtime.enable', {});

  const api = {
    async goto(url, { waitMs = 1500 } = {}) {
      await page.send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, waitMs));
    },
    /** Evaluate in the page and return the plain value. */
    async eval(expr) {
      const r = await page.send('Runtime.evaluate', {
        expression: '(function(){ try { return JSON.stringify(' + expr + '); } catch (e) { return JSON.stringify(null); } })()',
        returnByValue: true, awaitPromise: true,
      });
      const v = r && r.result && r.result.value;
      try { return JSON.parse(v); } catch (_) { return null; }
    },
    /** Text of everything a person can actually read on the page. */
    visibleText() {
      return api.eval('document.body.innerText');
    },
    /** Wait until an expression is truthy, or give up honestly. */
    async waitFor(expr, { timeoutMs = 15000, everyMs = 400 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await api.eval(expr)) return true;
        await new Promise((r) => setTimeout(r, everyMs));
      }
      return false;
    },
    /** Click the first element matching a CSS selector; false if absent. */
    async click(selector) {
      return api.eval('(function(){var e=document.querySelector(' + JSON.stringify(selector) +
                      '); if(!e) return false; e.click(); return true; })()');
    },
    /** Click by visible label — what a person aims at, not what the DOM calls it. */
    async clickText(text, selector = 'button,a,[role=button],label,.tile,.card') {
      return api.eval('(function(){var t=' + JSON.stringify(text) +
        '.toLowerCase();var els=[].slice.call(document.querySelectorAll(' + JSON.stringify(selector) +
        '));var e=els.find(function(x){return (x.innerText||"").toLowerCase().indexOf(t)!==-1;});' +
        'if(!e) return false; e.click(); return true; })()');
    },
    async screenshot(file) {
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      if (r && r.data) require('fs').writeFileSync(file, Buffer.from(r.data, 'base64'));
      return !!(r && r.data);
    },
    /** Errors the page itself raised — a console a person never opens. */
    async pageErrors() {
      return api.eval('(window.__journeyErrors || [])');
    },
    async installErrorTrap() {
      await page.send('Runtime.evaluate', { expression:
        'window.__journeyErrors = window.__journeyErrors || [];' +
        'if (!window.__journeyTrapped) { window.__journeyTrapped = 1;' +
        '  window.addEventListener("error", function(e){ window.__journeyErrors.push(String(e.message)); });' +
        '  window.addEventListener("unhandledrejection", function(e){ window.__journeyErrors.push("unhandled: " + String(e.reason)); });' +
        '}' });
    },
    // The whole browser dies with the run — it was spawned for this run and
    // owes nothing to anyone. A previous run's leftover (attached, no pid)
    // gets its tab closed and is left for its own reaper. Fire-and-forget
    // on purpose: scenarios call this from finally.
    close() {
      (async () => {
        try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {}
        try { page.close(); } catch (_) {}
        try { browser.close(); } catch (_) {}
        if (up.spawned && up.pid) { try { process.kill(up.pid, 'SIGTERM'); } catch (_) {} }
        // The throwaway profile goes with the browser: a run leaves nothing
        // behind in the temp directory.
        setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }, 1500).unref();
      })();
    },
  };
  return api;
}

module.exports = { open };
