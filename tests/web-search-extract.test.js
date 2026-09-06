#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The search extractor: an engine with its own result list reads that list,
// the generic road skips the engine's navigation and its own links, every
// generated expression is JavaScript the page can run, and a page that is
// only a bot check counts as blocked.
const assert = require('assert');
const path = require('path');
const SHARED = path.join(__dirname, '..', 'shared-core');
const daemonPath = require.resolve(path.join(SHARED, 'perception', 'chromium-daemon.js'));
const cdpPath    = require.resolve(path.join(SHARED, 'perception', 'cdp-client.js'));
process.env.TROTH_WEB_NAV_WAIT_MS = '5';

const seen = [];
const page = { evaluate: () => JSON.stringify({ title: 't', snippet: 's', results: [] }) };
class FakeSession {
  send(method, params) {
    if (method === 'Runtime.evaluate') { seen.push(params.expression); return Promise.resolve({ result: { value: page.evaluate(params.expression) } }); }
    return Promise.resolve({});
  }
  close() {}
}
function stub(file, exportsObj) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
stub(daemonPath, {
  async ensure() { process.env.TROTH_BROWSER_CDP_PORT = '18999'; return { ok: true, port: 18999, host: '127.0.0.1', attached: true }; },
  defaultProfileDir() { return '/nowhere/agent-browser-profile'; },
  legacyProfileDir() { return '/nowhere/chrome-profile'; },
});
stub(cdpPath, { async connectFirstPage() { return new FakeSession(); } });
const web = require(path.join(SHARED, 'tools', 'web-research.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== web search extraction ===\n');

(async () => {
  await t('an engine with its own result list reads that list, and every expression runs as JavaScript', async () => {
    seen.length = 0;
    delete process.env.TROTH_SEARCH_URL;
    const r = await web.web_search.run({ query: 'anything', limit: 3 }, {});
    assert.strictEqual(r.error, 'all_engines_failed');
    assert.deepStrictEqual(r.tried, ['brave:empty', 'ecosia:empty', 'startpage:empty', 'marginalia:empty']);
    assert.ok(/\.result-body a/.test(seen[0]), 'brave reads its result bodies');
    assert.ok(/\.result a\.result-link/.test(seen[2]), 'startpage reads its result links');
    assert.ok(!/closest\("header,nav,footer,aside"\)/.test(seen[0]), 'a listed engine needs no page-chrome filter');
    assert.ok(/closest\("header,nav,footer,aside"\)/.test(seen[1]), 'the generic road skips navigation, footer and side blocks');
    assert.ok(/querySelectorAll\("a\[href\^=\\"http\\"\]"\)/.test(seen[1]), 'the generic road starts from every outbound link');
    for (const e of seen) new Function('return ' + e);
  });

  await t('the generic road keeps the engine\'s own links out, brand token included', async () => {
    const expr = seen[3];
    assert.ok(/split\("-"\)\[0\]/.test(expr), 'the brand token is the first word of the host');
    const sandbox = { location: { host: 'marginalia-search.com' }, document: null };
    const fn = new Function('location', 'document', 'URL', 'return ' + expr);
    const links = [
      { href: 'https://git.marginalia.nu/x', innerText: 'git repository', closest: () => null },
      { href: 'https://example.org/page', innerText: 'Example page', closest: () => null },
      { href: 'https://example.net/nav', innerText: 'Nav link', closest: () => ({}) },
      { href: 'https://example.com/two', innerText: 'Second real result', closest: () => null },
    ];
    const doc = { title: 'q - Marginalia Search', body: { innerText: 'results' }, querySelectorAll: () => links };
    const out = JSON.parse(fn(sandbox.location, doc, URL));
    assert.deepStrictEqual(out.results.map((x) => x.url), ['https://example.org/page', 'https://example.com/two']);
  });

  await t('a page that is only a bot check counts as blocked', async () => {
    process.env.TROTH_SEARCH_URL = 'https://engine.example/search?q={q}';
    page.evaluate = () => JSON.stringify({ title: '', snippet: 'Verifying your request... Calculating... Difficulty: 6', results: [] });
    const r = await web.web_search.run({ query: 'anything' }, {});
    assert.strictEqual(r.error, 'all_engines_failed');
    assert.deepStrictEqual(r.tried, ['custom:blocked']);
  });

  await t('a listed engine\'s result title comes from the result heading when there is one', async () => {
    delete process.env.TROTH_SEARCH_URL;
    seen.length = 0;
    page.evaluate = () => JSON.stringify({ title: 't', snippet: 's', results: [] });
    await web.web_search.run({ query: 'anything' }, {});
    const fn = new Function('location', 'document', 'URL', 'return ' + seen[0]);
    const heading = { innerText: 'Real title' };
    const box = { querySelector: () => heading };
    const links = [
      { href: 'https://example.org/a', innerText: 'example.org › a', closest: () => box },
      { href: 'https://example.net/b', innerText: 'example.net › b', closest: () => box },
    ];
    const doc = { title: 'q - Brave Search', body: { innerText: 'results' }, querySelectorAll: () => links };
    const out = JSON.parse(fn({ host: 'search.brave.com' }, doc, URL));
    assert.deepStrictEqual(out.results.map((x) => x.title), ['Real title', 'Real title']);
  });

  console.log('\nweb-search-extract: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
