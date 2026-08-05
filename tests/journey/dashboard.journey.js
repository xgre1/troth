// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The dashboard as a person meets it: a real browser, a real proxy, a HOME
// with nothing in it. This is the surface an open-repo user lands on before
// they have configured anything, and until now nothing had ever looked at it
// except by hand.
module.exports.describe = 'a stranger opens the dashboard on a fresh machine';
module.exports.run = async (ctx, check) => {
  const browserLib = require('./lib/browser.js');

  // Nothing configured. Not an empty file — no file at all, the way a machine
  // that has never run this arrives.
  const proxy = await ctx.proxy();
  const probe = await proxy.get('/api/setup/local');
  check('the proxy answers on a machine with no config', probe.status === 200,
    'status=' + probe.status + ' ' + (probe.error || ''));
  if (probe.status !== 200) return;

  let page;
  try { page = await browserLib.open(ctx.root); }
  catch (e) {
    check('a browser is available to look with', false,
      String(e && e.message) + ' — start Chrome with --remote-debugging-port=9222');
    return;
  }

  try {
    await page.goto('http://127.0.0.1:' + proxy.port + '/ui', { waitMs: 800 });
    await page.installErrorTrap();
    // Wait for the page to have DECIDED, not for a fixed number of seconds. The
    // first-run overlay appears only after boot() has fetched /api/config, and a
    // three-second sleep was long enough on the machine that wrote this test and
    // too short inside a container — which reads exactly like the product
    // behaving differently on Linux. It was the clock.
    const decided = await page.waitFor(
      '(document.readyState === "complete") && (!!document.querySelector("#tob.on") || !!document.querySelector("[data-view], .view, main, #app"))',
      { timeoutMs: 25000 });
    check('the page finishes deciding what to show', decided, 'still undecided after 25s');

    const title = await page.eval('document.title');
    check('the dashboard loads at all', !!title, 'no document title');

    const text = (await page.visibleText()) || '';
    check('the page renders something a person can read', text.trim().length > 40,
      JSON.stringify(text.slice(0, 120)));

    // A first run must SAY what to do. Asked as the page itself answers it —
    // the overlay element carries the state — not by pattern-matching prose. A
    // regex over innerText passed on one machine and failed on another while
    // the overlay was up in both, which is a test reporting its own vagueness
    // as a platform difference.
    const onboardingUp = await page.eval('!!document.querySelector("#tob.on")');
    const cfg = (await proxy.get('/api/config')).json || {};
    const configured = !!cfg.onboarding_done ||
      Object.values(cfg.providers || {}).some(function (p) { return p && p.enabled; });
    check('a fresh machine is offered setup, not a wall of switches', onboardingUp || configured,
      'nothing configured and no onboarding overlay');
    if (onboardingUp) {
      const tobText = await page.eval('(document.getElementById("tob") || {}).innerText || ""');
      check('the first step names engines a person can choose',
        /chatgpt|claude|kimi|api key|local model/i.test(tobText),
        JSON.stringify(String(tobText).slice(0, 160)));
    }

    // Whatever the page believes about the local stack has to match what the
    // API says — the two disagreeing is the shape every reported defect took.
    const api = (await proxy.get('/api/setup/local')).json || {};
    const parts = api.parts || {};
    check('the API names the local components', Object.keys(parts).length >= 3,
      'parts: ' + Object.keys(parts).join(','));
    if (parts.embedder) {
      const claimsInstalled = /memory model/i.test(text) && /install/i.test(text);
      const isInstalled = !!parts.embedder.present;
      check('it does not offer to install a model it already has',
        !(isInstalled && claimsInstalled),
        'present=' + isInstalled + ' but the page still offers Install');
    }

    const errs = (await page.pageErrors()) || [];
    check('the page raises no errors while a person looks at it', errs.length === 0,
      JSON.stringify(errs.slice(0, 3)));

    const shot = require('path').join(require('os').tmpdir(), 'journey-dashboard.png');
    if (await page.screenshot(shot)) console.log('        screenshot: ' + shot);
  } finally { page.close(); }
};
