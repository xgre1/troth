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

    // No surface may claim a connection nobody verified. The Claude tile wired
    // the plugin and reported a linked subscription on machines where nobody
    // had ever signed in, while the providers panel two clicks away reported
    // none — the operator was told both at once.
    const mcp = (await proxy.get('/api/mcp/status')).json || {};
    const cc = mcp.claude_code || {};
    const claimsClaude = await page.eval(
      '/linked|detected/i.test((document.getElementById("tob-claude-note") || {}).innerText || "")');
    check('the Claude tile does not claim what the machine cannot back',
      !claimsClaude || !!cc.subscription_active,
      'page says linked/detected while /api/mcp/status reports subscription_active=' + !!cc.subscription_active);

    // Structure, asserted in the DOM rather than by reading the file. Removing
    // a card by hand once left its closing tag behind; the page container shut
    // early and every card after it rendered on all pages at once. Nothing in
    // the suite could see that — the page still navigated, raised no errors and
    // screenshotted fine. The invariant is simple: a card lives on a page.
    const structure = await page.eval(`(function(){
      var cards = [].slice.call(document.querySelectorAll('.settings-card'));
      var orphans = cards.filter(function (el) { return !el.closest('.page'); });
      var navs = [].slice.call(document.querySelectorAll('.nav-item[data-page]'))
                   .map(function (n) { return n.getAttribute('data-page'); });
      var missing = navs.filter(function (p) { return !document.getElementById('page-' + p); });
      return {
        orphans: orphans.map(function (e) {
          return ((e.querySelector('.card-title') || {}).textContent || e.id || '?').trim();
        }).slice(0, 5),
        cards: cards.length,
        missing: missing,
        memoryPage: !!document.getElementById('page-memory'),
        memoryHasStack: !!document.querySelector('#page-memory #stack-card'),
        memoryHasImport: !!document.querySelector('#page-memory #import-card'),
        providersHasStack: !!document.querySelector('#page-ai-setup #stack-card')
      };
    })()`);
    check('every card belongs to a page', structure.orphans.length === 0,
      structure.cards + ' cards, adrift: ' + JSON.stringify(structure.orphans));
    check('every sidebar entry leads somewhere', structure.missing.length === 0,
      'nav without a page: ' + JSON.stringify(structure.missing));
    // Memory is the product, not a provider: the stack and the chat import
    // belong on their own page, and a person reaches them without Operator mode.
    check('memory has its own page', structure.memoryPage, 'no #page-memory');
    check('the memory stack and chat import live under Memory',
      structure.memoryHasStack && structure.memoryHasImport && !structure.providersHasStack,
      'stack=' + structure.memoryHasStack + ' import=' + structure.memoryHasImport +
      ' stillUnderProviders=' + structure.providersHasStack);

    // The command reference is served from the loader and the CLI table —
    // if either side is empty, the reference page is a shell.
    const cmds = (await proxy.get('/api/commands')).json || {};
    check('the command reference names the real surface',
      (cmds.slash || []).length >= 10 && (cmds.cli || []).length >= 40,
      'slash=' + (cmds.slash || []).length + ' cli=' + (cmds.cli || []).length);

    const errs = (await page.pageErrors()) || [];
    check('the page raises no errors while a person looks at it', errs.length === 0,
      JSON.stringify(errs.slice(0, 3)));

    const shot = require('path').join(require('os').tmpdir(), 'journey-dashboard.png');
    if (await page.screenshot(shot)) console.log('        screenshot: ' + shot);
  } finally { page.close(); }
};
