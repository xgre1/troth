#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The rule listing on a topic: superseded rules dropped, duplicates folded,
// this project's rules first, then the ones the topic's words touch, then the
// newest; whole text while the budget lasts, the opening after; each with its
// scope and day; what does not fit is counted and named.
const assert = require('assert');
const path = require('path');
const sr = require(path.join(__dirname, '..', 'shared-core', 'standing-rules.js'));
const tools = require(path.join(__dirname, '..', 'shared-core', 'substrate-tools.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 1);
const rows = [
  { id: 'aaaa1111-0000-7000-8000-000000000001', timestamp: T0 + 1 * DAY, cwd: null, scope: null, text: 'Commit subjects read like a person wrote them in one breath.' },
  { id: 'aaaa1111-0000-7000-8000-000000000002', timestamp: T0 + 2 * DAY, cwd: null, scope: null, text: 'Benchmark runs never execute on the laptop; the bench machine is elsewhere.' },
  { id: 'aaaa1111-0000-7000-8000-000000000003', timestamp: T0 + 3 * DAY, cwd: '/w/p', scope: 'project', text: 'In this repository, work lands on main. No side branches.' },
  { id: 'aaaa1111-0000-7000-8000-000000000004', timestamp: T0 + 4 * DAY, cwd: null, scope: null, text: 'SUPERSEDES rule aaaa1111-0000-7000-8000-000000000001 (too broad). Background agents are fine; only the marketplace reviewer is not.' },
  { id: 'bbbb2222-0000-7000-8000-000000000005', timestamp: T0 + 5 * DAY, cwd: null, scope: null, text: 'Commit subjects read like a person wrote them in one breath.' },
  { id: 'bbbb2222-0000-7000-8000-000000000006', timestamp: T0 + 6 * DAY, cwd: null, scope: null, text: 'When writing a commit message for the public repo, state capability, never process. ' + 'Say what the code does. '.repeat(12) }
];
const state = { listOperatorLessons: () => rows.slice() };

console.log('\n=== rule listing on a topic ===\n');

t('the order: this project first, then the topic, then the newest; superseded dropped; duplicates folded', () => {
  const r = sr.listRulesFor(state, { topic: 'commit message subject' });
  const ids = r.items.map((x) => x.id.slice(-1));
  assert.strictEqual(ids[0], '3', 'the project rule leads: ' + ids.join(''));
  assert.ok(ids.indexOf('6') === 1 || ids.indexOf('5') === 1, 'a commit rule comes next: ' + ids.join(''));
  // rule 4 names rule 1 by its id: only that one is superseded
  assert.strictEqual(r.superseded_dropped, 1);
  assert.ok(!r.items.some((x) => x.id.endsWith('1')), 'the superseded rule is gone: ' + ids.join(''));
  assert.ok(ids.includes('2') && ids.includes('3'), 'the others stay: ' + ids.join(''));
  assert.strictEqual(r.items.filter((x) => /one breath/.test(x.text)).length, 1, 'the duplicate text appears once');
});

t('each item carries its scope and the day it was set', () => {
  const r = sr.listRulesFor(state, { topic: '' });
  const proj = r.items.find((x) => x.scope === 'this project');
  assert.ok(proj, JSON.stringify(r.items));
  assert.strictEqual(proj.when, '2026-09-04');
  assert.ok(r.items.every((x) => x.scope === 'general' || x.scope === 'this project'));
  assert.ok(r.items.every((x) => typeof x.text === 'string' && x.text.length > 0));
});

t('whole text while the budget lasts, the opening after, and the count of what did not fit', () => {
  const full = sr.listRulesFor(state, { topic: 'commit', limit: 20 });
  assert.strictEqual(full.omitted, 0);
  assert.strictEqual(full.clipped, 0);
  assert.strictEqual(full.note, undefined);
  const tight = sr.listRulesFor(state, { topic: 'commit', limit: 20, budget_chars: 220 });
  assert.ok(tight.clipped >= 1 || tight.omitted >= 1, JSON.stringify(tight));
  assert.ok(/Ask again with a narrower topic/.test(tight.note), tight.note);
  const one = sr.listRulesFor(state, { topic: 'commit', limit: 1 });
  assert.strictEqual(one.shown, 1);
  assert.strictEqual(one.omitted, one.count - 1);
  assert.ok(/not shown/.test(one.note), one.note);
});

t('the tool takes a topic and reads through the same road', () => {
  const schema = tools.REGISTRY.rule_list.schema.function;
  assert.ok(schema.parameters.properties.topic, 'topic parameter');
  assert.ok(/topic/.test(schema.description));
});

t('the per-prompt block reads the same order and points the rest at rule_list with the topic', () => {
  const b = sr.renderStandingRules(state, { prompt: 'commit subject', cwd: null, budget_chars: 200 });
  assert.ok(/\[this project\]/.test(b.text.split('\n')[1]), 'the project rule leads the block: ' + b.text.split('\n')[1]);
  assert.ok(/ask rule_list with the topic/.test(b.text), b.text.slice(-160));
  assert.strictEqual(b.superseded, 1);
});

console.log('\nrule-list-topic: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
