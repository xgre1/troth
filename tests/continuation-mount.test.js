#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A short acknowledgement inside a live thread is a continuation of that
// thread and mounts its window; a greeting stays a greeting.
const assert = require('assert');
const path = require('path');
const ir = require(path.join(__dirname, '..', 'shared-core', 'intent-router.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== continuation inside a thread ===\n');

t('acknowledgements and go-aheads are continuations', () => {
  for (const s of ['ok psaxe', 'ok ψάξε', 'ναι κάν το', 'yes do it', 'ok', 'continue', 'go', 'nai', 'οκ συνέχισε', 'sure']) {
    assert.strictEqual(ir.isContinuation(s), true, s);
  }
});

t('greetings and thanks are not continuations', () => {
  for (const s of ['hi', 'hello there', 'καλημέρα', 'γεια', 'thanks', 'ευχαριστώ', 'good morning']) {
    assert.strictEqual(ir.isContinuation(s), false, s);
  }
});

t('inside a live thread a continuation mounts the window; without one it mounts nothing', () => {
  assert.strictEqual(ir.routeInThread('ok psaxe', { thread_live: true }).mount_policy, 'dmn_slot');
  assert.strictEqual(ir.routeInThread('ναι κάν το', { thread_live: true }).mount_policy, 'dmn_slot');
  assert.strictEqual(ir.routeInThread('ok psaxe', { thread_live: false }).mount_policy, 'null_mount');
  assert.strictEqual(ir.routeInThread('hi', { thread_live: true }).mount_policy, 'null_mount', 'a greeting stays a greeting');
  assert.strictEqual(ir.routeInThread('ti kaname me auto?', { thread_live: true }).mount_policy, 'full_recall', 'a memory question keeps its own policy');
  assert.strictEqual(ir.routeInThread('what is the date today', { thread_live: true }).mount_policy, 'null_mount', 'trivia keeps its own policy');
});

console.log('\ncontinuation-mount: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
