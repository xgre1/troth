#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A cancelled turn stops the browser step it is on: a page still loading, the
// settle wait after navigation, and the next engine of a search all end the
// moment the turn is stopped, and the tool answers cancelled. No Chrome runs
// here: the daemon and the CDP session are stand-ins with the real session's
// contract (close() rejects everything still pending).
const assert = require('assert');
const path = require('path');
const SHARED = path.join(__dirname, '..', 'shared-core');

const daemonPath = require.resolve(path.join(SHARED, 'perception', 'chromium-daemon.js'));
const cdpPath    = require.resolve(path.join(SHARED, 'perception', 'cdp-client.js'));

const counts = { connects: 0, navigations: 0, closes: 0 };
// Per-test behaviour of the stand-in page.
const page = { navigateHangs: false, evaluate: () => 'hello from the page' };

class FakeSession {
  constructor() { this._pending = new Set(); this.closed = false; }
  send(method, params) {
    if (this.closed) return Promise.reject(new Error('cdp not open'));
    if (method === 'Page.navigate') {
      counts.navigations++;
      if (!page.navigateHangs) return Promise.resolve({ frameId: 'f' });
      return new Promise((_, reject) => { this._pending.add(reject); });
    }
    if (method === 'Runtime.evaluate') {
      return Promise.resolve({ result: { value: page.evaluate(params && params.expression) } });
    }
    return Promise.resolve({});
  }
  close() {
    this.closed = true;
    counts.closes++;
    for (const reject of this._pending) reject(new Error('cdp session closed'));
    this._pending.clear();
  }
}

function stub(file, exportsObj) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
stub(daemonPath, {
  async ensure() { process.env.TROTH_BROWSER_CDP_PORT = '18999'; return { ok: true, port: 18999, host: '127.0.0.1', attached: true }; },
  defaultProfileDir() { return '/nowhere/agent-browser-profile'; },
  legacyProfileDir() { return '/nowhere/chrome-profile'; },
});
stub(cdpPath, {
  async connectFirstPage() { counts.connects++; return new FakeSession(); },
});

const web = require(path.join(SHARED, 'tools', 'web-research.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reset() { counts.connects = 0; counts.navigations = 0; counts.closes = 0; page.navigateHangs = false; page.evaluate = () => 'hello from the page'; }
function ctxCancelledAfter(ms) {
  const c = { cancelled: false };
  setTimeout(() => { c.cancelled = true; }, ms);
  return { cwd: process.cwd(), shouldCancel: () => c.cancelled };
}

console.log('\n=== a cancelled turn stops its browser step ===\n');
(async () => {
  await t('a fetch that nobody stops returns the page', async () => {
    reset();
    process.env.TROTH_WEB_NAV_WAIT_MS = '30';
    const r = await web.web_fetch.run({ url: 'https://example.test/a' }, { cwd: process.cwd(), shouldCancel: () => false });
    assert.strictEqual(r.content, 'hello from the page', JSON.stringify(r).slice(0, 200));
    assert.strictEqual(r.audience, 'external');
    assert.strictEqual(counts.closes, 1, 'the page session is closed once');
  });

  await t('a page still loading is dropped the moment the turn is stopped', async () => {
    reset();
    page.navigateHangs = true;
    process.env.TROTH_WEB_NAV_WAIT_MS = '30';
    const t0 = Date.now();
    const r = await web.web_fetch.run({ url: 'https://example.test/slow' }, ctxCancelledAfter(300));
    const ms = Date.now() - t0;
    assert.strictEqual(r.error, 'cancelled', JSON.stringify(r).slice(0, 200));
    assert.strictEqual(r.interrupted, true);
    assert.ok(ms >= 250 && ms < 1500, 'it came back right after the stop: ' + ms + ' ms');
    assert.ok(counts.closes >= 1, 'the session was closed by the stop');
  });

  await t('the settle wait after navigation ends with the stop', async () => {
    reset();
    process.env.TROTH_WEB_NAV_WAIT_MS = '8000';
    const t0 = Date.now();
    const r = await web.web_fetch.run({ url: 'https://example.test/settle' }, ctxCancelledAfter(300));
    const ms = Date.now() - t0;
    assert.strictEqual(r.error, 'cancelled', JSON.stringify(r).slice(0, 200));
    assert.ok(ms < 1500, 'the 8 s wait was cut short: ' + ms + ' ms');
  });

  await t('a search does not move to the next engine after the stop', async () => {
    reset();
    process.env.TROTH_WEB_NAV_WAIT_MS = '30';
    delete process.env.TROTH_SEARCH_URL;
    page.evaluate = () => JSON.stringify({ title: 'Just a moment', snippet: 'cloudflare', results: [] });
    const c = { cancelled: false };
    const ctx = { cwd: process.cwd(), shouldCancel: () => c.cancelled };
    const origEvaluate = page.evaluate;
    page.evaluate = (expr) => { c.cancelled = true; return origEvaluate(expr); };
    const r = await web.web_search.run({ query: 'troth' }, ctx);
    assert.strictEqual(r.error, 'cancelled', JSON.stringify(r).slice(0, 200));
    assert.strictEqual(counts.navigations, 1, 'only the first engine was tried: ' + counts.navigations);
  });

  await t('a turn already stopped never opens the browser', async () => {
    reset();
    const r = await web.web_fetch.run({ url: 'https://example.test/late' }, { cwd: process.cwd(), shouldCancel: () => true });
    assert.strictEqual(r.error, 'cancelled', JSON.stringify(r).slice(0, 200));
    assert.strictEqual(counts.connects, 0, 'no CDP connection was made');
  });

  await t('without a stop hook the tools behave as before', async () => {
    reset();
    process.env.TROTH_WEB_NAV_WAIT_MS = '30';
    const r = await web.web_fetch.run({ url: 'https://example.test/plain' });
    assert.strictEqual(r.content, 'hello from the page', JSON.stringify(r).slice(0, 200));
  });

  console.log('\nweb-cancel: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
