#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The questions harness works end to end on the two-threads seed: the judge
// is pure, both roads put a block in front of the model, a thread finds its
// own facts, the input copy is never written, and the report lands where
// compare.js expects it.
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

console.log('\n=== substrate questions ===\n');

const { judge, summarize } = require(path.join(DIR, 'run.js'));

t('the judge counts facts and leaks as regexes over the block', () => {
  const j = judge({ must: ['Tuesday', '19:00'], must_not: ['Thursday'] }, 'training is Tuesday at 19:00, said the coach');
  assert.strictEqual(j.must_hit, 2);
  assert.deepStrictEqual(j.leaks, []);
  const k = judge({ must: ['Tuesday'], must_not: ['thursday'] }, 'Thursday 20:30');
  assert.strictEqual(k.must_hit, 0);
  assert.deepStrictEqual(k.missing, ['Tuesday']);
  assert.deepStrictEqual(k.leaks, ['thursday']);
  const s = summarize([j, k].map((x) => Object.assign({ ms: 1 }, x)));
  assert.strictEqual(s.facts_hit, 2);
  assert.strictEqual(s.leaks, 1);
  assert.strictEqual(s.items_with_leak, 1);
});

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-questions-test-'));
const seed = spawnSync(process.execPath, [path.join(DIR, 'seed-two-threads.js'), '--out', out], { encoding: 'utf8', timeout: 60000 });
const [db, questions] = String(seed.stdout || '').trim().split('\n');

t('the seed writes a database and its questions', () => {
  assert.strictEqual(seed.status, 0, seed.stderr);
  assert.ok(db && fs.existsSync(db), 'db at ' + db);
  assert.ok(questions && fs.existsSync(questions), 'questions at ' + questions);
});

const before = db && fs.existsSync(db) ? fs.statSync(db) : null;
const run = spawnSync(process.execPath, [
  '-r', path.join(REPO, 'tests', 'hermetic-db.js'), path.join(DIR, 'run.js'),
  '--db', db, '--questions', questions, '--road', 'both', '--label', 'harness-check', '--out', out, '--quiet'
], { encoding: 'utf8', timeout: 180000 });

let report = null;
t('a run writes one report covering both roads', () => {
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const files = fs.readdirSync(out).filter((n) => n.startsWith('harness-check-') && n.endsWith('.json'));
  assert.strictEqual(files.length, 1, files.join(','));
  report = JSON.parse(fs.readFileSync(path.join(out, files[0]), 'utf8'));
  assert.ok(report.roads.entity && report.roads['claude-code'], Object.keys(report.roads).join(','));
  assert.strictEqual(report.roads.entity.items.length, 6);
  assert.strictEqual(report.roads['claude-code'].items.length, 6);
});

t('each road puts a block in front of the model', () => {
  for (const road of ['entity', 'claude-code']) {
    const withText = report.roads[road].items.filter((it) => it.chars > 0).length;
    assert.ok(withText >= 1, road + ': ' + withText + ' items with a block; stderr: ' + report.roads[road].items.map((it) => it.stderr).join(' | '));
  }
});

t('a thread finds its own facts on the entity road', () => {
  const byId = new Map(report.roads.entity.items.map((it) => [it.id, it]));
  assert.strictEqual(byId.get('q1').must_hit, 1, 'football training missing ' + JSON.stringify(byId.get('q1').missing));
  assert.strictEqual(byId.get('q2').must_hit, 1, 'volleyball training missing ' + JSON.stringify(byId.get('q2').missing));
  assert.strictEqual(byId.get('q4').must_hit, 1, 'shared fact missing ' + JSON.stringify(byId.get('q4').missing));
});

t('the input copy is never written by a run', () => {
  const after = fs.statSync(db);
  assert.strictEqual(after.size, before.size);
  assert.strictEqual(after.mtimeMs, before.mtimeMs);
  assert.ok(!fs.existsSync(db + '-wal'), 'no wal beside the input');
});

console.log('\nsubstrate-questions: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
