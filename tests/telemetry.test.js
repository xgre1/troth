#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The machine's own telemetry: a hook writes how long it took, the proxy
// writes each error it answered with, and the doctor reads both into two
// lines a person can act on. Files only, never leaving the machine.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const assert = require('assert');
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-telemetry-'));
fs.mkdirSync(path.join(TMP, '.troth'), { recursive: true });
process.env.HOME = TMP;
process.env.CLAUDE_PLUGIN_DATA = path.join(TMP, '.troth');
process.env.STATE_DB_PATH = path.join(TMP, '.troth', 'state.db');
process.env._TROTH_TEST_HOME = TMP;
process.env.TROTH_NO_MODEL_FETCH = '1';
const tel = require(path.join(REPO, 'shared-core', 'telemetry.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== telemetry: hook timing and proxy errors ===\n');

t('lines append and read back, newest included, older than since left out', () => {
  assert.ok(tel.append('t.jsonl', { a: 1 }));
  const before = Date.now();
  assert.ok(tel.append('t.jsonl', { a: 2 }));
  const all = tel.read('t.jsonl', 0);
  assert.strictEqual(all.length, 2);
  assert.ok(tel.read('t.jsonl', before + 1).length <= 1);
});

t('a file past two megabytes rolls once and the rolled lines still read', () => {
  const big = 'x'.repeat(4000);
  for (let i = 0; i < 560; i++) tel.append('big.jsonl', { i, big });
  const f = path.join(tel.dir(), 'big.jsonl');
  assert.ok(fs.existsSync(f + '.1'), 'rolled file exists');
  assert.ok(fs.statSync(f).size < tel.MAX_BYTES, 'the live file is small again');
  assert.strictEqual(tel.read('big.jsonl', 0).length, 560, 'every line still reads');
});

t('the hook summary names the slow hook and counts runs past the budget', () => {
  for (const ms of [120, 300, 450, 4800, 90]) tel.append('hook-timing.jsonl', { hook: 'injector.mjs', event: 'UserPromptSubmit', ms });
  for (const ms of [30, 40]) tel.append('hook-timing.jsonl', { hook: 'mark-read.mjs', event: 'PostToolUse', ms });
  const s = tel.hookSummary(0, { budget_ms: 4000 });
  assert.strictEqual(s.runs, 7);
  assert.strictEqual(s.over_budget, 1);
  assert.strictEqual(s.hooks[0].hook, 'injector.mjs');
  assert.strictEqual(s.hooks[0].p95, 4800);
  assert.strictEqual(s.hooks[0].p50, 300);
  assert.strictEqual(s.hooks[1].over_budget, 0);
});

t('the error summary counts by reason and keeps the last message', () => {
  tel.append('proxy-errors.jsonl', { where: 'request_failed', msg: 'socket hang up' });
  tel.append('proxy-errors.jsonl', { where: 'request_failed', msg: 'ECONNRESET' });
  tel.append('proxy-errors.jsonl', { where: 'all_providers_failed', msg: 'Anthropic API + fallback chain' });
  const s = tel.errorSummary(0);
  assert.strictEqual(s.n, 3);
  assert.deepStrictEqual(s.reasons[0], { where: 'request_failed', count: 2 });
  assert.strictEqual(s.last.msg, 'Anthropic API + fallback chain');
});

t('a real hook run leaves its timing line', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'plugin', 'hooks', 'mark-read.mjs')], {
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(REPO, 'package.json') }, tool_response: {} }),
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin') }),
    encoding: 'utf8', timeout: 15000
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const rows = tel.read('hook-timing.jsonl', 0).filter((x) => x.hook === 'mark-read.mjs' && x.event === 'PostToolUse');
  assert.ok(rows.length >= 1, 'a timing line for mark-read');
  assert.ok(Number.isFinite(rows[rows.length - 1].ms) && rows[rows.length - 1].ms >= 0);
});

t('the doctor reads both into its two lines', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'troth.js'), 'doctor'], { env: process.env, encoding: 'utf8', timeout: 90000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const hook = out.split('\n').find((l) => /Hook latency \(24 h\)/.test(l)) || '';
  const err = out.split('\n').find((l) => /Proxy errors \(24 h\)/.test(l)) || '';
  assert.ok(/injector p95 4800 ms \(1\/5 over\)/.test(hook), hook || out.slice(0, 400));
  assert.ok(/3 · request_failed ×2 · all_providers_failed ×1/.test(err), err);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\ntelemetry: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
