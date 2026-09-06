#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A long turn says so: a progress note every few steps with the count, the
// elapsed time and the last tool, while the turn runs on until the model
// answers. Every finished tool reports its name, time and outcome.
process.env.TROTH_TURN_PROGRESS_STEPS = '2';
const assert = require('assert');
const path = require('path');
const { makeOrchestrator } = require(path.join(__dirname, '..', 'shared-core', 'llm-orchestrator.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const TOOLS = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } }];

// A transport that reads a different file every turn for `steps` turns, then answers.
function reader(steps) {
  let n = 0;
  return {
    async stream() {
      n++;
      return (async function* () {
        if (n > steps) { yield { delta: 'answer: read them all' }; yield { done: true }; return; }
        yield { tool_calls: [{ id: 'c' + n, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/p/f' + n + '.js' }) } }] };
        yield { done: true };
      })();
    },
    abort() {}
  };
}

console.log('\n=== progress notes and the tool-finished signal ===\n');

(async () => {
  await t('a long turn posts progress every few steps and runs on until the model answers', async () => {
    const notes = [], ended = [];
    const orch = makeOrchestrator({ transport: reader(9), onProgress: (p) => notes.push(p), onToolEnd: (r) => ended.push(r) });
    const out = await orch.composeAgentic({ prompt: 'read everything', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ content: 'x' }) });
    assert.strictEqual(out.status, 'ok', JSON.stringify(out).slice(0, 200));
    assert.ok(/read them all/.test(out.text), out.text);
    assert.deepStrictEqual(notes.map((p) => p.steps), [2, 4, 6, 8], 'notes at every second step: ' + JSON.stringify(notes.map((p) => p.steps)));
    assert.ok(notes.every((p) => typeof p.elapsed_ms === 'number' && p.last_tool === 'Read'), 'a note carries elapsed and the last tool');
    assert.ok(!out.trace.some((s) => s.tools_closed), 'nothing closed the tools');
    assert.strictEqual(ended.length, 9, 'nine tools finished');
    assert.ok(ended.every((r) => r.name === 'Read' && typeof r.ms === 'number' && r.ok === true && typeof r.chars === 'number'), 'each finished tool reports name, ms, ok, chars: ' + JSON.stringify(ended[0]));
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

  console.log('\norchestrator-progress: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
