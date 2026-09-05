#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A long turn says so and stops at its budget: a progress note every few
// steps, and past the budget the tools close and the answer is asked for. A
// model that keeps calling after that ends the turn as turn_budget. Every
// finished tool reports its name, time and outcome to the surface.
process.env.TROTH_TURN_BUDGET_STEPS = '6';
process.env.TROTH_TURN_PROGRESS_STEPS = '2';
const assert = require('assert');
const path = require('path');
const { makeOrchestrator } = require(path.join(__dirname, '..', 'shared-core', 'llm-orchestrator.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const TOOLS = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } }];

// A transport that reads a different file every turn (never a repeat) and
// answers in words once the tools close, if it honors that.
function reader(opts) {
  opts = opts || {};
  let n = 0;
  return {
    async stream(req) {
      const closed = req.options && req.options.tool_choice === 'none';
      n++;
      return (async function* () {
        if (opts.honorsClose && closed) { yield { delta: 'answer: read what I could' }; yield { done: true }; return; }
        yield { tool_calls: [{ id: 'c' + n, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/p/f' + n + '.js' }) } }] };
        yield { done: true };
      })();
    },
    abort() {}
  };
}

console.log('\n=== the turn budget and the tool-finished signal ===\n');

(async () => {
  await t('progress notes every few steps, then the budget closes the tools and the answer comes', async () => {
    const notes = [], ended = [];
    const orch = makeOrchestrator({ transport: reader({ honorsClose: true }), onProgress: (p) => notes.push(p), onToolEnd: (r) => ended.push(r) });
    const out = await orch.composeAgentic({ prompt: 'read everything', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ content: 'x' }) });
    assert.strictEqual(out.status, 'ok', JSON.stringify(out).slice(0, 200));
    assert.ok(/read what I could/.test(out.text), out.text);
    assert.deepStrictEqual(notes.map((p) => p.steps), [2, 4], 'notes at steps 2 and 4: ' + JSON.stringify(notes.map((p) => p.steps)));
    assert.ok(notes.every((p) => typeof p.elapsed_ms === 'number' && p.last_tool === 'Read'), 'a note carries elapsed and the last tool');
    const closed = out.trace.find((s) => s.tools_closed === 'turn_budget');
    assert.ok(closed && closed.steps === 6, 'the tools closed at the budget: ' + JSON.stringify(closed));
    assert.strictEqual(ended.length, 6, 'six tools finished');
    assert.ok(ended.every((r) => r.name === 'Read' && typeof r.ms === 'number' && r.ok === true && typeof r.chars === 'number'), 'each finished tool reports name, ms, ok, chars: ' + JSON.stringify(ended[0]));
  });

  await t('a model that keeps calling after the budget ends the turn as turn_budget, with a plain tail', async () => {
    const orch = makeOrchestrator({ transport: reader({}) });
    const out = await orch.composeAgentic({ prompt: 'read everything', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ content: 'x' }) });
    assert.strictEqual(out.status, 'aborted');
    assert.strictEqual(out.reason, 'turn_budget');
    assert.ok(/reached its budget/.test(out.text), out.text);
  });

  await t('a refused tool reports refused; a failed one reports why', async () => {
    const ended = [];
    let n = 0;
    const transport = { async stream(req) { n++; const closed = req.options && req.options.tool_choice === 'none'; return (async function* () {
      if (closed || n > 4) { yield { delta: 'done' }; yield { done: true }; return; }
      yield { tool_calls: [{ id: 'c' + n, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'cat same.txt' }) } }] };
      yield { done: true };
    })(); }, abort() {} };
    const orch = makeOrchestrator({ transport, onToolEnd: (r) => ended.push(r) });
    await orch.composeAgentic({ prompt: 'x', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ error: 'exit_code', exitCode: 1, stderr: 'no such file' }) });
    assert.ok(ended.length >= 3, 'tools finished: ' + ended.length);
    assert.strictEqual(ended[0].ok, false);
    assert.ok(ended[0].why, 'a failed tool names why: ' + JSON.stringify(ended[0]));
    assert.ok(ended.some((r) => r.why === 'refused'), 'a refused call reports refused: ' + JSON.stringify(ended.map((r) => r.why)));
  });

  console.log('\norchestrator-turn-budget: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
