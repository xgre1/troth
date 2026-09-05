#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A cancelled turn stops the command it is running: the shell and every
// process under it end within the grace period, the tool answers
// interrupted, and the turn comes back aborted without another round.
const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');
const SHARED = path.join(__dirname, '..', 'shared-core');
const tr = require(path.join(SHARED, 'tools', 'runner.js'));
const bashTool = require(path.join(SHARED, 'tools', 'bash.js'));
const { makeOrchestrator } = require(path.join(SHARED, 'llm-orchestrator.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = 'troth-cancel-probe-' + process.pid;
function alive() { try { return execSync('pgrep -f "' + MARK + '" || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch (_) { return -1; } }

console.log('\n=== a cancelled turn stops its command ===\n');
(async () => {
  await t('the shell tool ends the whole process tree when the turn is cancelled', async () => {
    let cancelled = false;
    const t0 = Date.now();
    const p = bashTool.run ? bashTool.run({ command: 'sleep 30 # ' + MARK + '\necho done', timeout: 60000 }, { cwd: process.cwd(), shouldCancel: () => cancelled })
                           : tr.makeRunner({ cwd: process.cwd() })({ function: { name: 'Bash', arguments: JSON.stringify({ command: 'sleep 30 # ' + MARK }) } }, { shouldCancel: () => cancelled });
    await sleep(800);
    assert.ok(alive() >= 1, 'the probe command is running before the cancel');
    cancelled = true;
    const r = await p;
    const ms = Date.now() - t0;
    const out = typeof r === 'string' ? JSON.parse(r) : r;
    assert.strictEqual(out.interrupted, true, 'the tool answers interrupted: ' + JSON.stringify(out).slice(0, 200));
    assert.ok(ms < 6000, 'it came back within the grace period: ' + ms + ' ms');
    await sleep(300);
    assert.strictEqual(alive(), 0, 'nothing under the shell survives the cancel');
  });
  await t('the turn comes back aborted and asks the engine for nothing more', async () => {
    let calls = 0;
    const transport = {
      async stream() {
        calls++;
        return (async function* () {
          yield { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'sleep 30 # ' + MARK + '-orch' }) } }] };
          yield { done: true };
        })();
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, faculty_label: 'test' });
    const runner = tr.makeRunner({ agent_id: 'cancel-test', cwd: process.cwd(), user_id: 'u' });
    const signal = { cancelled: false, reason: null, _abort: null };
    const t0 = Date.now();
    const p = orch.composeAgentic(
      { prompt: 'wait', messages: [{ role: 'user', content: 'wait' }], options: { tools: tr.coreToolsArray(), max_iterations: 4, auto_write: true } },
      { tool_runner: runner, cancel_signal: signal }
    );
    await sleep(900);
    signal.cancelled = true; signal.reason = 'operator_cancel';
    const res = await p;
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, 'the turn ended within the grace period: ' + ms + ' ms');
    assert.strictEqual(calls, 1, 'no second round after the cancel: ' + calls);
    assert.ok(res.status === 'aborted' || res.cancelled === true || /cancel/.test(String(res.reason || '')), 'the turn reports the cancel: ' + JSON.stringify(res).slice(0, 200));
  });
  console.log('\ntool-cancel: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
