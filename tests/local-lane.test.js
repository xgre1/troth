#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The local lane: a server on this machine leads by default; a host on
// another machine leads only when the operator chose it, never carries
// background reading unless opened to it, and no local server is handed a
// request its context cannot hold while a hosted lane exists.
const assert = require('assert');
const path = require('path');
try { delete require.cache[require.resolve(path.join(__dirname, '..', 'proxy', 'modules', 'router'))]; } catch (_) {}
const T = require(path.join(__dirname, '..', 'proxy', 'modules', 'router')).__test;

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== local lane ===\n');

t('a host on this machine is known by name or address, with or without scheme and port', () => {
  for (const h of ['127.0.0.1', 'localhost', 'http://127.0.0.1:1234', 'localhost:11434', '[::1]', '0.0.0.0']) assert.ok(T.isLoopbackName(h), h);
  for (const h of ['mainbox', 'studio.local', '10.0.0.5', 'http://10.0.0.5:1234', '']) assert.ok(!T.isLoopbackName(h), h);
});

t('a local server on this machine leads unless the operator prefers hosted', () => {
  assert.ok(T.localLeads({ dispatch_prefer: 'local', dispatch_prefer_explicit: false }, '127.0.0.1'));
  assert.ok(!T.localLeads({ dispatch_prefer: 'hosted', dispatch_prefer_explicit: true }, '127.0.0.1'));
});

t('a host on another machine leads only when the operator chose it', () => {
  assert.ok(!T.localLeads({ dispatch_prefer: 'local', dispatch_prefer_explicit: false }, 'studio.local'), 'a derived preference never leads to another machine');
  assert.ok(T.localLeads({ dispatch_prefer: 'local', dispatch_prefer_explicit: true }, 'studio.local'), 'the operator chose it');
  assert.ok(!T.localLeads({ dispatch_prefer: 'hosted', dispatch_prefer_explicit: true }, 'studio.local'));
});

t('background reading never takes a host on another machine unless it is opened to it', () => {
  const loc = { name: 'local', fn: null };
  const base = { loc, host: 'studio.local', source: 'question-shape', namedOpen: false, byokCount: 2, bodyStr: '{"x":1}', n_ctx: 8192 };
  assert.strictEqual(T.gateLocal(base), null, 'closed by default');
  assert.strictEqual(T.gateLocal(Object.assign({}, base, { namedOpen: true })), loc, 'opened by the operator');
  assert.strictEqual(T.gateLocal(Object.assign({}, base, { source: 'instance-extraction' })), null, 'every background source');
  assert.strictEqual(T.gateLocal(Object.assign({}, base, { host: '127.0.0.1' })), loc, 'a server on this machine reads background work');
  assert.strictEqual(T.gateLocal(Object.assign({}, base, { source: '' })), loc, 'a conversation is not background');
});

t('a request the local context cannot hold goes hosted while a hosted lane exists', () => {
  const loc = { name: 'local', fn: null };
  const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(60000) }] });
  const small = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
  assert.ok(!T.localFits(big, 8192), 'sixty thousand characters do not fit an 8k context');
  assert.ok(T.localFits(small, 8192));
  assert.ok(T.localFits(small, 0), 'an unknown context is taken as 16k');
  assert.ok(!T.localFits('x'.repeat(100000), 0), 'and a hundred thousand characters exceed it');
  assert.strictEqual(T.gateLocal({ loc, host: '127.0.0.1', source: '', namedOpen: false, byokCount: 1, bodyStr: big, n_ctx: 8192 }), null, 'hosted takes the oversized request');
  assert.strictEqual(T.gateLocal({ loc, host: '127.0.0.1', source: '', namedOpen: false, byokCount: 0, bodyStr: big, n_ctx: 8192 }), loc, 'with no hosted lane the local server still gets its chance');
});

console.log('\nlocal-lane: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
