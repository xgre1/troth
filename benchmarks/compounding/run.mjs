#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Compounding benchmark — does substrate value grow as sessions accumulate?
//
// Drives 5 sequential `claude -p` sessions in the same cwd, each fixing a
// different metric function that has the SAME null-null-bug class. If the
// substrate is working as the scope doc claims, every later session should:
//   - see more [troth/precedent] rows injected
//   - pay less cache-creation cost
//   - finish faster
// because prior sessions left verified edit ActionRecords that the
// injector surfaces.
//
// Writes benchmarks/results/compounding-<timestamp>.json on success.

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const SCRATCH = '/tmp/gc-compound-bench';
// Substrate path. As of  the plugin and proxy share a single
// SQLite at ~/.troth/state.db.
// Honor an explicit override for harnesses that point elsewhere.
const DB = process.env.STATE_DB_PATH || process.env.TROTH_DB_PATH || (process.env.HOME + '/.troth/state.db');

// Reset scratch + purge prior substrate rows for this cwd so the first
// session is genuinely cold.
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
mkdirSync(SCRATCH + '/src', { recursive: true });
mkdirSync(SCRATCH + '/test', { recursive: true });

// Seed: all 5 functions are broken with the same null-coercion pattern.
// Tests start disabled; we enable them one at a time per session.
writeFileSync(SCRATCH + '/package.json', JSON.stringify({
  name: 'gc-compound', private: true,
  scripts: { test: 'node --test test/*.test.js' }
}, null, 2) + '\n');

writeFileSync(SCRATCH + '/src/metrics.js', `// All five use the same Math.max(...map(...value)) / sum+length pattern.
// Null samples coerce to 0, producing wrong results on all-negative data.

function peakValue(samples) {
  return Math.max(...samples.map(s => s.value));
}
function avgValue(samples) {
  const sum = samples.reduce((a, s) => a + s.value, 0);
  return sum / samples.length;
}
function minValue(samples) {
  return Math.min(...samples.map(s => s.value));
}
function rangeValue(samples) {
  return Math.max(...samples.map(s => s.value)) - Math.min(...samples.map(s => s.value));
}
function sumValue(samples) {
  return samples.reduce((a, s) => a + s.value, 0);
}
module.exports = { peakValue, avgValue, minValue, rangeValue, sumValue };
`);

// One test per function, each exposing the null-coercion bug.
const TESTS = {
  peak:  `const {test}=require('node:test');const a=require('node:assert');const {peakValue}=require('../src/metrics');test('peakValue ignores nulls (negative dataset)',()=>{a.strictEqual(peakValue([{value:-3},{value:null},{value:-1},{value:-5}]),-1);});`,
  avg:   `const {test}=require('node:test');const a=require('node:assert');const {avgValue}=require('../src/metrics');test('avgValue ignores nulls',()=>{a.strictEqual(avgValue([{value:4},{value:null},{value:8}]),6);});`,
  min:   `const {test}=require('node:test');const a=require('node:assert');const {minValue}=require('../src/metrics');test('minValue ignores nulls (positive dataset)',()=>{a.strictEqual(minValue([{value:3},{value:null},{value:7},{value:5}]),3);});`,
  range: `const {test}=require('node:test');const a=require('node:assert');const {rangeValue}=require('../src/metrics');test('rangeValue ignores nulls',()=>{a.strictEqual(rangeValue([{value:2},{value:null},{value:5},{value:3}]),3);});`,
  sum:   `const {test}=require('node:test');const a=require('node:assert');const {sumValue}=require('../src/metrics');test('sumValue ignores nulls',()=>{a.strictEqual(sumValue([{value:1},{value:null},{value:4},{value:5}]),10);});`
};
for (const [k, v] of Object.entries(TESTS)) {
  writeFileSync(SCRATCH + '/test/' + k + '.test.js.off', v + '\n');
}

// Purge prior substrate rows for this cwd so session 1 is cold.
execSync(`sqlite3 "${DB}" "DELETE FROM action_records WHERE cwd='/private${SCRATCH}'"`);
// Clear per-session chain trackers.
try { rmSync(process.env.HOME + '/.claude/plugins/data/troth-troth-local/chains/', { recursive: true, force: true }); } catch {}

const ORDER = ['peak', 'avg', 'min', 'range', 'sum'];
const results = [];

function enableTest(name) {
  const off = SCRATCH + '/test/' + name + '.test.js.off';
  const on  = SCRATCH + '/test/' + name + '.test.js';
  try { execSync(`mv "${off}" "${on}"`); } catch {}
}
function querySubstrate(sessionId) {
  const sql = `SELECT json_extract(input,'$.precedent_count'),
                      json_extract(input,'$.map_included')
               FROM action_records
               WHERE session_id='${sessionId}'
                 AND json_extract(input,'$.kind')='context_injection'
               ORDER BY timestamp ASC LIMIT 1`;
  const out = execSync(`sqlite3 "${DB}" "${sql}"`, { encoding: 'utf8' }).trim();
  if (!out) return { precedent_count: null, map_included: null };
  const [prec, map] = out.split('|');
  return { precedent_count: parseInt(prec || '0', 10), map_included: map === '1' };
}

for (let i = 0; i < ORDER.length; i++) {
  const name = ORDER[i];
  enableTest(name);
  console.log(`\n[session ${i + 1}/${ORDER.length}] fixing ${name}Value`);

  const t0 = Date.now();
  const raw = execSync(
    `cd "${SCRATCH}" && claude -p --dangerously-skip-permissions --output-format=json "npm test fails. Fix the production code so it passes. Don't modify any file under test/."`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const wallMs = Date.now() - t0;
  const j = JSON.parse(raw);
  const subst = querySubstrate(j.session_id);

  const row = {
    idx: i + 1,
    task: name,
    session_id: j.session_id.slice(0, 12),
    wall_ms: wallMs,
    duration_ms: j.duration_ms,
    cost_usd: j.total_cost_usd,
    cache_creation: j.usage.cache_creation_input_tokens,
    cache_read: j.usage.cache_read_input_tokens,
    output_tokens: j.usage.output_tokens,
    turns: j.num_turns,
    precedent_count: subst.precedent_count,
    map_included: subst.map_included
  };
  results.push(row);
  console.log(`  dur=${row.duration_ms}ms cost=$${row.cost_usd.toFixed(4)} cache_create=${row.cache_creation} precedent=${row.precedent_count}`);

  // Sanity: tests pass.
  try { execSync(`cd "${SCRATCH}" && npm test --silent`, { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { console.warn('  ⚠ tests failed after agent — skipping further sessions'); break; }
}

// ── Report ───────────────────────────────────────────────────────────────
console.log('\n=== compounding report ===\n');
console.log('idx  task    cost     cache_create  precedent  turns');
for (const r of results) {
  console.log(
    String(r.idx).padEnd(4) +
    r.task.padEnd(8) +
    ('$' + r.cost_usd.toFixed(4)).padEnd(9) +
    String(r.cache_creation).padEnd(14) +
    String(r.precedent_count).padEnd(11) +
    r.turns
  );
}

// Persist raw JSON for the report doc.
mkdirSync(REPO + '/benchmarks/results', { recursive: true });
// A sanitising pass once replaced the date template here with the words that
// described it, so every run overwrote a single file literally named
// " (dated per run)". Same stamp format as the other runners.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(REPO + '/benchmarks/results/compounding-' + stamp + '.json',
  JSON.stringify(results, null, 2) + '\n');

// Compute trend metrics.
const firstCache = results[0] && results[0].cache_creation;
const lastCache  = results[results.length - 1] && results[results.length - 1].cache_creation;
const firstCost  = results[0] && results[0].cost_usd;
const lastCost   = results[results.length - 1] && results[results.length - 1].cost_usd;
const maxPrec    = Math.max(...results.map(r => r.precedent_count || 0));

console.log('\n[trend]');
console.log('  cache-creation s1→sN: ' + firstCache + ' → ' + lastCache +
  ' (' + (lastCache / firstCache * 100).toFixed(0) + '%)');
console.log('  cost s1→sN          : $' + firstCost.toFixed(4) + ' → $' + lastCost.toFixed(4) +
  ' (' + (lastCost / firstCost * 100).toFixed(0) + '%)');
console.log('  precedent peak      : ' + maxPrec);
console.log('  sessions completed  : ' + results.length);
