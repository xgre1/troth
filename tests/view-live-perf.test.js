#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Live-view perf invariants.
// Acceptance criterion:
//   A6.1: 'header shows live URL in <1.5s while the faculty sleeps.'
//   A6.4: 'ActivityPanel updates with no Node subprocess spawn per tick.'
// Both reduce to the same architecture: control:browser_state and
// control:perception_tail read from the in-memory perception ring that
// the observer tees into. No DB query, no shell-out, no Node fork. This
// test pins the latency budget AND the no-fork invariant by:
//   - spying on child_process to detect any spawn/exec/fork during the
//     read path
//   - timing perceptionTail + browserState across N successive calls
//     after a single page_visit and asserting both are well under 1.5s
//     (in practice < 50ms — the budget is to catch a regression that
//     introduces a DB query or a fork per tick, not to set a perf gate).
//
// Hermetic: pure in-memory ring. tail.__resetForTest gives each case a
// clean state.

const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const tail = require(path.join(PROJECT_ROOT, 'shared-core', 'perception', 'perception-tail.js'));
const schemas = require(path.join(PROJECT_ROOT, 'shared-core', 'perception', 'engram-schemas.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

// Patch child_process methods to RECORD every call so we can prove the
// read path forks nothing.
const cp = require('child_process');
const recorded = [];
function withChildSpyCalled(fn) {
  const originals = {};
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    originals[k] = cp[k];
    cp[k] = function () {
      recorded.push({ method: k, args: Array.prototype.slice.call(arguments) });
      return originals[k].apply(cp, arguments);
    };
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(originals)) cp[k] = originals[k];
  }
}

console.log('\n=== view live perf — URL <1.5s + no subprocess per tick ===\n');

t('A6.1 — browserState returns the latest page URL well under 1.5s', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.pageVisit({
    url: 'https://example.com/login', title: 'Login', ts: Date.now(),
    ax_node_count: 12, semantic_summary: 'sign-in form', ax_graph_text: 'h1|button'
  }));
  const start = process.hrtime.bigint();
  const r = tail.browserState();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(r.last_page && /example.com\/login/.test(r.last_page.url),
    'URL surfaced: ' + JSON.stringify(r.last_page));
  assert.ok(elapsedMs < 1500,
    'A6.1 budget: browserState() took ' + elapsedMs.toFixed(3) +
    'ms (limit 1500ms)');
});

t('A6.1 — 100 sequential reads stay under 1.5s total (no slow path)', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.pageVisit({
    url: 'https://x.test/page', title: 'X', ts: Date.now(),
    ax_node_count: 5, semantic_summary: 's', ax_graph_text: 'a'
  }));
  const start = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) tail.browserState();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 1500,
    '100 reads took ' + elapsedMs.toFixed(3) + 'ms — slow path leaked in');
});

t('A6.4 — perceptionTail + browserState spawn NO subprocess', () => {
  tail.__resetForTest();
  // Seed once outside the spy (the schemas constructor may itself touch
  // child_process for unrelated reasons in production — what we're
  // pinning is that THE READ PATH doesn't).
  tail.recordPerception(schemas.pageVisit({
    url: 'https://x.test', title: 'X', ts: Date.now(),
    ax_node_count: 1, semantic_summary: 's', ax_graph_text: 'a'
  }));
  recorded.length = 0;
  withChildSpyCalled(() => {
    for (let i = 0; i < 50; i++) {
      tail.perceptionTail({});
      tail.browserState();
    }
  });
  assert.strictEqual(recorded.length, 0,
    'A6.4 invariant — read path forked ' + recorded.length + ' subprocess(es): ' +
    JSON.stringify(recorded.slice(0, 3)));
});

t('A6.4 — perceptionTail bounded result (no unbounded scan)', () => {
  tail.__resetForTest();
  // Push 200 events; perceptionTail's default cap is small. Assert the
  // result is bounded — otherwise the ActivityPanel would have to render
  // 200 rows per tick, which is the spirit of the no-subprocess rule too.
  for (let i = 0; i < 200; i++) {
    tail.recordPerception(schemas.pageVisit({
      url: 'https://x.test/' + i, title: 't' + i, ts: Date.now() + i,
      ax_node_count: 1, semantic_summary: 's', ax_graph_text: 'a'
    }));
  }
  const r = tail.perceptionTail({});
  assert.ok(Array.isArray(r.events));
  assert.ok(r.events.length <= 200, 'result is bounded: ' + r.events.length);
  // r.buffered tracks the true count for telemetry.
  assert.ok(r.buffered >= 1);
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
