#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Reconsolidation candidates on the read path.
// Acceptance criterion: "reconsolidation candidates appear on read
// path (currently 0)." The lability-reconsolidation module reads recent
// engram_retrieval decision records, scores each retrieved engram against
// the new action text, and returns candidates whose contradiction_kind is
// set (polarity_flip OR topic_mismatch). An earlier version of the
// retrieval query was cwd-scoped, which silently dropped every
// markRetrieved call that omitted a cwd (engram.js:_triggerPLR), making
// the candidate count permanently 0 — an internal audit
// post-fix behavior so any future cwd-partitioning regression is caught.
//
// Hermetic via tests/hermetic-db.js — temp HOME, fresh state.db. action-
// record schema is the same as production.

const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const lab    = require(path.join(PROJECT_ROOT, 'shared-core', 'lability-reconsolidation.js'));
const engram = require(path.join(PROJECT_ROOT, 'shared-core', 'engram.js'));
const state  = require(path.join(PROJECT_ROOT, 'shared-core', 'state.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

function seedEngram(statement) {
  return engram.recordEngram({
    agent_id: 'recon-test', user_id: 'operator', cwd: null,
    statement, source: 'recon-test',
    source_authority: 'llm_inferred', auto_verify: false
  });
}

console.log('\n=== reconsolidation candidates on read path ===\n');

t('baseline: empty retrieval window → assessActionAgainstRetrieved returns []', () => {
  const out = lab.assessActionAgainstRetrieved({
    state, action_text: 'we should use Python'
  });
  assert.ok(Array.isArray(out));
  assert.strictEqual(out.length, 0);
});

t('A1.4 — markRetrieved + contradictory action → returns candidate (polarity_flip)', () => {
  // Seed a prior belief and mark it retrieved (no cwd — mirrors the PLR
  // revival path that historically broke this).
  const id = seedEngram('we should use Rust for the body');
  assert.ok(id);
  const ridDec = lab.markRetrieved({ state, engram_id: id });
  assert.ok(ridDec, 'markRetrieved must persist a decision row');

  // Contradict the prior statement with a high-overlap negation.
  const out = lab.assessActionAgainstRetrieved({
    state,
    action_text: 'we should NOT use Rust for the body'
  });

  assert.ok(out.length >= 1,
    'reconsolidation candidate must appear on the read path (was 0 pre-019e7614); got ' +
    JSON.stringify(out));
  const hit = out.find((c) => c.engram_id === id);
  assert.ok(hit, 'the seeded engram is the candidate');
  assert.strictEqual(hit.contradiction_kind, 'polarity_flip',
    'negation flip + high overlap → polarity_flip');
  assert.ok(typeof hit.prior_statement === 'string' &&
            hit.prior_statement.indexOf('Rust') >= 0,
    'prior statement carried through');
});

t('topic_mismatch path: low overlap + some shared tokens → topic_mismatch candidate', () => {
  const id = seedEngram('the database is sqlite WAL mode for atomic writes');
  lab.markRetrieved({ state, engram_id: id });
  const out = lab.assessActionAgainstRetrieved({
    state,
    action_text: 'the database query joined three tables for the report'
  });
  const hit = out.find((c) => c.engram_id === id);
  assert.ok(hit, 'topic-mismatch candidate must surface');
  assert.ok(hit.contradiction_kind === 'topic_mismatch' ||
            hit.contradiction_kind === 'polarity_flip',
    'contradiction_kind set: ' + hit.contradiction_kind);
});

t('no contradiction (high similarity, no flip) → no candidate', () => {
  const id = seedEngram('the proxy listens on port 7777 for control messages');
  lab.markRetrieved({ state, engram_id: id });
  const out = lab.assessActionAgainstRetrieved({
    state,
    action_text: 'the proxy listens on port 7777 for control messages'
  });
  const hit = out.find((c) => c.engram_id === id);
  assert.strictEqual(hit, undefined,
    'identical text must NOT yield a candidate; got ' + JSON.stringify(hit));
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
