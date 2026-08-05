#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// faculty.wake refusal acceptance.
// Acceptance criterion: "a vault-scoped engram in remote context →
// wake REFUSES, falls back local, writes remote_faculty_refused"; "$0/day
// budget → remote refused, local fallback." The refusal path is wired
// (faculty.js:168-179); this test pins it as acceptance behavior so any
// regression surfaces immediately.
//
// Hermetic via tests/hermetic-db.js — temp HOME, no real LLM is contacted.
// A stub transport proves the wake never reaches the wire when refused.

const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const faculty = require(path.join(PROJECT_ROOT, 'shared-core', 'faculty.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log('  \u2713 ' + name); pass++; },
        (e) => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
      );
    }
    console.log('  \u2713 ' + name); pass++;
  } catch (e) {
    console.log('  \u2717 ' + name + ': ' + e.message); fail++;
  }
}

// Stub transport: records calls so we can assert the wake never reached the
// wire on a refusal. generate() returns a token marker so a NON-refusal
// path is observable as text.
function makeStubTransport(label) {
  const calls = [];
  return {
    calls,
    generate: async (args) => {
      calls.push(args);
      return { tokens: '<<' + label + '-reached>>', usage: { input_tokens: 1, output_tokens: 2 } };
    }
  };
}

// Capture engrams the wake writes so we don't have to crawl the DB.
function makeEngramCapture() {
  const records = [];
  return {
    records,
    writer: (eng) => records.push(eng),
    has: (cls) => records.some((r) => r.class === cls || r.payload && r.payload.faculty_class === cls),
    byClass: (cls) => records.filter((r) => r.class === cls),
  };
}

console.log('\n=== faculty.wake vault + budget refusal ===\n');

(async () => {

  await t('A2.2 — vault-scope context → REMOTE wake refused, transport never called', async () => {
    const stub = makeStubTransport('anthropic');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'anthropic',                     // remote family
      prompt: 'summarize',
      context_engrams: [
        { scope: 'vault:operator_login', statement: 'secret' },
        { scope: 'general',              statement: 'fine' },
      ],
      writeEngram: cap.writer,
      _transport:  stub,
      tick_id:     'test-tick-vault',
    });
    assert.strictEqual(r.refused, true, 'refused:true on sensitive context');
    assert.strictEqual(r.reason, 'sensitive_context');
    assert.strictEqual(r.tokens, '');
    assert.strictEqual(stub.calls.length, 0,
      'transport.generate must NOT have been called for a refused wake');
    const refused = cap.byClass('remote_faculty_refused');
    assert.strictEqual(refused.length, 1, 'one remote_faculty_refused engram');
    assert.strictEqual(refused[0].audience, 'operator');
    assert.strictEqual(refused[0].payload.faculty, 'anthropic');
    assert.strictEqual(refused[0].payload.sensitive_engram_count, 1);
    const cost = cap.byClass('faculty_cost');
    assert.strictEqual(cost.length, 1, 'one faculty_cost engram with refused:true');
    assert.strictEqual(cost[0].payload.refused, true);
    assert.strictEqual(cost[0].payload.cost_usd, 0);
  });

  await t('A2.2 — same context to a LOCAL family → wake proceeds (no refusal)', async () => {
    const stub = makeStubTransport('llamacpp');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'llamacpp',                      // local family — no refusal
      prompt: 'summarize',
      context_engrams: [
        { scope: 'vault:operator_login', statement: 'secret' },
      ],
      writeEngram: cap.writer,
      _transport:  stub,
    });
    assert.strictEqual(r.refused, undefined, 'no refusal on local family');
    assert.ok(/llamacpp-reached/.test(r.tokens), 'tokens came back: ' + r.tokens);
    assert.strictEqual(stub.calls.length, 1, 'transport.generate called once');
  });

  await t('A2.2 — operator_only audience → REMOTE wake refused', async () => {
    const stub = makeStubTransport('anthropic');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'help',
      context_engrams: [{ scope: 'general', audience: 'operator_only', statement: 'private' }],
      writeEngram: cap.writer,
      _transport:  stub,
    });
    assert.strictEqual(r.refused, true);
    assert.strictEqual(stub.calls.length, 0);
    assert.strictEqual(cap.byClass('remote_faculty_refused').length, 1);
  });

  await t('A2.2 — sensitivity:forbid_remote tag → REMOTE wake refused', async () => {
    const stub = makeStubTransport('anthropic');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'help',
      context_engrams: [{ scope: 'general', sensitivity: 'forbid_remote', statement: 'x' }],
      writeEngram: cap.writer,
      _transport:  stub,
    });
    assert.strictEqual(r.refused, true);
    assert.strictEqual(stub.calls.length, 0);
  });

  await t('A2.3 — $0/day budget → REMOTE wake refused, no transport hit', async () => {
    const stub = makeStubTransport('anthropic');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'p',
      context_engrams: [],
      writeEngram: cap.writer,
      _transport:  stub,
      budget: { daily_usd: 0, spent_usd: 0.0 },
    });
    assert.strictEqual(r.refused, true, 'refused at budget gate');
    assert.strictEqual(r.reason, 'budget_exceeded');
    assert.strictEqual(stub.calls.length, 0,
      'transport.generate must NOT be called when over budget');
    const refused = cap.byClass('remote_faculty_refused');
    assert.strictEqual(refused.length, 1, 'budget refusal also writes the refusal engram');
    assert.strictEqual(refused[0].payload.reason, 'budget_exceeded');
  });

  await t('A2.3 — budget headroom > 0 → wake proceeds', async () => {
    const stub = makeStubTransport('anthropic');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'anthropic',
      prompt: 'p',
      context_engrams: [],
      writeEngram: cap.writer,
      _transport:  stub,
      budget: { daily_usd: 1.00, spent_usd: 0.10 },
    });
    assert.strictEqual(r.refused, undefined);
    assert.strictEqual(stub.calls.length, 1, 'budget allows → transport called');
  });

  await t('A2.3 — LOCAL family ignores budget (local is free)', async () => {
    const stub = makeStubTransport('llamacpp');
    const cap = makeEngramCapture();
    const r = await faculty.wake({
      family: 'llamacpp',
      prompt: 'p',
      context_engrams: [],
      writeEngram: cap.writer,
      _transport:  stub,
      budget: { daily_usd: 0, spent_usd: 0 },
    });
    assert.strictEqual(r.refused, undefined);
    assert.strictEqual(stub.calls.length, 1);
  });

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
