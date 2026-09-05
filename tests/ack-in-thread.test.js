#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A bare 'ok' with nothing behind it gets the canned acknowledgement; inside
// a live thread it is a continuation the engine answers.
const assert = require('assert');
const path = require('path');
const de = require(path.join(__dirname, '..', 'shared-core', 'decision-engine.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== a short ack inside a live thread ===\n');
(async () => {
  const engine = de.makeEngine();
  await t('with no thread behind it, ok is acknowledged without the engine', async () => {
    const a = await engine({}, { type: 'user_input', input: { text: 'ok' } });
    assert.strictEqual(a && a.kind, 'respond_directly');
    assert.strictEqual(a && a.reason, 'ack_passthrough');
  });
  await t('inside a live thread, ok goes to the engine as a continuation', async () => {
    for (const text of ['ok', 'okay', 'thanks', 'got it']) {
      const a = await engine({}, { type: 'user_input', input: { text }, thread_live: true });
      assert.notStrictEqual(a && a.reason, 'ack_passthrough', text + ' was acknowledged instead of continued');
      assert.strictEqual(a && a.kind, 'llm', text + ' did not reach the engine: ' + JSON.stringify(a));
    }
  });
  await t('an empty line is still a noop either way', async () => {
    const a = await engine({}, { type: 'user_input', input: { text: '   ' }, thread_live: true });
    assert.strictEqual(a && a.kind, 'noop');
  });
  console.log('\nack-in-thread: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
