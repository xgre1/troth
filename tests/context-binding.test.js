#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The context a conversation binds to, by one chain for every surface: an
// explicit statement wins, a recorded binding holds, the directory names it,
// the session's file activity votes, a plain mention decides last. Each new
// binding is recorded in the session.
require('./hermetic-db.js');
const assert = require('assert');
const os = require('os');
const path = require('path');

const CORE = path.join(__dirname, '..', 'shared-core');
const ctxReg = require(path.join(CORE, 'context-registry.js'));
const state = require(path.join(CORE, 'state.js'));
const ar = require(path.join(CORE, 'action-record.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== context binding ===\n');

assert.ok(ctxReg.ensureContext('alpha-work').ok);
assert.ok(ctxReg.ensureContext('beta-work').ok);

t('an explicit statement binds and is recorded', () => {
  const r = ctxReg.bindSession({ session_id: 's1', cwd: '/w/nowhere', text: 'we are working on alpha work today' });
  assert.strictEqual(r.context_id, 'ctx:alpha-work');
  assert.strictEqual(r.by, 'explicit');
  assert.strictEqual(ctxReg.currentBinding('s1'), 'ctx:alpha-work');
});

t('a recorded binding holds for the next message', () => {
  const r = ctxReg.bindSession({ session_id: 's1', cwd: '/w/nowhere', text: 'and what about beta work?' });
  assert.strictEqual(r.context_id, 'ctx:alpha-work');
  assert.strictEqual(r.by, 'recorded');
});

t('an explicit switch rebinds', () => {
  const r = ctxReg.bindSession({ session_id: 's1', cwd: '/w/nowhere', text: 'switch to beta work' });
  assert.strictEqual(r.context_id, 'ctx:beta-work');
  assert.strictEqual(ctxReg.currentBinding('s1'), 'ctx:beta-work');
});

t('the directory binds when it names a registered context', () => {
  const r = ctxReg.bindSession({ session_id: 's2', cwd: '/w/beta-work', text: 'hello' });
  assert.strictEqual(r.context_id, 'ctx:beta-work');
  assert.strictEqual(r.by, 'cwd');
});

t('a home folder never binds', () => {
  ctxReg.ensureContext(path.basename(os.homedir()));
  const r = ctxReg.bindSession({ session_id: 's3', cwd: os.homedir(), text: 'hello' });
  assert.strictEqual(r.context_id, null);
  const d = ctxReg.bindSession({ session_id: 's3b', cwd: '/w/documents', text: 'hello' });
  assert.strictEqual(d.context_id, null);
});

t('file activity binds a session that names nothing', () => {
  for (let i = 0; i < 4; i++) {
    state.recordAction({ id: ar.uuidv7(), timestamp: Date.now(), type: 'edit', agent_id: 'fc', session_id: 's4',
      input: { file_path: '/w/alpha-work/src/f' + i + '.js' }, output: {} }, 'edit');
  }
  const r = ctxReg.bindSession({ session_id: 's4', cwd: '/w/other', text: 'hi' });
  assert.strictEqual(r.context_id, 'ctx:alpha-work');
  assert.strictEqual(r.by, 'activity');
});

t('a plain mention binds last', () => {
  const r = ctxReg.bindSession({ session_id: 's5', cwd: '/w/other', text: 'what about the alpha work deadline' });
  assert.strictEqual(r.context_id, 'ctx:alpha-work');
  assert.strictEqual(r.by, 'mention');
});

t('a session that names nothing stays unbound', () => {
  const r = ctxReg.bindSession({ session_id: 's6', cwd: '/w/other', text: 'hello there' });
  assert.strictEqual(r.context_id, null);
  assert.strictEqual(ctxReg.currentBinding('s6'), null);
});

console.log('\ncontext-binding: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
