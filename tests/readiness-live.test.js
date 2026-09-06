#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A cached readiness answer carries counts; the pause and the drain heartbeat
// are read live on top of it, and the one reason line that depends on them
// follows: pressed a second ago shows now, released shows now.
const assert = require('assert');
const readiness = require('../shared-core/memory-readiness.js');
const gate = require('../shared-core/maintenance-gate.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const PAUSED = /^paused by you/;
const NODRAIN = /^no background worker has drained/;

(async () => {
  console.log('readiness-live');
  await t('a cached answer taken before the pause shows the pause after applyLive', () => {
    gate.resume();
    const cached = readiness.readiness();
    assert.strictEqual(cached.paused.paused, false);
    gate.pause({ by: 'test', reason: 'quiet' });
    const stale = Object.assign({}, cached, { reasons: cached.reasons.slice() });
    assert.strictEqual(stale.paused.paused, false, 'the copy is stale on purpose');
    const live = readiness.applyLive(stale);
    assert.strictEqual(live.paused.paused, true);
    assert.strictEqual(live.paused.by, 'test');
    assert.ok(live.reasons.some((s) => PAUSED.test(s)), 'the pause is named as the person\'s act: ' + JSON.stringify(live.reasons));
    assert.ok(!live.reasons.some((s) => NODRAIN.test(s)), 'and not as a stalled worker');
  });
  await t('a cached answer taken while paused shows the release after applyLive', () => {
    const cached = readiness.readiness();
    assert.strictEqual(cached.paused.paused, true);
    gate.resume();
    const live = readiness.applyLive(Object.assign({}, cached, { reasons: cached.reasons.slice() }));
    assert.strictEqual(live.paused.paused, false);
    assert.ok(!live.reasons.some((s) => PAUSED.test(s)), 'the pause line is gone: ' + JSON.stringify(live.reasons));
  });
  await t('other fields and other reasons ride through untouched', () => {
    const live = readiness.applyLive({ stage: 'engine_downloading', reasons: ['memory engine downloading (0%)'], indexing: { recall_missing: 0 }, drain: { alive: true, last_run_ts: 1, last_notes: null } });
    assert.strictEqual(live.stage, 'engine_downloading');
    assert.deepStrictEqual(live.reasons.filter((s) => !PAUSED.test(s) && !NODRAIN.test(s)), ['memory engine downloading (0%)']);
    assert.strictEqual(readiness.applyLive(null), null);
  });
  console.log('\nreadiness-live: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
