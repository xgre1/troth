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

/** Attach to the already-running Chrome (127.0.0.1:9222 by convention). */
async function open(root, { host = '127.0.0.1', port = 9222 } = {}) {
  const cdp = load(root);
  const page = await cdp.connectFirstPage(host, port);
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
    close() { try { page.close(); } catch (_) {} },
  };
  return api;
}

module.exports = { open };
