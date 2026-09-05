#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The Anthropic-shaped transport renders the loop's history as the model's
// own turns: tool calls as tool_use blocks, results as tool_result blocks in
// the next user turn, roles alternating; a one-turn history stays a plain
// string. And a repeated call is recognised by its working arguments, not
// by a narration field.
const assert = require('assert');
const http = require('http');
const path = require('path');
const { makeAnthropicTransport } = require(path.join(__dirname, '..', 'shared-core', 'transports', 'anthropic.js'));
const orch = require(path.join(__dirname, '..', 'shared-core', 'llm-orchestrator.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// A stand-in endpoint: keeps the body, answers with an empty completed stream.
const bodies = [];
const server = http.createServer((req, res) => {
  let buf = ''; req.on('data', (c) => { buf += c; }); req.on('end', () => {
    bodies.push(JSON.parse(buf));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
});

async function send(messages, tools) {
  const port = server.address().port;
  const tr = makeAnthropicTransport({ api_key: 'test-key', model: 'test-model', base_url: 'http://127.0.0.1:' + port });
  const stream = tr.stream({ messages, options: { tools: tools || [] } });
  for await (const _ of stream) { /* drain */ }
  return bodies[bodies.length - 1];
}

console.log('\n=== anthropic transport turns ===\n');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  await t('a one-turn history stays a plain string with the system apart', async () => {
    const b = await send([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }]);
    assert.strictEqual(b.system, 'be brief');
    assert.deepStrictEqual(b.messages, [{ role: 'user', content: 'hello' }]);
  });

  await t('tool calls and results become the model\'s own turns, alternating', async () => {
    const b = await send([
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo hi"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"stdout":"hi\\n","exitCode":0}' },
      { role: 'assistant', content: 'now the file', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Write', arguments: '{"file_path":"a.txt","content":"ok"}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: '{"ok":true}' }
    ], [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }]);
    const roles = b.messages.map((m) => m.role);
    assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user'], roles.join(','));
    assert.strictEqual(b.messages[1].content[0].type, 'tool_use');
    assert.strictEqual(b.messages[1].content[0].id, 'call_1');
    assert.deepStrictEqual(b.messages[1].content[0].input, { command: 'echo hi' });
    assert.strictEqual(b.messages[2].content[0].type, 'tool_result');
    assert.strictEqual(b.messages[2].content[0].tool_use_id, 'call_1');
    assert.ok(/"stdout"/.test(b.messages[2].content[0].content));
    assert.strictEqual(b.messages[3].content[0].type, 'text');
    assert.strictEqual(b.messages[3].content[1].type, 'tool_use');
    assert.strictEqual(b.messages[3].content[1].name, 'Write');
    assert.strictEqual(b.messages[4].content[0].tool_use_id, 'call_2');
    assert.strictEqual(b.tools[0].name, 'Bash');
  });

  await t('two results in a row fold into one user turn', async () => {
    const b = await send([
      { role: 'user', content: 'both' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'Read', arguments: '{"file_path":"x"}' } },
        { id: 'b', type: 'function', function: { name: 'Read', arguments: '{"file_path":"y"}' } }
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'X' },
      { role: 'tool', tool_call_id: 'b', content: 'Y' }
    ]);
    assert.deepStrictEqual(b.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepStrictEqual(b.messages[2].content.map((c) => c.tool_use_id), ['a', 'b']);
  });

  await t('a repeated call is known by its working arguments; the description does not make it new', async () => {
    const a = orch._callKeyText('{"command":"echo hi","description":"first try","timeout":120000}');
    const b = orch._callKeyText('{"timeout":120000,"description":"second try","command":"echo hi"}');
    const c = orch._callKeyText('{"command":"echo bye","description":"first try","timeout":120000}');
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
    assert.strictEqual(orch._callKeyText('not json'), 'not json');
  });

  server.close();
  console.log('\nanthropic-turns: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
