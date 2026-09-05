#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The tool loop paces a poll and ends a standoff: the same action repeated
// with changing results runs after a growing wait and, on the sixth time,
// closes the tools and asks for the answer; identical results are refused
// once, then the tools close; a model that keeps calling ends the turn as
// repeat_limit. Following a job with job_wait is never a repeat.
process.env.TROTH_POLL_WAIT_SCALE = '0.002';
const assert = require('assert');
const path = require('path');
const { makeOrchestrator } = require(path.join(__dirname, '..', 'shared-core', 'llm-orchestrator.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const call = (i, name, args) => ({ id: 'c' + i, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const TOOLS = [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
               { type: 'function', function: { name: 'job_wait', parameters: { type: 'object', properties: { job_id: { type: 'string' } } } } }];

// A transport that repeats one tool call every turn. `honorsClose`: answers in
// words once the loop closes the tools (tool_choice none), the way the local
// transport does. `stopAfter`: answers in words after that many calls.
function repeater(name, args, opts) {
  opts = opts || {};
  let n = 0;
  const seen = { lastToolContent: null, requests: 0 };
  return { seen, transport: {
    async stream(req) {
      seen.requests++;
      const msgs = req.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'tool') { seen.lastToolContent = String(msgs[i].content); break; }
      const closed = req.options && req.options.tool_choice === 'none';
      n++;
      return (async function* () {
        if ((opts.honorsClose && closed) || (opts.stopAfter && n > opts.stopAfter)) { yield { delta: 'answer: still running, waiting on the job' }; yield { done: true }; return; }
        yield { tool_calls: [call(n, name, args)] };
        yield { done: true };
      })();
    },
    abort() {}
  } };
}

console.log('\n=== poll pacing and the repeat limit ===\n');

(async () => {
  await t('a poll with changing results runs after growing waits and the sixth call closes the tools', async () => {
    const r = repeater('Bash', { command: './status.sh' }, { honorsClose: true });
    let runs = 0;
    const orch = makeOrchestrator({ transport: r.transport });
    const out = await orch.composeAgentic({ prompt: 'follow it', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ stdout: 'progress ' + (++runs) }) });
    assert.strictEqual(out.status, 'ok', JSON.stringify(out).slice(0, 200));
    assert.strictEqual(runs, 5, 'five runs: two at once, three after waits; the sixth is refused');
    const waits = out.trace.filter((s) => s.poll_wait_s).map((s) => s.poll_wait_s);
    assert.deepStrictEqual(waits, [5, 15, 30]);
    assert.ok(out.trace.some((s) => s.tools_closed === 'repeat_limit'), 'the tools closed');
    assert.ok(/refused":"repeat_limit"/.test(r.seen.lastToolContent), 'the model was told: ' + r.seen.lastToolContent);
    assert.ok(/answer: still running/.test(out.text), out.text);
  });

  await t('a run after a wait carries the note inside the JSON result', async () => {
    const r = repeater('Bash', { command: './status.sh' }, { stopAfter: 3 });
    let runs = 0;
    const orch = makeOrchestrator({ transport: r.transport });
    await orch.composeAgentic({ prompt: 'follow it', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ stdout: 'progress ' + (++runs) }) });
    const last = JSON.parse(r.seen.lastToolContent);
    assert.strictEqual(last.stdout, 'progress 3');
    assert.ok(/after a 5 s wait/.test(last.troth_note), 'the note names the wait: ' + last.troth_note);
  });

  await t('identical results are refused once, then the tools close', async () => {
    const r = repeater('Bash', { command: 'cat same.txt' }, { honorsClose: true });
    let runs = 0;
    const orch = makeOrchestrator({ transport: r.transport });
    const out = await orch.composeAgentic({ prompt: 'read it', options: { tools: TOOLS } }, { tool_runner: async () => { runs++; return JSON.stringify({ stdout: 'same' }); } });
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(runs, 2, 'the third identical call is refused, never run');
    assert.ok(out.trace.some((s) => s.tools_closed === 'repeat_limit'), 'the second refusal closes the tools');
  });

  await t('a model that keeps calling after the tools closed ends the turn as repeat_limit, with a plain tail', async () => {
    const r = repeater('Bash', { command: './status.sh' }, {});
    let runs = 0;
    const orch = makeOrchestrator({ transport: r.transport });
    const out = await orch.composeAgentic({ prompt: 'follow it', options: { tools: TOOLS } }, { tool_runner: async () => JSON.stringify({ stdout: 'progress ' + (++runs) }) });
    assert.strictEqual(out.status, 'aborted');
    assert.strictEqual(out.reason, 'repeat_limit');
    assert.ok(/kept being repeated/.test(out.text), out.text);
    assert.ok(r.seen.requests <= 12, 'the turn ended soon after the close: ' + r.seen.requests + ' requests');
  });

  await t('following a job with job_wait is never a repeat', async () => {
    const r = repeater('job_wait', { job_id: 'job-1' }, { stopAfter: 8 });
    let runs = 0;
    const orch = makeOrchestrator({ transport: r.transport });
    const out = await orch.composeAgentic({ prompt: 'follow it', options: { tools: TOOLS } }, { tool_runner: async () => { runs++; return JSON.stringify({ ok: true, job: { state: 'running' } }); } });
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(runs, 8, 'every wait ran: ' + runs);
    assert.ok(!out.trace.some((s) => s.poll_wait_s || s.tools_closed), 'no pacing, no closing');
  });

  await t('an edit followed by the same test command again is work, never a poll', async () => {
    let n = 0;
    const transport = { async stream() { n++; return (async function* () {
      if (n > 8) { yield { delta: 'all green' }; yield { done: true }; return; }
      yield { tool_calls: [n % 2 ? call(n, 'Edit', { file_path: '/p/a.js', old_string: 'x' + n, new_string: 'y' }) : call(n, 'Bash', { command: 'npm test' })] };
      yield { done: true };
    })(); }, abort() {} };
    let runs = 0;
    const orch = makeOrchestrator({ transport });
    const t0 = Date.now();
    const out = await orch.composeAgentic({ prompt: 'fix it', options: { tools: TOOLS } }, { tool_runner: async (tc) => JSON.stringify({ ok: true, run: ++runs, tool: tc.function.name }) });
    assert.strictEqual(out.status, 'ok', JSON.stringify(out).slice(0, 200));
    assert.strictEqual(runs, 8, 'every call ran: ' + runs);
    assert.ok(!out.trace.some((s) => s.poll_wait_s || s.tools_closed), 'no pacing, no closing');
    assert.ok(Date.now() - t0 < 3000, 'no waits were inserted');
  });

  console.log('\norchestrator-poll-pacing: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
