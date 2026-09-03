#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Two conversations in the same words never see each other's facts on either
// memory road, and each finds its own: the two-threads seed asked through
// the questions harness, with the reranker absent (so the Claude Code road
// answers from its identity block alone).
require('./hermetic-db.js');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DIR = path.join(REPO, 'benchmarks', 'substrate-questions');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== thread isolation ===\n');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-isolation-'));
const seed = spawnSync(process.execPath, [path.join(DIR, 'seed-two-threads.js'), '--out', out], { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(seed.status, 0, seed.stderr);
const [db, questions] = String(seed.stdout || '').trim().split('\n');
const run = spawnSync(process.execPath, [
  '-r', path.join(REPO, 'tests', 'hermetic-db.js'), path.join(DIR, 'run.js'),
  '--db', db, '--questions', questions, '--road', 'both', '--label', 'isolation', '--out', out, '--quiet'
], { encoding: 'utf8', timeout: 180000 });
assert.strictEqual(run.status, 0, run.stderr || run.stdout);
const file = fs.readdirSync(out).find((n) => n.startsWith('isolation-') && n.endsWith('.json'));
const report = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
const items = (road) => new Map(report.roads[road].items.map((it) => [it.id, it]));
const show = (it) => it.id + ' leaks=' + JSON.stringify(it.leaks) + ' missing=' + JSON.stringify(it.missing) + '\n' + it.text.slice(0, 600);

t('the entity road leaks nothing between the two conversations', () => {
  assert.strictEqual(report.roads.entity.summary.leaks, 0, report.roads.entity.items.filter((i) => i.leaks.length).map(show).join('\n---\n'));
});

t('the entity road finds every fact through its own thread', () => {
  const s = report.roads.entity.summary;
  assert.strictEqual(s.facts_hit, s.facts_total, report.roads.entity.items.filter((i) => i.missing.length).map(show).join('\n---\n'));
});

t('the Claude Code road leaks nothing between the two conversations', () => {
  assert.strictEqual(report.roads['claude-code'].summary.leaks, 0, report.roads['claude-code'].items.filter((i) => i.leaks.length).map(show).join('\n---\n'));
});

t('the Claude Code road answers each thread from its own facts', () => {
  const by = items('claude-code');
  assert.strictEqual(by.get('q1').must_hit, 1, show(by.get('q1')));
  assert.strictEqual(by.get('q2').must_hit, 1, show(by.get('q2')));
});

console.log('\nthread-isolation: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
