#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The ChatGPT lane's request body: a multi-step turn reaches the Responses
// endpoint as its own items — the assistant's tool calls as function_call,
// their results as function_call_output — so the model sees what it ran and
// answers from the result instead of a flattened transcript.
const assert = require('assert');
const path = require('path');
const cx = require(path.join(__dirname, '..', 'shared-core', 'transports', 'codex-oauth.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== codex responses items ===\n');

const transport = cx.makeCodexOAuthTransport({});
const body = (req) => JSON.parse(transport._buildBody(req, 'gpt-5.6-sol'));

t('a tool round trip is function_call and function_call_output items', () => {
  const b = body({
    system: 'You are the partner.',
    messages: [
      { role: 'user', content: 'list the standing rules' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'rule_list', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '[{"id":"r1","text":"never push without the word"}]' }
    ],
    options: { tools: [{ type: 'function', function: { name: 'rule_list', description: 'list rules', parameters: { type: 'object', properties: {} } } }] }
  });
  assert.strictEqual(b.model, 'gpt-5.6-sol');
  assert.strictEqual(b.instructions, 'You are the partner.');
  assert.strictEqual(b.store, false);
  assert.ok(!('max_output_tokens' in b), 'no max_output_tokens on the ChatGPT-account endpoint');
  assert.deepStrictEqual(b.input.map((i) => i.type || i.role), ['user', 'function_call', 'function_call_output']);
  assert.strictEqual(b.input[0].content[0].type, 'input_text');
  assert.strictEqual(b.input[1].call_id, 'call_1');
  assert.strictEqual(b.input[1].name, 'rule_list');
  assert.strictEqual(b.input[1].arguments, '{}');
  assert.strictEqual(b.input[2].call_id, 'call_1');
  assert.ok(/never push/.test(b.input[2].output));
  assert.deepStrictEqual(b.tools, [{ type: 'function', name: 'rule_list', description: 'list rules', parameters: { type: 'object', properties: {} } }]);
});

t('assistant text and object arguments keep their shape', () => {
  const b = body({
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c2', function: { name: 'recall', arguments: { q: 'x' } } }] },
      { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'found' }] }
    ]
  });
  assert.strictEqual(b.instructions, 'be brief');
  assert.strictEqual(b.input[0].content[0].text, 'hi');
  assert.strictEqual(b.input[1].role, 'assistant');
  assert.strictEqual(b.input[1].content[0].type, 'output_text');
  assert.strictEqual(b.input[2].type, 'function_call');
  assert.strictEqual(b.input[2].arguments, '{"q":"x"}');
  assert.strictEqual(b.input[3].output, 'found');
});

t('a bare prompt is one user item', () => {
  const b = body({ system: 's', user: 'ping' });
  assert.deepStrictEqual(b.input, [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }]);
});

console.log('\ncodex-responses-items: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
