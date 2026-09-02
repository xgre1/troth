#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The standing rules fit the block the harness will actually show. Order:
// this project's rules, then the rules the prompt's own words touch, then
// the newest; a rule is shown by its opening sentences; the footer counts
// what did not fit.
const assert = require('assert');
const sr = require('../shared-core/standing-rules.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== standing rules: budget, order, clipping ===\n');

const long = 'Verify the cause before fixing anything, read the adjacent code, and never ship on hygiene arguments alone; a finding is not a design and a design is not finished until the mechanisms were compared. ';
const rows = [];
for (let i = 0; i < 60; i++) rows.push({ id: 'r' + i, scope: i % 6 === 0 ? 'project' : 'global', ts: 1000 + i, text: 'Rule ' + i + ': ' + long.repeat(2) });
rows[13].text = 'Hooks must never time out: measure every hook before adding one, and keep the recall race under the budget.';
rows[41].text = 'Benchmark runs never execute on the laptop; the bench machine is the studio.';
const state = { listOperatorLessons: () => rows };

t('the block stays inside the budget', () => {
  const b = sr.renderStandingRules(state, { prompt: 'why do the hooks time out?', cwd: null });
  assert.ok(Buffer.byteLength(b.text) <= sr.MAX_CHARS + 400, 'bytes ' + Buffer.byteLength(b.text));
  assert.ok(b.count >= 12 && b.count < 60, 'shown ' + b.count);
  assert.strictEqual(b.count + b.omitted, 60);
});

t('this project\'s rules come first, then the rule the prompt touches', () => {
  const b = sr.renderStandingRules(state, { prompt: 'why do the hooks time out?', cwd: null });
  const lines = b.text.split('\n').filter(l => /^  · /.test(l));
  const projectCount = rows.filter(r => r.scope === 'project').length;
  for (let i = 0; i < projectCount; i++) assert.ok(/\[this project\]$/.test(lines[i]), 'line ' + i + ' is a project rule: ' + lines[i].slice(0, 60));
  assert.ok(/Hooks must never time out/.test(lines[projectCount]), 'the hooks rule leads the global rules: ' + lines[projectCount].slice(0, 80));
});

t('a long rule is shown by its opening sentences, with a mark that more follows', () => {
  const b = sr.renderStandingRules(state, { prompt: 'anything', cwd: null });
  const first = b.text.split('\n').find(l => /^  · Rule /.test(l));
  assert.ok(first.length <= sr.RULE_CHARS + 40, 'clipped: ' + first.length);
  assert.ok(/…/.test(first), 'marked as clipped');
  assert.strictEqual(sr.clipRule('short rule.', 280), 'short rule.');
});

t('the footer counts what did not fit and names where the rest lives', () => {
  const b = sr.renderStandingRules(state, { prompt: 'anything', cwd: null });
  assert.ok(new RegExp('\\(' + b.omitted + ' more rules hold this turn too; read them with rule_list').test(b.text), b.text.slice(-200));
  assert.ok(/60 rules the operator set/.test(b.text), 'the true count leads');
});

t('a few short rules render whole, with no footer', () => {
  const few = { listOperatorLessons: () => rows.slice(0, 5).map(r => ({ ...r, text: 'Short rule ' + r.id + '.' })) };
  const b = few && sr.renderStandingRules(few, { prompt: 'x', cwd: null });
  assert.strictEqual(b.omitted, 0);
  assert.ok(!/more rule/.test(b.text));
});

console.log('\nstanding-rules-budget: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
