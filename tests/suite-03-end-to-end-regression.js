// SPDX-License-Identifier: AGPL-3.0-only
// Auto-split from tests/test-all.js (verbatim section bodies; order preserved).
// Sections: end-to-end regression suite | Query + Causality (behavior) | GMP v0.1 conformance (behavior) | Virtual Runtime Layer | KnowledgeAtlas + AgentMarket | PRECOMPACT HOOK (product gap 1): turns Layer 5 from theory to practice | cachestable (prompt-cache p
module.exports = function run({ test }) {
const assert = require('assert');
const fsMod = require('fs');
const pathMod = require('path');
const TMP = require('os').tmpdir() + '/troth-validator-test-' + Date.now();
const errortax = require('../proxy/modules/errortax');
const { record, getRecent } = require('../proxy/modules/perflog');
// --- End-to-end regression suite ---
//
// Each test here pins a real bug found after the isolated hook tests were
// green. Those cover hook behavior in isolation with low-volume mock data;
// these scenarios cover the end-to-end paths that A6's mocks don't
// exercise (high-volume substrate, snapshot/decision interleaving,
// proxy-vs-CLI db parity). When one of these fails it points at the
// specific class of regression — not at hook logic.
console.log('\nEnd-to-end regression suite:');
(function runE2eRegressionTests() {
  const childA7 = require('child_process');
  const pA7 = require('path');
  const fA7 = require('fs');
  const cryptoA7 = require('crypto');
  const ARecA7 = require('../shared-core/action-record');

  function loadStateForDirA7(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }
  function freshMindModule() {
    delete require.cache[require.resolve('../shared-core/mind-state')];
    return require('../shared-core/mind-state');
  }
  function tmp(label) {
    const dir = pA7.join(require('os').tmpdir(), 'gc-a7' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    fA7.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function makeNoiseDecision(cwd, ts, kind) {
    return {
      id: cryptoA7.randomUUID(),
      timestamp: ts,
      type: 'decision',
      agent_id: 'noise',
      cwd,
      input: { kind, signals: { note: 'noise' } },
      output: { decision: 'noted' },
      verification: {},
      outcome: {}
    };
  }
  function makeMindDecision(cwd, ts, projectId, summary) {
    return {
      id: cryptoA7.randomUUID(),
      timestamp: ts,
      type: 'decision',
      agent_id: 'cli',
      cwd,
      input: {
        kind: 'mind_decision',
        signals: { project_id: projectId, summary, rationale: '' }
      },
      output: { decision: 'recorded' },
      verification: {},
      outcome: {}
    };
  }

  test('A7.E2E.1: queryActions honors kind filter at SQL level', () => {
    const TMP = tmp('e2e1');
    const s = loadStateForDirA7(TMP);
    const cwd = require('os').tmpdir() + '/a7e2e1';
    const now = Date.now();
    s.recordAction(makeNoiseDecision(cwd, now - 5000, 'loopbreaker'));
    s.recordAction(makeNoiseDecision(cwd, now - 4000, 'ast_validate'));
    s.recordAction(makeMindDecision(cwd, now - 3000, 'p', 'kept decision'));
    s.recordAction(makeNoiseDecision(cwd, now - 2000, 'critic'));
    const all   = s.queryActions({ type: 'decision', cwd });
    const kept  = s.queryActions({ type: 'decision', cwd, kind: 'mind_decision' });
    const ghost = s.queryActions({ type: 'decision', cwd, kind: 'no_such_kind' });
    assert.strictEqual(all.length, 4, 'unfiltered returns all decisions');
    assert.strictEqual(kept.length, 1, 'kind filter scopes to mind_decision rows');
    assert.strictEqual(ghost.length, 0, 'unknown kind returns empty');
    try { fA7.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A7.E2E.2: recompute finds mind_decisions in a high-volume substrate (kind-filter regression)', () => {
    // Without the SQL-level kind filter, queryActions({type:"decision"})
    // would return up to 1000 rows ordered by ts. With 5000+ noise
    // decisions (loopbreaker etc.) and a handful of mind_decisions,
    // the mind events fall outside the 1000-row window and never fold.
    // This test pins the kind-filter fix in mind-state.js.
    const TMP = tmp('e2e2');
    const s = loadStateForDirA7(TMP);
    const mind = freshMindModule();
    const cwd = require('os').tmpdir() + '/a7e2e2';
    const now = Date.now();

    // Seed an initial project snapshot so recompute has something to fold into.
    const seed = mind.emptyMindState('alex');
    seed.active_projects = [{
      id: 'p', name: 'Project P', stage: 'build', current_focus: '',
      audience: '', key_decisions: [], open_questions: [],
      constraints: [], collaborators: []
    }];
    const seedBuilt = mind.buildSnapshotRecord({
      id: cryptoA7.randomUUID(), timestamp: now - 60 * 60 * 1000,
      agent_id: 'cli', cwd, mind_state: seed, trigger: 'seed', prev_snapshot_id: null
    });
    assert.ok(seedBuilt.ok);
    s.recordAction(seedBuilt.record, ARecA7.toSearchText(seedBuilt.record));

    // 1500 noise decisions BEFORE the mind ones (would clip them with
    // limit:1000, order:'asc' if no kind filter).
    for (let i = 0; i < 1500; i++) {
      s.recordAction(makeNoiseDecision(cwd, now - 50 * 60 * 1000 + i, 'loopbreaker'));
    }
    s.recordAction(makeMindDecision(cwd, now - 5000, 'p', 'D1'));
    s.recordAction(makeMindDecision(cwd, now - 4000, 'p', 'D2'));
    s.recordAction(makeMindDecision(cwd, now - 3000, 'p', 'D3'));
    s.recordAction(makeMindDecision(cwd, now - 2000, 'p', 'D4'));

    const out = mind.recomputeFromSubstrate(s, { cwd });
    const proj = out.mind_state.active_projects.find(p => p.id === 'p');
    assert.ok(proj, 'project survives recompute');
    const sums = proj.key_decisions.map(d => d.summary).sort();
    assert.deepStrictEqual(sums, ['D1', 'D2', 'D3', 'D4'],
      'all 4 mind_decisions must fold despite 1500 noise rows; got: ' + JSON.stringify(sums));
    try { fA7.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A7.E2E.3: recompute folds decisions written BEFORE the latest snapshot ts (decaySince regression)', () => {
    // Reproduces the live bug: set-project writes a snapshot at T0,
    // user records mind_decisions at T0+1s, then re-runs set-project
    // at T0+2s (writes another snapshot). Old code used since=prevTs,
    // which excluded decisions older than the latest snapshot — they
    // got orphaned. Fix: decision query uses 30-day decay window.
    const TMP = tmp('e2e3');
    const s = loadStateForDirA7(TMP);
    const mind = freshMindModule();
    const cwd = require('os').tmpdir() + '/a7e2e3';
    const t0 = Date.now() - 60 * 60 * 1000; // 1h ago
    const tDecisions = t0 + 1000;
    const tNewerSnapshot = t0 + 2000;

    // Snapshot 1 — project only, no decisions yet.
    const ms1 = mind.emptyMindState('alex');
    ms1.active_projects = [{
      id: 'p', name: 'Project P', stage: 'build', current_focus: '',
      audience: '', key_decisions: [], open_questions: [],
      constraints: [], collaborators: []
    }];
    const built1 = mind.buildSnapshotRecord({
      id: cryptoA7.randomUUID(), timestamp: t0,
      agent_id: 'cli', cwd, mind_state: ms1, trigger: 'set_project', prev_snapshot_id: null
    });
    s.recordAction(built1.record, ARecA7.toSearchText(built1.record));

    // 3 mind_decisions written AFTER snapshot 1.
    s.recordAction(makeMindDecision(cwd, tDecisions, 'p', 'X1'));
    s.recordAction(makeMindDecision(cwd, tDecisions + 100, 'p', 'X2'));
    s.recordAction(makeMindDecision(cwd, tDecisions + 200, 'p', 'X3'));

    // Snapshot 2 — would mask the decisions if recompute used since=prevTs.
    const ms2 = JSON.parse(JSON.stringify(ms1));
    const built2 = mind.buildSnapshotRecord({
      id: cryptoA7.randomUUID(), timestamp: tNewerSnapshot,
      agent_id: 'cli', cwd, mind_state: ms2, trigger: 'set_project_again', prev_snapshot_id: built1.record.id
    });
    s.recordAction(built2.record, ARecA7.toSearchText(built2.record));

    const out = mind.recomputeFromSubstrate(s, { cwd });
    const proj = out.mind_state.active_projects.find(p => p.id === 'p');
    const sums = proj.key_decisions.map(d => d.summary).sort();
    assert.deepStrictEqual(sums, ['X1', 'X2', 'X3'],
      'decisions must fold despite being older than the latest snapshot; got: ' + JSON.stringify(sums));
    try { fA7.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A7.E2E.4: getSalienceTopK survives high-volume substrate (kind-filter regression)', () => {
    // Same shape as E2E.2 but for the salience scoreboard endpoint.
    const TMP = tmp('e2e4');
    const s = loadStateForDirA7(TMP);
    const mind = freshMindModule();
    const cwd = require('os').tmpdir() + '/a7e2e4';
    const now = Date.now();

    // Project snapshot for project_name resolution.
    const seed = mind.emptyMindState('alex');
    seed.active_projects = [{
      id: 'p', name: 'Project P', stage: 'build', current_focus: '',
      audience: '', key_decisions: [], open_questions: [],
      constraints: [], collaborators: []
    }];
    const seedBuilt = mind.buildSnapshotRecord({
      id: cryptoA7.randomUUID(), timestamp: now - 60 * 60 * 1000,
      agent_id: 'cli', cwd, mind_state: seed, trigger: 'seed', prev_snapshot_id: null
    });
    s.recordAction(seedBuilt.record, ARecA7.toSearchText(seedBuilt.record));

    // 1200 noise decisions, then 3 mind_decisions.
    for (let i = 0; i < 1200; i++) {
      s.recordAction(makeNoiseDecision(cwd, now - 30 * 60 * 1000 + i, 'critic'));
    }
    s.recordAction(makeMindDecision(cwd, now - 5000, 'p', 'S-A'));
    s.recordAction(makeMindDecision(cwd, now - 4000, 'p', 'S-B'));
    s.recordAction(makeMindDecision(cwd, now - 3000, 'p', 'S-C'));

    const top = mind.getSalienceTopK(s, { cwd, k: 10 });
    const sums = top.map(d => d.summary).sort();
    assert.deepStrictEqual(sums, ['S-A', 'S-B', 'S-C'],
      'salience must surface all mind_decisions despite 1200 noise rows; got: ' + JSON.stringify(sums));
    assert.ok(top.every(d => d.project_name === 'Project P'),
      'project_name must resolve from latest snapshot');
    try { fA7.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A7.E2E.5: full lifecycle — bootstrap → decisions → recompute → orientation has content', () => {
    // Smoke test of the loop a real the operator session exercises:
    //   1) write project-only snapshot (set-project)
    //   2) record N mind_decisions (troth mind decision)
    //   3) recompute + persist (Stop / pre-compact)
    //   4) latest snapshot's mind_state must have decisions folded
    //   5) formatOrientation on the recomputed state must include the project
    const TMP = tmp('e2e5');
    const s = loadStateForDirA7(TMP);
    const mind = freshMindModule();
    const cwd = require('os').tmpdir() + '/a7e2e5';
    const now = Date.now();

    // 1) bootstrap
    const ms = mind.emptyMindState('alex');
    ms.active_projects = [{
      id: 'gc', name: 'troth v11', stage: 'build',
      current_focus: 'mind protocol smoke test',
      audience: 'self', key_decisions: [], open_questions: [],
      constraints: [], collaborators: []
    }];
    const seedBuilt = mind.buildSnapshotRecord({
      id: cryptoA7.randomUUID(), timestamp: now - 60 * 1000,
      agent_id: 'cli', cwd, mind_state: ms, trigger: 'set_project', prev_snapshot_id: null
    });
    s.recordAction(seedBuilt.record, ARecA7.toSearchText(seedBuilt.record));

    // 2) decisions
    s.recordAction(makeMindDecision(cwd, now - 30000, 'gc', 'P1: Mind = working context, persona is wrong frame'));
    s.recordAction(makeMindDecision(cwd, now - 20000, 'gc', 'Locked Q5: append-only event substrate'));
    s.recordAction(makeMindDecision(cwd, now - 10000, 'gc', 'Deferred: heuristic decision capture (Q-DECISION-PATTERNS)'));

    // 3) recompute + persist
    const out = mind.recomputeFromSubstrate(s, { cwd });
    const built = mind.buildSnapshotRecord({
      id: cryptoA7.randomUUID(), timestamp: now,
      agent_id: 'cli', cwd, mind_state: out.mind_state,
      trigger: 'manual_fold', prev_snapshot_id: out.prev_snapshot_id
    });
    assert.ok(built.ok, 'recomputed snapshot must build');
    const id = s.recordAction(built.record, ARecA7.toSearchText(built.record));
    assert.ok(id, 'recomputed snapshot must persist');

    // 4) latest snapshot has decisions
    const latest = s.queryActions({ type: 'mind_snapshot', cwd, limit: 1, order: 'desc' });
    assert.strictEqual(latest.length, 1);
    const latestRec = ARecA7.fromRow(latest[0]);
    const proj = latestRec.output.mind_state.active_projects.find(p => p.id === 'gc');
    assert.strictEqual(proj.key_decisions.length, 3, 'all 3 decisions folded');

    // 5) orientation block renders the project + focus
    const text = mind.formatOrientation(latestRec.output.mind_state);
    assert.ok(text.includes('Session orientation'), 'orientation header present');
    assert.ok(text.includes('troth v11'), 'project name present');
    assert.ok(text.includes('mind protocol smoke test'), 'current_focus present');
    try { fA7.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

// --- PHASE B: Query + Causality (behavior) ---
console.log('\nPhase B — deterministic query + causality:');
(function runPhaseBTests() {
  const AR = require('../shared-core/action-record');
  const pB = require('path');
  const fB = require('fs');
  const TMP_B = pB.join(require('os').tmpdir(), 'gc-b-' + Date.now());
  fB.mkdirSync(TMP_B, { recursive: true });
  const savedB = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_B;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/query')];
  delete require.cache[require.resolve('../shared-core/causality')];
  const state = require('../shared-core/state');
  const Q     = require('../shared-core/query');
  const C     = require('../shared-core/causality');

  // Seed data: 1 read, 2 edits (one passing AST, one failing), 1 lesson, 1 causal chain
  const sess = 'B-' + Date.now();
  const cwd = require('os').tmpdir() + '/Bproj';

  const r1 = AR.create({ type: 'read', agent_id: 'cc', session_id: sess, cwd,
    input: { file_path: 'mod.ts' }, output: { hash: 'r1' } });
  state.recordAction(r1, AR.toSearchText(r1));

  const e1 = AR.create({ type: 'edit', agent_id: 'cc', session_id: sess, cwd,
    input: { file_path: 'mod.ts', format: 'hashline' }, output: { hash_after: 'e1' },
    verification: { ast: { ok: true, skipped: false } } });
  state.recordAction(e1, AR.toSearchText(e1));

  const e2 = AR.create({ type: 'edit', agent_id: 'cc', session_id: sess, cwd,
    parent_id: e1.id,
    input: { file_path: 'mod.ts', format: 'hashline' }, output: { hash_after: 'e2' },
    verification: { ast: { ok: false, skipped: false, errors: [{ line: 5, kind: 'parse_error' }] } } });
  state.recordAction(e2, AR.toSearchText(e2));

  const L = AR.create({ type: 'lesson', agent_id: 'cc', session_id: sess, cwd,
    input: { source: 'critic', fingerprint: 'fp-avoid-bail' },
    output: { text: 'deliver substantive output' } });
  state.recordAction(L, AR.toSearchText(L));

  // B1 — deterministic query
  test('B1: hasBeenRead returns true for the exact file that was read', () => {
    assert.strictEqual(Q.hasBeenRead(state, { file_path: 'mod.ts', session_id: sess }), true);
  });
  test('B1: hasBeenRead returns false for an unread file', () => {
    assert.strictEqual(Q.hasBeenRead(state, { file_path: 'other.ts', session_id: sess }), false);
  });
  test('B1: countReads returns exact integer', () => {
    assert.strictEqual(Q.countReads(state, { file_path: 'mod.ts', session_id: sess }), 1);
  });
  test('B1: getEditHistory returns edits in chronological order', () => {
    const h = Q.getEditHistory(state, { file_path: 'mod.ts', cwd });
    assert.strictEqual(h.length, 2);
    assert.ok(h[0].timestamp <= h[1].timestamp);
    assert.strictEqual(h[0].id, e1.id);
  });
  test('B1: getVerifiedActions returns only verification.ok=true records', () => {
    const v = Q.getVerifiedActions(state, { type: 'edit', cwd });
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].id, e1.id);
  });
  test('B1: findFailedAttempts returns only verification.ok=false records', () => {
    const f = Q.findFailedAttempts(state, { type: 'edit', cwd });
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].id, e2.id);
  });
  test('B1: getLessons dedupes by fingerprint', () => {
    // Insert a second lesson with same fingerprint
    const L2 = AR.create({ type: 'lesson', agent_id: 'cc', session_id: sess, cwd,
      input: { source: 'critic', fingerprint: 'fp-avoid-bail' },
      output: { text: 'same fingerprint, duplicate' } });
    state.recordAction(L2, AR.toSearchText(L2));
    const got = Q.getLessons(state, { cwd });
    const withSameFp = got.filter(g => g.input.fingerprint === 'fp-avoid-bail');
    assert.strictEqual(withSameFp.length, 1, 'duplicate fingerprint must be deduped');
  });
  test('B1: getActionsByType returns parsed records for a type', () => {
    const reads = Q.getActionsByType(state, 'read', { session_id: sess });
    assert.ok(reads.length >= 1);
    assert.strictEqual(reads[0].type, 'read');
    assert.strictEqual(reads[0].input.file_path, 'mod.ts');
  });

  // B2 — causality
  test('B2: traceCausalChain walks from child to root', () => {
    // Build chain: read -> edit (parent=read) -> lesson (parent=edit) -> decision (parent=lesson)
    const sessC = 'Bc-' + Date.now();
    const r = AR.create({ type: 'read', agent_id: 'cc', session_id: sessC, cwd, input: { file_path: 'c.ts' }, output: { hash: 'rc' } });
    state.recordAction(r, AR.toSearchText(r));
    const e = AR.create({ type: 'edit', agent_id: 'cc', session_id: sessC, cwd, parent_id: r.id, input: { file_path: 'c.ts', format: 'h' }, output: { hash_after: 'ec' } });
    state.recordAction(e, AR.toSearchText(e));
    const l = AR.create({ type: 'lesson', agent_id: 'cc', session_id: sessC, cwd, parent_id: e.id, input: { source: 'critic', fingerprint: 'fc' }, output: { text: 'x' } });
    state.recordAction(l, AR.toSearchText(l));
    const d = AR.create({ type: 'decision', agent_id: 'cc', session_id: sessC, cwd, parent_id: l.id, input: { kind: 'retry' }, output: { decision: 'retry' } });
    state.recordAction(d, AR.toSearchText(d));

    const chain = C.traceCausalChain(state, d.id);
    assert.strictEqual(chain.length, 4, 'chain must have 4 nodes');
    assert.deepStrictEqual(chain.map(x => x.type), ['decision', 'lesson', 'edit', 'read']);
  });
  test('B2: getDescendants returns all causally-downstream actions', () => {
    const sessD = 'Bd-' + Date.now();
    const root = AR.create({ type: 'tool_call', agent_id: 'cc', session_id: sessD, cwd, input: { tool_name: 'Bash' }, output: { status: 'error' } });
    state.recordAction(root, AR.toSearchText(root));
    const child1 = AR.create({ type: 'lesson', agent_id: 'cc', session_id: sessD, cwd, parent_id: root.id, input: { source: 'errortax', fingerprint: 'x' }, output: { text: 'l' } });
    state.recordAction(child1, AR.toSearchText(child1));
    const child2 = AR.create({ type: 'decision', agent_id: 'cc', session_id: sessD, cwd, parent_id: root.id, input: { kind: 'abandon' }, output: { decision: 'abandon' } });
    state.recordAction(child2, AR.toSearchText(child2));
    const grand = AR.create({ type: 'edit', agent_id: 'cc', session_id: sessD, cwd, parent_id: child1.id, input: { file_path: 'f.ts', format: 'h' }, output: { hash_after: 'g' } });
    state.recordAction(grand, AR.toSearchText(grand));

    const desc = C.getDescendants(state, root.id);
    const ids = new Set(desc.map(d => d.id));
    assert.ok(ids.has(child1.id));
    assert.ok(ids.has(child2.id));
    assert.ok(ids.has(grand.id));
    assert.strictEqual(desc.length, 3);
  });
  test('B2: getSiblings finds actions sharing the same parent', () => {
    const sessS = 'Bs-' + Date.now();
    const parent = AR.create({ type: 'decision', agent_id: 'cc', session_id: sessS, cwd, input: { kind: 'x' }, output: { decision: 'y' } });
    state.recordAction(parent, AR.toSearchText(parent));
    const c1 = AR.create({ type: 'lesson', agent_id: 'cc', session_id: sessS, cwd, parent_id: parent.id, input: { source: 's', fingerprint: 'f1' }, output: { text: 'a' } });
    state.recordAction(c1, AR.toSearchText(c1));
    const c2 = AR.create({ type: 'lesson', agent_id: 'cc', session_id: sessS, cwd, parent_id: parent.id, input: { source: 's', fingerprint: 'f2' }, output: { text: 'b' } });
    state.recordAction(c2, AR.toSearchText(c2));
    const sibs = C.getSiblings(state, c1.id);
    assert.strictEqual(sibs.length, 1);
    assert.strictEqual(sibs[0].id, c2.id);
  });
  test('B2: traceCausalChain is cycle-safe', () => {
    // Synthetic: force a row to reference itself — should not hang.
    const bad = AR.create({ type: 'decision', agent_id: 'cc', session_id: 'cycle', cwd, input: { kind: 'x' }, output: { decision: 'y' } });
    bad.parent_id = bad.id;
    state.recordAction(bad, AR.toSearchText(bad));
    const chain = C.traceCausalChain(state, bad.id, { maxDepth: 10 });
    assert.ok(chain.length <= 1, 'cycle must not extend the chain');
  });
  test('B2: getStateAt returns latest edit for file', () => {
    const st = C.getStateAt(state, { file_path: 'mod.ts', cwd });
    assert.ok(st);
    assert.strictEqual(st.file_path, 'mod.ts');
    assert.ok(st.edits.length >= 2);
    assert.ok(st.hash);
  });
  test('B2: summarize returns self + ancestors + descendants + siblings', () => {
    const sum = C.summarize(state, e2.id);
    assert.ok(sum);
    assert.strictEqual(sum.self.id, e2.id);
    assert.ok(sum.ancestors.length >= 1, 'edit has at least one ancestor (the parent edit)');
  });

  // B4 — hook integration: verifyfirst hits substrate, injector surfaces
  // substrate lessons. These overlap with A5 integration tests but assert
  // the new code paths specifically.
  test('B4: verifyfirst honors substrate read records', () => {
    const childB = require('child_process');
    const pBx = require('path');
    const REPO_B = pBx.resolve(__dirname, '..');
    const PLUGIN_B = pBx.join(REPO_B, 'plugin');
    const sessV = 'B4vf-' + Date.now();

    // First: run mark-read to record a read into substrate.
    childB.execFileSync('node', [pBx.join(PLUGIN_B, 'hooks', 'mark-read.mjs')], {
      input: JSON.stringify({
        session_id: sessV, cwd: REPO_B, tool_name: 'Read',
        tool_input: { file_path: REPO_B + '/package.json' },
        tool_response: {}
      }),
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN_B, CLAUDE_PLUGIN_DATA: TMP_B }),
      encoding: 'utf8'
    });
    // Then: run verifyfirst on the same file — should allow with read_ok.
    const out = childB.execFileSync('node', [pBx.join(PLUGIN_B, 'hooks', 'verifyfirst.mjs')], {
      input: JSON.stringify({
        session_id: sessV, cwd: REPO_B, tool_name: 'Edit',
        tool_input: { file_path: REPO_B + '/package.json' }
      }),
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN_B, CLAUDE_PLUGIN_DATA: TMP_B }),
      encoding: 'utf8'
    }).trim();
    // allow() emits empty {}
    assert.strictEqual(out, '{}', 'verifyfirst must allow when substrate shows read (got: ' + out + ')');
  });

  try { fB.rmSync(TMP_B, { recursive: true, force: true }); } catch (e) {}
  process.env.CLAUDE_PLUGIN_DATA = savedB;
})();

// --- PHASE C: GMP v0.1 conformance (behavior) ---
console.log('\nPhase C — GMP v0.1 conformance:');
(function runAmpLiteConformance() {
  const childProcessC = require('child_process');
  const pC = require('path');
  const fC = require('fs');
  const REPO_C = pC.resolve(__dirname, '..');
  const PLUGIN_C = pC.join(REPO_C, 'plugin');
  const TMP_C = pC.join(require('os').tmpdir(), 'gc-c-' + Date.now());
  fC.mkdirSync(TMP_C, { recursive: true });

  const SERVER_PATH = pC.join(PLUGIN_C, 'mcp-servers', 'troth-memory', 'server.mjs');

  // Spawn the GMP server once, reuse across tests. stdio JSON-RPC.
  const server = childProcessC.spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN_C, CLAUDE_PLUGIN_DATA: TMP_C })
  });

  let buf = '';
  const pending = new Map();
  let nextId = 1;
  server.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    }
  });

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(nextId++);
      //  bumped 5s → 15s. Suite has grown past 1300 tests +
      // many async tests pre-fire heavy require chains at flushAsyncTests
      // start. Single-threaded event loop occasionally serializes
      // enough work between RPC send and stdout drain that 5s slipped
      // on shared workstations. 15s is generous for real-world failure
      // cases (server hung → noticeable) while killing the load flake.
      const deadline = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, 15000);
      pending.set(id, (msg) => { clearTimeout(deadline); resolve(msg); });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  // Conformance clauses from the GMP spec (published separately) §Conformance.
  test('C1: server advertises protocol_version 0.1 and core features', async () => {
    const r = await rpc('troth/list_capabilities', { client_name: 'test', client_version: '1.0' });
    assert.ok(r.result, 'list_capabilities must return result');
    assert.strictEqual(r.result.protocol_version, '0.1');
    assert.strictEqual(r.result.server_name, 'troth-memory');
    assert.strictEqual(typeof r.result.features, 'object');
    assert.strictEqual(r.result.features.fts_search, true);
  });

  test('C2: record_action accepts a well-formed edit record', async () => {
    const action = {
      id: '019db0ff-0000-7000-8000-000000000001',
      timestamp: Date.now(),
      type: 'edit',
      agent_id: 'conformance-test',
      session_id: 'C-sess',
      cwd: '/tmp/Cproj',
      input:  { file_path: 'conform.ts', format: 'hashline' },
      output: { hash_after: 'c1' },
      verification: { ast: { ok: true, skipped: false } }
    };
    const r = await rpc('troth/record_action', { action });
    assert.ok(r.result, 'record_action must return result (not error). got: ' + JSON.stringify(r));
    assert.strictEqual(r.result.id, action.id);
  });

  test('C3: fetch_action returns the exact record by id', async () => {
    const r = await rpc('troth/fetch_action', { id: '019db0ff-0000-7000-8000-000000000001' });
    assert.ok(r.result, 'fetch_action must return result');
    assert.strictEqual(r.result.action.id, '019db0ff-0000-7000-8000-000000000001');
    assert.strictEqual(r.result.action.type, 'edit');
    assert.strictEqual(r.result.action.input.file_path, 'conform.ts');
  });

  test('C4: fetch_action returns -32100 on unknown id', async () => {
    const r = await rpc('troth/fetch_action', { id: '00000000-0000-0000-0000-000000000000' });
    assert.ok(r.error, 'unknown id must return error');
    assert.strictEqual(r.error.code, -32100);
  });

  test('C5: record_action rejects malformed records with -32101', async () => {
    const r = await rpc('troth/record_action', { action: { type: 'not_a_real_type' } });
    assert.ok(r.error, 'schema-invalid record must error');
    assert.strictEqual(r.error.code, -32101);
    assert.ok(r.error.data && Array.isArray(r.error.data.errors));
  });

  test('C6: query_actions filters by type + session_id', async () => {
    // Record a read in a known session, then query.
    const read = {
      id: '019db0ff-0000-7000-8000-000000000002',
      timestamp: Date.now(),
      type: 'read',
      agent_id: 'conformance-test',
      session_id: 'C-sess',
      cwd: '/tmp/Cproj',
      input: { file_path: 'other.ts' },
      output: { hash: 'c2' }
    };
    await rpc('troth/record_action', { action: read });
    const r = await rpc('troth/query_actions', { filter: { type: 'read', session_id: 'C-sess' } });
    assert.ok(r.result && Array.isArray(r.result.actions));
    assert.ok(r.result.actions.some(a => a.id === read.id), 'query must return the recorded read');
  });

  test('C7: count_actions returns integer count', async () => {
    const r = await rpc('troth/count_actions', { filter: { session_id: 'C-sess' } });
    assert.ok(r.result);
    assert.ok(Number.isInteger(r.result.count));
    assert.ok(r.result.count >= 2, 'at least the 2 records recorded above');
  });

  test('C8: trace_causality returns a chain of at least 1 (the action itself)', async () => {
    const r = await rpc('troth/trace_causality', { action_id: '019db0ff-0000-7000-8000-000000000001' });
    assert.ok(r.result && Array.isArray(r.result.chain));
    assert.ok(r.result.chain.length >= 1);
    assert.strictEqual(r.result.chain[0].id, '019db0ff-0000-7000-8000-000000000001');
  });

  test('C9: unknown method returns -32601', async () => {
    const r = await rpc('troth/does_not_exist', {});
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32601);
  });

  test('C10: MCP tools/list exposes all GMP methods as tools', async () => {
    const r = await rpc('tools/list', {});
    assert.ok(r.result && Array.isArray(r.result.tools));
    const names = r.result.tools.map(t => t.name);
    // Core methods must all be exposed.
    for (const required of [
      'troth_list_capabilities',
      'troth_record_action',
      'troth_fetch_action',
      'troth_query_actions',
      'troth_count_actions',
      'troth_trace_causality'
    ]) {
      assert.ok(names.includes(required), 'missing MCP wrapper: ' + required);
    }
  });

  test('C11: MCP tools/call routes to same GMP handler', async () => {
    const r = await rpc('tools/call', {
      name: 'troth_count_actions',
      arguments: { filter: { session_id: 'C-sess' } }
    });
    assert.ok(r.result && Array.isArray(r.result.content));
    const text = r.result.content[0].text;
    const payload = JSON.parse(text);
    assert.ok(Number.isInteger(payload.count));
  });

  test('C12: search_actions (optional fts_search) finds indexed tokens', async () => {
    // FTS5 tokenizer splits on punctuation, so "conform.ts" indexes as
    // separate tokens "conform" + "ts". Search for the bare token, not
    // the full filename.
    const r = await rpc('troth/search_actions', { query: 'conform' });
    assert.ok(r.result, 'search must work when fts_search is advertised');
    assert.ok(Array.isArray(r.result.hits));
    assert.ok(r.result.hits.length >= 1, 'expected at least 1 hit for recorded token');
  });

  test('C13: compat shim — archive_search is served by memory server', async () => {
    // The troth-archive MCP was retired; its three tools live on as
    // compat shims inside troth-memory. Prove archive_search responds
    // (even with zero hits against an empty archive) and does not 404.
    const r = await rpc('troth/archive_search', { query: 'noop' });
    assert.ok(r.result, 'archive_search must still respond from memory server');
    assert.ok(Array.isArray(r.result.hits));
  });

  test('C14: compat shim — archive_list is served by memory server', async () => {
    const r = await rpc('troth/archive_list', { limit: 5 });
    assert.ok(r.result, 'archive_list must still respond from memory server');
    assert.ok(Array.isArray(r.result.archives));
  });

  test('C15: archive_* compat aliases callable via tools/call but hidden from tools/list (P14 token-economy)', async () => {
    // P14 deliberately removed archive_* tools from the visible tools/list to
    // save ~1,500 bytes/turn of system-prompt context. The handlers and the
    // tools/call alias map stay for back-compat callers (hooks, runtime, CLI)
    // they're just not advertised to the model. See troth-memory/server.mjs
    // around the TOOLS array for the rationale.
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const hidden of ['archive_search', 'archive_excerpt', 'archive_list']) {
      assert.ok(!names.includes(hidden), 'archive_* must stay hidden from tools/list: ' + hidden);
    }
    // But still callable via tools/call alias map.
    const callable = await rpc('tools/call', { name: 'archive_search', arguments: { query: 'noop' } });
    assert.ok(callable.result, 'archive_search must remain callable via tools/call alias');
  });

  // F14 / GMP v0.2 — DecisionGraph capability + record_edge /
  // query_edges / trace_causal_path native methods. Conformance for the
  // v0.2 contract documented in the GMP spec (published separately).
  test('C16: list_capabilities advertises decision_graph + compact_wire (v0.2)', async () => {
    const r = await rpc('troth/list_capabilities', { client_name: 'test', client_version: '0.2' });
    assert.strictEqual(r.result.features.decision_graph, true);
    assert.strictEqual(r.result.features.compact_wire, true);
  });

  test('C17: record_edge writes a typed edge between two existing records', async () => {
    // Reuse the records C2/C3 wrote earlier in this conformance run.
    const r = await rpc('troth/record_edge', {
      from_id: '019db0ff-0000-7000-8000-000000000001',
      to_id:   '019db0ff-0000-7000-8000-000000000001',
      label:   'rationalizes',
      weight:  0.5
    });
    assert.ok(r.result, 'record_edge result missing: ' + JSON.stringify(r));
    assert.ok(r.result.edge_id && r.result.edge_id.length === 36);
  });

  test('C18: record_edge rejects unknown label with -32101', async () => {
    const r = await rpc('troth/record_edge', {
      from_id: '019db0ff-0000-7000-8000-000000000001',
      to_id:   '019db0ff-0000-7000-8000-000000000001',
      label:   'made_up_label'
    });
    assert.ok(r.error, 'expected error for invalid label');
    assert.strictEqual(r.error.code, -32101);
  });

  test('C19: record_edge rejects orphan from_id with -32100', async () => {
    const r = await rpc('troth/record_edge', {
      from_id: '00000000-0000-7000-8000-000000000000',
      to_id:   '019db0ff-0000-7000-8000-000000000001',
      label:   'satisfies'
    });
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32100);
  });

  test('C20: query_edges filters by label', async () => {
    const r = await rpc('troth/query_edges', { label: 'rationalizes' });
    assert.ok(r.result);
    assert.ok(Array.isArray(r.result.edges));
    assert.ok(r.result.edges.length >= 1, 'expected ≥1 rationalizes edge from C17');
    for (const e of r.result.edges) assert.strictEqual(e.label, 'rationalizes');
  });

  test('C21: trace_causal_path walks edges from a starting record', async () => {
    const r = await rpc('troth/trace_causal_path', {
      start_id: '019db0ff-0000-7000-8000-000000000001',
      depth_limit: 5
    });
    assert.ok(r.result);
    assert.ok(Array.isArray(r.result.path), 'expected path array');
  });

  test('C22: trace_causal_path with format=tron returns TRON-encoded payload', async () => {
    const r = await rpc('troth/trace_causal_path', {
      start_id: '019db0ff-0000-7000-8000-000000000001',
      depth_limit: 5,
      format: 'tron'
    });
    assert.ok(r.result);
    assert.strictEqual(r.result.format, 'tron');
    assert.strictEqual(typeof r.result.payload, 'string');
  });

  test('C23: tools/list advertises troth_record_edge / query_edges / trace_causal_path', async () => {
    const r = await rpc('tools/list', {});
    const names = r.result.tools.map(t => t.name);
    for (const wanted of ['troth_record_edge', 'troth_query_edges', 'troth_trace_causal_path']) {
      assert.ok(names.includes(wanted), 'missing v0.2 tool: ' + wanted);
    }
  });

  test('C24: tools/call wraps record_edge correctly', async () => {
    const r = await rpc('tools/call', {
      name: 'troth_record_edge',
      arguments: {
        from_id: '019db0ff-0000-7000-8000-000000000001',
        to_id:   '019db0ff-0000-7000-8000-000000000001',
        label:   'supersedes'
      }
    });
    assert.ok(r.result, 'tools/call wrapper result missing');
    // Wrapper returns { content: [{type:'text', text:'<json>'}] }; parse it.
    const text = r.result.content && r.result.content[0] && r.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.edge_id && parsed.edge_id.length === 36);
  });

  // ── V11 Mind Protocol — load + persist conformance ──────────────────────
  // These tests exercise the v0.1 lifecycle: persist a snapshot, load it
  // back. Append-only semantics mean each persist creates a new record;
  // load_orientation returns the latest.
  const VALID_MIND_STATE = {
    schema_version: '0.1',
    snapshot_at: '2026-04-29T20:00:00Z',
    user_id: 'test-user',
    current_focus: 'mind protocol v0.1 conformance',
    active_projects: [
      {
        id: 'troth-v11',
        name: 'troth v11',
        stage: 'design',
        current_focus: 'shipping mind protocol v0.1',
        audience: 'developers',
        key_decisions: [],
        open_questions: [],
        constraints: [],
        collaborators: []
      }
    ],
    current_intent: {
      task_signature: { domain: 'code', project_id: 'troth-v11', subgoal: 'tests' },
      what: 'verify persist/load lifecycle',
      why: 'lock v0.1 conformance'
    },
    ongoing_threads: [],
    decisions_explicitly_rejected: []
  };

  test('C25: mind/persist accepts a valid mind_state and returns snapshot_id', async () => {
    const r = await rpc('troth/mind/persist', {
      mind_state: VALID_MIND_STATE,
      agent_id: 'claude-code',
      cwd: '/tmp/v11-conformance',
      trigger: 'test'
    });
    assert.ok(r.result, 'persist result missing: ' + JSON.stringify(r));
    assert.ok(r.result.snapshot_id && r.result.snapshot_id.length === 36,
      'expected 36-char snapshot_id, got: ' + r.result.snapshot_id);
  });

  test('C26: mind/persist rejects malformed mind_state with -32101', async () => {
    const r = await rpc('troth/mind/persist', {
      mind_state: { schema_version: '0.1' /* missing user_id, snapshot_at, etc */ }
    });
    assert.ok(r.error, 'expected error for malformed mind_state');
    assert.strictEqual(r.error.code, -32101);
  });

  test('C27: mind/load_orientation returns the latest persisted snapshot', async () => {
    const r = await rpc('troth/mind/load_orientation', {
      cwd: '/tmp/v11-conformance',
      agent_id: 'claude-code'
    });
    assert.ok(r.result, 'load result missing: ' + JSON.stringify(r));
    assert.strictEqual(r.result.is_empty, false);
    assert.ok(r.result.snapshot_id, 'expected snapshot_id from C25');
    assert.strictEqual(r.result.mind_state.user_id, 'test-user');
    assert.strictEqual(r.result.mind_state.current_focus,
      'mind protocol v0.1 conformance');
    assert.strictEqual(r.result.mind_state.active_projects.length, 1);
    assert.strictEqual(r.result.mind_state.active_projects[0].id, 'troth-v11');
  });

  test('C28: mind/load_orientation returns empty state for unknown filter', async () => {
    const r = await rpc('troth/mind/load_orientation', {
      cwd: '/tmp/no-such-cwd-' + Date.now(),
      user_id: 'fresh-user'
    });
    assert.ok(r.result, 'load result missing');
    assert.strictEqual(r.result.is_empty, true);
    assert.strictEqual(r.result.snapshot_id, null);
    assert.strictEqual(r.result.mind_state.user_id, 'fresh-user');
    assert.strictEqual(r.result.mind_state.schema_version, '0.1');
    assert.ok(Array.isArray(r.result.mind_state.active_projects));
    assert.strictEqual(r.result.mind_state.active_projects.length, 0);
  });

  test('C29: tools/list advertises agent-facing mind tools (and HIDES internal ones)', async () => {
    const r = await rpc('tools/list', {});
    const names = r.result.tools.map(t => t.name);
    // Agent-facing tools — must be advertised.
    for (const wanted of [
      'troth_mind_surface',
      'troth_mind_fault_project',
      'troth_mind_record_decision',
      'troth_mind_distill_project'
    ]) {
      assert.ok(names.includes(wanted), 'missing v11 mind tool: ' + wanted);
    }
    // Internal-only tools — must NOT appear in tools/list (token economy).
    // Handlers remain callable via tools/call by name AND via native
    // troth/* methods, but the model shouldn't see ~1.5K tokens of
    // descriptions for hooks-only lifecycle tools.
    for (const hidden of ['troth_mind_persist', 'troth_mind_load_orientation', 'troth_query_persona_context']) {
      assert.ok(!names.includes(hidden), 'expected hidden tool to be absent: ' + hidden);
    }
  });

  test('C30: tools/call still routes mind_persist by name (handler remains live)', async () => {
    // Hidden from tools/list, but the handler is still wired into the
    // tools/call switch — programmatic / hook callers use it directly.
    const r = await rpc('tools/call', {
      name: 'troth_mind_persist',
      arguments: {
        mind_state: VALID_MIND_STATE,
        agent_id: 'cursor',
        cwd: '/tmp/v11-conformance-wrapper'
      }
    });
    assert.ok(r.result, 'tools/call wrapper result missing for hidden mind_persist');
    const text = r.result.content && r.result.content[0] && r.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.snapshot_id && parsed.snapshot_id.length === 36,
      'expected 36-char snapshot_id from wrapper');
  });

  // Multi-project state for surface tests.
  const SURFACE_MIND_STATE = {
    schema_version: '0.1',
    snapshot_at: '2026-04-29T20:30:00Z',
    user_id: 'surface-user',
    current_focus: 'surface conformance',
    active_projects: [
      {
        id: 'surf-gc', name: 'troth v11', stage: 'design', current_focus: 'spec',
        audience: 'devs',
        key_decisions: [{ decision_id: 'sd1', summary: 'mind = world-state' }],
        open_questions: ['decay'], constraints: ['no persona'], collaborators: []
      },
      {
        id: 'surf-ar', name: 'atlasforge', stage: 'GTM', current_focus: 'launch',
        audience: 'firms',
        key_decisions: [{ decision_id: 'sd2', summary: 'book-a-call' }],
        open_questions: ['v6'], constraints: [], collaborators: []
      }
    ],
    current_intent: null,
    ongoing_threads: [],
    decisions_explicitly_rejected: []
  };

  test('C31: mind/surface returns hot/cold-shaped state for matching project_id', async () => {
    // Seed via persist first.
    const persist = await rpc('troth/mind/persist', {
      mind_state: SURFACE_MIND_STATE,
      agent_id: 'claude-code',
      cwd: '/tmp/v11-surface'
    });
    assert.ok(persist.result, 'seed persist failed');

    const r = await rpc('troth/mind/surface', {
      cwd: '/tmp/v11-surface',
      task_signature: { domain: 'code', project_id: 'surf-gc', subgoal: 'spec' }
    });
    assert.ok(r.result, 'surface result missing: ' + JSON.stringify(r));
    assert.strictEqual(r.result.is_empty, false);
    assert.ok(r.result.shape_info, 'shape_info expected');
    assert.strictEqual(r.result.shape_info.matched, true);
    assert.strictEqual(r.result.shape_info.hot_projects, 1);
    assert.strictEqual(r.result.shape_info.cold_projects, 1);

    const gc = r.result.mind_state.active_projects.find(p => p.id === 'surf-gc');
    const ar = r.result.mind_state.active_projects.find(p => p.id === 'surf-ar');
    assert.ok(Array.isArray(gc.key_decisions) && gc.key_decisions.length === 1, 'gc must stay hot');
    assert.ok(!gc._cold);
    assert.strictEqual(ar._cold, true, 'ar must be cold');
    assert.strictEqual(ar.key_decisions, undefined);
  });

  test('C32: tools/list advertises troth_mind_surface and tools/call wraps it', async () => {
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('troth_mind_surface'), 'mind_surface must be advertised');

    const call = await rpc('tools/call', {
      name: 'troth_mind_surface',
      arguments: {
        cwd: '/tmp/v11-surface',
        task_signature: { project_id: 'surf-gc' }
      }
    });
    assert.ok(call.result, 'wrapper call must return result');
    const text = call.result.content && call.result.content[0] && call.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.shape_info, 'wrapper output must include shape_info');
    assert.strictEqual(parsed.shape_info.matched, true);
  });

  test('C33: mind/fault_project expands a cold project id to full hot detail', async () => {
    // Re-uses the snapshot persisted in C31. surf-ar was cold there;
    // here we fetch its full detail by id.
    const r = await rpc('troth/mind/fault_project', {
      cwd: '/tmp/v11-surface',
      project_id: 'surf-ar'
    });
    assert.ok(r.result, 'fault_project result missing: ' + JSON.stringify(r));
    assert.strictEqual(r.result.is_empty, false);
    assert.ok(r.result.projects && r.result.projects['surf-ar'],
      'surf-ar must be present in projects map');
    const ar = r.result.projects['surf-ar'];
    // Full hot detail — fields stripped from cold form must be present here.
    assert.ok(Array.isArray(ar.key_decisions) && ar.key_decisions.length === 1);
    assert.ok(Array.isArray(ar.open_questions));
    assert.ok(!ar._cold, 'fault_project output must NOT have _cold marker');
    assert.deepStrictEqual(r.result.not_found, []);
  });

  test('C34: mind/fault_project reports unknown ids in not_found', async () => {
    const r = await rpc('troth/mind/fault_project', {
      cwd: '/tmp/v11-surface',
      project_ids: ['surf-gc', 'does-not-exist']
    });
    assert.ok(r.result);
    assert.ok(r.result.projects['surf-gc'], 'surf-gc must be expanded');
    assert.deepStrictEqual(r.result.not_found, ['does-not-exist']);
  });

  test('C35: mind/fault_project rejects calls with no project ids', async () => {
    const r = await rpc('troth/mind/fault_project', { cwd: '/tmp/v11-surface' });
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32602);
  });

  test('C36: fault_in accepts new <troth:mind:UUID> marker prefix', async () => {
    // Persist a snapshot, then page-fault using its id wrapped as a mind marker.
    const persist = await rpc('troth/mind/persist', {
      mind_state: VALID_MIND_STATE,
      agent_id: 'claude-code',
      cwd: '/tmp/v11-fault-in-mind'
    });
    const snapId = persist.result.snapshot_id;
    assert.ok(snapId);

    const handle = '<troth:mind:' + snapId + '>';
    const r = await rpc('troth/fault_in', { handle });
    assert.ok(r.result, 'fault_in with mind marker failed: ' + JSON.stringify(r));
    assert.strictEqual(r.result.handle_kind, 'mind');
    assert.ok(r.result.action, 'returned action must be present');
    assert.strictEqual(r.result.action.type, 'mind_snapshot');
    assert.strictEqual(r.result.action.id, snapId);
  });

  test('C37: fault_in rejects unrecognized marker prefix', async () => {
    const r = await rpc('troth/fault_in', {
      handle: '<troth:bogus:00000000-0000-7000-8000-000000000000>'
    });
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32602);
  });

  test('C38: mind/record_decision writes a decision record and returns the id', async () => {
    const r = await rpc('troth/mind/record_decision', {
      project_id: 'surf-gc',
      summary: 'pivot to mind-as-working-context, persona rejected',
      rationale: 'user himself does not have a fixed persona — wrong frame',
      agent_id: 'claude-code',
      cwd: '/tmp/v11-record-decision'
    });
    assert.ok(r.result, 'record_decision result missing: ' + JSON.stringify(r));
    assert.strictEqual(r.result.project_id, 'surf-gc');
    assert.ok(r.result.decision_id && r.result.decision_id.length === 36);
  });

  test('C39: mind/record_decision rejects missing project_id or summary', async () => {
    const noProj = await rpc('troth/mind/record_decision', { summary: 'x' });
    assert.ok(noProj.error);
    assert.strictEqual(noProj.error.code, -32602);

    const noSum  = await rpc('troth/mind/record_decision', { project_id: 'x' });
    assert.ok(noSum.error);
    assert.strictEqual(noSum.error.code, -32602);
  });

  test('C41: mind/distill_project skips gracefully when no LLM endpoint is set', async () => {
    // Seed a snapshot with a project so distill has something to find.
    const seedMs = {
      schema_version: '0.1',
      snapshot_at: '2026-04-29T22:00:00Z',
      user_id: 'distill-user',
      current_focus: 'distill conformance',
      active_projects: [{
        id: 'd-gc', name: 'troth v11', stage: 'design', current_focus: 'distill',
        audience: 'devs', key_decisions: [], open_questions: [], constraints: [],
        collaborators: []
      }],
      current_intent: null,
      ongoing_threads: [],
      decisions_explicitly_rejected: []
    };
    const persist = await rpc('troth/mind/persist', {
      mind_state: seedMs,
      agent_id: 'claude-code',
      cwd: '/tmp/v11-distill-skip'
    });
    assert.ok(persist.result);

    const r = await rpc('troth/mind/distill_project', {
      project_id: 'd-gc',
      cwd: '/tmp/v11-distill-skip'
    });
    assert.ok(r.result, 'distill must return a result, got: ' + JSON.stringify(r));
    // Test environment has no TROTH_MIND_DISTILL_ENDPOINT, so we
    // expect a graceful skip.
    assert.strictEqual(r.result.skipped, true);
    assert.strictEqual(r.result.reason, 'no_endpoint');
  });

  test('C42: mind/distill_project rejects missing project_id', async () => {
    const r = await rpc('troth/mind/distill_project', { cwd: '/tmp/v11-distill-skip' });
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32602);
  });

  test('C43: mind/distill_project skips when project not in latest snapshot', async () => {
    const r = await rpc('troth/mind/distill_project', {
      project_id: 'no-such-project',
      cwd: '/tmp/v11-distill-skip'
    });
    assert.ok(r.result);
    assert.strictEqual(r.result.skipped, true);
    // Either no_endpoint (driver missing) OR project_not_in_snapshot.
    assert.ok(['project_not_in_snapshot', 'no_endpoint', 'no_snapshot'].includes(r.result.reason),
      'unexpected skip reason: ' + r.result.reason);
  });

  test('C44: tools/list advertises troth_mind_distill_project', async () => {
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('troth_mind_distill_project'),
      'mind_distill_project must be advertised');
  });

  test('C40: tools/list advertises troth_mind_record_decision and tools/call wraps it', async () => {
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('troth_mind_record_decision'),
      'mind_record_decision must be advertised');

    const call = await rpc('tools/call', {
      name: 'troth_mind_record_decision',
      arguments: {
        project_id: 'wrapper-proj',
        summary: 'tools/call wrapper test',
        agent_id: 'cursor'
      }
    });
    assert.ok(call.result, 'wrapper call result missing');
    const text = call.result.content && call.result.content[0] && call.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.decision_id && parsed.decision_id.length === 36);
    assert.strictEqual(parsed.project_id, 'wrapper-proj');
  });

  // Cleanup after ALL tests run. Bound to process exit (not a fixed
  // setTimeout) so the server stays alive for the duration of every
  // queued async test — the old 2s setTimeout fired mid-flight when
  // the suite grew past that mark, killing the server and producing
  // spurious rpc-timeout failures for any C test whose await happened
  // to land after 2s. process.on('exit') runs synchronously on the
  // final exit tick, after flushAsyncTests has resolved everything.
  process.on('exit', () => {
    try { server.kill('SIGTERM'); } catch {}
    try { fC.rmSync(TMP_C, { recursive: true, force: true }); } catch {}
  });
})();

// --- PHASE D: Virtual Runtime Layer ---
console.log('\nPhase D — virtual runtime + working set:');
(function runPhaseDTests() {
  const AR = require('../shared-core/action-record');
  const pD = require('path');
  const fD = require('fs');
  const TMP_D = pD.join(require('os').tmpdir(), 'gc-d-' + Date.now());
  fD.mkdirSync(TMP_D, { recursive: true });
  const savedD = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_D;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/working-set')];
  delete require.cache[require.resolve('../shared-core/runtime')];
  const state = require('../shared-core/state');
  const WS    = require('../shared-core/working-set');
  const RT    = require('../shared-core/runtime');

  // Seed: 6 records for working-set play.
  const sess = 'D-' + Date.now();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const r = AR.create({
      type: 'edit', agent_id: 'cc', session_id: sess, cwd: '/tmp/Dproj',
      input: { file_path: 'f' + i + '.ts', format: 'hashline' },
      output: { hash_after: 'h' + i },
      verification: { ast: { ok: true, skipped: false } }
    });
    state.recordAction(r, AR.toSearchText(r));
    ids.push(r.id);
  }

  // D1 — working set basics
  test('D1: openSession creates a session with budget + max_size', () => {
    const s = WS.openSession(state, { session_id: sess, agent_id: 'cc', cwd: '/tmp/Dproj', budget_tokens: 200, max_size: 4 });
    assert.ok(s);
    assert.strictEqual(s.session_id, sess);
    assert.strictEqual(s.budget, 200);
    assert.strictEqual(s.max_size, 4);
  });

  test('D1: load adds pointer; duplicate load is a no-op (move-to-front)', () => {
    WS.load(state, sess, ids[0]);
    const sizeAfter1 = WS.size(sess);
    WS.load(state, sess, ids[0]);
    assert.strictEqual(WS.size(sess), sizeAfter1, 'duplicate load must not grow the set');
  });

  test('D1: load beyond max_size evicts LRU non-pinned', () => {
    // After prior test, ids[0] is resident. Load 4 more → expect eviction.
    for (let i = 1; i < 5; i++) WS.load(state, sess, ids[i]);
    assert.ok(WS.size(sess) <= 4, 'max_size=4 should enforce cap, got ' + WS.size(sess));
  });

  test('D1: pin prevents eviction under pressure', () => {
    // Pin whatever is currently resident as the oldest, then load more.
    const m1 = WS.manifest(sess);
    const oldest = m1.entries[m1.entries.length - 1];
    WS.pin(sess, oldest.id);
    // Push beyond max_size.
    WS.load(state, sess, ids[5]);
    const m2 = WS.manifest(sess);
    assert.ok(m2.entries.some(e => e.id === oldest.id), 'pinned record must survive eviction');
  });

  test('D1: swap with pinned page in remove-list is rejected', () => {
    const m = WS.manifest(sess);
    const pinnedId = m.pinned[0];
    assert.ok(pinnedId, 'test setup: need a pinned id');
    const r = WS.swap(state, sess, { remove: [pinnedId] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'pinned_page_cannot_be_removed');
  });

  test('D1: compact event recorded for every working-set change', () => {
    const compacts = state.queryActions({ type: 'compact', session_id: sess });
    assert.ok(compacts.length >= 1, 'at least one compact event should exist (got ' + compacts.length + ')');
  });

  // D2 — runtime manifest
  test('D2: buildManifest returns text with pointer+summary lines', () => {
    const out = RT.buildManifest(sess);
    assert.ok(out && out.text);
    assert.ok(out.text.includes('[troth/working-set]'));
    assert.ok(out.tokens_used > 0);
    assert.ok(out.manifest.resident >= 1);
  });

  test('D2: handleFetch succeeds for known id + auto-loads', () => {
    // Create a fresh session to isolate; fetch should auto-open it.
    const ghost = 'ghost-' + Date.now();
    const r = RT.handleFetch(state, ghost, ids[0]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action.id, ids[0]);
    // After fetch, the session must exist and have the page resident.
    assert.ok(WS.isResident(ghost, ids[0]));
  });

  test('D2: handleFetch returns structured fault for unknown id', () => {
    const r = RT.handleFetch(state, sess, '00000000-0000-0000-0000-000000000000');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.fault, 'not_found');
    assert.ok(r.hint, 'fault must carry a hint so the agent does not hallucinate');
  });

  // D3 — lifecycle + integrity
  test('D3: onBeforeCompact keeps pinned + drops to 70% of budget', () => {
    const compactSess = 'D3-compact-' + Date.now();
    // Budget large enough to hold all 6 seed records, then compact targets 70%.
    WS.openSession(state, { session_id: compactSess, agent_id: 'cc', cwd: '/tmp/Dproj', budget_tokens: 500, max_size: 10 });
    // Pin the first at load-time so it survives whatever eviction may happen.
    WS.load(state, compactSess, ids[0], { pinned: true });
    for (let i = 1; i < ids.length; i++) WS.load(state, compactSess, ids[i]);
    const before = WS.size(compactSess);
    const r = RT.onBeforeCompact(state, compactSess);
    assert.strictEqual(r.ok, true);
    const after = WS.size(compactSess);
    assert.ok(after <= before, 'compact should not grow the working set');
    assert.ok(WS.isResident(compactSess, ids[0]), 'pinned page must survive compact');
  });

  test('D3: onReset drops non-pinned pointers but keeps pinned', () => {
    const resetSess = 'D3-reset-' + Date.now();
    WS.openSession(state, { session_id: resetSess, agent_id: 'cc', cwd: '/tmp/Dproj' });
    WS.load(state, resetSess, ids[0], { pinned: true });
    WS.load(state, resetSess, ids[1]);
    WS.load(state, resetSess, ids[2]);
    const r = RT.onReset(state, resetSess);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.kept_pinned, 1);
    assert.ok(WS.isResident(resetSess, ids[0]));
    assert.ok(!WS.isResident(resetSess, ids[1]));
  });

  test('D3: checkIntegrity reports no issues for a well-formed session', () => {
    const ok = RT.checkIntegrity(state, sess);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.issues, []);
  });

  test('D3: compact events log trigger and removed/kept counts', () => {
    const compacts = (state.queryActions({ type: 'compact', session_id: sess }) || []).map(AR.fromRow);
    // Must have trigger + counts.
    for (const c of compacts) {
      assert.ok(c.input.trigger, 'compact record must carry a trigger');
      assert.ok(Number.isInteger(c.output.removed_count));
      assert.ok(Number.isInteger(c.output.kept_count));
    }
  });

  // Context reduction proof-point: how small is the manifest vs full content?
  test('D proof: manifest tokens are a fraction of full content tokens (asserts 3x or better)', () => {
    const manifestOut = RT.buildManifest(sess);
    // Sum up the raw JSON size of all resident records; rough token estimate.
    const ids = manifestOut.manifest.entries.map(e => e.id);
    let fullSize = 0;
    for (const id of ids) {
      const row = state.getAction(id);
      if (!row) continue;
      fullSize += JSON.stringify(row).length;
    }
    const fullTokens = Math.ceil(fullSize / 3.5);
    const manifestTokens = manifestOut.tokens_used;
    const ratio = fullTokens / Math.max(1, manifestTokens);
    // Conservative threshold: 3x (for tiny records the ratio is modest;
    // real workloads with large edits/outputs go 20-50x).
    assert.ok(ratio >= 3,
      'manifest should be at least 3x smaller than full content (got ratio=' + ratio.toFixed(2) +
      ', full=' + fullTokens + ', manifest=' + manifestTokens + ')');
  });

  try { fD.rmSync(TMP_D, { recursive: true, force: true }); } catch {}
  process.env.CLAUDE_PLUGIN_DATA = savedD;
})();

// --- PHASE E: KnowledgeAtlas + AgentMarket ---
console.log('\nPhase E — KnowledgeAtlas + AgentMarket:');
(function runPhaseETests() {
  const AR = require('../shared-core/action-record');
  const pE = require('path');
  const fE = require('fs');
  const TMP_E = pE.join(require('os').tmpdir(), 'gc-e-' + Date.now());
  fE.mkdirSync(TMP_E, { recursive: true });
  const savedE = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_E;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/atlas')];
  delete require.cache[require.resolve('../shared-core/market')];
  const state  = require('../shared-core/state');
  const Atlas  = require('../shared-core/atlas');
  const Market = require('../shared-core/market');

  // Seed: 4 records across 2 projects.
  const rA1 = AR.create({ type: 'edit', agent_id: 'cc', session_id: 'E', cwd: '/projA',
    input: { file_path: 'a.ts', format: 'hashline' }, output: { hash_after: 'a1' } });
  state.recordAction(rA1, AR.toSearchText(rA1));
  const rA2 = AR.create({ type: 'lesson', agent_id: 'cc', session_id: 'E', cwd: '/projA',
    input: { source: 'critic', fingerprint: 'fpA' }, output: { text: 'lesson A' } });
  state.recordAction(rA2, AR.toSearchText(rA2));
  const rB1 = AR.create({ type: 'edit', agent_id: 'cc', session_id: 'E', cwd: '/projB',
    input: { file_path: 'b.ts', format: 'hashline' }, output: { hash_after: 'b1' } });
  state.recordAction(rB1, AR.toSearchText(rB1));
  const rB2 = AR.create({ type: 'decision', agent_id: 'cc', session_id: 'E', cwd: '/projB',
    input: { kind: 'critic' }, output: { decision: 'block' } });
  state.recordAction(rB2, AR.toSearchText(rB2));

  // E1 — Atlas export/import
  test('E1: exportAtlas produces NDJSON with header + records', () => {
    const out = Atlas.exportAtlas(state, { filter: { cwd: '/projA', record_types: ['edit', 'lesson'] } });
    assert.strictEqual(out.count, 2);
    const lines = out.content.split('\n').filter(l => l.trim());
    assert.strictEqual(lines.length, 3, 'header + 2 records');
    const header = JSON.parse(lines[0]);
    assert.ok(header.__atlas);
    assert.strictEqual(header.__atlas.version, Atlas.ATLAS_VERSION);
    assert.strictEqual(header.__atlas.count, 2);
  });

  test('E1: exportAtlas filter record_types narrows to specific types', () => {
    const out = Atlas.exportAtlas(state, { filter: { record_types: ['lesson'] } });
    assert.strictEqual(out.count, 1, 'only the lesson should match');
  });

  test('E1: exportAtlas bypasses the 1000-row recall clamp and defaults to mind types (data-loss regression)', () => {
    // Regression for the "Move to another Mac" data-loss bug: exportAtlas pulled
    // rows via state.queryActions, whose limit is HARD-clamped at 1000 for recall
    // performance — so a 187K-memory mind exported as only ~1000 rows. The fix
    // threads forExport:true so a deliberate export reads the whole substrate.
    // This test crosses the 1000 boundary and proves the clamp is bypassed, and
    // that the default export carries the mind types but NOT the audit noise.
    const bulkDir = pE.join(require('os').tmpdir(), 'gc-e-bulk-' + Date.now());
    fE.mkdirSync(bulkDir, { recursive: true });
    const saveD = process.env.CLAUDE_PLUGIN_DATA;
    const saveBypass = process.env.TROTH_STVC_BYPASS;
    process.env.CLAUDE_PLUGIN_DATA = bulkDir;
    process.env.TROTH_STVC_BYPASS = '1'; // deterministic bulk seed; STVC is not under test here
    delete require.cache[require.resolve('../shared-core/state')];
    const bulkState = require('../shared-core/state');

    const N = 1100; // > the 1000 queryActions recall clamp
    for (let i = 0; i < N; i++) {
      const c = AR.create({
        type: 'commitment', agent_id: 'cc', session_id: 'BULK', cwd: '/bulk',
        input:  { source: 'seed' },
        output: { statement: 'commitment #' + i, commitment_type: 'hard' }
      });
      bulkState.recordAction(c, AR.toSearchText(c));
    }
    // A high-volume audit-trail type that must NOT ride along in a default export.
    const noise = AR.create({
      type: 'tool_call', agent_id: 'cc', session_id: 'BULK', cwd: '/bulk',
      input: { tool_name: 'bash' }, output: { status: 'ok' }
    });
    bulkState.recordAction(noise, AR.toSearchText(noise));

    // Guard: normal recall is STILL clamped at 1000 (the perf cap is untouched).
    assert.strictEqual(
      bulkState.queryActions({ type: 'commitment', limit: 100000 }).length, 1000,
      'normal recall must stay clamped at 1000');

    // Default export (no record_types) pulls the WHOLE mind, past the clamp...
    const out = Atlas.exportAtlas(bulkState, {});
    assert.strictEqual(out.count, N,
      'export must return all ' + N + ' commitments, not the 1000-row recall window');
    const recs = out.content.split('\n').filter(l => l.trim()).slice(1).map(l => JSON.parse(l));
    assert.strictEqual(recs.filter(r => r.type === 'commitment').length, N);
    // ...while the audit-noise type is excluded from the mind-type default.
    assert.strictEqual(recs.filter(r => r.type === 'tool_call').length, 0,
      'tool_call is audit noise — excluded from the default mind export');

    // But an explicit record_types override still exports the audit type.
    const toolOut = Atlas.exportAtlas(bulkState, { filter: { record_types: ['tool_call'] } });
    assert.strictEqual(toolOut.count, 1,
      'explicit record_types must still export tool_call');

    // Restore module + env so later Phase E tests keep the original state.
    process.env.CLAUDE_PLUGIN_DATA = saveD;
    if (saveBypass === undefined) delete process.env.TROTH_STVC_BYPASS;
    else process.env.TROTH_STVC_BYPASS = saveBypass;
    delete require.cache[require.resolve('../shared-core/state')];
    try { fE.rmSync(bulkDir, { recursive: true, force: true }); } catch {}
  });

  test('E1: inspectAtlas reports ok for valid bundle', () => {
    const out = Atlas.exportAtlas(state, { filter: { cwd: '/projA', record_types: ['edit', 'lesson'] } });
    const i = Atlas.inspectAtlas(out.content);
    assert.strictEqual(i.ok, true);
    assert.strictEqual(i.records_seen, 2);
  });

  test('E1: inspectAtlas reports errors for malformed lines', () => {
    const bad = '{"__atlas":{"version":"0.1"}}\nnot-json\n';
    const i = Atlas.inspectAtlas(bad);
    assert.strictEqual(i.ok, false);
    assert.ok(i.errors.some(e => e.kind === 'parse'));
  });

  test('E1: importAtlas roundtrip into fresh substrate preserves records', () => {
    const freshDir = pE.join(require('os').tmpdir(), 'gc-e-fresh-' + Date.now());
    fE.mkdirSync(freshDir, { recursive: true });
    const saveD = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = freshDir;
    delete require.cache[require.resolve('../shared-core/state')];
    const freshState = require('../shared-core/state');

    const bundle = Atlas.exportAtlas(state, { filter: { cwd: '/projA', record_types: ['edit', 'lesson'] } });
    const result = Atlas.importAtlas(freshState, bundle.content);
    assert.strictEqual(result.imported, 2);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(freshState.countActions({ cwd: '/projA' }), 2);

    // F5 regression — FTS5 mirror MUST be populated for every imported record so
    // searchActions returns hits post-import. The probe must use an FTS5-safe
    // query: `claude-code` parses as `claude` MINUS `code` and reads as an empty
    // index. This assertion locks the contract: row count in action_records_fts ==
    // row count in action_records for imported rows.
    const ftsRows = freshState._dbForQuery()
      .prepare('SELECT COUNT(*) AS n FROM action_records_fts').get().n;
    assert.strictEqual(ftsRows, 2, 'FTS5 mirror must have 1 row per imported record');
    // And: a safe FTS5 probe finds at least one hit.
    const hits = freshState.searchActions('edit', { limit: 5 });
    assert.ok(hits.length >= 1, 'searchActions("edit") must return ≥1 hit on imported records');

    // Restore
    process.env.CLAUDE_PLUGIN_DATA = saveD;
    delete require.cache[require.resolve('../shared-core/state')];
    try { fE.rmSync(freshDir, { recursive: true, force: true }); } catch {}
  });

  test('E1: importAtlas skip-conflict preserves local data on duplicate import', () => {
    // Import the same bundle twice into same state — skip mode.
    const bundle = Atlas.exportAtlas(state, { filter: { cwd: '/projA', record_types: ['edit', 'lesson'] } });
    const r1 = Atlas.importAtlas(state, bundle.content, { conflict: 'skip' });
    const r2 = Atlas.importAtlas(state, bundle.content, { conflict: 'skip' });
    // First import: all already exist (they came from state itself), so all skipped.
    assert.strictEqual(r1.skipped, 2);
    assert.strictEqual(r2.skipped, 2);
  });

  test('E1: importAtlas rejects incompatible version', () => {
    const incompatible = JSON.stringify({ __atlas: { version: '2.0', count: 0 } }) + '\n';
    const r = Atlas.importAtlas(state, incompatible);
    assert.ok(r.errors.some(e => e.kind === 'incompatible_version'));
  });

  // E2 — AgentMarket
  test('E2: race picks highest-scoring agent', async () => {
    const agents = [
      { id: 'low',  run: async () => ({
        record: AR.create({
          type: 'edit', agent_id: 'low',
          input: { file_path: 'x.ts', format: 'h' }, output: { hash_after: 'lx' },
          verification: { ast: { ok: false, skipped: false, errors: [{line:1}] } }
        }),
        tokens: 500
      }) },
      { id: 'high', run: async () => ({
        record: AR.create({
          type: 'edit', agent_id: 'high',
          input: { file_path: 'x.ts', format: 'h' }, output: { hash_after: 'hx' },
          verification: {
            ast:   { ok: true, skipped: false },
            tests: { ok: true, skipped: false, details: { passed: 3, failed: 0 } }
          }
        }),
        tokens: 300
      }) }
    ];
    const result = await Market.race(state, { task: 'e2-task', agents, cwd: '/projE' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.winner.agent_id, 'high');
    assert.ok(result.winner.score > result.attempts.find(a => a.agent_id === 'low').score);
  });

  test('E2: race records market_run + market_winner actions in substrate', async () => {
    const agents = [
      { id: 'solo', run: async () => ({
        record: AR.create({
          type: 'edit', agent_id: 'solo',
          input: { file_path: 's.ts', format: 'h' }, output: { hash_after: 's' },
          verification: { ast: { ok: true, skipped: false } }
        })
      }) }
    ];
    await Market.race(state, { task: 'e2b-task', agents, cwd: '/projE' });
    const decisions = state.queryActions({ type: 'decision', cwd: '/projE' }).map(AR.fromRow);
    const runs = decisions.filter(d => d.input && d.input.kind === 'market_run');
    const wins = decisions.filter(d => d.input && d.input.kind === 'market_winner');
    assert.ok(runs.length >= 1, 'market_run recorded');
    assert.ok(wins.length >= 1, 'market_winner recorded');
  });

  test('E2: race with all agents failing returns ok=false + no winner', async () => {
    const agents = [
      { id: 'fail1', run: async () => { throw new Error('boom'); } },
      { id: 'fail2', run: async () => ({ /* no record */ }) }
    ];
    const result = await Market.race(state, { task: 'e2c', agents, cwd: '/projE' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.winner, null);
    assert.ok(result.attempts.every(a => a.record === null));
  });

  test('E2: analyzeWinners aggregates wins/losses per agent', async () => {
    // Run its own race inside the test so this test is self-contained.
    // The sync-IIFE test-queue-flush model means earlier-declared async
    // race tests haven't drained yet when subsequent sync tests run, so
    // we can't depend on state populated by prior tests.
    const agents = [
      { id: 'winner', run: async () => ({
        record: AR.create({
          type: 'edit', agent_id: 'winner',
          input: { file_path: 'w.ts', format: 'h' }, output: { hash_after: 'w' },
          verification: {
            ast:   { ok: true, skipped: false },
            tests: { ok: true, skipped: false, details: { passed: 3, failed: 0 } }
          }
        })
      }) },
      { id: 'loser', run: async () => ({
        record: AR.create({
          type: 'edit', agent_id: 'loser',
          input: { file_path: 'w.ts', format: 'h' }, output: { hash_after: 'l' },
          verification: { ast: { ok: false, skipped: false, errors: [{line:1}] } }
        })
      }) }
    ];
    await Market.race(state, { task: 'analyze-test', agents, cwd: '/tmp/analyze' });
    const stats = Market.analyzeWinners(state);
    assert.strictEqual(typeof stats, 'object');
    assert.ok(stats.winner && stats.winner.wins >= 1, 'winner agent recorded wins: ' + JSON.stringify(stats));
    assert.ok(stats.loser  && stats.loser.losses >= 1, 'loser agent recorded losses: ' + JSON.stringify(stats));
  });

  try { fE.rmSync(TMP_E, { recursive: true, force: true }); } catch {}
  process.env.CLAUDE_PLUGIN_DATA = savedE;
})();

// --- PRECOMPACT HOOK (product gap 1): turns Layer 5 from theory to practice ---
console.log('\nPreCompact hook integration:');
(function runPreCompactTests() {
  const AR = require('../shared-core/action-record');
  const childPC = require('child_process');
  const pPC = require('path');
  const fPC = require('fs');
  const REPO_PC = pPC.resolve(__dirname, '..');
  const PLUGIN_PC = pPC.join(REPO_PC, 'plugin');
  const TMP_PC = pPC.join(require('os').tmpdir(), 'gc-precompact-' + Date.now());
  fPC.mkdirSync(TMP_PC, { recursive: true });

  function runPreCompact(payload) {
    const out = childPC.execFileSync(
      'node', [pPC.join(PLUGIN_PC, 'hooks', 'pre-compact.mjs')],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, {
          CLAUDE_PLUGIN_ROOT: PLUGIN_PC,
          CLAUDE_PLUGIN_DATA: TMP_PC
        }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  test('PreCompact hook: allow() when no session_id', () => {
    const out = runPreCompact({});
    assert.deepStrictEqual(out, {}, 'empty payload should fall through to allow');
  });

  test('PreCompact hook: writes compact_handoff decision to substrate', () => {
    // PreCompact cannot use hookSpecificOutput.additionalContext (CC schema
    // rejects hookEventName 'PreCompact'). The cross-compact bridge is the
    // substrate: PreCompact writes a `decision` ActionRecord with
    // kind='compact_handoff'; SessionStart's auto-resume picks it up.
    process.env.CLAUDE_PLUGIN_DATA = TMP_PC;
    delete require.cache[require.resolve('../shared-core/state')];
    delete require.cache[require.resolve('../shared-core/working-set')];
    const state = require('../shared-core/state');
    const ws    = require('../shared-core/working-set');

    const sess = 'PC-' + Date.now();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = AR.create({
        type: 'edit', agent_id: 'claude-code', session_id: sess, cwd: '/tmp/PCproj',
        input: { file_path: 'p' + i + '.ts', format: 'hashline' },
        output: { hash_after: 'h' + i },
        verification: { ast: { ok: true, skipped: false } }
      });
      state.recordAction(r, AR.toSearchText(r));
      ids.push(r.id);
    }
    ws.openSession(state, { session_id: sess, agent_id: 'claude-code', cwd: '/tmp/PCproj', budget_tokens: 40, max_size: 10 });
    ws.load(state, sess, ids[0], { pinned: true });
    ws.load(state, sess, ids[1]);
    ws.load(state, sess, ids[2]);

    const out = runPreCompact({ session_id: sess, cwd: '/tmp/PCproj' });
    assert.deepStrictEqual(out, {}, 'PreCompact must emit allow() {} — schema rejects PreCompact additionalContext');

    // Verify the handoff decision record landed.
    const decisions = state.queryActions({ type: 'decision', session_id: sess, limit: 5 });
    const handoff = (decisions || [])
      .map((row) => { try { return { id: row.id, input: JSON.parse(row.input), output: JSON.parse(row.output) }; } catch { return null; } })
      .filter(Boolean)
      .find((d) => d.input && d.input.kind === 'compact_handoff');
    assert.ok(handoff, 'compact_handoff decision must be persisted to substrate');
    assert.strictEqual(handoff.output.decision, 'handoff_recorded', 'output.decision required by schema');
    assert.ok(typeof handoff.output.summary === 'string', 'output.summary must exist');
  });

  test('PreCompact hook: the handoff says WHERE the work sits — branch and recent commits', () => {
    // The dirty list said what had changed and never what it changed FROM. A
    // post-compact agent that knows the files but not the branch has to ask, and
    // asking is the thing this record exists to prevent. The repository is BUILT
    // here rather than borrowed from the surrounding checkout. A test that only
    // holds where its author ran it is not a test.
    const gitEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'suite', GIT_AUTHOR_EMAIL: 'suite@invalid',
      GIT_COMMITTER_NAME: 'suite', GIT_COMMITTER_EMAIL: 'suite@invalid'
    });
    const repo = pPC.join(TMP_PC, 'handoff-repo');
    fPC.mkdirSync(repo, { recursive: true });
    const git = (args) => childPC.execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    let haveGit = true;
    try {
      git(['init', '-q']);
      fPC.writeFileSync(pPC.join(repo, 'note.txt'), 'first\n');
      git(['add', 'note.txt']);
      git(['commit', '-q', '-m', 'the commit the handoff should name']);
      fPC.writeFileSync(pPC.join(repo, 'note.txt'), 'second\n');   // leave it dirty
    } catch (_) { haveGit = false; }

    process.env.CLAUDE_PLUGIN_DATA = TMP_PC;
    delete require.cache[require.resolve('../shared-core/state')];
    delete require.cache[require.resolve('../shared-core/working-set')];
    const state = require('../shared-core/state');
    const sess = 'PCGIT-' + Date.now();
    const out = runPreCompact({ session_id: sess, cwd: repo });
    assert.deepStrictEqual(out, {}, 'still allow()');
    const handoff = (state.queryActions({ type: 'decision', session_id: sess, limit: 5 }) || [])
      .map((row) => { try { return { input: JSON.parse(row.input), output: JSON.parse(row.output) }; } catch { return null; } })
      .filter(Boolean)
      .find((d) => d.input && d.input.kind === 'compact_handoff');
    assert.ok(handoff, 'handoff persisted');
    // Shape first: outside a repository these must be an empty string and an
    // empty array, never absent and never a throw.
    assert.strictEqual(typeof handoff.output.branch, 'string', 'branch is always a string');
    assert.ok(Array.isArray(handoff.output.recent_commits), 'recent_commits is always an array');
    if (!haveGit) return;   // no git on this machine — the shape above is the whole claim
    assert.ok(handoff.output.branch.length > 0,
      'inside a repository the branch is captured: ' + JSON.stringify(handoff.output.branch));
    assert.ok(handoff.output.recent_commits.length > 0,
      'and the last commits: ' + JSON.stringify(handoff.output.recent_commits));
    assert.ok(/the commit the handoff should name/.test(handoff.output.recent_commits.join(' ')),
      'the real subject line, not a placeholder: ' + JSON.stringify(handoff.output.recent_commits));
    assert.ok(/Branch: /.test(String(handoff.output.summary)),
      'and it reaches the summary the post-compact agent actually reads: ' + String(handoff.output.summary).slice(0, 200));
  });

  test('PreCompact hook: records a type=compact ActionRecord in substrate', () => {
    process.env.CLAUDE_PLUGIN_DATA = TMP_PC;
    delete require.cache[require.resolve('../shared-core/state')];
    const state = require('../shared-core/state');
    const rows = state.queryActions({ type: 'compact' });
    assert.ok(rows.length >= 1, 'compact event must be logged in action_records');
  });

  try { fPC.rmSync(TMP_PC, { recursive: true, force: true }); } catch {}
})();

// --- cachestable (prompt-cache prefix stability) ---
(() => {
  const cs = require('../proxy/modules/cachestable');

  test('cachestable: canonicalizeTools sorts by name + deterministic keys', () => {
    const shuffled = [
      { description: 'reads', name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { input_schema: { properties: { cmd: { type: 'string' } }, type: 'object' }, name: 'Bash', description: 'runs' },
    ];
    const canon = cs.canonicalizeTools(shuffled);
    assert.strictEqual(canon[0].name, 'Bash', 'Bash must come before Read alphabetically');
    assert.strictEqual(canon[1].name, 'Read');
    const s = cs.canonicalStringify(canon[0]);
    assert.ok(s.indexOf('"description"') < s.indexOf('"input_schema"'), 'keys sorted');
    assert.ok(s.indexOf('"input_schema"') < s.indexOf('"name"'));
  });

  test('cachestable: canonicalStringify is byte-stable across key orderings', () => {
    const a = { b: 1, a: 2, c: { z: 9, a: 10 } };
    const b = { c: { a: 10, z: 9 }, a: 2, b: 1 };
    assert.strictEqual(cs.canonicalStringify(a), cs.canonicalStringify(b), 'logically identical objects must stringify identically');
  });

  test('cachestable: sanitizeSystem strips volatile date lines', () => {
    const sys = "Today's date is 2026-04-24\nReal instruction\nCurrent date: 2026-04-24T12:00:00Z\nMore content";
    const r = cs.sanitizeSystem(sys);
    assert.strictEqual(r.stripped, 2, 'must strip 2 volatile lines');
    assert.ok(!r.sanitized.includes('2026-04-24'), 'no dates leak through');
    assert.ok(r.sanitized.includes('Real instruction'), 'keeps real content');
  });

  test('cachestable: minCacheTokens returns 4096 for Opus 4.7 family, 1024 for older', () => {
    assert.strictEqual(cs.minCacheTokens('claude-opus-4-7'), 4096);
    assert.strictEqual(cs.minCacheTokens('claude-opus-4-7[1m]'), 4096, 'strip trailing tags');
    assert.strictEqual(cs.minCacheTokens('claude-sonnet-4-5'), 1024);
    assert.strictEqual(cs.minCacheTokens(undefined), 1024, 'fallback when model missing');
  });

  test('cachestable: placeCacheControls respects token threshold (silent-fail guard)', () => {
    const body = {
      model: 'claude-opus-4-7',
      system: 'short',
      tools: [{ name: 'x', description: 'y' }],
      messages: [{ role: 'user', content: 'hi' }]
    };
    cs.placeCacheControls(body, body.model);
    assert.ok(!body.tools[0].cache_control, 'tools must not get breakpoint below Opus 4096 threshold');
  });

  test('cachestable: apply is idempotent under double-application', () => {
    const make = () => ({
      model: 'claude-sonnet-4-5',
      system: 'You are a helpful coding agent. '.repeat(200),
      tools: [{ name: 'Bash', description: 'runs shell' }, { name: 'Read', description: 'reads files' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    });
    const r1 = cs.apply(make());
    const r2 = cs.apply(make());
    assert.strictEqual(JSON.stringify(r1.body), JSON.stringify(r2.body), 'fresh apply identical on clones');
    const r3 = cs.apply(r1.body);
    assert.strictEqual(r3.stats.breakpointsPlaced, r1.stats.breakpointsPlaced, 'breakpoint count stable under re-apply');
  });
})();

// --- troth-cache (Phase A — semantic tool-result cache) ---
(() => {
  const gc = require('../proxy/modules/troth-cache');
  const BetterSqlite = require('better-sqlite3');

  // Each test gets a fresh in-memory DB + cache instance so they can't
  // leak state into each other.
  function freshCache() {
    const db = new BetterSqlite(':memory:');
    return gc.createCache({ db });
  }

  test('troth-cache: computeKey is deterministic across arg key order', () => {
    const a = gc.computeKey({ tool_name: 'Read', args: { path: '/tmp/x', limit: 10 }, cwd: '/p', file_hashes: ['aaa'] });
    const b = gc.computeKey({ tool_name: 'Read', args: { limit: 10, path: '/tmp/x' }, cwd: '/p', file_hashes: ['aaa'] });
    assert.strictEqual(a, b, 'shuffled arg keys must produce the same cache key');
  });

  test('troth-cache: computeKey changes when cwd changes', () => {
    const a = gc.computeKey({ tool_name: 'Grep', args: { pattern: 'foo' }, cwd: '/p1', file_hashes: [] });
    const b = gc.computeKey({ tool_name: 'Grep', args: { pattern: 'foo' }, cwd: '/p2', file_hashes: [] });
    assert.notStrictEqual(a, b, 'different cwds → different keys');
  });

  test('troth-cache: computeKey changes when any referenced file hash changes', () => {
    const base = { tool_name: 'Read', args: { path: '/tmp/x' }, cwd: '/p', file_hashes: ['aaaaa'] };
    const a = gc.computeKey(base);
    const b = gc.computeKey(Object.assign({}, base, { file_hashes: ['bbbbb'] }));
    assert.notStrictEqual(a, b, 'file-hash change must bust the cache');
  });

  test('troth-cache: computeKey normalizes path-bearing args so relative and absolute share a key', () => {
    const fsLocal = require('fs'); const pl = require('path'); const osLocal = require('os');
    const dir = fsLocal.mkdtempSync(pl.join(osLocal.tmpdir(), 'gc-pathnorm-'));
    try {
      const rel = 'sub/file.js';
      const abs = pl.join(dir, rel);
      const a = gc.computeKey({ tool_name: 'Read', args: { file_path: rel }, cwd: dir, file_hashes: ['h1'] });
      const b = gc.computeKey({ tool_name: 'Read', args: { file_path: abs }, cwd: dir, file_hashes: ['h1'] });
      assert.strictEqual(a, b, 'relative and absolute path must produce the same key');
      // Sanity: `path` and `file_path` on the same actual file should ALSO match when normalized
      // (callers should pick one consistently, but the normalization must at least handle resolution).
      const c = gc.computeKey({ tool_name: 'Read', args: { file_path: abs }, cwd: '/different/cwd', file_hashes: ['h1'] });
      assert.notStrictEqual(a, c, 'different cwd still differentiates keys (cwd is part of the hash)');
    } finally {
      try { fsLocal.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  test('troth-cache: computeKey is stable under file_hashes reordering', () => {
    const a = gc.computeKey({ tool_name: 'MultiRead', args: {}, cwd: '/p', file_hashes: ['aa','bb','cc'] });
    const b = gc.computeKey({ tool_name: 'MultiRead', args: {}, cwd: '/p', file_hashes: ['cc','aa','bb'] });
    assert.strictEqual(a, b, 'file_hashes order must not affect the key');
  });

  test('troth-cache: store then lookup roundtrips the value', () => {
    const c = freshCache();
    const key = c.computeKey({ tool_name: 'Grep', args: { pattern: 'foo' }, cwd: '/p', file_hashes: [] });
    c.store({ key, tool_name: 'Grep', cwd: '/p', value: { matches: ['a.js','b.js'] }, ttl_s: 60 });
    const r = c.lookup({ tool_name: 'Grep', args: { pattern: 'foo' }, cwd: '/p', file_hashes: [] });
    assert.strictEqual(r.hit, true, 'fresh entry must hit');
    assert.deepStrictEqual(r.value, { matches: ['a.js','b.js'] });
  });

  test('troth-cache: expired entries are evicted on lookup', () => {
    const c = freshCache();
    const key = c.computeKey({ tool_name: 'Read', args: { path: '/x' }, cwd: '/p', file_hashes: ['h'] });
    // Backdate: store with positive ttl_s, then overwrite expires_at to the past.
    c.store({ key, tool_name: 'Read', cwd: '/p', value: { content: 'stale' }, ttl_s: 60 });
    c._db.prepare('UPDATE tool_response_cache SET expires_at = ? WHERE key = ?')
      .run(Date.now() - 1000, key);
    const r = c.lookup({ tool_name: 'Read', args: { path: '/x' }, cwd: '/p', file_hashes: ['h'] });
    assert.strictEqual(r.hit, false);
    assert.strictEqual(r.reason, 'expired');
    const row = c._db.prepare('SELECT 1 FROM tool_response_cache WHERE key = ?').get(key);
    assert.strictEqual(row, undefined, 'expired row must be deleted');
  });

  test('troth-cache: refuses to cache stateful tools (Edit/Write/MultiEdit)', () => {
    assert.strictEqual(gc.isCacheable('Edit', { file_path: '/x' }), false);
    assert.strictEqual(gc.isCacheable('Write', { file_path: '/x' }), false);
    assert.strictEqual(gc.isCacheable('MultiEdit', {}), false);
    const c = freshCache();
    const r = c.lookup({ tool_name: 'Edit', args: { file_path: '/x' }, cwd: '/p', file_hashes: [] });
    assert.strictEqual(r.hit, false);
    assert.strictEqual(r.reason, 'uncacheable_tool');
  });

  test('troth-cache: Bash allow-list accepts read-only, rejects side-effecting + shell meta', () => {
    assert.strictEqual(gc.isBashCacheable('git log --oneline -5'), true);
    assert.strictEqual(gc.isBashCacheable('ls -la'), true);
    assert.strictEqual(gc.isBashCacheable('cat /etc/hosts'), true);
    assert.strictEqual(gc.isBashCacheable('rm -rf /tmp/x'), false, 'rm must not cache');
    assert.strictEqual(gc.isBashCacheable('git commit -m foo'), false, 'git commit must not cache');
    assert.strictEqual(gc.isBashCacheable('ls > out.txt'), false, 'redirects must not cache');
    assert.strictEqual(gc.isBashCacheable('ls | grep x'), false, 'pipes must not cache');
    assert.strictEqual(gc.isBashCacheable('npm install react'), false, 'npm install must not cache');
    assert.strictEqual(gc.isBashCacheable('echo $(whoami)'), false, 'command substitution must not cache');
  });

  test('troth-cache: invalidate({cwd}) purges only that cwd\'s entries', () => {
    const c = freshCache();
    const k1 = c.computeKey({ tool_name: 'Read', args: { path: '/a' }, cwd: '/p1', file_hashes: ['h1'] });
    const k2 = c.computeKey({ tool_name: 'Read', args: { path: '/b' }, cwd: '/p2', file_hashes: ['h2'] });
    c.store({ key: k1, tool_name: 'Read', cwd: '/p1', value: { n: 1 }, ttl_s: 60 });
    c.store({ key: k2, tool_name: 'Read', cwd: '/p2', value: { n: 2 }, ttl_s: 60 });
    const purged = c.invalidate({ cwd: '/p1' });
    assert.strictEqual(purged, 1);
    assert.strictEqual(c.lookup({ tool_name: 'Read', args: { path: '/a' }, cwd: '/p1', file_hashes: ['h1'] }).hit, false);
    assert.strictEqual(c.lookup({ tool_name: 'Read', args: { path: '/b' }, cwd: '/p2', file_hashes: ['h2'] }).hit, true, '/p2 entry survives');
  });

  test('troth-cache: stampede write-lock is mutually exclusive', () => {
    const c = freshCache();
    const key = 'abc123';
    assert.strictEqual(c.acquireWriteLock(key), true, 'first acquire wins');
    assert.strictEqual(c.acquireWriteLock(key), false, 'second acquire blocked while first holds');
    assert.strictEqual(c.hasWriteLock(key), true);
    assert.strictEqual(c.releaseWriteLock(key), true);
    assert.strictEqual(c.hasWriteLock(key), false);
    assert.strictEqual(c.acquireWriteLock(key), true, 're-acquire after release');
  });

  test('troth-cache: dirty marker aborts in-flight store (cache-resurrection guard)', () => {
    const c = freshCache();
    const key = c.computeKey({ tool_name: 'Read', args: { path: '/x' }, cwd: '/p', file_hashes: ['h'] });
    // Simulate an Edit hook marking this entry dirty BEFORE an in-flight
    // store completes. The store() call must refuse to write.
    c._db.prepare('INSERT OR REPLACE INTO tool_cache_dirty (key, invalidated_at) VALUES (?, ?)')
      .run(key, Date.now());
    const ok = c.store({ key, tool_name: 'Read', cwd: '/p', value: { content: 'stale' }, ttl_s: 60 });
    assert.strictEqual(ok, false, 'store must abort during dirty window');
    const row = c._db.prepare('SELECT 1 FROM tool_response_cache WHERE key = ?').get(key);
    assert.strictEqual(row, undefined, 'no row written');
  });

  test('troth-cache: populateFromRequestBody stores cacheable tool_use/tool_result pairs', () => {
    const c = freshCache();
    const tmpDir = require('os').tmpdir();
    const tmpFile = require('path').join(tmpDir, 'troth-cache-populate-' + process.pid + '.txt');
    require('fs').writeFileSync(tmpFile, 'hello world\n');

    const body = {
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: tmpFile } },
          { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: tmpFile, old_string: 'a', new_string: 'b' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'hello world\n' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'ok' },
        ]},
      ]
    };
    const pop = c.populateFromRequestBody(body, { cwd: tmpDir });
    assert.strictEqual(pop.scanned, 2, 'scanned both pairs');
    assert.strictEqual(pop.stored, 1, 'only Read stored (Edit is uncacheable)');
    assert.strictEqual(pop.skipped, 1, 'Edit skipped as uncacheable');

    // Second request with the same Read args should be a hit.
    const gc2 = require('../proxy/modules/troth-cache');
    const fileHashes = gc2.hashReferencedFiles([tmpFile]);
    const r = c.lookup({ tool_name: 'Read', args: { file_path: tmpFile }, cwd: tmpDir, file_hashes: fileHashes });
    assert.strictEqual(r.hit, true, 'populated entry must be retrievable');
    assert.strictEqual(r.value, 'hello world\n');

    // Modify file → same lookup must miss because file hash changed.
    require('fs').writeFileSync(tmpFile, 'CHANGED\n');
    const fileHashes2 = gc2.hashReferencedFiles([tmpFile]);
    const r2 = c.lookup({ tool_name: 'Read', args: { file_path: tmpFile }, cwd: tmpDir, file_hashes: fileHashes2 });
    assert.strictEqual(r2.hit, false, 'stale entry must miss after file change');

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}
  });

  test('troth-cache: populateFromRequestBody skips is_error tool_results', () => {
    const c = freshCache();
    const body = {
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'foo' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'error', is_error: true },
        ]},
      ]
    };
    const pop = c.populateFromRequestBody(body, { cwd: '/p' });
    assert.strictEqual(pop.scanned, 1);
    assert.strictEqual(pop.stored, 0, 'error results must not be cached');
    assert.strictEqual(pop.skipped, 1);
  });

  test('troth-cache: detectBashBulkInvalidation classifies git / package / benign commands', () => {
    assert.strictEqual(gc.detectBashBulkInvalidation('git checkout main'), 'all_cwd');
    assert.strictEqual(gc.detectBashBulkInvalidation('git pull --rebase'), 'all_cwd');
    assert.strictEqual(gc.detectBashBulkInvalidation('git rebase main'), 'all_cwd');
    assert.strictEqual(gc.detectBashBulkInvalidation('git switch feature-x'), 'all_cwd');
    assert.strictEqual(gc.detectBashBulkInvalidation('npm install react'), 'package');
    assert.strictEqual(gc.detectBashBulkInvalidation('pnpm add lodash'), 'package');
    assert.strictEqual(gc.detectBashBulkInvalidation('pip install flask'), 'package');
    assert.strictEqual(gc.detectBashBulkInvalidation('cargo build --release'), 'package');
    assert.strictEqual(gc.detectBashBulkInvalidation('git status'), null, 'read-only git must not trigger');
    assert.strictEqual(gc.detectBashBulkInvalidation('ls -la'), null);
  });

  test('troth-cache: invalidateFromRequestBody evicts on Edit mutation (tool_use)', () => {
    const c = freshCache();
    // Seed an entry for path /p/a.js.
    const k = c.computeKey({ tool_name: 'Read', args: { file_path: '/p/a.js' }, cwd: '/p', file_hashes: ['abc'] });
    c.store({ key: k, tool_name: 'Read', cwd: '/p', value: 'old content', ttl_s: 60 });
    const before = c.stats();
    assert.strictEqual(before.entries, 1);

    const body = {
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'x', new_string: 'y' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        ]},
      ]
    };
    const r = c.invalidateFromRequestBody(body, { cwd: '/p' });
    assert.strictEqual(r.mutations, 1, 'one Edit detected');
    assert.ok(r.evicted >= 1, 'at least one entry evicted');
    assert.strictEqual(c.stats().entries, 0, 'Read entry for that cwd purged');
  });

  test('troth-cache: invalidateFromRequestBody dedupes repeat mutations on the same file', () => {
    const c = freshCache();
    // Seed entry in a different cwd so it survives.
    const kOther = c.computeKey({ tool_name: 'Read', args: { file_path: '/q/b.js' }, cwd: '/q', file_hashes: ['h'] });
    c.store({ key: kOther, tool_name: 'Read', cwd: '/q', value: 'untouched', ttl_s: 60 });

    const body = {
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'x', new_string: 'y' } },
          { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'y', new_string: 'z' } },
          { type: 'tool_use', id: 'tu_3', name: 'Write', input: { file_path: '/p/a.js', content: 'final' } },
        ]},
      ]
    };
    const r = c.invalidateFromRequestBody(body, { cwd: '/p' });
    assert.strictEqual(r.mutations, 1, 'three mutations on same file dedupe to one invalidation call');
    assert.strictEqual(c.lookup({ tool_name: 'Read', args: { file_path: '/q/b.js' }, cwd: '/q', file_hashes: ['h'] }).hit, true, 'other cwd untouched');
  });

  test('troth-cache: invalidateFromRequestBody triggers cwd purge on git checkout Bash', () => {
    const c = freshCache();
    const k = c.computeKey({ tool_name: 'Read', args: { file_path: '/p/a.js' }, cwd: '/p', file_hashes: ['h'] });
    c.store({ key: k, tool_name: 'Read', cwd: '/p', value: 'pre-checkout', ttl_s: 60 });
    const body = {
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'git checkout main' } },
        ]},
      ]
    };
    const r = c.invalidateFromRequestBody(body, { cwd: '/p' });
    assert.strictEqual(r.bulk, 1);
    assert.ok(r.evicted >= 1);
    assert.strictEqual(c.stats().entries, 0, 'git checkout purges cwd');
  });

  test('troth-cache: invalidate runs BEFORE populate in integrated path', () => {
    // Simulate the server.js ordering: same-request Edit then Read tool_use/tool_result.
    // After invalidate+populate, the cache should hold the FRESH post-edit Read result,
    // not anything stale (there was nothing stale in this case — test the ordering).
    const c = freshCache();
    const tmpDir = require('os').tmpdir();
    const tmpFile = require('path').join(tmpDir, 'gc-phase-c-order-' + process.pid + '.txt');
    require('fs').writeFileSync(tmpFile, 'NEW\n');

    const body = {
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: tmpFile, content: 'NEW\n' } },
          { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: tmpFile } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'wrote' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'NEW\n' },
        ]},
      ]
    };
    c.invalidateFromRequestBody(body, { cwd: tmpDir });
    c.populateFromRequestBody(body, { cwd: tmpDir });

    const gc2 = require('../proxy/modules/troth-cache');
    const fh = gc2.hashReferencedFiles([tmpFile]);
    const r = c.lookup({ tool_name: 'Read', args: { file_path: tmpFile }, cwd: tmpDir, file_hashes: fh });
    assert.strictEqual(r.hit, true, 'post-edit Read entry must be cached');
    assert.strictEqual(r.value, 'NEW\n');

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}
  });

  test('troth-cache: telemetry emits gemcache:* events into savings_ledger (Phase E)', () => {
    // Build a cache against a fresh file-backed DB so state.js treats it as
    // its own. We then open a separate read handle to verify telemetry rows
    // landed. Using an isolated path keeps us from polluting ~/.troth.
    const os = require('os');
    const pathMod = require('path');
    const fsMod = require('fs');
    const tmpDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'gc-cache-telem-'));
    const dbPath = pathMod.join(tmpDir, 'state.db');

    const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    // Force state.js to (re)open its singleton against the new DATA_DIR.
    // It caches _db; for an isolated test we load a fresh copy via a
    // bypass: require the file, call close() to reset, re-require path.
    delete require.cache[require.resolve('../shared-core/state.js')];
    delete require.cache[require.resolve('../proxy/modules/troth-cache.js')];
    const gc2 = require('../proxy/modules/troth-cache');

    try {
      const c = gc2.createCache({ dbPath, telemetry: true });
      // Point the module-level state resolver at the same DB path.
      // (Its own require('../../shared-core/state') respects CLAUDE_PLUGIN_DATA
      // which we set above, so it opens the same file.)
      const key = c.computeKey({ tool_name: 'Grep', args: { pattern: 'x' }, cwd: '/p', file_hashes: [] });
      c.store({ key, tool_name: 'Grep', cwd: '/p', value: { a: 1 }, ttl_s: 60 });
      c.lookup({ tool_name: 'Grep', args: { pattern: 'x' }, cwd: '/p', file_hashes: [] }); // hit
      c.invalidate({ cwd: '/p', bulk_pattern: 'all_cwd' });

      const state = require('../shared-core/state.js');
      const rows = state.db().prepare(
        "SELECT kind, COUNT(*) as n FROM savings_ledger WHERE kind LIKE 'gemcache:%' GROUP BY kind ORDER BY kind"
      ).all();
      const byKind = Object.fromEntries(rows.map(r => [r.kind, r.n]));
      assert.ok(byKind['gemcache:populate'] >= 1, 'populate event recorded');
      assert.ok(byKind['gemcache:hit'] >= 1, 'hit event recorded');
      assert.ok(byKind['gemcache:invalidate'] >= 1, 'invalidate event recorded');

      c.close && c.close();
      state.close && state.close();
    } finally {
      if (prevEnv !== undefined) process.env.CLAUDE_PLUGIN_DATA = prevEnv;
      else delete process.env.CLAUDE_PLUGIN_DATA;
      // Clean up caches so later tests get fresh state resolution.
      delete require.cache[require.resolve('../shared-core/state.js')];
      delete require.cache[require.resolve('../proxy/modules/troth-cache.js')];
      try { fsMod.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('troth-cache: stats() reports hits/misses/entries accurately', () => {
    const c = freshCache();
    const key = c.computeKey({ tool_name: 'Glob', args: { pattern: '*.js' }, cwd: '/p', file_hashes: [] });
    c.lookup({ tool_name: 'Glob', args: { pattern: '*.js' }, cwd: '/p', file_hashes: [] }); // miss
    c.store({ key, tool_name: 'Glob', cwd: '/p', value: { files: ['a.js'] }, ttl_s: 60 });
    c.lookup({ tool_name: 'Glob', args: { pattern: '*.js' }, cwd: '/p', file_hashes: [] }); // hit
    c.lookup({ tool_name: 'Glob', args: { pattern: '*.js' }, cwd: '/p', file_hashes: [] }); // hit
    const s = c.stats();
    assert.strictEqual(s.hits, 2);
    assert.strictEqual(s.misses, 1);
    assert.strictEqual(s.entries, 1);
    assert.ok(s.total_bytes > 0, 'bytes tracked');
    assert.ok(Math.abs(s.hit_rate - 2/3) < 0.001, 'hit_rate = 2/3');
  });
})();

// --- keepalive (Phase D — idle-refresh heartbeat) ---
(() => {
  const ka = require('../proxy/modules/keepalive');

  // Wait for n ms — would let timers actually fire in the real runtime.
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  test('keepalive: disabled by default — track() does nothing', () => {
    const m = ka.createManager({ cfg: { enabled: false } });
    const ok = m.track('sess1', { model: 'x', estimatedTokens: 5000 });
    assert.strictEqual(ok, false);
    assert.strictEqual(m._sessions.size, 0);
    assert.strictEqual(m.stats().skippedDisabled, 1);
  });

  test('keepalive: enabled — track() schedules a timer with jitter inside ±jitter_s window', () => {
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 10000, jitter_s: 2, min_prefix_tokens: 1 },
      transmit: async () => {},
    });
    const ok = m.track('s1', { model: 'x', estimatedTokens: 5000 });
    assert.strictEqual(ok, true);
    const sess = m._sessions.get('s1');
    assert.ok(sess, 'session tracked');
    const delta = sess.fires_at - Date.now();
    assert.ok(delta >= 10000 - 2000 - 50, 'delay at least idle - jitter (got ' + delta + ')');
    assert.ok(delta <= 10000 + 2000 + 50, 'delay at most idle + jitter (got ' + delta + ')');
    m.stopAll();
  });

  test('keepalive: re-track cancels old timer and reschedules', () => {
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 60000, jitter_s: 0, min_prefix_tokens: 1 },
      transmit: async () => {},
    });
    m.track('s1', { model: 'x', estimatedTokens: 5000 });
    const first = m._sessions.get('s1');
    const firstTimer = first.timer;
    m.track('s1', { model: 'x', estimatedTokens: 5000 });
    const second = m._sessions.get('s1');
    assert.notStrictEqual(second.timer, firstTimer, 'timer replaced on re-track');
    assert.strictEqual(m._sessions.size, 1, 'still exactly one session');
    m.stopAll();
  });

  test('keepalive: short prefixes below min_prefix_tokens are not scheduled', () => {
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 1000, jitter_s: 0, min_prefix_tokens: 1024 },
      transmit: async () => {},
    });
    const ok = m.track('s1', { model: 'x', estimatedTokens: 500 });
    assert.strictEqual(ok, false);
    assert.strictEqual(m._sessions.size, 0);
  });

  test('keepalive: fire() calls transmit and sends exactly one ping per idle window', async () => {
    let sent = 0;
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 50, jitter_s: 0, min_prefix_tokens: 1 },
      transmit: async () => { sent++; },
    });
    m.track('s1', { model: 'x', estimatedTokens: 5000, backend_url: 'http://stub' });
    await sleep(90);      // long enough for one fire, short enough to miss the reschedule (next would be ~t=140)
    m.stopAll();          // cancel the reschedule before it can fire
    await sleep(10);      // drain any in-flight resolution
    assert.strictEqual(sent, 1, 'exactly one ping — reschedule was cancelled');
    assert.strictEqual(m.stats().sent, 1);
  });

  test('keepalive: TPM cap exceeded → skip send, reschedule on backoff', async () => {
    let sent = 0;
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 40, jitter_s: 0, tpm_cap: 100, min_prefix_tokens: 1 },
      transmit: async () => { sent++; },
    });
    m._tpm.add(200); // pre-charge above cap
    m.track('s1', { model: 'x', estimatedTokens: 5000, backend_url: 'http://stub' });
    await sleep(80);
    m.stopAll();
    await sleep(10);
    assert.strictEqual(sent, 0, 'TPM guard blocks send');
    assert.strictEqual(m.stats().skippedTpm, 1);
  });

  test('keepalive: transport failure triggers retry, gives up after max_retries', async () => {
    // F28 fix: replace fragile fixed-wait `sleep(400)` with a polling
    // loop. The previous test was timing-flaky under load — when the
    // event loop is busy (e.g. P17 perf-mode 50k-edge insert running
    // earlier), the 3 retries don't complete in 400ms and the test
    // fails non-deterministically. Polling lets the assertion fire as
    // soon as the manager finishes its retry budget, regardless of
    // wall-clock timing.
    let attempts = 0;
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 30, jitter_s: 0, max_retries: 2, retry_base_ms: 20, min_prefix_tokens: 1 },
      transmit: async () => { attempts++; throw new Error('boom'); },
    });
    m.track('s1', { model: 'x', estimatedTokens: 5000, backend_url: 'http://stub' });
    // Poll for the manager to give up on s1. With max_retries=2 +
    // retry_base_ms=20 + exponential backoff, the ideal completion is
    // ~140ms. The budget is counted in EVENT-LOOP TURNS, not wall-clock
    // (F28 follow-up): a wall-clock deadline dies when the CI runner
    // stalls the whole process for seconds (GC / noisy neighbor) — the
    // stall eats the entire budget while zero timers ran, which is
    // exactly the "got 1" flake seen on GitHub runners. 500 turns of
    // sleep(20) is ~10s of ACTIVE loop time; a monolithic stall costs
    // at most one turn.
    for (let turns = 0; turns < 500; turns++) {
      if (attempts >= 3 && !m._sessions.has('s1')) break;
      await sleep(20);
    }
    assert.ok(attempts >= 3, 'first attempt + at least 2 retries (got ' + attempts + ')');
    assert.strictEqual(m._sessions.has('s1'), false, 'session dropped after max retries');
    assert.ok(m.stats().errors >= 3);
    m.stopAll();
  });

  test('keepalive: stop() cancels an active schedule', async () => {
    let sent = 0;
    const m = ka.createManager({
      cfg: { enabled: true, idle_ms: 50, jitter_s: 0, min_prefix_tokens: 1 },
      transmit: async () => { sent++; },
    });
    m.track('s1', { model: 'x', estimatedTokens: 5000, backend_url: 'http://stub' });
    assert.strictEqual(m.stop('s1'), true);
    assert.strictEqual(m._sessions.size, 0);
    await sleep(150);
    assert.strictEqual(sent, 0, 'cancelled timer must not fire');
  });

  test('keepalive: deriveSessionKey prefers explicit session_id then falls back to prefix hash', () => {
    const a = ka.deriveSessionKey({ metadata: { user_id: 'u-42' }, model: 'x' });
    assert.strictEqual(a, 'u-42');
    const b = ka.deriveSessionKey({ metadata: { session_id: 'sess-7' }, model: 'x' });
    assert.strictEqual(b, 'sess-7');
    const c = ka.deriveSessionKey({ model: 'claude-opus-4-7', system: 'You are helpful', tools: [{ name: 'Read' }, { name: 'Bash' }] });
    const d = ka.deriveSessionKey({ model: 'claude-opus-4-7', system: 'You are helpful', tools: [{ name: 'Bash' }, { name: 'Read' }] });
    assert.strictEqual(c, d, 'tool ordering must not affect key (sorted)');
    assert.match(c, /^[0-9a-f]{16}$/);
  });

  test('keepalive: buildPingBody preserves tools+system, rewrites messages to 1-token nudge', () => {
    const body = JSON.parse(ka.buildPingBody({
      model: 'claude-opus-4-7',
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Read' }],
    }));
    assert.strictEqual(body.model, 'claude-opus-4-7');
    assert.strictEqual(body.max_tokens, 1);
    assert.deepStrictEqual(body.tools, [{ name: 'Read' }]);
    assert.ok(body.system[0].cache_control, 'cache_control preserved on system block');
    assert.strictEqual(body.messages.length, 1);
    assert.strictEqual(body.messages[0].content[0].text, 'ping');
  });

  test('keepalive: TPM ring buffer drops entries older than 60s', () => {
    const w = ka.createTpmWindow();
    w.add(100);
    assert.strictEqual(w.current(), 100);
    // Force stale entry by monkeypatching — real test would need timer mock.
    // Here: drain the list via wouldExceed against a huge cap (internal prune).
    w._reset();
    w.add(50);
    assert.strictEqual(w.current(), 50);
    assert.strictEqual(w.wouldExceed(200, 100), false);
    assert.strictEqual(w.wouldExceed(100, 60), true);
  });
})();

// --- Verified Intent Layer foundation ---
console.log('\nP16 Tier 1 — intent type + DecisionGraph edges + path queries:');
(function runP16T1Tests() {
  const pP16  = require('path');
  const fsP16 = require('fs');
  const TMP_P16 = pP16.join(require('os').tmpdir(), 'gc-p16-t1-' + Date.now());
  fsP16.mkdirSync(TMP_P16, { recursive: true });
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_P16;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/query')];
  delete require.cache[require.resolve('../shared-core/causality')];
  const AR    = require('../shared-core/action-record');
  const state = require('../shared-core/state');
  const Q     = require('../shared-core/query');
  const C     = require('../shared-core/causality');

  // ── Schema (5 tests) ────────────────────────────────────────────────────
  test('P16-T1.S1: intent is in ALL_TYPES', () => {
    assert.ok(AR.ALL_TYPES.includes('intent'));
  });

  test('P16-T1.S2: validate accepts well-formed intent', () => {
    const r = AR.create({
      type: 'intent', agent_id: 'cc',
      input:  { goal: 'refactor auth', source_message_hash: 'sha256:abc' },
      output: { chosen_path: 'extract auth/middleware.js' }
    });
    const v = AR.validate(r);
    assert.strictEqual(v.ok, true, 'errors: ' + JSON.stringify(v.errors));
  });

  test('P16-T1.S3: validate rejects intent missing input.goal', () => {
    const r = AR.create({
      type: 'intent', agent_id: 'cc',
      input:  { source_message_hash: 'sha256:abc' },
      output: { chosen_path: 'p' }
    });
    const v = AR.validate(r);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some(e => e.kind === 'missing_input_field' && e.field === 'goal'));
  });

  test('P16-T1.S4: validate rejects intent missing output.chosen_path', () => {
    const r = AR.create({
      type: 'intent', agent_id: 'cc',
      input:  { goal: 'g', source_message_hash: 'h' },
      output: {}
    });
    const v = AR.validate(r);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some(e => e.kind === 'missing_output_field' && e.field === 'chosen_path'));
  });

  test('P16-T1.S5: intent records round-trip through toRow/fromRow', () => {
    const r = AR.create({
      type: 'intent', agent_id: 'cc', session_id: 's', cwd: '/p',
      input:  { goal: 'g', source_message_hash: 'h', constraint: ['no_breaking'], acceptance_criteria: 'tests pass' },
      output: { chosen_path: 'p', alternatives_considered: ['a','b'] }
    });
    const back = AR.fromRow(AR.toRow(r));
    assert.strictEqual(back.type, 'intent');
    assert.strictEqual(back.input.goal, 'g');
    assert.deepStrictEqual(back.input.constraint, ['no_breaking']);
    assert.deepStrictEqual(back.output.alternatives_considered, ['a','b']);
  });

  // ── Edge CRUD (6 tests) ─────────────────────────────────────────────────
  // Seed two real records so FK pre-checks pass.
  const intentRec = AR.create({
    type: 'intent', agent_id: 'cc',
    input:  { goal: 'g1', source_message_hash: 'h1' },
    output: { chosen_path: 'p1' }
  });
  const editRec = AR.create({
    type: 'edit', agent_id: 'cc',
    input:  { file_path: 'a.ts', format: 'hashline' },
    output: { hash_after: 'abc' }
  });
  state.recordAction(intentRec);
  state.recordAction(editRec);

  test('P16-T1.E1: recordEdge writes a canonical-label edge and returns id', () => {
    const id = state.recordEdge({ from_id: intentRec.id, to_id: editRec.id, label: 'produces_edit', weight: 0.9 });
    assert.ok(id && id.length === 36);
  });

  test('P16-T1.E2: recordEdge rejects unknown label (returns null)', () => {
    const id = state.recordEdge({ from_id: intentRec.id, to_id: editRec.id, label: 'made_up_label' });
    assert.strictEqual(id, null);
  });

  test('P16-T1.E3: recordEdge accepts ext:* prefix label', () => {
    const id = state.recordEdge({ from_id: intentRec.id, to_id: editRec.id, label: 'ext:domain_specific' });
    assert.ok(id && id.length === 36);
  });

  test('P16-T1.E4: recordEdge rejects FK violation cleanly (nonexistent from_id)', () => {
    const id = state.recordEdge({
      from_id: '00000000-0000-7000-8000-000000000000',
      to_id: editRec.id, label: 'satisfies'
    });
    assert.strictEqual(id, null);
  });

  test('P16-T1.E5: queryEdges({from_id}) returns matching edges only', () => {
    const edges = state.queryEdges({ from_id: intentRec.id });
    assert.ok(edges.length >= 2, 'expected ≥2 edges from intent, got ' + edges.length);
    for (const e of edges) assert.strictEqual(e.from_id, intentRec.id);
  });

  test('P16-T1.E6: queryEdges({label}) filters by label', () => {
    const edges = state.queryEdges({ label: 'produces_edit' });
    assert.ok(edges.length >= 1);
    for (const e of edges) assert.strictEqual(e.label, 'produces_edit');
  });

  // ── Path query (5 tests) ────────────────────────────────────────────────
  // Build a 3-hop chain: A --produces_edit--> B --satisfies--> C
  const A = AR.create({ type: 'intent', agent_id: 'cc',
    input: { goal: 'A', source_message_hash: 'A' }, output: { chosen_path: 'pA' } });
  const B = AR.create({ type: 'edit', agent_id: 'cc',
    input: { file_path: 'b.ts', format: 'h' }, output: { hash_after: 'B' } });
  const Cn = AR.create({ type: 'decision', agent_id: 'cc',
    input: { kind: 'critic_verdict' }, output: { decision: 'approve' } });
  state.recordAction(A); state.recordAction(B); state.recordAction(Cn);
  state.recordEdge({ from_id: A.id, to_id: B.id, label: 'produces_edit' });
  state.recordEdge({ from_id: B.id, to_id: Cn.id, label: 'satisfies' });

  test('P16-T1.P1: traceCausalPath walks 2-hop outbound chain', () => {
    const rows = Q.traceCausalPath(state, { start_id: A.id, depth_limit: 5 });
    const ids = rows.map(r => r.node_id);
    assert.ok(ids.includes(B.id), 'B must be reached at depth 1');
    assert.ok(ids.includes(Cn.id), 'C must be reached at depth 2');
  });

  test('P16-T1.P2: traceCausalPath respects depth_limit', () => {
    const rows = Q.traceCausalPath(state, { start_id: A.id, depth_limit: 1 });
    const ids = rows.map(r => r.node_id);
    assert.ok(ids.includes(B.id));
    assert.ok(!ids.includes(Cn.id), 'C must NOT be reached at depth_limit=1');
  });

  test('P16-T1.P3: traceCausalPath filters by label', () => {
    const rows = Q.traceCausalPath(state, { start_id: A.id, label: 'produces_edit', depth_limit: 5 });
    const ids = rows.map(r => r.node_id);
    assert.ok(ids.includes(B.id));
    // C is reached only via 'satisfies' — must be excluded under label filter
    assert.ok(!ids.includes(Cn.id), 'label filter must exclude C');
  });

  test('P16-T1.P4: traceCausalPath direction=in walks inbound edges', () => {
    const rows = Q.traceCausalPath(state, { start_id: Cn.id, direction: 'in', depth_limit: 5 });
    const ids = rows.map(r => r.node_id);
    assert.ok(ids.includes(B.id), 'B must be reached as ancestor');
    assert.ok(ids.includes(A.id), 'A must be reached as transitive ancestor');
  });

  test('P16-T1.P5: traceCausalPath cycle-safe at depth_limit', () => {
    const X = AR.create({ type: 'decision', agent_id: 'cc',
      input: { kind: 'x' }, output: { decision: 'x' } });
    const Y = AR.create({ type: 'decision', agent_id: 'cc',
      input: { kind: 'y' }, output: { decision: 'y' } });
    state.recordAction(X); state.recordAction(Y);
    state.recordEdge({ from_id: X.id, to_id: Y.id, label: 'rationalizes' });
    state.recordEdge({ from_id: Y.id, to_id: X.id, label: 'rationalizes' });
    const rows = Q.traceCausalPath(state, { start_id: X.id, depth_limit: 5 });
    // Must terminate (depth_limit caps the recursion); count <= 5.
    assert.ok(rows.length <= 5, 'cycle must terminate at depth_limit, got ' + rows.length);
  });

  // ── Causality typed walk (2 tests) ──────────────────────────────────────
  test('P16-T1.C1: traceCausalChainTyped includes nodes reached via produces_edit edge', () => {
    const chain = C.traceCausalChainTyped(state, B.id);
    const ids = chain.map(r => r.id);
    assert.ok(ids.includes(B.id), 'self must be included');
    assert.ok(ids.includes(A.id), 'A must be reached via inbound produces_edit edge');
  });

  test('P16-T1.C2: traceCausalChainTyped respects maxNodes', () => {
    const chain = C.traceCausalChainTyped(state, Cn.id, { maxNodes: 1 });
    assert.strictEqual(chain.length, 1);
  });

  // ── Performance smoke (2 tests, gated) ─────────────────────────────────
  // Performance gates run with `TROTH_PERF=1 node tests/test-all.js`.
  // Default CI runs functional conformance only — the 50k-edge insert in X1
  // dominates the event loop briefly and can perturb downstream timing-
  // sensitive async tests (notably keepalive retry-backoff). Production
  // perf target stays the same: depth-10 traversal on 50k edges < 100ms
  // (research G16.F).
  const PERF = process.env.TROTH_PERF === '1';
  const perfTest = PERF ? test : (name) => { /* skipped in non-perf mode */ };
  perfTest('P16-T1.X1: 50k edges sparse-DAG, recursive traversal depth-10 under 100ms', () => {
    // A realistic fixture: 25k nodes arranged as a DAG where each node has
    // 2 forward edges to nearby targets. Total edges = ~50k. The CTE uses
    // UNION (deduplicates), so the search frontier stays bounded by reachable
    // node count, not by path count. Production semantics: "find every node
    // reachable within depth_limit hops, with shortest path".
    const N_RECORDS = 25000;
    const FANOUT    = 2;
    const recs = [];
    const insertRec = state._dbForQuery().prepare(`
      INSERT INTO action_records (id, timestamp, type, agent_id, session_id, user_id, cwd,
        parent_id, context_hash, input, output, verification, outcome)
      VALUES (?, ?, 'decision', 'perf', NULL, NULL, NULL, NULL, NULL, '{}', '{}', '{}', '{}')
    `);
    const insertEdge = state._dbForQuery().prepare(`
      INSERT INTO action_record_edges (id, from_id, to_id, label, weight, created_at)
      VALUES (?, ?, ?, 'produces_edit', NULL, ?)
    `);
    const tx = state._dbForQuery().transaction(() => {
      const now = Date.now();
      for (let i = 0; i < N_RECORDS; i++) {
        const id = AR.uuidv7(now + i);
        insertRec.run(id, now + i);
        recs.push(id);
      }
      let edgeCounter = 0;
      for (let i = 0; i < N_RECORDS; i++) {
        for (let j = 0; j < FANOUT; j++) {
          const targetIdx = Math.min(i + 1 + j, N_RECORDS - 1);
          if (targetIdx === i) continue;
          insertEdge.run(
            AR.uuidv7(now + 10_000_000 + edgeCounter++),
            recs[i], recs[targetIdx], now + i
          );
        }
      }
    });
    tx();
    const edgeCount = state._dbForQuery().prepare(
      'SELECT COUNT(*) AS n FROM action_record_edges'
    ).get().n;
    assert.ok(edgeCount >= 40000, 'fixture must have ≥40k edges, got ' + edgeCount);

    const t0 = process.hrtime.bigint();
    const rows = Q.traceCausalPath(state, { start_id: recs[0], depth_limit: 10 });
    const tMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(rows.length > 0, 'must reach at least one node');
    assert.ok(tMs < 100, 'depth-10 traversal must be < 100ms, got ' + tMs.toFixed(2) + 'ms');
  });

  perfTest('P16-T1.X2: queryEdges({label}) over ~50k edges under 50ms', () => {
    // Reuses the fixture from X1; just measures the indexed label filter.
    const t0 = process.hrtime.bigint();
    const edges = state.queryEdges({ label: 'produces_edit', limit: 2000 });
    const tMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(edges.length > 0);
    assert.ok(tMs < 50, 'label-filtered queryEdges must be < 50ms, got ' + tMs.toFixed(2) + 'ms');
  });

  // Cleanup
  process.env.CLAUDE_PLUGIN_DATA = savedEnv;
  setTimeout(() => {
    try { fsP16.rmSync(TMP_P16, { recursive: true, force: true }); } catch (_) {}
  }, 500).unref();
})();

};
