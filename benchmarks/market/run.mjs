#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// AgentMarket live race — Layer 3 of the substrate.
//
// The earlier unit tests for race() used synthetic in-memory agents with
// hand-built verification verdicts. That proved the scoring logic is
// sound but left a gap: we never watched race() on agents doing real
// file work against the real filesystem, with verification reading real
// bytes off disk.
//
// This benchmark closes that: two agent callables each edit a fresh
// copy of the null-guard sample. Agent A produces a correct fix; agent
// B produces syntactically broken output. Verification runs AST against
// each result. Winner should be A. Both attempts should land in the
// substrate as losing/winning ActionRecords. analyzeWinners should
// reflect the outcome.
//
// No Docker needed — what the architecture cares about is "two agents
// race, verifier scores, substrate records." Shelling out to Docker
// workers is plumbing, not substrate. A follow-up bench can plumb
// Docker once we care about true-parallel different-model execution.
//
// Usage:
//   node benchmarks/market/run.mjs

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const DATA_DIR = '/tmp/gc-market-' + Date.now();
mkdirSync(DATA_DIR, { recursive: true });
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR;

const state         = require(resolve(REPO, 'shared-core', 'state.js'));
const actionRecord  = require(resolve(REPO, 'shared-core', 'action-record.js'));
const verification  = require(resolve(REPO, 'shared-core', 'verification.js'));
const market        = require(resolve(REPO, 'shared-core', 'market.js'));

const TASK_ID = 'null-guard-' + Date.now();
const SESSION = 'market-' + Date.now();
const CWD_A   = '/tmp/gc-market-worker-a-' + Date.now();
const CWD_B   = '/tmp/gc-market-worker-b-' + Date.now();
mkdirSync(CWD_A, { recursive: true });
mkdirSync(CWD_B, { recursive: true });

// Seed each worker's scratch with the same broken source.
const BROKEN = `function peakValue(samples) {
  return Math.max(...samples.map(s => s.value));
}
module.exports = { peakValue };
`;
writeFileSync(resolve(CWD_A, 'metrics.js'), BROKEN);
writeFileSync(resolve(CWD_B, 'metrics.js'), BROKEN);

let failed = 0;
function assert(cond, label) {
  const mark = cond ? '✓' : '✗';
  console.log('  ' + mark + ' ' + label);
  if (!cond) failed++;
}

// ── Agent A: produces a correct fix (filters nulls before Math.max) ──────
async function agentA({ task }) {
  const file = resolve(CWD_A, 'metrics.js');
  const fixed = `function peakValue(samples) {
  const values = samples.map(s => s.value).filter(v => v !== null);
  return Math.max(...values);
}
module.exports = { peakValue };
`;
  writeFileSync(file, fixed);
  const ast = verification.verifyAST(file, fixed);
  const rec = actionRecord.create({
    type: 'edit', agent_id: 'worker-a',
    session_id: SESSION, cwd: CWD_A,
    input:  { file_path: file, format: 'write' },
    output: { hash_after: 'a'.repeat(40), lines_changed: 4 },
    verification: { ast }
  });
  state.recordAction(rec, actionRecord.toSearchText(rec));
  return { record: rec, tokens: 420, latency_ms: 50 };
}

// ── Agent B: produces syntactically broken output (unclosed brace) ───────
async function agentB({ task }) {
  const file = resolve(CWD_B, 'metrics.js');
  const broken = `function peakValue(samples) {
  return samples.filter(s => s.value != null).reduce((m, s) => s.value > m ? s.value : m, -Infinity
}
module.exports = { peakValue };
`;
  writeFileSync(file, broken);
  const ast = verification.verifyAST(file, broken);
  const rec = actionRecord.create({
    type: 'edit', agent_id: 'worker-b',
    session_id: SESSION, cwd: CWD_B,
    input:  { file_path: file, format: 'write' },
    output: { hash_after: 'b'.repeat(40), lines_changed: 4 },
    verification: { ast }
  });
  state.recordAction(rec, actionRecord.toSearchText(rec));
  return { record: rec, tokens: 380, latency_ms: 45 };
}

// ── Run the race ─────────────────────────────────────────────────────────
console.log('[race] dispatching worker-a + worker-b on task ' + TASK_ID);
const result = await market.race(state, {
  task: 'Fix peakValue to ignore null samples',
  task_id: TASK_ID,
  session_id: SESSION,
  cwd: CWD_A,
  agents: [
    { id: 'worker-a', run: agentA },
    { id: 'worker-b', run: agentB }
  ]
});

console.log('[race] winner: ' + (result.winner && result.winner.agent_id));
console.log('[race] attempts: ' + result.attempts.map(a => a.agent_id + '=' + a.score.toFixed(1)).join(', '));

// ── Assertions ───────────────────────────────────────────────────────────
console.log('[check] assertions:');

assert(result.ok === true, 'race returned ok=true');
assert(result.attempts.length === 2, 'race produced exactly 2 attempts');
assert(!!result.winner, 'race picked a winner');
assert(result.winner && result.winner.agent_id === 'worker-a',
  'winner is worker-a (correct fix) not worker-b (broken) — actual: ' +
  (result.winner && result.winner.agent_id));

// market_run audit row should exist in the substrate.
const runs = state.queryActions({ type: 'decision', session_id: SESSION });
const marketRuns = runs.filter(r => {
  const p = actionRecord.fromRow(r);
  return p.input && p.input.kind === 'market_run';
});
assert(marketRuns.length >= 1, 'substrate has a market_run decision row (got ' + marketRuns.length + ')');

const winners = runs.filter(r => {
  const p = actionRecord.fromRow(r);
  return p.input && p.input.kind === 'market_winner';
});
assert(winners.length >= 1, 'substrate has a market_winner decision row (got ' + winners.length + ')');

// Both worker records should survive as queryable evidence.
const workerEdits = state.queryActions({ type: 'edit', session_id: SESSION });
assert(workerEdits.length === 2, 'both worker edit attempts are preserved (got ' + workerEdits.length + ')');

// analyzeWinners should reflect the outcome. Returns an object keyed
// by agent_id → { wins, losses, total, win_rate }.
const stats = market.analyzeWinners(state) || {};
assert(stats['worker-a'] && stats['worker-a'].wins >= 1,
  'analyzeWinners shows at least 1 win for worker-a (got ' + JSON.stringify(stats['worker-a']) + ')');
assert(!stats['worker-b'] || (stats['worker-b'].wins || 0) === 0,
  'analyzeWinners shows 0 wins for worker-b (got ' + JSON.stringify(stats['worker-b']) + ')');
assert(stats['worker-b'] && stats['worker-b'].losses >= 1,
  'analyzeWinners shows at least 1 loss for worker-b (got ' + JSON.stringify(stats['worker-b']) + ')');

// Verification on the broken file is actually false.
const bFileContent = readFileSync(resolve(CWD_B, 'metrics.js'), 'utf8');
const bAst = verification.verifyAST(resolve(CWD_B, 'metrics.js'), bFileContent);
assert(bAst.ok === false, 'broken file AST verification is false (sanity: losing agent really did break it)');

// ── Report ───────────────────────────────────────────────────────────────
console.log('\n[report]');
console.log('  task_id        : ' + TASK_ID);
console.log('  session_id     : ' + SESSION);
console.log('  winner         : ' + (result.winner && result.winner.agent_id));
console.log('  market_run rows: ' + marketRuns.length);
console.log('  market_winner  : ' + winners.length);
console.log('  worker edits   : ' + workerEdits.length);
console.log('  analyzeWinners : ' + JSON.stringify(stats));
console.log('  data dir       : ' + DATA_DIR);
console.log('  assertions     : ' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));

if (failed > 0) process.exit(1);
