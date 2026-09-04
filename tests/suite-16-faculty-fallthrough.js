// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// suite-16 — cross-faculty fallthrough contract.
// A dead claude_cli organ was eating whole turns: spawn failures and empty
// exits surfaced as a silent empty "ok", plain-text auth errors streamed as
// "the answer", and an explicit Local pin naming an unwired faculty vanished
// with no trace — in every case the entity's cross-faculty walk never fired
// while working faculties sat idle. These tests pin the contract: every
// no-work death is a TAGGED transport abort, and a dropped hint is annotated.
const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');

const SHARED = path.join(__dirname, '..', 'shared-core');
const { makeSubprocessCliTransport } = require(path.join(SHARED, 'transports', 'subprocess-cli.js'));
const { makeOrchestrator } = require(path.join(SHARED, 'llm-orchestrator.js'));
const dispatchModule = require(path.join(SHARED, 'dispatch.js'));

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin  = { write() {}, end() {} };
  child.kill   = () => {};
  return child;
}

// script(child) drives the fake process after launch() has wired listeners.
function makeTx(script) {
  return makeSubprocessCliTransport({
    binary: 'troth-test-fake-cli',
    args: [],
    parse: 'claude_stream_json',
    pipe_stdin: false,
    _spawn: () => { const c = fakeChild(); setImmediate(() => script(c)); return c; }
  });
}

async function collect(stream) {
  const chunks = [];
  for await (const ch of stream) { chunks.push(ch); if (ch && ch.done) break; }
  return chunks;
}

module.exports = ({ test, skip }) => {
  test('FT-1: spawn failure is a tagged transport abort (cli_spawn), not a silent done', async () => {
    const tx = makeTx((c) => c.emit('error', new Error('spawn troth-test-fake-cli ENOENT')));
    const chunks = await collect(await tx.stream({ system: '', user: 'hi' }));
    const done = chunks.find((c) => c && c.done);
    assert.ok(done, 'stream must end with a done chunk');
    assert.strictEqual(done._abort_reason, 'cli_spawn');
    assert.ok(/spawn/i.test(String(done.error || '')), 'error detail preserved');
  });

  test('FT-2: exit 0 with zero output aborts as cli_empty so the entity can walk on', async () => {
    const tx = makeTx((c) => c.emit('close', 0));
    const chunks = await collect(await tx.stream({ system: '', user: 'hi' }));
    const done = chunks.find((c) => c && c.done);
    assert.strictEqual(done._abort_reason, 'cli_empty');
    assert.ok(!chunks.some((c) => c && c.delta), 'nothing streamed');
  });

  test('FT-3: plain-text auth failure on the raw-fallback path aborts as cli_auth, streams nothing', async () => {
    const tx = makeTx((c) => {
      // Old CLI that does not speak stream-json: plain text on stdout, exit 0.
      c.stdout.emit('data', Buffer.from('Failed to authenticate. Please run /login\n'));
      c.emit('close', 0);
    });
    const chunks = await collect(await tx.stream({ system: '', user: 'hi' }));
    const done = chunks.find((c) => c && c.done);
    assert.strictEqual(done._abort_reason, 'cli_auth');
    assert.ok(!chunks.some((c) => c && c.delta), 'auth text must never stream as the answer');
  });

  test('FT-4: a real answer with exit 0 stays a plain done (no over-aborting)', async () => {
    const ev = JSON.stringify({ type: 'assistant', message: { model: 'test-model', content: [{ type: 'text', text: 'hello world' }] } });
    const tx = makeTx((c) => {
      c.stdout.emit('data', Buffer.from(ev + '\n'));
      c.emit('close', 0);
    });
    const chunks = await collect(await tx.stream({ system: '', user: 'hi' }));
    assert.ok(chunks.some((c) => c && typeof c.delta === 'string' && c.delta.includes('hello world')));
    const done = chunks.find((c) => c && c.done);
    assert.strictEqual(done._abort_reason, undefined);
  });

  test('FT-5: orchestrator maps an untagged {done,error} to a transport abort, never empty-ok', async () => {
    const transport = {
      stream: async function* () { yield { done: true, error: 'x_provider_failed' }; },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'q', options: {} }, { tool_runner: async () => ({}) });
    assert.strictEqual(res.status, 'aborted');
    assert.strictEqual(res.reason, 'transport_done_error');
  });

  test('FT-7: TROTH_CLAUDE_MCP=1 wires the substrate MCP server into the claude spawn (strict, in-tree path)', () => {
    const { PROFILES } = require(path.join(SHARED, 'transports', 'subprocess-cli.js'));
    const prev = process.env.TROTH_CLAUDE_MCP;
    try {
      process.env.TROTH_CLAUDE_MCP = '1';
      const on = PROFILES.claude_cli.buildArgs({ user: 'hi', system: 's' });
      const i = on.indexOf('--mcp-config');
      assert.ok(i > -1, '--mcp-config present when flagged on');
      const cfg = JSON.parse(on[i + 1]);
      assert.ok(cfg.mcpServers['troth-substrate'], 'substrate server configured');
      assert.ok(String(cfg.mcpServers['troth-substrate'].args[0]).endsWith('plugin/mcp-servers/troth-substrate/server.mjs'));
      assert.ok(on.includes('--strict-mcp-config'), 'operator MCP servers stay out of the organ');
      delete process.env.TROTH_CLAUDE_MCP;
      const off = PROFILES.claude_cli.buildArgs({ user: 'hi', system: 's' });
      // One-road containment: flag off removes the SUBSTRATE, never the
      // walled execution servers. Full silence needs TROTH_ONE_ROAD=0 too.
      const iOff = off.indexOf('--mcp-config');
      assert.ok(iOff > -1, 'execution servers still ride with the flag off');
      const cfgOff = JSON.parse(off[iOff + 1]);
      assert.ok(!cfgOff.mcpServers['troth-substrate'], 'flag off → no substrate wiring');
      assert.ok(cfgOff.mcpServers['troth-bash'], 'flag off keeps the walled hands');
      const prevRoad = process.env.TROTH_ONE_ROAD;
      process.env.TROTH_ONE_ROAD = '0';
      const bare = PROFILES.claude_cli.buildArgs({ user: 'hi', system: 's' });
      if (prevRoad === undefined) delete process.env.TROTH_ONE_ROAD; else process.env.TROTH_ONE_ROAD = prevRoad;
      assert.ok(!bare.includes('--mcp-config'), 'flag off + road off → no MCP wiring at all');
    } finally {
      if (prev === undefined) delete process.env.TROTH_CLAUDE_MCP; else process.env.TROTH_CLAUDE_MCP = prev;
    }
  });

  test('FT-6: dispatcher annotates a dropped transport_hint instead of swallowing it', () => {
    const d = dispatchModule.makeDispatcher({ available: ['echo'], priority: ['echo'] });
    const dropped = d.pick({ options: { transport_hint: 'llamacpp' } }, {});
    assert.strictEqual(dropped.faculty, 'echo');
    assert.strictEqual(dropped._hint_dropped, 'llamacpp');
    const bound = d.pick({ options: { transport_hint: 'echo' } }, {});
    assert.strictEqual(bound.faculty, 'echo');
    assert.strictEqual(bound._hint_dropped, undefined);
  });

  // LP regression pair: the in-memory loop detector used a
  // tool+target signature, so a NORMAL editing session (Read->Edit->Read->Edit
  // on ONE file) hit repeat_threshold and the third detection aborted the turn
  // as "(Stopped before finishing.)" — every real chat
  // task on a single file died. The signature is now progress-aware
  // (arguments + result hashed in): only genuine no-progress repetition loops.
  test('LP-1: many same-tool same-file calls with DIFFERENT args/results is normal work, not a loop', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter <= 8) {
          yield { tool_calls: [{ id: 't' + iter, type: 'function', function: {
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/tmp/page.html', offset: iter })
          } }] };
        } else {
          yield { delta: 'All edits applied.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'edit the page', options: {} }, {
      tool_runner: async (tc) => 'content-after-change-' + JSON.parse(tc.function.arguments).offset
    });
    assert.strictEqual(res.status, 'ok', 'progressing work must not be aborted: ' + res.reason);
    assert.ok(/All edits applied/.test(res.text));
  });

  test('LP-2: the IDENTICAL call returning the IDENTICAL result still detects and aborts as loop_detected', async () => {
    const transport = {
      stream: async function* () {
        yield { tool_calls: [{ id: 'same', type: 'function', function: {
          name: 'Read',
          arguments: JSON.stringify({ file_path: '/tmp/page.html', offset: 1 })
        } }] };
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'stuck', options: {} }, {
      tool_runner: async () => 'the same unchanging content'
    });
    assert.strictEqual(res.status, 'aborted');
    assert.strictEqual(res.reason, 'loop_detected');
  });

  test('LP-3: identical CHECK calls interleaved with novel productive work never trip the detector', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter <= 7) {
          // Every iteration: the SAME directory check + one NOVEL write step —
          // the burn-in false-positive shape.
          yield { tool_calls: [
            { id: 'ls' + iter, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'ls notes' }) } },
            { id: 'w' + iter,  type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: '/tmp/notes/f' + iter + '.md', content: 'step ' + iter }) } }
          ] };
        } else {
          yield { delta: 'All files created.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'make the files', options: {} }, {
      tool_runner: async (tc) => {
        const args = JSON.parse(tc.function.arguments);
        return args.command ? 'a.md b.md c.md' : 'wrote ' + args.file_path; // ls result identical every time
      }
    });
    assert.strictEqual(res.status, 'ok', 'interleaved checks must not abort: ' + res.reason);
    assert.ok(/All files created/.test(res.text));
  });

  test('LP-5: an agent-faculty (tool_activity) hammering the IDENTICAL internal call aborts as loop_detected', async () => {
    // The claude_cli backbone surfaces its internal tools as tool_activity
    // (visibility chips) with no orchestrator-level tool_calls at all. Before
    //  the loop detector never saw them: a stuck harness opened ~20
    // identical browser windows unchecked.
    const transport = {
      stream: async function* () {
        for (let i = 0; i < 30; i++) {
          yield { tool_activity: { id: 'a' + i, name: 'Bash', input: { command: 'open http://same.example' } } };
        }
        yield { delta: 'done opening' };
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'open it', options: {} }, { tool_runner: async () => 'unused' });
    assert.strictEqual(res.status, 'aborted');
    assert.strictEqual(res.reason, 'loop_detected');
  });

  test('LP-6: the 3rd IDENTICAL side-effecting call is refused, not executed (damage prevention)', async () => {
    let iter = 0;
    const executed = [];
    const transport = {
      stream: async function* () {
        iter++;
        if (iter <= 5) {
          yield { tool_calls: [{ id: 'o' + iter, type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'open http://same.example' })
          } }] };
        } else {
          yield { delta: 'ok stopping' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'open it', options: {} }, {
      tool_runner: async (tc) => { executed.push(tc.id); return 'window opened'; }
    });
    assert.strictEqual(executed.length, 2, 'only the first 2 identical calls actually run; got ' + executed.length);
    assert.ok(res.status === 'ok' || res.reason === 'loop_detected', 'turn ends by answer or backstop, never by piling side effects');
  });

  test('LARP-1: a failed side-effecting action is stapled to the answer so a false "done" is contradicted', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'm1', type: 'function', function: {
            name: 'mcp_call', arguments: JSON.stringify({ server: 'supabase', tool: 'apply' })
          } }] };
        } else {
          yield { delta: 'Done. Created all the tables in Supabase.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'set up supabase', options: {} }, {
      tool_runner: async () => JSON.stringify({ error: 'unknown downstream server: supabase' })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(/did NOT complete/.test(res.text), 'failure note present: ' + res.text);
    assert.ok(/mcp_call/.test(res.text) && /supabase/.test(res.text), 'names the failed action');
  });

  test('LARP-2: a recovered action (same call errors then succeeds) leaves NO failure note', async () => {
    let call = 0;
    const transport = {
      stream: async function* () {
        call++;
        if (call <= 2) {
          yield { tool_calls: [{ id: 'w' + call, type: 'function', function: {
            name: 'Write', arguments: JSON.stringify({ file_path: '/tmp/x', content: 'hi' })
          } }] };
        } else {
          yield { delta: 'File written.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    let n = 0;
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'write it', options: {} }, {
      // first identical Write errors, the retry (same signature) succeeds
      tool_runner: async () => (++n === 1 ? JSON.stringify({ error: 'ENOENT' }) : 'wrote ok')
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(!/did NOT complete/.test(res.text), 'recovered action must not raise a false note: ' + res.text);
  });

  test('LARP-3: a SUCCESSFUL Bash (exitCode 0) with stderr noise never raises a failure note', async () => {
    // The shape this covers: find scanning node_modules
    // grumbles "No such file or directory" on stderr while the command
    // succeeds — the staple called a 63-action turn unreliable over it.
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'b1', type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'find node_modules -name x' })
          } }] };
        } else {
          yield { delta: 'Done. Scan finished.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'scan it', options: {} }, {
      tool_runner: async () => JSON.stringify({
        stdout: '', stderr: 'find: node_modules/next/dist/docs/01-app: No such file or directory\n',
        interrupted: false, exitCode: 0, signal: null
      })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(!/did NOT complete/.test(res.text), 'exit 0 is success no matter what stderr says: ' + res.text);
  });

  test('LARP-4: an interrupted Bash IS stapled — the exit metadata is the verdict both ways', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'b1', type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'npm run build' })
          } }] };
        } else {
          yield { delta: 'Done. Build passed.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'build it', options: {} }, {
      tool_runner: async () => JSON.stringify({
        stdout: '', stderr: '', interrupted: true, exitCode: null, signal: null
      })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(/did NOT complete/.test(res.text), 'interrupted command must be stapled: ' + res.text);
    assert.ok(/interrupted before completion/.test(res.text), 'names the interruption');
  });

  test('LARP-12: a failed Bash names its error line, it never pastes its own JSON result', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'b1', type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'bash race.sh 140 abc' })
          } }] };
        } else {
          yield { delta: 'Extracted the pubkey.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'run it', options: {} }, {
      tool_runner: async () => JSON.stringify({
        stdout: '00000000000000000000d43c4dde17a574c1d718cc392914583d7a0967bf8552\n',
        stderr: 'Traceback (most recent call last):\n  File "<string>", line 31, in <module>\nNameError: name rd_varint is not defined\n',
        interrupted: false, exitCode: 1, signal: null
      })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(/did NOT complete/.test(res.text), 'a real failure is still stapled: ' + res.text);
    assert.ok(/NameError: name rd_varint is not defined/.test(res.text), 'the error line reaches the operator: ' + res.text);
    assert.ok(!/"stdout"/.test(res.text), 'the raw tool JSON must never be pasted: ' + res.text);
    assert.ok(!/d43c4dde17a574c1d718cc392914583d7a0967bf8552/.test(res.text), 'stdout must not leak into the note: ' + res.text);
  });

  test('RESUME-1: a stream that dies mid-turn is repaired — the turn finishes and no tool re-runs', async () => {
    let iter = 0;
    let toolRuns = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 't1', type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'ls' })
          } }] };
          yield { done: true };
        } else if (iter === 2) {
          yield { delta: 'The first half of the answer. ' };
          yield { done: true, _abort_reason: 'stream_ended_without_completion' };
        } else {
          yield { delta: 'The second half of the answer.' };
          yield { done: true };
        }
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'do it', options: {} }, {
      tool_runner: async () => { toolRuns++; return JSON.stringify({ stdout: 'a b c', stderr: '', exitCode: 0 }); }
    });
    assert.strictEqual(res.status, 'ok', 'a dead stream must not end the turn: ' + res.reason);
    assert.strictEqual(toolRuns, 1, 'the tool ran once and was never re-executed');
    assert.ok(/first half/.test(res.text), 'the partial text survived: ' + res.text);
    assert.ok(/second half/.test(res.text), 'the continuation landed: ' + res.text);
  });

  test('RESUME-2: a turn cut at the length limit continues itself instead of asking the operator to say "continue"', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { delta: 'Part one. ' };
          yield { finish_reason: 'length' };
          yield { done: true };
        } else {
          yield { delta: 'Part two.' };
          yield { done: true };
        }
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'write it', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'ok');
    assert.ok(/Part one/.test(res.text) && /Part two/.test(res.text), 'both halves present: ' + res.text);
    assert.ok(!/Say "continue"/.test(res.text), 'no hand-back note once it continued itself: ' + res.text);
  });

  test('RESUME-3: a permanently broken stream stops at the repair budget, names the real reason, and keeps what it produced', async () => {
    const transport = {
      stream: async function* () {
        yield { delta: 'partial words ' };
        yield { done: true, _abort_reason: 'stream_error' };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'do it', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'aborted', 'it does give up eventually');
    assert.ok(/stream_error/.test(String(res.reason)), 'the real reason is named: ' + res.reason);
    assert.ok(/partial words/.test(res.text), 'what it produced is not eaten: ' + res.text);
  });

  test('RESUME-4: an expired session is named as such, never as an unreachable endpoint', async () => {
    const transport = {
      stream: async function* () { yield { done: true, _abort_reason: 'auth_expired' }; },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'hi', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'aborted');
    assert.ok(/session expired/.test(res.text), 'the cause is named: ' + res.text);
    assert.ok(!/looks offline/.test(res.text), 'an auth failure is not a network failure: ' + res.text);
  });

  test('CTX-1: a turn that outgrows the engine window is compacted and finishes, without re-running its tools', async () => {
    const overflow = JSON.stringify({ error: {
      code: 400, type: 'exceed_context_size_error',
      message: 'request (300052 tokens) exceeds the available context size (65536 tokens)',
      n_prompt_tokens: 300052, n_ctx: 65536
    } });
    let iter = 0, toolRuns = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 't1', type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'ls' })
          } }] };
          yield { done: true };
        } else if (iter === 2) {
          yield { done: true, _abort_reason: 'http_error', _status: 400, _detail: overflow };
        } else {
          yield { delta: 'Answer after compaction.' };
          yield { done: true };
        }
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'go', options: {} }, {
      tool_runner: async () => { toolRuns++; return 'X'.repeat(50000); }
    });
    assert.strictEqual(res.status, 'ok', 'the turn recovers: ' + res.reason);
    assert.strictEqual(toolRuns, 1, 'compaction never re-runs a tool');
    const compactions = (res.trace || []).filter((t) => t.repair === 'compact');
    assert.strictEqual(compactions.length, 1, 'exactly one compaction');
    assert.ok(compactions[0].dropped >= 1, 'it actually shed tool output');
    assert.ok(/Answer after compaction/.test(res.text), 'the answer arrives: ' + res.text);
  });

  test('CTX-2: a 400 that is not an overflow is not retried, and the reply names the status', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        yield { done: true, _abort_reason: 'http_error', _status: 400,
                _detail: JSON.stringify({ error: { code: 400, type: 'invalid_request_error' } }) };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'go', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'aborted');
    assert.ok(/http_400/.test(String(res.reason)), 'the status rides in the reason: ' + res.reason);
    assert.ok(iter <= 2, 'a non-repairable 400 is not retried in a loop, streams opened: ' + iter);
    assert.ok(!/looks offline/.test(res.text), 'never presented as a network failure: ' + res.text);
  });

  test('SLEEP-1: a turn frozen mid-stream resumes instead of blaming the model for being slow', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          const until = Date.now() + 400;
          while (Date.now() < until) { /* freeze the loop: the suspend signature */ }
          await new Promise(() => {});
        }
        yield { delta: 'Answer after the machine came back.' };
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 50 });
    const res = await orch.composeAgentic({ prompt: 'go', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'ok', 'a frozen turn resumes: ' + res.reason);
    assert.ok(/came back/.test(res.text), 'the answer arrives: ' + res.text);
    assert.ok(!/break the task into smaller steps/.test(res.text), 'never blames the model for a freeze: ' + res.text);
    const repairs = (res.trace || []).filter((t) => t.repair === 'suspended');
    assert.ok(repairs.length >= 1, 'the resume is recorded in the trace');
  });

  test('SLEEP-2: a genuinely slow model is still reported as slow, not as a freeze', async () => {
    const { wasSuspended } = require('../shared-core/llm-orchestrator.js');
    assert.strictEqual(wasSuspended(240000, 240000), false, 'on-time expiry is slowness');
    assert.strictEqual(wasSuspended(245000, 240000), false, 'a small overshoot is slowness');
    assert.strictEqual(wasSuspended(2400000, 240000), true, 'a huge overshoot is a freeze');
    assert.strictEqual(wasSuspended(null, 240000), false, 'garbage never claims a freeze');
  });

  test('LP-7: the SAME command re-run against a CHANGING world executes every time (git status / npm test)', async () => {
    // fix -> test -> fix -> test is normal verification work. The dedup may
    // only refuse a repeat whose previous runs returned the identical result.
    let iter = 0;
    const executed = [];
    const transport = {
      stream: async function* () {
        iter++;
        if (iter <= 3) {
          yield { tool_calls: [{ id: 'g' + iter, type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'git status' })
          } }] };
        } else {
          yield { delta: 'All clean now.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'fix and verify', options: {} }, {
      tool_runner: async (tc) => { executed.push(tc.id); return JSON.stringify({
        stdout: 'modified: file' + executed.length + '.js', stderr: '', interrupted: false, exitCode: 0, signal: null
      }); }
    });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(executed.length, 3, 'every re-check against a changing world runs; got ' + executed.length);
    assert.ok(!/did NOT complete/.test(res.text), 'no failure note on healthy verification: ' + res.text);
  });

  test('LARP-5: a fetched PAGE mentioning "connection refused" is not a failed action (ok:true wins over text grep)', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'f1', type: 'function', function: {
            name: 'web_fetch', arguments: JSON.stringify({ url: 'https://docs.example/errors' })
          } }] };
        } else {
          yield { delta: 'Done. Summarized the error docs.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'read the docs page', options: {} }, {
      tool_runner: async () => JSON.stringify({
        ok: true,
        content: 'Troubleshooting: ERR_CONNECTION_REFUSED means the server rejected... 401 unauthorized is returned when...'
      })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(!/did NOT complete/.test(res.text), 'page content must not read as a failure: ' + res.text);
  });

  test('LARP-6: a dedup REFUSAL never staples an action that already completed', async () => {
    // The model stupidly re-calls the same successful open 3x. The 3rd is
    // refused (stagnant repeat) — but the action HAPPENED; the answer must
    // not carry a "did NOT complete" banner over completed work.
    let iter = 0;
    const executed = [];
    const transport = {
      stream: async function* () {
        iter++;
        if (iter <= 3) {
          yield { tool_calls: [{ id: 'o' + iter, type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'open http://same.example' })
          } }] };
        } else {
          yield { delta: 'Done. Opened the page.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'open it', options: {} }, {
      tool_runner: async (tc) => { executed.push(tc.id); return JSON.stringify({
        stdout: '', stderr: '', interrupted: false, exitCode: 0, signal: null
      }); }
    });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(executed.length, 2, 'stagnant repeat still refused; got ' + executed.length);
    assert.ok(!/did NOT complete/.test(res.text), 'refusal of a pointless repeat is not a failed action: ' + res.text);
  });

  test('LARP-7: recovery with DIFFERENT args on the same file clears the stale failure (the hashline retry shape)', async () => {
    // The shape this covers: a hashline Edit fails, the model
    // re-reads and retries with FRESH line hashes — new args, new signature —
    // and succeeds. The stale failure under the old signature must not
    // staple a recovered action.
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'e1', type: 'function', function: {
            name: 'Edit', arguments: JSON.stringify({ file_path: '/proj/app.js', edits: [{ line: 12, hash: 'aaaa', new: 'x' }] })
          } }] };
        } else if (iter === 2) {
          yield { tool_calls: [{ id: 'e2', type: 'function', function: {
            name: 'Edit', arguments: JSON.stringify({ file_path: '/proj/app.js', edits: [{ line: 12, hash: 'bbbb', new: 'x' }] })
          } }] };
        } else {
          yield { delta: 'Done. Applied the change.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    let call = 0;
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'edit it', options: {} }, {
      tool_runner: async () => (++call === 1
        ? JSON.stringify({ error: 'hashline_edits_failed', mode: 'hashline', file_path: '/proj/app.js', errors: [{ line: 12, why: 'hash_mismatch' }] })
        : JSON.stringify({ filePath: '/proj/app.js', mode: 'hashline', strategy: 'hashline_tag' }))
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(!/did NOT complete/.test(res.text), 'recovered-via-new-hashes must not staple: ' + res.text);
  });

  test('LARP-8: an iteration-capped turn says so — never a synthesized bare "Done."', async () => {
    // The model works every round and never returns a closing text-only turn;
    // the cap cuts it. finalize()’s "Done." fallback would ship as the whole
    // answer — the tail must now say it was cut and how
    // to resume.
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        yield { tool_calls: [{ id: 'w' + iter, type: 'function', function: {
          name: 'Bash', arguments: JSON.stringify({ command: 'step ' + iter })
        } }] };
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'big task', options: { max_iterations: 3 } }, {
      tool_runner: async (tc) => JSON.stringify({ stdout: 'ok ' + tc.id, stderr: '', interrupted: false, exitCode: 0, signal: null })
    });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.reason, 'iteration_cap');
    assert.ok(/Stopped at the iteration budget \(3 rounds\)/.test(res.text), 'the cut is named: ' + res.text);
    assert.ok(/continue/i.test(res.text), 'tells the user how to resume');
    assert.ok(!/^Done\.\s*$/.test(res.text.trim()), 'no synthesized bare Done');
  });

  test('FT-6: a COMPLETELY empty turn (bare done, no text, no tools) aborts as transport_empty_turn, never ok-with-silence', async () => {
    // First live find of the operator simulator: a transport
    // that ends with a bare {done:true} escaped as status:ok with EMPTY
    // text - the user saw silence presented as success. Tagged transport_*
    // so the entity's cross-faculty walk can rescue it.
    const transport = {
      stream: async function* () { yield { done: true }; },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'say something', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'aborted', 'empty turn must abort, got ' + res.status);
    assert.strictEqual(res.reason, 'transport_empty_turn', 'walkable transport_ reason; got ' + res.reason);
    // A HARD-PINNED engine has no cross-faculty walk to rescue this, so the
    // terminal itself must carry an honest line, never empty text (simulator
    // p4 probe find.
    assert.ok(/returned nothing/i.test(String(res.text)), 'honest empty-turn line present; got: ' + JSON.stringify(res.text));
  });

  test('LP-8: no arithmetic cliff — a default turn runs to MODEL completion past the old 50-round cap', async () => {
    // Claude CLI parity: real multi-hundred-call work
    // passes through; only the loop detector, the stagnant dedup, timeouts
    // and context stop a turn, never a round number. Explicit caller caps
    // (step-engine=4, reflection=1) keep meaning exactly what they say.
    let iter = 0;
    const executed = [];
    const transport = {
      stream: async function* () {
        iter++;
        if (iter <= 60) {
          yield { tool_calls: [{ id: 's' + iter, type: 'function', function: {
            name: 'Bash', arguments: JSON.stringify({ command: 'step-' + iter })
          } }] };
        } else {
          yield { delta: 'Finished the whole task.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'huge task', options: {} }, {
      tool_runner: async (tc) => { executed.push(tc.id); return JSON.stringify({
        stdout: 'ok', stderr: '', interrupted: false, exitCode: 0, signal: null
      }); }
    });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.reason, null, 'model-driven completion, not a cap; got ' + res.reason);
    assert.strictEqual(executed.length, 60, 'every round of real work ran; got ' + executed.length);
    assert.ok(/Finished the whole task/.test(res.text), 'the model closing text is the answer');
    assert.ok(!/Stopped at the iteration budget/.test(res.text), 'no budget note on completed work');
  });

  test('LARP-9: a NON-allowlisted side-effecting tool that fails is stapled too (image_generate, supabase_run_sql, ...)', async () => {
    // The old anti-LARP set named 8 tools; ~15 real side-effecting tools were
    // invisible, so a failed image_generate the model narrated as "done"
    // shipped uncontradicted. Coverage is now by EXCLUSION of pure reads.
    for (const toolName of ['image_generate', 'supabase_run_sql', 'submit_goal', 'operator_request']) {
      let iter = 0;
      const transport = {
        stream: async function* () {
          iter++;
          if (iter === 1) {
            yield { tool_calls: [{ id: 'x1', type: 'function', function: {
              name: toolName, arguments: JSON.stringify({ any: 'arg' })
            } }] };
          } else {
            yield { delta: 'Done. Handled it.' };
          }
          yield { done: true };
        },
        abort() {}
      };
      const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
      const res = await orch.composeAgentic({ prompt: 'do the thing', options: {} }, {
        tool_runner: async () => JSON.stringify({ ok: false, reason: 'upstream_failed' })
      });
      assert.strictEqual(res.status, 'ok');
      assert.ok(/did NOT complete/.test(res.text), toolName + ' failure must be stapled: ' + res.text);
      assert.ok(new RegExp(toolName).test(res.text), 'names the failed tool ' + toolName);
    }
  });

  test('LARP-10: a failed PURE read (engram_search / Grep) is NOT stapled — normal exploration', async () => {
    for (const toolName of ['engram_search', 'Grep', 'mcp_list']) {
      let iter = 0;
      const transport = {
        stream: async function* () {
          iter++;
          if (iter === 1) {
            yield { tool_calls: [{ id: 'r1', type: 'function', function: {
              name: toolName, arguments: JSON.stringify({ q: 'x' })
            } }] };
          } else {
            yield { delta: 'Here is what I found.' };
          }
          yield { done: true };
        },
        abort() {}
      };
      const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
      const res = await orch.composeAgentic({ prompt: 'look it up', options: {} }, {
        tool_runner: async () => JSON.stringify({ error: 'not found' })
      });
      assert.strictEqual(res.status, 'ok');
      assert.ok(!/did NOT complete/.test(res.text), 'a failed read is not a failed action: ' + toolName + ' -> ' + res.text);
    }
  });

  test('TRUNC-1: a FINAL turn cut at the model length limit says the answer is incomplete', async () => {
    const transport = {
      stream: async function* () {
        yield { delta: 'The first half of the answer that runs right up to the' };
        yield { finish_reason: 'length' };
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'write a long thing', options: {} }, { tool_runner: async () => '{}' });
    assert.strictEqual(res.status, 'ok');
    assert.ok(/cut off at the model.s length limit/i.test(res.text), 'truncation is surfaced: ' + res.text);
    assert.ok(/continue/i.test(res.text), 'tells the user how to get the rest');
  });

  test('LARP-11: the staple names the refused PATH, not just the policy token', async () => {
    // 'Write: path_policy_refusal' told the operator nothing; the diagnosis
    // hinged on WHICH path was refused.
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { tool_calls: [{ id: 'w1', type: 'function', function: {
            name: 'Write', arguments: JSON.stringify({ file_path: '/Users/op/.env.local', content: 'X=1' })
          } }] };
        } else {
          yield { delta: 'Done. Wrote the env file.' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'write env', options: {} }, {
      tool_runner: async () => JSON.stringify({ error: 'path_policy_refusal', tool: 'Write', path: '/Users/op/.env.local', reason: 'blocked_system_path' })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(/did NOT complete/.test(res.text), 'refusal stapled');
    assert.ok(/\/Users\/op\/\.env\.local/.test(res.text), 'the exact refused path is visible: ' + res.text);
  });

  test('LP-9: POLLING reads (sms_recent / email_wait_for) repeat identically without refusal or staple', async () => {
    // Waiting for a login code IS calling the same read with the same args and
    // getting the same empty answer until the SMS lands. The first cut of the
    // coverage-by-exclusion set missed these, so the stagnant dedup would have
    // refused the 3rd poll mid-login.
    for (const toolName of ['sms_recent', 'email_wait_for', 'jobs_status']) {
      let iter = 0;
      const executed = [];
      const transport = {
        stream: async function* () {
          iter++;
          if (iter <= 4) {
            yield { tool_calls: [{ id: 'p' + iter, type: 'function', function: {
              name: toolName, arguments: JSON.stringify({ since: 'login' })
            } }] };
          } else {
            yield { delta: 'Code arrived, logging in.' };
          }
          yield { done: true };
        },
        abort() {}
      };
      const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
      const res = await orch.composeAgentic({ prompt: 'wait for the code', options: {} }, {
        tool_runner: async (tc) => { executed.push(tc.id); return JSON.stringify({ ok: true, messages: [] }); }
      });
      assert.strictEqual(res.status, 'ok');
      assert.strictEqual(executed.length, 4, toolName + ': every identical poll runs; got ' + executed.length);
      assert.ok(!/did NOT complete/.test(res.text), toolName + ': polling is not a failed action: ' + res.text);
    }
  });

  test('REFL-1/2/3: the structured verdict beats the prose-grep; grep is fallback only', async () => {
    // reflection.js is a CLOSED overlay (gitignored in the open repo) — CI
    // checks out open core only, so skip cleanly there; the dev tree and the
    // internals repo (which tracks the overlay) exercise the real assertions.
    let reflection;
    try { reflection = require('../shared-core/reflection.js'); }
    catch (_) { skip('reflection is a closed overlay; covered where that module lives'); }
    const mkOrch = (replyText) => ({ composeAgentic: async () => ({ status: 'ok', text: replyText }) });
    const base = { goal_text: 'ship it', goal_class: 'build', step_results: [], ctx: { tool_runner: async () => '' } };

    // REFL-1: explicit verdict:achieved with a concern bullet that MATCHES the
    // critical regex ("did not need to run tests") must NOT be flagged critical.
    const r1 = await reflection.reflect(Object.assign({}, base, {
      orchestrator: mkOrch('verdict: achieved\n- The agent did not need to run tests because the change was docs-only.')
    }));
    assert.strictEqual(r1.achieved, true, 'structured verdict parsed');
    assert.strictEqual(r1.critical, false, 'explicit achieved wins over the prose-grep: ' + JSON.stringify(r1.concerns));

    // REFL-2: explicit verdict:not_achieved is critical regardless of bullets.
    const r2 = await reflection.reflect(Object.assign({}, base, {
      orchestrator: mkOrch('verdict: not_achieved\n- Looks fine overall.')
    }));
    assert.strictEqual(r2.achieved, false);
    assert.strictEqual(r2.critical, true, 'not_achieved is critical');

    // REFL-3: NO explicit verdict → fall back to the grep, which fires on a
    // real miss ("the file was never created").
    const r3 = await reflection.reflect(Object.assign({}, base, {
      orchestrator: mkOrch('- The output file was never created.')
    }));
    assert.strictEqual(r3.achieved, null, 'no explicit verdict');
    assert.strictEqual(r3.critical, true, 'grep fallback still catches a real miss when no verdict is given');
  });

  test('TRUNC-2: a turn cut at length that then tool-calls and finishes clean carries NO truncation note', async () => {
    let iter = 0;
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { delta: 'Let me check' };
          yield { tool_calls: [{ id: 'b1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] };
          yield { finish_reason: 'length' }; // cut mid-turn, but there IS a tool call, so the loop continues
        } else {
          yield { delta: 'All done, here is the full answer.' };
          yield { finish_reason: 'stop' };
        }
        yield { done: true };
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, timeout_ms: 5000 });
    const res = await orch.composeAgentic({ prompt: 'do it', options: {} }, {
      tool_runner: async () => JSON.stringify({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0, signal: null })
    });
    assert.strictEqual(res.status, 'ok');
    assert.ok(!/cut off at the model/i.test(res.text), 'a clean FINAL turn must not inherit the earlier cut: ' + res.text);
  });
};
