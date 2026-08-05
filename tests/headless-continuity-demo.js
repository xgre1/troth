#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Headless end-to-end demo of phases.
//
// Simulates an operator working across TWO projects (troth, crypto-app)
// to exercise every phase visibly. Output is human-readable so you can
// SEE the substrate doing the right thing at each step.
//
// Run:  node tests/headless-continuity-demo.js
// Suite-safe: writes to a tmp DATA_DIR so it doesn't pollute production
// state.db, restores env on exit.

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Isolate to a tmp dir so we don't pollute production
const TMP = path.join(os.tmpdir(), 'troth-headless-demo-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const SAVED_ENV = process.env.CLAUDE_PLUGIN_DATA;
process.env.CLAUDE_PLUGIN_DATA = TMP;
for (const k of Object.keys(require.cache)) {
  if (k.indexOf('/shared-core/') >= 0) delete require.cache[k];
}

// Fake-project directories — these stand in for real cwds the operator
// might be working in (e.g. a 'troth' codebase vs a 'crypto-app').
const TROTH_CWD = path.join(TMP, 'troth');
const CRYPTO_CWD  = path.join(TMP, 'crypto-app');
fs.mkdirSync(TROTH_CWD, { recursive: true });
fs.mkdirSync(CRYPTO_CWD, { recursive: true });

const engram   = require('../shared-core/engram.js');
const recall   = require('../shared-core/recall.js');
const state    = require('../shared-core/state.js');
const tools    = require('../shared-core/substrate-tools.js');
const runner   = require('../shared-core/tools/runner.js');
const pac      = require('../shared-core/tools/pre-action-context.js');
const ar       = require('../shared-core/action-record.js');
const projectIdMod = require('../shared-core/project-id.js');

function h(title) { console.log('\n━━━━━━ ' + title + ' ━━━━━━'); }
function s(name)  { console.log('\n• ' + name); }
function k(label, val) {
  const v = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  console.log('    ' + label + ': ' + v);
}
function pass(msg) { console.log('    \u2713 ' + msg); }
function fail(msg) { console.log('    \u2717 ' + msg); failures++; }

let failures = 0;
let scenarios = 0;

async function run() {
  projectIdMod._clearCache();
  k('project_id (troth cwd)', projectIdMod.resolveProjectId(TROTH_CWD));
  k('project_id (crypto cwd)',  projectIdMod.resolveProjectId(CRYPTO_CWD));

  // ── Phase A — topic isolation via project_id auto-derive ───
  h('Phase A — topic isolation via project_id');
  scenarios++;
  s('Operator works on troth, writes a project-specific decision');
  const gDec = engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'we chose substrate-as-entity over agent-framework',
    scope: 'decision:architecture',
    source_authority: 'operator_confirmed'
  });
  s('Operator switches to crypto-app, writes a different decision');
  const cDec = engram.recordEngram({
    agent_id: 'op', cwd: CRYPTO_CWD,
    statement: 'we use uniswap v4 hooks for the AMM',
    scope: 'decision:architecture',
    source_authority: 'operator_confirmed'
  });
  const gRec = state.getAction(gDec);
  const cRec = state.getAction(cDec);
  const gOut = JSON.parse(gRec.output);
  const cOut = JSON.parse(cRec.output);
  k('troth decision project_id', gOut.project_id);
  k('crypto decision project_id',  cOut.project_id);
  if (gOut.project_id !== cOut.project_id) pass('decisions stamped with distinct project_ids');
  else fail('project_id did not differentiate — got both ' + gOut.project_id);

  s('Filter decisions for troth cwd — should NOT see crypto decision');
  const trothPid = projectIdMod.resolveProjectId(TROTH_CWD);
  const allDecisions = engram.listEngrams({ audience: 'model_visible', limit: 100 })
    .filter(e => e.scope && e.scope.indexOf('decision:') === 0);
  const introth = allDecisions.filter(d => d.project_id === trothPid);
  k('decisions visible in troth context', introth.map(d => d.statement));
  if (introth.some(d => d.statement.indexOf('substrate-as-entity') >= 0)) pass('troth decision surfaces');
  if (!introth.some(d => d.statement.indexOf('uniswap') >= 0)) pass('crypto decision correctly filtered out');
  else fail('crypto decision leaked into troth context');

  // ── Phase B — identity drift resolution ───
  h('Phase B — identity drift resolution via update_identity');
  scenarios++;
  s('First operator statement: prefers verbose');
  const r1 = await tools.dispatchToolCall(
    { function: { name: 'update_identity', arguments: JSON.stringify({ statement: 'operator prefers verbose explanations in code reviews' }) } },
    { agent_id: 'op', cwd: TROTH_CWD }
  );
  k('write 1 result', JSON.parse(r1));

  s('Operator corrects: actually prefers terse');
  const r2 = await tools.dispatchToolCall(
    { function: { name: 'update_identity', arguments: JSON.stringify({ statement: 'operator prefers terse code reviews' }) } },
    { agent_id: 'op', cwd: TROTH_CWD }
  );
  const r2Data = JSON.parse(r2);
  k('write 2 result', r2Data);

  s('Default identity read — should show only the correction');
  const visible = engram.listEngrams({ scope: 'identity', agent_id: 'op', limit: 20 });
  const visibleStmts = visible.map(e => e.statement);
  k('visible identity', visibleStmts);
  if (visibleStmts.some(s => s.indexOf('terse') >= 0) && !visibleStmts.some(s => s.indexOf('verbose') >= 0)) {
    pass('correction surfaces, old verbose preference correctly retired');
  } else {
    fail('drift resolution failed — old fact still visible');
  }
  if (r2Data.superseded && r2Data.superseded.length) pass('update_identity reported supersede chain to caller');
  else fail('update_identity did not return supersede ids');

  // ── Phase C — emphasis salience on write ───
  h('Phase C — emphasis-based salience on write');
  scenarios++;
  s('Plain statement vs SCREAMED + intensified statement');
  const plainId = engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'we use prettier sometimes',
    scope: 'docs:test-emphasis'
  });
  const screamId = engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'ALWAYS RUN TESTS BEFORE MERGING — this is CRITICAL!!',
    scope: 'docs:test-emphasis'
  });
  const plainE = engram.listEngrams({ scope: 'docs:test-emphasis', limit: 10 }).find(e => e.id === plainId);
  const screamE = engram.listEngrams({ scope: 'docs:test-emphasis', limit: 10 }).find(e => e.id === screamId);
  k('plain salience',  plainE && plainE.salience);
  k('scream salience', screamE && screamE.salience);
  if (screamE.salience > plainE.salience) pass('emphasis boost active (scream outranks plain)');
  else fail('emphasis boost not applied');

  // ── Phase D — retrieval frequency feedback ───
  h('Phase D — retrieval frequency feedback (Bjork)');
  scenarios++;
  s('Write a fresh fixture, recall it 3×, check counter');
  const bjorkId = engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'bjork-headless-fixture-zztop-unique-' + Date.now(),
    scope: 'docs:test-bjork'
  });
  const countBefore = state.getRetrievalCount(bjorkId);
  for (let i = 0; i < 3; i++) {
    await recall.recall({ query: 'bjork-headless-fixture-zztop-unique', class: 'all', limit: 5 });
  }
  const countAfter = state.getRetrievalCount(bjorkId);
  k('retrieval count before/after', countBefore + ' → ' + countAfter);
  if (countAfter >= 3) pass('counter incremented per recall');
  else fail('counter did not bump');

  // ── Phase E — working memory consolidation ───
  h('Phase E — working memory consolidation (background-worker)');
  scenarios++;
  s('Seed two dialogue turns — one plain, one emphasized');
  const now = Date.now();
  function seedTurn(ts, text) {
    const rec = {
      id: ar.uuidv7(ts), timestamp: ts, type: 'tool_call',
      agent_id: 'headless-op', cwd: TROTH_CWD, user_id: 'default',
      input: { tool_name: 'dialogue.turn', args: { user_text: text } },
      output: { status: 'recorded', assistant_text: 'ack' }
    };
    state.recordAction(rec, ar.toSearchText(rec));
  }
  seedTurn(now - 200, 'we usually do postgres setup later');
  seedTurn(now - 100, 'STOP RUSHING. NEVER ship without tests. CRITICAL.');
  const bw = require('../shared-core/background-worker.js');
  const wmTask = bw.DEFAULT_TASKS.find(t => t.name === 'wm_consolidation');
  const wmResult = await wmTask.run({ substrate_ctx: { cwd: TROTH_CWD, agent_id: 'headless-op' } });
  k('wm_consolidation notes', wmResult.notes);
  const promoted = engram.listEngrams({ scope: 'consolidated:dialogue', agent_id: 'headless-op', limit: 10 });
  k('promoted engrams', promoted.map(e => ({ sal: e.salience.toFixed(2), s: e.statement.slice(0, 80) })));
  if (promoted.some(p => p.statement.toUpperCase().indexOf('CRITICAL') >= 0)) pass('emphasized turn auto-promoted');
  else fail('wm_consolidation missed the emphasized turn');
  if (!promoted.some(p => p.statement.indexOf('usually do postgres') >= 0)) pass('plain turn correctly skipped');
  else fail('plain turn promoted (should not have been)');

  // ── Phase F — project-aware identity ranking ───
  h('Phase F — project-aware identity ranking');
  scenarios++;
  s('Seed identity facts — one universal, one troth-specific, one crypto-specific');
  engram.recordEngram({ agent_id: 'op', cwd: null, statement: 'operator is alex', scope: 'identity', source_authority: 'operator_confirmed' });
  engram.recordEngram({ agent_id: 'op', cwd: TROTH_CWD, statement: 'we are building substrate-as-entity in troth', scope: 'identity', source_authority: 'operator_confirmed' });
  engram.recordEngram({ agent_id: 'op', cwd: CRYPTO_CWD, statement: 'we ship to base L2 not ethereum mainnet', scope: 'identity', source_authority: 'operator_confirmed' });

  const idHits = engram.listEngrams({ scope: 'identity', limit: 50 });
  const _AUTH_W = { operator_confirmed: 1.0, plr_evolved: 0.9, llm_inferred: 0.6, regex_extracted: 0.3 };
  function projectMatchFactor(e, currentPid) {
    const pid = e && e.project_id;
    if (!pid || pid === '__ephemeral__') return 1.0;
    if (pid === currentPid) return 1.0;
    return 0.5;
  }
  function rank(currentPid) {
    return idHits
      .filter(e => e.statement)
      .map(e => ({ e, score: (_AUTH_W[e.source_authority] || 0.3) * (e.salience || 1) * projectMatchFactor(e, currentPid) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(x => x.e.statement);
  }
  const inG = rank(projectIdMod.resolveProjectId(TROTH_CWD));
  const inC = rank(projectIdMod.resolveProjectId(CRYPTO_CWD));
  k('identity surfaced in troth context', inG);
  k('identity surfaced in crypto  context', inC);
  if (inG.some(s => s.indexOf('substrate-as-entity') >= 0) && inG.some(s => s.indexOf('alex') >= 0)) {
    pass('troth context shows troth-specific + universal identity');
  } else fail('troth context missing expected facts');
  if (inC.some(s => s.indexOf('base L2') >= 0) && inC.some(s => s.indexOf('alex') >= 0)) {
    pass('crypto context shows crypto-specific + universal identity');
  } else fail('crypto context missing expected facts');

  // ── Phase G — pre-action retrieval at tool dispatch ───
  h('Phase G — pre-action retrieval (substrate cues before tool runs)');
  scenarios++;
  s('Seed context about a fictional file');
  engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'we use Zod for schema validation in users.ts; switched from Joi 3 weeks ago',
    scope: 'decision:validation'
  });
  engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'always validate users.ts inputs before db write',
    scope: 'identity', source_authority: 'operator_confirmed'
  });
  s('Simulate the LLM reaching for Read(users.ts)');
  const priorCtx = pac.gatherPriorContext({
    tool_name: 'Read', args: { file_path: path.join(TROTH_CWD, 'users.ts') }, cwd: TROTH_CWD
  });
  k('substrate prepended this BEFORE the tool ran', priorCtx && priorCtx.summary);
  if (priorCtx && priorCtx.summary.indexOf('Zod') >= 0 && priorCtx.summary.indexOf('validate users.ts') >= 0) {
    pass('LLM gets prior decisions + identity facts inline with tool result');
  } else fail('pre-action context missing expected priors');
  s('Bash is correctly skipped (too noisy)');
  const bashCtx = pac.gatherPriorContext({ tool_name: 'Bash', args: { command: 'ls' }, cwd: TROTH_CWD });
  if (bashCtx === null) pass('Bash gets no pre-action context (substrate-native skip list works)');
  else fail('Bash should have been skipped');

  // ── Phase H — decision lineage traversal ───
  h('Phase H — decision lineage via causality graph');
  scenarios++;
  s('Seed a rationale → decision edge, then traverse');
  const rationale = engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'audit found agent-framework patterns drifting from substrate-as-entity',
    scope: 'research:audit'
  });
  const decision = engram.recordEngram({
    agent_id: 'op', cwd: TROTH_CWD,
    statement: 'reshape to substrate-native: revert file conventions',
    scope: 'decision:architecture-reshape'
  });
  state.recordEdge({ from_id: rationale, to_id: decision, label: 'rationalizes' });

  const causality = require('../shared-core/causality.js');
  const chain = causality.traceCausalChainTyped(state, decision, {
    maxNodes: 4, labels: ['refines_intent', 'rationalizes', 'supersedes']
  });
  k('chain length', chain.length);
  for (let i = 0; i < chain.length; i++) {
    const stmt = (chain[i].output && chain[i].output.statement) || '(no statement)';
    k('  [' + i + ']', String(stmt).slice(0, 80));
  }
  if (chain.length >= 2) pass('lineage traversal reaches the rationale');
  else fail('chain too shallow');

  // ── Phase I — in-flight reasoning preservation patterns ───
  h('Phase I — in-flight reasoning extraction patterns');
  scenarios++;
  s('Sample dialogue moments with open questions vs closed statements');
  const PATTERNS = [
    /\b(?:should|do|can|could|would|might) (?:we|i|you)\b[^.!?\n]{6,140}\?/gi,
    /\b(?:considering|evaluating|deciding between|weighing)\b[^.!?\n]{6,120}/gi,
    /\bopen question:?\s+[^.!?\n]{6,120}/gi,
    /\b(?:the question is|unclear if|not sure (?:if|whether))\b[^.!?\n]{6,120}/gi,
    /\bwhat (?:about|if)\b[^.!?\n]{6,120}\??/gi,
    /\b[a-z][a-z0-9_-]{2,30}\s+(?:vs|or)\s+[a-z][a-z0-9_-]{2,30}\b/gi
  ];
  const corpus = [
    ['Should we ship Phase F first or do everything together?', true],
    ['considering whether to extract this as a helper',         true],
    ['we just decided to ship Tauri',                            false],
    ['Zod vs Joi for validation',                                true],
    ['fix the bug please',                                       false]
  ];
  for (const [txt, expected] of corpus) {
    let any = false;
    for (const re of PATTERNS) if (re.test(txt)) { any = true; break; }
    if (any === expected) pass((expected ? 'caught' : 'skipped') + ': "' + txt.slice(0, 60) + '"');
    else fail((expected ? 'missed' : 'falsely caught') + ': "' + txt.slice(0, 60) + '"');
  }

  // ── Phase K — embedding cache storage round-trip ───
  h('Phase K — embedding cache storage');
  scenarios++;
  s('Write a Float32Array, read it back, check lossless');
  const sampleVec = [0.1, 0.2, -0.3, 0.4, -0.5];
  state.setEmbedding('headless-emb-' + Date.now(), sampleVec, { model: 'test' });
  const back = state.getEmbedding('headless-emb-' + Date.now());
  // Note: writing then immediately reading with same id-template, may not match.
  // Better: round-trip with a deterministic id.
  const id = 'headless-emb-fixed';
  state.setEmbedding(id, sampleVec, { model: 'test' });
  const back2 = state.getEmbedding(id);
  if (back2 && back2.length === sampleVec.length) pass('vector round-trip dim=' + back2.length);
  else fail('round-trip failed');
  const missing = state.listEngramsMissingEmbeddings(3);
  k('engrams missing embeddings (sample 3)', missing.length);

  // ── Combined scenario — parallel project conversations ───
  h('COMBINED — operator switches between troth and crypto convos');
  scenarios++;
  s('Operator is now in CRYPTO. What identity / decisions / focus would surface?');
  const cryptoPid = projectIdMod.resolveProjectId(CRYPTO_CWD);
  const cryptoIdentity = rank(cryptoPid);
  const cryptoDecisions = engram.listEngrams({ audience: 'model_visible', limit: 100 })
    .filter(e => e.scope && e.scope.indexOf('decision:') === 0)
    .filter(e => e.project_id === cryptoPid || !e.project_id);
  k('identity (crypto context)',  cryptoIdentity);
  k('decisions (crypto context)', cryptoDecisions.map(d => d.statement));
  const notrothLeak = !cryptoDecisions.some(d => d.statement.indexOf('substrate-as-entity') >= 0);
  if (notrothLeak) pass('NO cross-project leak: troth decisions do not surface in crypto convo');
  else fail('CROSS-PROJECT LEAK: troth decision visible in crypto context');

  s('Operator switches back to TROTH');
  const gemIdentity = rank(trothPid);
  const gemDecisions = engram.listEngrams({ audience: 'model_visible', limit: 100 })
    .filter(e => e.scope && e.scope.indexOf('decision:') === 0)
    .filter(e => e.project_id === trothPid || !e.project_id);
  k('identity (troth context)',  gemIdentity);
  k('decisions (troth context)', gemDecisions.map(d => d.statement));
  const universalSurvives = gemIdentity.some(s => s.indexOf('alex') >= 0) && cryptoIdentity.some(s => s.indexOf('alex') >= 0);
  if (universalSurvives) pass('person-level identity (operator is alex) survives across BOTH contexts');
  else fail('universal identity did not carry across projects');

  // ── Summary ───
  h('SUMMARY');
  k('scenarios exercised', scenarios);
  k('failures', failures);
  if (failures === 0) {
    console.log('\n  \u2713 ALL HEADLESS SCENARIOS PASS — substrate behaves as designed across both projects.\n');
  } else {
    console.log('\n  \u2717 ' + failures + ' SCENARIO(S) FAILED. See output above.\n');
    process.exitCode = 1;
  }
}

(async () => {
  try { await run(); }
  catch (e) {
    console.error('\nHEADLESS DEMO CRASHED:', e && e.stack || e);
    process.exitCode = 2;
  } finally {
    // Restore env
    if (SAVED_ENV === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = SAVED_ENV;
    // Best-effort cleanup
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
})();
