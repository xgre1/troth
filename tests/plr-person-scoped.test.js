#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// PLR person-scoping regression test (single-mind). Standalone (does not
// touch the large test-all.js suite) — proves the root-cause fix for the
// "0 reconsolidation_candidate ever" defect an internal audit: a belief
// retrieved in one cwd and contradicted while working in ANOTHER cwd must
// still be an assessable reconsolidation candidate. The substrate is ONE
// mind (substrate-as-subject; identity/anchors are cross-cwd).
//
// Uses a pure in-memory fake state implementing only the three methods the
// lability module calls (recordAction / queryActions / getAction). The fake's
// queryActions HONORS a cwd filter when one is passed — so if the production
// code regressed back to passing cwd, the cross-cwd retrieval would be hidden
// and this test would fail. The fix queries person-wide (no cwd), so it passes.
const assert = require('assert');
const path = require('path');
const lab = require(path.join(__dirname, '..', 'shared-core', 'lability-reconsolidation.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// Minimal in-memory state. Rows are ActionRecord-ish objects.
function makeFakeState() {
  const rows = [];
  return {
    rows,
    recordAction(rec /*, searchText */) { rows.push(JSON.parse(JSON.stringify(rec))); },
    getAction(id) { return rows.find(r => r.id === id) || null; },
    queryActions(opts) {
      opts = opts || {};
      let out = rows.filter(r => {
        if (opts.type && r.type !== opts.type) return false;
        if (opts.cwd && r.cwd !== opts.cwd) return false;        // honored IFF passed
        if (opts.since && (r.timestamp || 0) < opts.since) return false;
        return true;
      });
      out = out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (opts.limit) out = out.slice(0, opts.limit);
      return out;
    },
  };
}

console.log('\n=== PLR person-scoped lability (cwd-partition fix) ===\n');

t('cross-cwd: retrieval in /project-a is assessable while contradicting in /project-b', () => {
  const state = makeFakeState();
  // Seed the engram row (getAction target). markRetrieved writes a decision
  // row that references this engram_id.
  const engramId = 'eng-xcwd-1';
  state.rows.push({
    id: engramId, type: 'commitment', cwd: '/project-a', timestamp: Date.now(),
    output: { commitment_type: 'engram', statement: 'the staging deploy uses the blue cluster' },
  });
  // Retrieval marked while in project A.
  lab.markRetrieved({ state, engram_id: engramId, cwd: '/project-a' });
  // Contradiction surfaces while working in a DIFFERENT project.
  const cands = lab.assessActionAgainstRetrieved({
    state,
    action_text: 'staging deploy now uses the green cluster, not the blue cluster',
    cwd: '/project-b',
  });
  assert.ok(
    cands.some(c => c.engram_id === engramId),
    'cross-cwd retrieval must be assessable (person-scoped); got ' + JSON.stringify(cands.map(c => c.engram_id))
  );
});

t('null-cwd retrieval (the engram.js _triggerPLR path) is assessable', () => {
  const state = makeFakeState();
  const engramId = 'eng-nullcwd-1';
  state.rows.push({
    id: engramId, type: 'commitment', cwd: null, timestamp: Date.now(),
    output: { commitment_type: 'engram', statement: 'production database is postgres' },
  });
  // _triggerPLR in engram.js calls markRetrieved with NO cwd.
  lab.markRetrieved({ state, engram_id: engramId });
  const cands = lab.assessActionAgainstRetrieved({
    state,
    action_text: 'production database is mysql now, not postgres',
    cwd: '/some-project',
  });
  assert.ok(
    cands.some(c => c.engram_id === engramId),
    'null-cwd retrieval (dominant path) must be assessable; got ' + JSON.stringify(cands.map(c => c.engram_id))
  );
});

t('no false positive: an aligned action produces no candidate', () => {
  const state = makeFakeState();
  const engramId = 'eng-align-1';
  state.rows.push({
    id: engramId, type: 'commitment', cwd: null, timestamp: Date.now(),
    output: { commitment_type: 'engram', statement: 'the staging deploy uses the blue cluster' },
  });
  lab.markRetrieved({ state, engram_id: engramId });
  const cands = lab.assessActionAgainstRetrieved({
    state,
    action_text: 'confirmed the staging deploy uses the blue cluster as expected',
    cwd: '/project-b',
  });
  assert.ok(!cands.some(c => c.engram_id === engramId), 'aligned action must NOT flag a candidate');
});

console.log('');
console.log(`PLR person-scoped: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
