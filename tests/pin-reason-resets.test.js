#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A pinned ChatGPT lane refused for the plan limit names the minutes until
// the window resets, counted down from the moment the refusal was recorded.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const errortax = require(path.join(__dirname, '..', 'proxy', 'modules', 'errortax.js'));
const router = require(path.join(__dirname, '..', 'proxy', 'modules', 'router.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== pin reason: the plan limit names its reset ===\n');

t('a 429 that carried resets_in_seconds reads as minutes', () => {
  errortax.record(429, 'rate limited resets_in_seconds=2160', 'openai_sub');
  const r = router.buildPinFailure('openai_sub');
  assert.ok(/resets in 36 min/.test(r.body.error.message), r.body.error.message);
  assert.strictEqual(r.status, 400);
});

t('a 429 without the field keeps the plain reason', () => {
  errortax.record(429, 'rate limited', 'openai_sub');
  const r = router.buildPinFailure('openai_sub');
  assert.ok(/rate limited by the plan/.test(r.body.error.message), r.body.error.message);
});

console.log('\npin-reason-resets: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
