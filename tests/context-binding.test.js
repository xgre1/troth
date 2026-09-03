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

t('a slug inside a longer word is no mention', () => {
  ctxReg.ensureContext('north');
  assert.strictEqual(ctxReg.resolveMention('how much do I earn from northwind'), null);
  assert.strictEqual(ctxReg.resolveMention('the north invoice is late'), 'ctx:north');
  assert.strictEqual(ctxReg.resolveMention('we talked about alpha-work and alpha work'), 'ctx:alpha-work');
});

t('a generic folder word never names a topic', () => {
  ctxReg.ensureContext('core');
  assert.strictEqual(ctxReg.resolveMention('the core of the problem'), null);
  assert.strictEqual(ctxReg.bindSession({ session_id: 's8', cwd: '/w/core', text: 'hello' }).context_id, null);
  assert.ok(ctxReg.isDeniedSlug('tool-results'));
});

t('a declaration names a topic the registry does not know yet', () => {
  const r = ctxReg.bindSession({ session_id: 's9', cwd: '/w/other', text: 'we are working on brightpress tracker today' });
  assert.strictEqual(r.context_id, 'ctx:brightpress-tracker');
  assert.ok(ctxReg.listContexts().some((c) => c.slug === 'brightpress-tracker'), 'the context exists now');
  assert.strictEqual(ctxReg.declaredContext('we are working on it now'), null);
  assert.strictEqual(ctxReg.declaredContext('I have been working on fixing the build for hours and hours and it still fails on the second step of the pipeline'), null);
});

t('a text names a context by slug, phrase or entity alias', () => {
  const identity = require(path.join(CORE, 'entity-identity.js'));
  identity.recordEntityIdentity({ name: 'North', agent_id: 'local-agent', kind: 'organization', aliases: ['Northwind', 'Νόρθγουιντ'] });
  const names = ctxReg.contextNamer(['ctx:north', 'ctx:alpha-work']);
  assert.ok(names('the invoice from Northwind arrived'), 'entity alias');
  assert.ok(names('μίλησα με τον Νόρθγουιντ σήμερα'), 'greek alias');
  assert.ok(names('the alpha work review is Thursday'), 'phrase');
  assert.ok(!names('the beta work review is Thursday'), 'another context');
  assert.ok(ctxReg.namesAnyContext('alpha-work ships', ['ctx:alpha-work']));
  assert.strictEqual(ctxReg.resolveMention('the invoice from Northwind arrived'), 'ctx:north', 'a mention by entity alias');
  assert.strictEqual(ctxReg.bindSession({ session_id: 's11', cwd: '/w/other', text: 'did Northwind pay the invoice?' }).context_id, 'ctx:north');
});

t('a company whose name begins with a context slug carries that context', () => {
  const identity = require(path.join(CORE, 'entity-identity.js'));
  ctxReg.ensureContext('bright');
  identity.recordEntityIdentity({ name: 'Brightpress', agent_id: 'local-agent', kind: 'organization', aliases: ['Brightpress SA'] });
  identity.recordEntityIdentity({ name: 'Brighton Adams', agent_id: 'local-agent', kind: 'person' });
  const names = ctxReg.contextNamer(['ctx:bright']);
  assert.ok(names('the Brightpress invoice is due'), 'the company carries the context');
  assert.ok(!names('Brighton Adams called'), 'a person does not');
  assert.strictEqual(ctxReg.resolveMention('Brightpress SA called about the job'), 'ctx:bright');
});

t('the facets of one subject are one family', () => {
  ctxReg.ensureContext('troth-core');
  ctxReg.ensureContext('troth-files');
  ctxReg.ensureContext('troth-positioning');
  ctxReg.ensureContext('lonework');
  const fam = ctxReg.contextFamily('ctx:troth-core');
  assert.strictEqual(fam.head, 'troth');
  assert.ok(fam.members.has('ctx:troth-files') && fam.members.has('ctx:troth-positioning'), [...fam.members].join(','));
  const lone = ctxReg.contextFamily('ctx:lonework');
  assert.strictEqual(lone.head, null);
  assert.deepStrictEqual([...lone.members], ['ctx:lonework']);
  const covered = ctxReg.scopeContexts(['ctx:troth-positioning']);
  assert.ok(covered.has('ctx:troth-core') && covered.has('ctx:troth-files'), [...covered].join(','));
  assert.ok(!covered.has('ctx:lonework'));
  const names = ctxReg.contextNamer(['ctx:troth-core']);
  assert.ok(names('the troth pricing page lists three tiers'), 'the subject word names every facet');
  assert.ok(!names('the trothless pricing page'), 'whole words only');
});

t('a write in a bound session carries the binding without any file activity', () => {
  ctxReg.bindSession({ session_id: 's10', cwd: '/w/other', text: 'we are working on alpha work' });
  const id = ar.uuidv7();
  state.recordAction({ id, timestamp: Date.now(), type: 'decision', agent_id: 'fc', session_id: 's10', input: {}, output: { note: 'a later write' } }, 'decision');
  assert.strictEqual(state.getAction(id).context_id, 'ctx:alpha-work');
});

console.log('\ncontext-binding: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
