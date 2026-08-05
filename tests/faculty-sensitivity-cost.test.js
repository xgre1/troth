#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Faculty sensitivity gate + faculty_cost ledger.
// Proves faculty.wake REFUSES to send operator-secret / vault / health /
// financial / operator_only / substrate_internal engrams to a REMOTE faculty,
// and writes a faculty_cost engram (tokens / cost / latency) on every wake.
//
// Hermetic: a fake _transport seam stands in for any provider, writeEngram is
// a collector, and now() is an injected clock — no network, no real provider,
// no engram DB, no wall-clock waits. Never touches live ~/.troth.
const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; })
    .catch(e => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; });
}

const SHARED  = path.join(__dirname, '..', 'shared-core');
const faculty = require(path.join(SHARED, 'faculty.js'));

console.log('\n=== faculty sensitivity gate + faculty_cost  ===\n');

(async () => {
  await t('_isRemoteFamily: local families local, everything else remote (fail-closed)', () => {
    for (const f of ['llamacpp', 'ollama', 'subprocess', 'subprocess-cli']) {
      assert.strictEqual(faculty._isRemoteFamily(f), false, f + ' is local');
    }
    for (const f of ['anthropic', 'codex-oauth', 'router', 'some-new-cloud', '', null]) {
      assert.strictEqual(faculty._isRemoteFamily(f), true, String(f) + ' is remote');
    }
  });

  await t('_isSensitiveEngram: secret scopes / audiences / explicit flag flagged', () => {
    const yes = [
      { scope: 'vault:session_cookie' },
      { scope: 'operator_secret:bank_pin' },
      { scope: 'health:lab_result' },
      { scope: 'financial:tax_2025' },
      { audience: 'operator_only', scope: 'note:x' },
      { audience: 'substrate_internal', scope: 'browser:vault_capture' },
      { sensitivity: 'forbid_remote', scope: 'note:y' },
    ];
    for (const e of yes) assert.strictEqual(faculty._isSensitiveEngram(e), true, JSON.stringify(e));
    const no = [
      { scope: 'note:public', audience: 'model_visible' },
      { scope: 'browser:page_visit', audience: 'external' },
      { audience: 'operator', scope: 'browser:operator_pause' },  // operator-surface, not operator_only
      null, undefined, 'string', {},
    ];
    for (const e of no) assert.strictEqual(faculty._isSensitiveEngram(e), false, JSON.stringify(e));
  });

  await t('wake REMOTE + sensitive context → refused, no transport call, audit engrams written', async () => {
    let called = false;
    const fakeTransport = { generate: async () => { called = true; return { text: 'leak' }; } };
    const written = [];
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'summarize my bank pin',
      context_engrams: [
        { scope: 'note:public', audience: 'model_visible' },
        { scope: 'vault:bank_pin', audience: 'operator_only' },
      ],
      tick_id: 'tick-1',
      _transport: fakeTransport,
      writeEngram: (e) => written.push(e),
    });
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.reason, 'sensitive_context');
    assert.strictEqual(r.sensitive_engram_count, 1, 'one sensitive engram counted');
    assert.strictEqual(r.tokens, '', 'no tokens returned on refusal');
    assert.strictEqual(called, false, 'transport MUST NOT be called on refusal');
    assert.strictEqual(written.length, 2, 'refusal + cost engram written');
    assert.strictEqual(written[0].class, 'remote_faculty_refused');
    assert.strictEqual(written[0].payload.sensitive_engram_count, 1);
    assert.strictEqual(written[1].class, 'faculty_cost');
    assert.strictEqual(written[1].payload.refused, true);
    assert.strictEqual(written[1].payload.tokens_in, 0);
  });

  await t('wake REMOTE + clean context → transport runs, faculty_cost written with estimates + latency', async () => {
    const fakeTransport = { generate: async () => ({ text: 'hello world reply' }) };
    const written = [];
    let nowVal = 1000;
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'a'.repeat(40),                       // ~10 tokens (char/4)
      context_engrams: [{ scope: 'note:public', audience: 'model_visible' }],
      tick_id: 'tick-2',
      _transport: fakeTransport,
      writeEngram: (e) => written.push(e),
      now: () => { const v = nowVal; nowVal += 250; return v; },   // +250ms across the call
    });
    assert.strictEqual(r.refused, undefined);
    assert.strictEqual(r.tokens, 'hello world reply');
    assert.strictEqual(r.faculty_cost.latency_ms, 250, 'latency measured via injected clock');
    assert.strictEqual(r.faculty_cost.tokens_in, 10, 'char/4 estimate of prompt');
    assert.ok(r.faculty_cost.tokens_out > 0, 'output token estimate > 0');
    assert.strictEqual(r.faculty_cost.cost_usd, 0, 'no fabricated price');
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].class, 'faculty_cost');
    assert.strictEqual(written[0].payload.refused, false);
    assert.strictEqual(written[0].payload.provider, 'anthropic');
  });

  await t('wake LOCAL family + sensitive context → NOT refused (local never leaves the machine)', async () => {
    let called = false;
    const fakeTransport = { generate: async () => { called = true; return { text: 'local reply' }; } };
    const written = [];
    const r = await faculty.wake({
      family: 'llamacpp',
      prompt: 'read my vault',
      context_engrams: [{ scope: 'vault:bank_pin', audience: 'operator_only' }],
      _transport: fakeTransport,
      writeEngram: (e) => written.push(e),
    });
    assert.strictEqual(r.refused, undefined, 'local family is not gated');
    assert.strictEqual(called, true, 'transport runs for local even with secrets in context');
    assert.strictEqual(r.tokens, 'local reply');
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].class, 'faculty_cost');
  });

  await t('faculty_cost honors transport-reported usage over the char/4 estimate', async () => {
    const fakeTransport = { generate: async () => ({ text: 'x', usage: { input_tokens: 1234, output_tokens: 56, cost_usd: 0.0042 } }) };
    const written = [];
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'short',
      context_engrams: [],
      _transport: fakeTransport,
      writeEngram: (e) => written.push(e),
    });
    assert.strictEqual(r.faculty_cost.tokens_in, 1234);
    assert.strictEqual(r.faculty_cost.tokens_out, 56);
    assert.strictEqual(r.faculty_cost.cost_usd, 0.0042);
    assert.strictEqual(written[0].payload.tokens_in, 1234);
    assert.strictEqual(written[0].payload.cost_usd, 0.0042);
  });

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
