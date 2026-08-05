// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// #50 proof: AUTO/best-first routing actually SWITCHES faculties by task. Uses
// the REAL dispatcher (shared-core/dispatch.js) with a realistic available set.
const assert = require('assert');
const dispatch = require('../../shared-core/dispatch.js');

function mk(available) {
  const d = dispatch.makeDispatcher({ available });
  return (action, view) => (d.pick ? d.pick(action, view) : d(action, view)).faculty;
}

module.exports = async function run(t) {
  const ALL = ['router', 'claude_cli', 'codex_oauth', 'llamacpp', 'ollama'];
  const pickAll = mk(ALL);

  await t('#50 hard reasoning -> Claude sub (claude_cli)', () =>
    assert.strictEqual(pickAll({ options: { difficulty: 'hard' } }), 'claude_cli'));

  await t('#50 hard reasoning cascades to GPT sub when no Claude', () =>
    assert.strictEqual(mk(['router', 'codex_oauth', 'llamacpp'])({ options: { difficulty: 'hard' } }), 'codex_oauth'));

  await t('#50 hard reasoning falls to router chain when no subs', () =>
    assert.strictEqual(mk(['router', 'llamacpp'])({ options: { difficulty: 'hard' } }), 'router'));

  await t('#50 explicit hint -> that faculty (switch to GPT sub on demand)', () =>
    assert.strictEqual(pickAll({ options: { transport_hint: 'codex_oauth' } }), 'codex_oauth'));

  await t('#50 creative -> unconstrained (ollama), a DIFFERENT faculty', () =>
    assert.strictEqual(pickAll({ options: { intent: 'creative' } }), 'ollama'));

  await t('#50 decode-constrained -> local (llamacpp)', () =>
    assert.strictEqual(pickAll({ options: { substrate_decode_constraints: { grammar: 'x' } } }), 'llamacpp'));

  await t('#50 the six cases yield MULTIPLE distinct faculties (real switching)', () => {
    const got = new Set([
      pickAll({ options: { difficulty: 'hard' } }),
      pickAll({ options: { transport_hint: 'codex_oauth' } }),
      pickAll({ options: { intent: 'creative' } }),
      pickAll({ options: { substrate_decode_constraints: { grammar: 'x' } } })
    ]);
    assert.ok(got.size >= 3, 'expected >=3 distinct faculties, got ' + got.size + ': ' + [...got].join(','));
  });
};
