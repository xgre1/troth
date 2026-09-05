#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The verdict on a tool result and the cap on what the model is shown: a
// structured result that parsed and carries no error marker is a success
// whatever words its data holds; the verdict is read from the whole result;
// a long list keeps whole items and says how many were left out.
const assert = require('assert');
const path = require('path');
const orch = require(path.join(__dirname, '..', 'shared-core', 'llm-orchestrator.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// Seventy-five rules that talk about refusals, permissions and errors: the
// shape of a rule_list answer, well over the cap.
const items = [];
for (let i = 0; i < 75; i++) items.push({ id: 'rule-' + i, timestamp: 1700000000000 + i, cwd: null, text: 'Rule ' + i + ': a false refusal is a safety defect; permission denied and unauthorized are words the wall must never say to legitimate work. ' + 'x'.repeat(400) });
const bigList = JSON.stringify({ count: items.length, items });

console.log('\n=== tool result verdict and cap ===\n');

t('a structured success is not judged by the words inside it', () => {
  assert.strictEqual(orch._toolErrorReason(bigList), null);
  assert.strictEqual(orch._toolErrorReason(JSON.stringify({ rows: [{ note: 'connection refused by the remote' }] })), null);
  assert.strictEqual(orch._toolErrorReason(JSON.stringify(['permission denied is a phrase'])), null);
});

t('error markers still carry the verdict', () => {
  assert.strictEqual(orch._toolErrorReason(JSON.stringify({ error: 'path_policy_refusal', path: '/x/.env' })), 'path_policy_refusal (/x/.env)');
  assert.strictEqual(orch._toolErrorReason(JSON.stringify({ ok: false, reason: 'not_pending' })), 'not_pending');
  assert.strictEqual(orch._toolErrorReason(JSON.stringify({ refused: 'rm -rf' })), 'rm -rf');
  assert.strictEqual(orch._toolErrorReason(JSON.stringify({ exitCode: 1, stderr: 'bash: nope: command not found' })), 'exit 1: bash: nope: command not found');
  assert.strictEqual(orch._toolErrorReason(JSON.stringify({ exitCode: 0, stderr: 'find: no such file or directory' })), null);
});

t('plain text keeps its failure shapes', () => {
  assert.strictEqual(orch._toolErrorReason('permission denied: /etc/hosts'), 'permission denied: /etc/hosts');
  assert.strictEqual(orch._toolErrorReason('all good'), null);
});

t('a cut list keeps whole items and says what was left out', () => {
  assert.ok(bigList.length > 32000, 'the fixture is over the cap: ' + bigList.length);
  const cut = orch._capToolResult(bigList, 32000);
  assert.ok(cut.text.length <= 32000, 'fits the cap: ' + cut.text.length);
  const obj = JSON.parse(cut.text);
  assert.strictEqual(obj.count, 75, 'the other fields stay');
  assert.ok(obj.items.length > 0 && obj.items.length < 75, 'a prefix of the items: ' + obj.items.length);
  assert.deepStrictEqual(obj.items[0], items[0], 'items are whole');
  assert.strictEqual(obj._truncated.field, 'items');
  assert.strictEqual(obj._truncated.kept, obj.items.length);
  assert.strictEqual(obj._truncated.total, 75);
  assert.deepStrictEqual(cut.trace, { kept_items: obj.items.length, total_items: 75, field: 'items' });
});

t('anything else keeps its first characters and the note', () => {
  const text = 'y'.repeat(40000);
  const cut = orch._capToolResult(text, 32000);
  assert.ok(cut.text.startsWith('y'.repeat(32000)));
  assert.ok(/\[tool result truncated: showing first 32000 of 40000 chars\. Re-call with a narrower query\/range if you need the rest\.\]$/.test(cut.text), cut.text.slice(-120));
  assert.deepStrictEqual(cut.trace, { kept: 32000 });
  const one = JSON.stringify({ blob: 'z'.repeat(40000) });
  const cutOne = orch._capToolResult(one, 32000);
  assert.ok(cutOne.trace.kept === 32000, 'an object without a list is cut by characters');
});

// Through the loop itself: a listing tool that answers with a long list of
// rules mentioning refusals is a completed action, and the reply carries no
// staple; a refused write still gets one.
function turn(toolName, args, reply) {
  let iter = 0;
  return {
    stream: async function* () {
      iter++;
      if (iter === 1) yield { tool_calls: [{ id: 't1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] };
      else yield { delta: reply };
      yield { done: true };
    },
    abort() {}
  };
}
(async () => {
  const big = await orch.makeOrchestrator({ transport: turn('rule_list', {}, 'Here are your rules.'), timeout_ms: 5000 })
    .composeAgentic({ prompt: 'list my rules', options: {} }, { tool_runner: async () => bigList });
  t('a long list answer is a completed action and the reply carries no staple', () => {
    assert.strictEqual(big.status, 'ok', big.reason);
    assert.ok(/Here are your rules/.test(big.text), big.text.slice(0, 200));
    assert.ok(!/did NOT complete/.test(big.text), big.text.slice(-400));
  });
  const refused = await orch.makeOrchestrator({ transport: turn('Write', { file_path: '/x/a.txt', content: 'hi' }, 'Saved it.'), timeout_ms: 5000 })
    .composeAgentic({ prompt: 'save', options: {} }, { tool_runner: async () => JSON.stringify({ ok: false, reason: 'path_policy_refusal' }) });
  t('a refused write still gets the staple', () => {
    assert.ok(/did NOT complete/.test(refused.text), refused.text.slice(-300));
    assert.ok(/Write: path_policy_refusal/.test(refused.text), refused.text.slice(-300));
  });
  console.log('\ntool-result-judge: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
