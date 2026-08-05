#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Retention benchmark — does specific knowledge from session 1 survive
// 3 intervening sessions of noise and still surface in session 5?
//
// Structure:
//   s1: fix peakValue (substrate gets a verified edit row for metrics.js)
//   s2-s4: 3 unrelated tasks in DIFFERENT scratch dirs — noise
//   s5: back to the same scratch as s1, different function that has the
//        same bug-class. If substrate retention works, s5's injector
//        surfaces s1's edit as precedent despite the 3 intervening
//        sessions.
//
// Metric: did s5's [troth/precedent] block include the s1 edit?
// Concrete: s5's context_injection decision row has precedent_count >= 1
// AND at least one precedent points at the s1 edit's file.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

// Resolve the substrate the same way shared-core/state.js does, instead of
// hardcoding one installation's legacy plugin-data path. That path stopped
// being where the database lives, so this benchmark was measuring retention in
// a file that was not there: STATE_DB_PATH first, then the current ~/.troth
// location, then the legacy path for an install that has not moved yet.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DB = process.env.STATE_DB_PATH ||
  [join(homedir(), '.troth', 'state.db'),
   join(homedir(), '.claude', 'plugins', 'data', 'troth-troth-local', 'state.db')]
    .find(existsSync) || join(homedir(), '.troth', 'state.db');
const MAIN_SCRATCH = '/tmp/gc-retention-main';
const NOISE_BASE   = '/tmp/gc-retention-noise';

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...opts });
}

function seedMainScratch() {
  try { rmSync(MAIN_SCRATCH, { recursive: true, force: true }); } catch {}
  mkdirSync(MAIN_SCRATCH + '/src', { recursive: true });
  mkdirSync(MAIN_SCRATCH + '/test', { recursive: true });
  writeFileSync(MAIN_SCRATCH + '/package.json', JSON.stringify({
    name: 'gc-retention', private: true,
    scripts: { test: 'node --test test/*.test.js' }
  }, null, 2) + '\n');
  writeFileSync(MAIN_SCRATCH + '/src/metrics.js', `// Two functions, same null-coercion bug pattern.
function peakValue(samples) { return Math.max(...samples.map(s => s.value)); }
function minValue(samples)  { return Math.min(...samples.map(s => s.value)); }
module.exports = { peakValue, minValue };
`);
  writeFileSync(MAIN_SCRATCH + '/test/peak.test.js.off',
    `const {test}=require('node:test');const a=require('node:assert');const {peakValue}=require('../src/metrics');test('peakValue ignores nulls',()=>{a.strictEqual(peakValue([{value:-3},{value:null},{value:-1}]),-1);});\n`);
  writeFileSync(MAIN_SCRATCH + '/test/min.test.js.off',
    `const {test}=require('node:test');const a=require('node:assert');const {minValue}=require('../src/metrics');test('minValue ignores nulls',()=>{a.strictEqual(minValue([{value:3},{value:null},{value:7}]),3);});\n`);
}

function seedNoiseScratch(tag) {
  const dir = NOISE_BASE + '-' + tag;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  mkdirSync(dir + '/src', { recursive: true });
  mkdirSync(dir + '/test', { recursive: true });
  writeFileSync(dir + '/package.json', JSON.stringify({
    name: 'gc-noise-' + tag, private: true,
    scripts: { test: 'node --test test/*.test.js' }
  }, null, 2) + '\n');
  // Totally unrelated task: a buggy string helper.
  writeFileSync(dir + '/src/strings.js', `function reverseWords(s) {
  // Bug: splits on single space only, loses runs of whitespace.
  return s.split(' ').reverse().join(' ');
}
module.exports = { reverseWords };
`);
  writeFileSync(dir + '/test/strings.test.js',
    `const {test}=require('node:test');const a=require('node:assert');const {reverseWords}=require('../src/strings');test('handles multi-space',()=>{a.strictEqual(reverseWords('hi   there'),'there   hi');});\n`);
  return dir;
}

function enableTest(scratch, name) {
  try { sh(`mv "${scratch}/test/${name}.test.js.off" "${scratch}/test/${name}.test.js"`); } catch {}
}

function runClaude(scratch) {
  const t0 = Date.now();
  const out = sh(`cd "${scratch}" && claude -p --dangerously-skip-permissions --output-format=json "npm test fails. Fix the production code so it passes. Don't modify any file under test/."`);
  const j = JSON.parse(out);
  j.wall_ms = Date.now() - t0;
  return j;
}

function injectorDecision(session_id) {
  const sql = `SELECT json_extract(input,'$.precedent_count'), cwd
               FROM action_records
               WHERE session_id='${session_id}'
                 AND json_extract(input,'$.kind')='context_injection'
               ORDER BY timestamp ASC LIMIT 1`;
  const out = sh(`sqlite3 "${DB}" "${sql}"`).trim();
  if (!out) return null;
  const [prec, cwd] = out.split('|');
  return { precedent_count: parseInt(prec || '0', 10), cwd };
}

function verifiedEditsForCwd(cwd) {
  const sql = `SELECT id, json_extract(input,'$.file_path')
               FROM action_records
               WHERE cwd='${cwd}' AND type='edit' AND json_extract(verification,'$.ast.ok')=1
               ORDER BY timestamp ASC`;
  return sh(`sqlite3 "${DB}" "${sql}"`).trim().split('\n').filter(Boolean)
    .map(l => { const [id, fp] = l.split('|'); return { id, file_path: fp }; });
}

// ── Run the sequence ─────────────────────────────────────────────────────
console.log('[setup] resetting scratch dirs and purging substrate rows for these cwds');
seedMainScratch();
for (const tag of ['a', 'b', 'c']) seedNoiseScratch(tag);
const mainAbs  = '/private' + MAIN_SCRATCH;
sh(`sqlite3 "${DB}" "DELETE FROM action_records WHERE cwd='${mainAbs}'"`);
for (const tag of ['a', 'b', 'c']) {
  sh(`sqlite3 "${DB}" "DELETE FROM action_records WHERE cwd='/private${NOISE_BASE}-${tag}'"`);
}

// s1: main scratch, fix peakValue
console.log('\n[s1] main scratch — fix peakValue');
enableTest(MAIN_SCRATCH, 'peak');
const s1 = runClaude(MAIN_SCRATCH);
const s1inj = injectorDecision(s1.session_id);
console.log(`  dur=${s1.duration_ms}ms precedent=${s1inj ? s1inj.precedent_count : '?'}`);

// s2, s3, s4: noise in different cwds
const noiseResults = [];
for (const tag of ['a', 'b', 'c']) {
  const dir = NOISE_BASE + '-' + tag;
  console.log(`\n[noise-${tag}] ${dir} — reverseWords fix`);
  const r = runClaude(dir);
  const inj = injectorDecision(r.session_id);
  console.log(`  dur=${r.duration_ms}ms precedent=${inj ? inj.precedent_count : '?'}`);
  noiseResults.push({ tag, ...r, inj });
}

// s5: back to main scratch, enable minValue test (different function, same bug class)
console.log('\n[s5] main scratch — fix minValue (retention test)');
enableTest(MAIN_SCRATCH, 'min');
const s5 = runClaude(MAIN_SCRATCH);
const s5inj = injectorDecision(s5.session_id);
console.log(`  dur=${s5.duration_ms}ms precedent=${s5inj ? s5inj.precedent_count : '?'}`);

// What verified edits exist for the main cwd RIGHT NOW?
const edits = verifiedEditsForCwd(mainAbs);
console.log(`\n[substrate] main cwd has ${edits.length} verified edit row(s):`);
for (const e of edits) console.log('  · ' + e.file_path + ' (id=' + e.id.slice(0, 13) + ')');

// ── Assertions ───────────────────────────────────────────────────────────
let failed = 0;
function assert(cond, label) {
  const mark = cond ? '✓' : '✗';
  console.log('  ' + mark + ' ' + label);
  if (!cond) failed++;
}

console.log('\n[check] assertions:');
assert(s1inj && s1inj.precedent_count === 0, 's1 saw 0 precedent (cold start)');
assert(s5inj && s5inj.precedent_count >= 1, 's5 saw ≥1 precedent despite 3 intervening noise sessions (got ' + (s5inj && s5inj.precedent_count) + ')');
assert(edits.length >= 1 && edits[0].file_path.endsWith('src/metrics.js'),
  's1 left a verified edit on metrics.js that persists in the substrate');
assert(s5.duration_ms < s1.duration_ms,
  's5 was faster than s1 (retention payoff; got s1=' + s1.duration_ms + ' s5=' + s5.duration_ms + ')');

console.log('\n[report]');
console.log('  s1 duration        : ' + s1.duration_ms + 'ms ($' + s1.total_cost_usd.toFixed(4) + ')');
console.log('  s5 duration        : ' + s5.duration_ms + 'ms ($' + s5.total_cost_usd.toFixed(4) + ')');
console.log('  s5 precedent_count : ' + (s5inj && s5inj.precedent_count));
console.log('  sessions between   : 3 (different cwds)');
console.log('  verified edits kept: ' + edits.length);
console.log('  assertions         : ' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));

if (failed > 0) process.exit(1);
