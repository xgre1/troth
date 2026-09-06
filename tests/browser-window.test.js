#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The agent's browser opens out of the way: right after a headed launch the
// daemon minimises its window over CDP (getTargets, getWindowForTarget,
// setWindowBounds minimized). A browser that refuses is left alone and the
// launch still counts. No Chrome here: the CDP session is a stand-in.
const assert = require('assert');
const path = require('path');
const SHARED = path.join(__dirname, '..', 'shared-core');

const cdpPath = require.resolve(path.join(SHARED, 'perception', 'cdp-client.js'));
const calls = [];
let refuse = false;
class FakeBrowser {
  constructor() { this.closed = false; }
  async send(method, params) {
    calls.push({ method, params });
    if (refuse) throw new Error('not allowed');
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 't-browser', type: 'browser' }, { targetId: 't-page', type: 'page', url: 'about:blank' }] };
    if (method === 'Browser.getWindowForTarget') return { windowId: 7, bounds: { windowState: 'normal' } };
    return {};
  }
  close() { this.closed = true; }
}
let last = null;
require.cache[cdpPath] = { id: cdpPath, filename: cdpPath, loaded: true, exports: {
  async connectBrowser() { last = new FakeBrowser(); return last; },
} };
const daemon = require(path.join(SHARED, 'perception', 'chromium-daemon.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== the agent browser opens minimised ===\n');
(async () => {
  await t('the window of the first page is minimised over CDP', async () => {
    calls.length = 0;
    const ok = await daemon.hideWindow('127.0.0.1', 18999);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls.map((c) => c.method), ['Target.getTargets', 'Browser.getWindowForTarget', 'Browser.setWindowBounds']);
    assert.strictEqual(calls[1].params.targetId, 't-page', 'the page target, never the browser target');
    assert.deepStrictEqual(calls[2].params, { windowId: 7, bounds: { windowState: 'minimized' } });
    assert.strictEqual(last.closed, true, 'the browser session is closed afterwards');
  });

  await t('a browser that refuses leaves the launch standing', async () => {
    calls.length = 0;
    refuse = true;
    const ok = await daemon.hideWindow('127.0.0.1', 18999);
    refuse = false;
    assert.strictEqual(ok, false);
    assert.strictEqual(last.closed, true);
  });

  await t('the tail the reaper matches on is the end of the profile path', async () => {
    assert.ok(daemon.defaultProfileDir().endsWith(daemon.agentProfileTail()));
    assert.ok(/^\.troth[\\/]agent-browser-profile$/.test(daemon.agentProfileTail()), daemon.agentProfileTail());
  });

  console.log('\nbrowser-window: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
