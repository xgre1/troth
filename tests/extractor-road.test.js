#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The live pass takes the local engine when it answers, else the operator's
// engine through the proxy under a budget, else none. Probes are injected:
// no network is touched.
const assert = require('assert');
const path = require('path');
const ic = require(path.join(__dirname, '..', 'shared-core', 'instance-consolidation.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== extractor road ===\n');

(async () => {
  const up = new Set();
  const probe = async (url) => [...up].some((u) => url.startsWith(u));
  delete process.env.TROTH_INSTANCE_EXTRACT_ENGINE;
  delete process.env.TROTH_INSTANCE_EXTRACT_TURNS_PER_PASS;

  await t('the local engine wins when it answers', async () => {
    up.clear(); up.add('http://local:1234');
    const r = await ic.makeExtractor({ probe, local_host: 'http://local:1234', proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r.road, 'local');
    assert.strictEqual(typeof r.llmCall, 'function');
    assert.strictEqual(r.limit, null, 'no budget on the local road');
  });

  await t('without a local engine the proxy road carries a budget of turns', async () => {
    up.clear(); up.add('http://127.0.0.1:8000');
    const r = await ic.makeExtractor({ probe, local_host: 'http://local:1234', proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r.road, 'engine');
    assert.strictEqual(r.limit, 60);
    process.env.TROTH_INSTANCE_EXTRACT_TURNS_PER_PASS = '25';
    const r2 = await ic.makeExtractor({ probe, local_host: 'http://local:1234', proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r2.limit, 25);
    delete process.env.TROTH_INSTANCE_EXTRACT_TURNS_PER_PASS;
  });

  await t('the operator can keep the pass local-only', async () => {
    up.clear(); up.add('http://127.0.0.1:8000');
    process.env.TROTH_INSTANCE_EXTRACT_ENGINE = '0';
    const r = await ic.makeExtractor({ probe, local_host: 'http://local:1234', proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r.road, 'none');
    assert.ok(/engine road is off/.test(r.reason), r.reason);
    delete process.env.TROTH_INSTANCE_EXTRACT_ENGINE;
  });

  await t('nothing reachable: the window is retained, with the reason', async () => {
    up.clear();
    const r = await ic.makeExtractor({ probe, local_host: 'http://local:1234', proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r.road, 'none');
    assert.strictEqual(r.llmCall, null);
    assert.ok(/no local engine and no proxy/.test(r.reason), r.reason);
  });

  await t('no local host configured at all: straight to the proxy road', async () => {
    up.clear(); up.add('http://127.0.0.1:8000');
    const r = await ic.makeExtractor({ probe, local_host: null, proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r.road, 'engine');
  });

  await t('the engine road stops when the daily budget is spent, and every session read spends it', async () => {
    up.clear(); up.add('http://127.0.0.1:8000');
    process.env.TROTH_UNDERSTANDING_DAILY_TURNS = '2';
    const r = await ic.makeExtractor({ probe, local_host: null, proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r.road, 'engine');
    assert.ok(r.limit <= 2, 'the per-pass limit never exceeds what is left: ' + r.limit);
    ic.spendEngine(2);
    const r2 = await ic.makeExtractor({ probe, local_host: null, proxy_host: 'http://127.0.0.1:8000' });
    assert.strictEqual(r2.road, 'none');
    assert.ok(/daily engine budget is spent/.test(r2.reason), r2.reason);
    delete process.env.TROTH_UNDERSTANDING_DAILY_TURNS;
  });

  console.log('\nextractor-road: ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
