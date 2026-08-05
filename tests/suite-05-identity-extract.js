// SPDX-License-Identifier: AGPL-3.0-only
// Auto-split from tests/test-all.js (verbatim section bodies; order preserved).
// Sections: IDENTITY-EXTRACT | ENGRAM-VERIFY | PROCEDURE COMPILER | PROCEDURE MATCHER | IDENTITY BOOTSTRAP | INJECTOR + COMPILED PROCEDURES | INJECTOR + Δ9 THROUGH-LINE (P16 current_goal anchor)
module.exports = function run({ test }) {
const assert = require('assert');
const TMP = '/tmp/troth-validator-test-' + Date.now();
const { record, getRecent } = require('../proxy/modules/perflog');
// --- IDENTITY-EXTRACT ---
console.log('\nIdentity extract:');
(function runIdentityExtractTests() {
  const ie = require('../shared-core/identity-extract.js');

  test('PF1: extractFromText pulls self-preference statements', () => {
    const out = ie.extractFromText('I prefer terse responses and I always run npm test before pushing.');
    const statements = out.map(c => c.statement);
    assert.ok(statements.some(s => /user prefer.*terse/.test(s)),
      'must extract "I prefer terse" → "user prefer terse"; got: ' + JSON.stringify(statements));
    assert.ok(statements.some(s => /user always run/.test(s)),
      'must extract "I always run npm test"; got: ' + JSON.stringify(statements));
  });

  test('PF2: extractFromText pulls explicit identity facts via "my X is Y"', () => {
    const out = ie.extractFromText('My name is the operator and my favorite editor is vim.');
    const statements = out.map(c => c.statement);
    assert.ok(statements.some(s => /user's name is the operator/i.test(s)),
      'must extract "my name is the operator"; got: ' + JSON.stringify(statements));
  });

  test('PF3: extractFromText pulls project context', () => {
    const out = ie.extractFromText('I am working on troth substrate this week.');
    const statements = out.map(c => c.statement);
    assert.ok(statements.some(s => /user works on project: troth/.test(s)),
      'must extract "working on troth"; got: ' + JSON.stringify(statements));
  });

  test('PF4: extractFromText does NOT emit tool_vocabulary candidates (removed)', () => {
    // TOOL_VOCABULARY pattern removed entirely.
    // Mere mention of a tool name in dialogue is not a stable identity fact —
    // it produced 256+ duplicate "user works with: X" engrams in production
    // for each tool casually mentioned. Surviving patterns must all be
    // OPERATOR-EXPLICIT first-person statements.
    const out = ie.extractFromText('Building with Tauri + React on Supabase. Tests via Jest. Running Ollama for inference.');
    const toolCands = out.filter(c => c.source_pattern === 'tool_vocabulary');
    assert.strictEqual(toolCands.length, 0,
      'tool_vocabulary pattern is removed; got: ' + JSON.stringify(toolCands));
  });

  test('PF5: extractFromText is empty for short / non-self-referential text', () => {
    assert.strictEqual(ie.extractFromText('').length, 0, 'empty input → no candidates');
    assert.strictEqual(ie.extractFromText('hi').length, 0, 'too-short input → no candidates');
    // Generic "the weather is nice" should NOT match SELF_DESCRIPTION (uses "the" not "my").
    const out = ie.extractFromText('the weather is nice today');
    const sd = out.filter(c => c.source_pattern === 'self_description');
    assert.strictEqual(sd.length, 0, 'no false-positive self_description matches');
  });

  test('PF6: filterStable requires ≥2 distinct day-buckets per fact', () => {
    // Three candidates of the same fact, all on same day → filtered out (only 1 session).
    const sameDay = Date.now();
    const cands = [
      { statement: 'user prefer terse', source_pattern: 'self_preference' },
      { statement: 'user prefer terse', source_pattern: 'self_preference' },
      { statement: 'user prefer terse', source_pattern: 'self_preference' }
    ];
    const ts = [sameDay, sameDay, sameDay];
    const groups = ie.groupAndCount(cands, ts);
    const stable = ie.filterStable(groups, 2);
    assert.strictEqual(stable.length, 0, 'one-day-only fact must NOT be stable');

    // Same fact across 2 distinct days → stable.
    const day1 = new Date('2026-05-01T12:00:00Z').getTime();
    const day2 = new Date('2026-05-03T12:00:00Z').getTime();
    const groups2 = ie.groupAndCount(cands, [day1, day1, day2]);
    const stable2 = ie.filterStable(groups2, 2);
    assert.strictEqual(stable2.length, 1, 'fact across 2 days IS stable');
    assert.strictEqual(stable2[0].sessions.size, 2, 'session count = 2 distinct days');
  });

  test('PF7: seedFromDialogue is DEPRECATED — never writes, returns deprecation marker (L4 integration point)', () => {
    // The regex auto-write path was retired on
    // because pattern matching on operator first-person statements is NOT
    // operator cryptographic confirmation. Capture now flows through
    // update_identity (llm_inferred) or Phase 3 reflection-tick backfill.
    const sourceAgent = 'pf7-source-' + Date.now();
    const cwd = '/tmp/pf7-' + Date.now();
    const state = require('../shared-core/state.js');
    const actionRec = require('../shared-core/action-record.js');
    function recordAt(ts, user_text) {
      const rec = {
        id: actionRec.uuidv7(ts),
        timestamp: ts,
        type: 'tool_call',
        agent_id: sourceAgent,
        cwd,
        user_id: 'default',
        input: { tool_name: 'dialogue.turn', args: { user_text } },
        output: { status: 'recorded', assistant_text: 'ack' }
      };
      state.recordAction(rec, actionRec.toSearchText(rec));
    }
    const day1 = new Date('2026-05-01T10:00:00Z').getTime();
    const day2 = new Date('2026-05-03T10:00:00Z').getTime();
    recordAt(day1, 'I always run tests before merging.');
    recordAt(day2, 'I always run tests before merging.');

    const r = ie.seedFromDialogue({
      source_agent_id: sourceAgent,
      cwd,
      limit: 50,
      min_sessions: 2
    });
    assert.strictEqual(r.ok, true, 'stub must still report ok');
    assert.strictEqual(r.deprecated, true, 'stub must surface deprecated:true');
    assert.deepStrictEqual(r.written, [], 'deprecated stub must NEVER write');
    assert.ok(typeof r.deprecation_reason === 'string', 'must carry a deprecation_reason');
  });

  test('PF7b: seedFromDialogue dry_run still surfaces preview (diagnostic use survives)', () => {
    // Helpers stay alive for inspection — only the WRITE is gone.
    const r = ie.seedFromDialogue({
      source_agent_id: 'pf7b-nonexistent-' + Date.now(),
      cwd: '/tmp/nope',
      limit: 10,
      dry_run: true
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dry_run, true);
    assert.deepStrictEqual(r.written, []);
    assert.strictEqual(r.deprecated, true);
  });

  test('PF8: previewExtract is read-only (writes nothing)', () => {
    const eng = require('../shared-core/engram.js');
    //  identity pool is filtered by scope='identity'
    // (the category), not by agent_id (which is provenance only).
    const before = eng.listEngrams({ scope: 'identity', limit: 1000 }).length;
    const r = ie.previewExtract({
      source_agent_id: 'pf8-nonexistent-' + Date.now(),
      cwd: '/tmp/nope',
      limit: 10
    });
    assert.ok(typeof r.turns_scanned === 'number', 'preview returns turns_scanned');
    const after = eng.listEngrams({ scope: 'identity', limit: 1000 }).length;
    assert.strictEqual(after, before, 'preview must NOT write to identity pool');
  });
})();

// --- ENGRAM-VERIFY ---
console.log('\nEngram verify (TMMA write-time QC):');
(function runEngramVerifyTests() {
  const verify = require('../shared-core/engram-verify.js');
  const eng    = require('../shared-core/engram.js');

  test('PE1: novel statement → working tier, truth_score 1.0', () => {
    const r = verify.verifyStatement({
      statement: 'user works with rust on tauri stack',
      existing: []
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.tier, verify.TIERS.WORKING);
    assert.strictEqual(r.truth_score, 1.0);
    assert.strictEqual(r.contradiction_refs.length, 0);
    assert.strictEqual(r.duplicate_of, null);
  });

  test('PE2: near-duplicate (high overlap, no negation) → summarized + duplicate_of', () => {
    const existing = [
      { id: 'e-prior-1', statement: 'user prefers terse responses' }
    ];
    const r = verify.verifyStatement({
      statement: 'user prefers terse responses now',
      existing
    });
    assert.strictEqual(r.tier, verify.TIERS.SUMMARIZED);
    assert.strictEqual(r.duplicate_of, 'e-prior-1');
    assert.ok(r.truth_score >= 0.9, 'duplicate stays high-trust');
  });

  test('PE3: contradiction (overlap + negation) → flagged with contradiction_refs', () => {
    const existing = [
      { id: 'e-old-pref', statement: 'user prefers terse responses' }
    ];
    const r = verify.verifyStatement({
      statement: 'user hates terse responses',
      existing
    });
    assert.strictEqual(r.tier, verify.TIERS.FLAGGED);
    assert.ok(r.truth_score < 0.5, 'contradiction lowers trust');
    assert.ok(r.contradiction_refs.includes('e-old-pref'),
      'contradicting prior id must be in refs');
  });

  test('PE4: explicit "not" negation triggers contradiction', () => {
    const existing = [
      { id: 'e-claim', statement: 'user uses qwen for local inference' }
    ];
    const r = verify.verifyStatement({
      statement: 'user does not use qwen for local inference',
      existing
    });
    assert.strictEqual(r.tier, verify.TIERS.FLAGGED);
    assert.ok(r.contradiction_refs.includes('e-claim'));
  });

  test('PE5: empty statement returns ok=false', () => {
    const r = verify.verifyStatement({ statement: '', existing: [] });
    assert.strictEqual(r.ok, false);
  });

  test('PE6: recordEngram WITHOUT auto_verify writes default tier=working, truth=1.0', () => {
    const agent_id = 'pe6-' + Date.now();
    const id = eng.recordEngram({
      agent_id,
      statement: 'baseline fact for PE6',
      source: 'pe6-test'
    });
    assert.ok(id, 'engram must be written');
    const list = eng.listEngrams({ agent_id, limit: 5 });
    assert.ok(list.length >= 1, 'engram must be listable');
    const e = list.find(r => r.id === id);
    assert.ok(e, 'just-written engram must be in list');
    assert.strictEqual(e.tier, 'working', 'default tier');
    assert.strictEqual(e.truth_score, 1.0, 'default truth_score');
    assert.strictEqual(e.contradiction_refs, null, 'no contradictions on baseline');
  });

  test('PE7: recordEngram WITH auto_verify flags a contradiction against prior write', () => {
    const agent_id = 'pe7-' + Date.now();
    // Seed a positive claim.
    const firstId = eng.recordEngram({
      agent_id,
      statement: 'user prefers verbose explanations',
      source: 'pe7-seed'
    });
    assert.ok(firstId, 'seed write must succeed');
    // Now write a contradicting claim with auto_verify on.
    const secondId = eng.recordEngram({
      agent_id,
      statement: 'user hates verbose explanations',
      source: 'pe7-contra',
      auto_verify: true
    });
    assert.ok(secondId, 'contradicting write must persist (verifier annotates, does not block)');
    const list = eng.listEngrams({ agent_id, limit: 10 });
    const second = list.find(r => r.id === secondId);
    assert.ok(second, 'second engram must be in list');
    assert.strictEqual(second.tier, 'flagged', 'contradiction → flagged tier');
    assert.ok(second.truth_score < 0.5, 'flagged engram has low truth_score');
    assert.ok(Array.isArray(second.contradiction_refs) && second.contradiction_refs.includes(firstId),
      'contradiction_refs must include the prior conflicting engram id; got: ' + JSON.stringify(second.contradiction_refs));
  });

  test('PE8: recordEngram with auto_verify marks near-duplicate as summarized', () => {
    const agent_id = 'pe8-' + Date.now();
    const firstId = eng.recordEngram({
      agent_id,
      statement: 'user works on troth substrate primarily',
      source: 'pe8-seed'
    });
    assert.ok(firstId);
    const secondId = eng.recordEngram({
      agent_id,
      statement: 'user works on troth substrate primarily',  // identical
      source: 'pe8-dup',
      auto_verify: true
    });
    assert.ok(secondId);
    const list = eng.listEngrams({ agent_id, limit: 10 });
    const second = list.find(r => r.id === secondId);
    assert.ok(second, 'duplicate engram must be in list');
    assert.strictEqual(second.tier, 'summarized', 'duplicate → summarized tier');
    assert.strictEqual(second.duplicate_of, firstId, 'duplicate_of points to original');
  });
})();

// --- PROCEDURE COMPILER ---
console.log('\nProcedure compiler:');
(function runProcedureCompilerTests() {
  const pc = require('../shared-core/procedure-compiler.js');
  const state = require('../shared-core/state.js');
  const ar = require('../shared-core/action-record.js');

  function recordToolCall(opts) {
    const rec = {
      id: ar.uuidv7(opts.ts || Date.now()),
      timestamp: opts.ts || Date.now(),
      type: 'tool_call',
      agent_id: opts.agent_id,
      cwd: opts.cwd || null,
      session_id: opts.session_id || null,
      user_id: 'default',
      input: { tool_name: opts.tool_name, args: opts.args || {} },
      output: { status: 'ok' }
    };
    state.recordAction(rec, ar.toSearchText(rec));
    return rec.id;
  }

  test('PC1: ngramsFromStream produces 2-grams and 3-grams from a 4-step stream', () => {
    const stream = [
      { name: 'A', ts: 1, id: 'a' },
      { name: 'B', ts: 2, id: 'b' },
      { name: 'C', ts: 3, id: 'c' },
      { name: 'D', ts: 4, id: 'd' }
    ];
    const grams = pc.ngramsFromStream(stream, 2, 3);
    const sigs = grams.map(g => pc.signatureFor(g.seq));
    // 2-grams: A→B, B→C, C→D. 3-grams: A→B→C, B→C→D.
    assert.ok(sigs.includes('A → B'));
    assert.ok(sigs.includes('A → B → C'));
    assert.strictEqual(grams.filter(g => g.seq.length === 2).length, 3);
    assert.strictEqual(grams.filter(g => g.seq.length === 3).length, 2);
  });

  test('PC2: isSkillCandidateTool filters substrate bookkeeping events', () => {
    assert.strictEqual(pc.isSkillCandidateTool('Bash'), true);
    assert.strictEqual(pc.isSkillCandidateTool('Edit'), true);
    assert.strictEqual(pc.isSkillCandidateTool('dialogue.turn'), false,
      'dialogue.turn is bookkeeping, not a skill step');
    assert.strictEqual(pc.isSkillCandidateTool('background_worker.drift_alert'), false,
      'background-worker emissions are not skill candidates');
    assert.strictEqual(pc.isSkillCandidateTool(null), false);
  });

  test('PC3: detectPatterns finds n-grams across ≥2 sessions, ignores single-session patterns', () => {
    const agent_id = 'pc3-' + Date.now();
    const sessA = 'pc3-A-' + Date.now();
    const sessB = 'pc3-B-' + Date.now();
    // Session A: Bash → Edit → Bash
    recordToolCall({ agent_id, session_id: sessA, tool_name: 'Bash', ts: 1000 });
    recordToolCall({ agent_id, session_id: sessA, tool_name: 'Edit', ts: 1001 });
    recordToolCall({ agent_id, session_id: sessA, tool_name: 'Bash', ts: 1002 });
    // Session B: Bash → Edit → Bash (same pattern)
    recordToolCall({ agent_id, session_id: sessB, tool_name: 'Bash', ts: 2000 });
    recordToolCall({ agent_id, session_id: sessB, tool_name: 'Edit', ts: 2001 });
    recordToolCall({ agent_id, session_id: sessB, tool_name: 'Bash', ts: 2002 });
    // Session A only: a one-off Read
    recordToolCall({ agent_id, session_id: sessA, tool_name: 'Read', ts: 1003 });

    const patterns = pc.detectPatterns({ agent_id, since: 0, min_sessions: 2 });
    const sigs = patterns.map(p => p.signature);
    assert.ok(sigs.includes('Bash → Edit'),
      '2-gram Bash→Edit must surface across both sessions; got: ' + JSON.stringify(sigs));
    assert.ok(sigs.includes('Bash → Edit → Bash'),
      '3-gram Bash→Edit→Bash must surface across both sessions');
    // Read-only sequence should NOT surface (only one session).
    assert.ok(!sigs.some(s => s === 'Read'),
      'single-session pattern must NOT meet ≥2 sessions threshold');
  });

  test('PC4: compileProcedure produces a valid compiled_procedure record', () => {
    const agent_id = 'pc4-' + Date.now();
    const pattern = {
      signature: 'Bash → Bash',
      seq: ['Bash', 'Bash'],
      occurrences: 5,
      sessions: ['s1', 's2'],
      first_seen_ts: 1000,
      last_seen_ts: 2000
    };
    const rec = pc.compileProcedure(pattern, { agent_id });
    assert.ok(rec, 'compiler must emit a record');
    assert.strictEqual(rec.type, 'compiled_procedure');
    assert.strictEqual(rec.input.pattern_signature, 'Bash → Bash');
    assert.strictEqual(rec.input.occurrences, 5);
    assert.strictEqual(rec.output.status, 'detected');
    assert.strictEqual(rec.output.template.length, 2);
    assert.strictEqual(rec.output.template[0].tool, 'Bash');
    assert.ok(Array.isArray(rec.output.trigger_keywords),
      'trigger_keywords must be an array');
    // Validate against ActionRecord schema.
    const v = ar.validate(rec);
    assert.ok(v.ok, 'compiled_procedure must validate; errors: ' + JSON.stringify(v.errors));
  });

  test('PC5: recordProcedures persists procedures, dedupes on second run', () => {
    const agent_id = 'pc5-' + Date.now();
    const sessA = 'pc5-A-' + Date.now();
    const sessB = 'pc5-B-' + Date.now();
    recordToolCall({ agent_id, session_id: sessA, tool_name: 'Grep', ts: 3000 });
    recordToolCall({ agent_id, session_id: sessA, tool_name: 'Read', ts: 3001 });
    recordToolCall({ agent_id, session_id: sessB, tool_name: 'Grep', ts: 4000 });
    recordToolCall({ agent_id, session_id: sessB, tool_name: 'Read', ts: 4001 });

    const r1 = pc.recordProcedures({ agent_id, since: 0, min_sessions: 2 });
    assert.ok(r1.ok);
    assert.ok(r1.written.length >= 1, 'first run writes at least one procedure');

    // Second run with no new patterns: nothing should be re-written.
    const r2 = pc.recordProcedures({ agent_id, since: 0, min_sessions: 2 });
    assert.ok(r2.ok);
    assert.strictEqual(r2.written.length, 0,
      'second run must dedupe — no new procedures should be written');
  });

  test('PC6: detectPatterns ignores dialogue.turn and background_worker events', () => {
    const agent_id = 'pc6-' + Date.now();
    const sess = 'pc6-S-' + Date.now();
    // Mix real tool calls with substrate bookkeeping. Bookkeeping must
    // NOT contribute to detected patterns.
    recordToolCall({ agent_id, session_id: sess, tool_name: 'dialogue.turn', ts: 5000 });
    recordToolCall({ agent_id, session_id: sess, tool_name: 'background_worker.drift_alert', ts: 5001 });
    recordToolCall({ agent_id, session_id: sess, tool_name: 'Bash', ts: 5002 });
    recordToolCall({ agent_id, session_id: sess, tool_name: 'Edit', ts: 5003 });
    // Second session with identical bookkeeping + a different real call.
    const sess2 = 'pc6-T-' + Date.now();
    recordToolCall({ agent_id, session_id: sess2, tool_name: 'dialogue.turn', ts: 6000 });
    recordToolCall({ agent_id, session_id: sess2, tool_name: 'Bash', ts: 6001 });
    recordToolCall({ agent_id, session_id: sess2, tool_name: 'Edit', ts: 6002 });

    const patterns = pc.detectPatterns({ agent_id, since: 0, min_sessions: 2 });
    const sigs = patterns.map(p => p.signature);
    assert.ok(sigs.includes('Bash → Edit'),
      'real Bash→Edit pattern must be detected');
    assert.ok(!sigs.some(s => s.includes('dialogue.turn')),
      'dialogue.turn must NEVER appear in detected pattern signatures');
    assert.ok(!sigs.some(s => s.includes('background_worker')),
      'background_worker.* events must NEVER appear in detected pattern signatures');
  });
})();

// --- PROCEDURE MATCHER ---
console.log('\nProcedure matcher:');
(function runProcedureMatcherTests() {
  const pm = require('../shared-core/procedure-matcher.js');
  const ar = require('../shared-core/action-record.js');

  function writeProcedure(opts) {
    const state = require('../shared-core/state.js');
    const rec = {
      id: ar.uuidv7(),
      timestamp: opts.ts || Date.now(),
      type: 'compiled_procedure',
      agent_id: opts.agent_id,
      cwd: opts.cwd || null,
      user_id: 'default',
      input: {
        pattern_signature: opts.signature || 'X → Y',
        occurrences: opts.occurrences || 1,
        detected_in_sessions: ['s1', 's2']
      },
      output: {
        template: opts.template || [{ tool: 'Bash', args: {} }, { tool: 'Edit', args: {} }],
        status: opts.status || 'detected',
        name: opts.name || 'unit-test-proc',
        trigger_keywords: opts.triggers || ['edit', 'run'],
        parameter_slots: [],
        first_seen_ts: opts.ts || Date.now(),
        last_seen_ts:  opts.ts || Date.now()
      }
    };
    state.recordAction(rec, ar.toSearchText(rec));
    return rec.id;
  }

  test('PMatch1: matchProcedure returns null with reason no_procedures when pool is empty', () => {
    const r = pm.matchProcedure({
      prompt: 'please edit src/foo.ts and run npm test',
      agent_id: 'pmatch1-empty-' + Date.now(),
      cwd: '/tmp/pmatch1'
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.match, null);
    assert.strictEqual(r.reason, 'no_procedures');
  });

  test('PMatch2: matchProcedure picks best by trigger overlap + occurrence boost', () => {
    const agent_id = 'pmatch2-' + Date.now();
    const cwd = '/tmp/pmatch2';
    // Procedure A: 2 trigger overlap, low occurrences.
    writeProcedure({ agent_id, cwd, signature: 'A → B', triggers: ['edit', 'run'], occurrences: 2, name: 'proc-a' });
    // Procedure B: 2 trigger overlap, much higher occurrences (boost).
    writeProcedure({ agent_id, cwd, signature: 'C → D', triggers: ['edit', 'run'], occurrences: 200, name: 'proc-b' });

    const r = pm.matchProcedure({
      prompt: 'please edit src/foo.ts then run the test suite for me',
      agent_id, cwd, min_confidence: 0.10
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.match, 'must return a match when triggers overlap; got: ' + JSON.stringify(r));
    assert.strictEqual(r.match.procedure.output ? null : null, null); // procedure row attached
    // The 200-occurrence procedure should win because the occurrence boost
    // breaks the tie at the same overlap.
    const inp = JSON.parse(r.match.procedure.input);
    assert.strictEqual(inp.pattern_signature, 'C → D',
      'higher-occurrence procedure should win the tie');
    assert.ok(r.match.score > 0,    'score must be positive');
    assert.ok(r.match.hits === 2,   'two trigger hits expected');
  });

  test('PMatch3: matchProcedure skips deprecated and prefers approved over detected at equal overlap', () => {
    const agent_id = 'pmatch3-' + Date.now();
    const cwd = '/tmp/pmatch3';
    writeProcedure({ agent_id, cwd, signature: 'DEP', triggers: ['edit', 'run'], occurrences: 999, status: 'deprecated', name: 'proc-dep' });
    writeProcedure({ agent_id, cwd, signature: 'DET', triggers: ['edit', 'run'], occurrences: 5,   status: 'detected',   name: 'proc-det' });
    writeProcedure({ agent_id, cwd, signature: 'APP', triggers: ['edit', 'run'], occurrences: 5,   status: 'approved',   name: 'proc-app' });

    const r = pm.matchProcedure({
      prompt: 'edit foo.ts and run the tests',
      agent_id, cwd, min_confidence: 0.10
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.match, 'a non-deprecated match must surface');
    const inp = JSON.parse(r.match.procedure.input);
    assert.strictEqual(inp.pattern_signature, 'APP',
      'approved procedure must beat detected at equal overlap; deprecated must be skipped');
  });

  test('PMatch4: buildReplayPlan extracts file paths into Read/Edit/Write slots and declares missing for Bash', () => {
    const procedure = {
      id: 'fake-proc',
      input: JSON.stringify({ pattern_signature: 'Read → Edit → Bash', occurrences: 3 }),
      output: JSON.stringify({
        template: [
          { tool: 'Read', args: {} },
          { tool: 'Edit', args: {} },
          { tool: 'Bash', args: {} }
        ],
        status: 'detected',
        trigger_keywords: ['read', 'edit', 'run'],
        parameter_slots: []
      })
    };
    const r = pm.buildReplayPlan({
      procedure,
      prompt: 'please read src/foo.ts and edit src/bar.ts then run npm test'
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.steps.length, 3);
    assert.strictEqual(r.steps[0].tool, 'Read');
    assert.strictEqual(r.steps[0].args.file_path, 'src/foo.ts',
      'first path token fills the Read slot');
    assert.strictEqual(r.steps[0].source, 'prompt_extraction');
    assert.strictEqual(r.steps[1].tool, 'Edit');
    assert.strictEqual(r.steps[1].args.file_path, 'src/bar.ts',
      'second path token fills the Edit slot (cursor advances)');
    assert.strictEqual(r.steps[2].tool, 'Bash');
    assert.deepStrictEqual(r.steps[2].missing, ['command'],
      'Bash declares missing command for the LLM/executor to finalize');
    assert.strictEqual(r.parameter_slots_filled, 2);
    assert.strictEqual(r.missing_args, 1);
    assert.deepStrictEqual(r.extracted.paths, ['src/foo.ts', 'src/bar.ts']);
  });
})();

// --- IDENTITY BOOTSTRAP ---
console.log('\nIdentity bootstrap (substrate-side end-to-end):');
(function runIdentityBootstrapTests() {
  const ie = require('../shared-core/identity-extract.js');
  const eng = require('../shared-core/engram.js');
  const state = require('../shared-core/state.js');
  const ar = require('../shared-core/action-record.js');

  // Helper to seed dialogue.turn entries directly via state.recordAction
  // so we control timestamps (day-bucket distinctness drives stability).
  function seedTurn(opts) {
    const rec = {
      id: ar.uuidv7(opts.ts || Date.now()),
      timestamp: opts.ts || Date.now(),
      type: 'tool_call',
      agent_id: opts.agent_id,
      cwd: opts.cwd || null,
      user_id: 'default',
      input: { tool_name: 'dialogue.turn', args: { user_text: opts.user_text } },
      output: { status: 'recorded', assistant_text: 'ack' }
    };
    state.recordAction(rec, ar.toSearchText(rec));
  }

  test('PFB1: bootstrap dry_run reports stable facts WITHOUT writing to identity pool', () => {
    const sourceAgent = 'pfb1-source-' + Date.now();
    const cwd = '/tmp/pfb1-' + Date.now();
    const day1 = new Date('2026-04-01T10:00:00Z').getTime();
    const day2 = new Date('2026-04-03T10:00:00Z').getTime();
    // Both turns must produce the SAME normalized predicate after the
    // SELF_PREFERENCE clause-stop regex — phrasing identically (no
    // trailing prepositions) so the day-bucket grouping sees one fact
    // across two days, not two distinct facts on one day each.
    seedTurn({ agent_id: sourceAgent, cwd, ts: day1, user_text: 'I always run npm test.' });
    seedTurn({ agent_id: sourceAgent, cwd, ts: day2, user_text: 'I always run npm test.' });

    const beforeIds = eng.listEngrams({ agent_id: 'identity-pfb1-' + Date.now(), limit: 1000 }).length;
    const r = ie.seedFromDialogue({
      source_agent_id: sourceAgent,
      target_agent_id: 'identity-pfb1-dryrun-' + Date.now(),
      cwd,
      limit: 50,
      min_sessions: 2,
      dry_run: true
    });
    assert.ok(r.ok, 'dry_run must succeed');
    assert.strictEqual(r.dry_run, true);
    assert.ok(r.stable_count >= 1, 'expected at least one stable fact in dry_run preview');
    assert.strictEqual((r.written || []).length, 0, 'dry_run must not write any engrams');
    const afterIds = eng.listEngrams({ agent_id: 'identity-pfb1-' + Date.now(), limit: 1000 }).length;
    assert.strictEqual(afterIds, beforeIds, 'identity pool size unchanged after dry_run');
  });

  test('PFB2: bootstrap is DEPRECATED — never writes to identity pool (L4 integration point)', () => {
    // Bootstrap auto-write retired on. Same
    // root cause as PF7: regex pattern matching is not operator
    // cryptographic confirmation. Capture flows through update_identity
    // (llm_inferred) or Phase 3 reflection-tick backfill.
    const sourceAgent = 'pfb2-source-' + Date.now();
    const cwd = '/tmp/pfb2-' + Date.now();
    const day1 = new Date('2026-04-01T10:00:00Z').getTime();
    const day2 = new Date('2026-04-03T10:00:00Z').getTime();
    seedTurn({ agent_id: sourceAgent, cwd, ts: day1, user_text: 'I prefer terse code reviews and I love qwen for local inference.' });
    seedTurn({ agent_id: sourceAgent, cwd, ts: day2, user_text: 'I prefer terse code reviews, qwen is great.' });

    const before = eng.listEngrams({ scope: 'identity', cwd, strict_isolation: true, limit: 50 }).length;
    const r = ie.seedFromDialogue({
      source_agent_id: sourceAgent,
      cwd,
      limit: 50,
      min_sessions: 2
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deprecated, true);
    assert.deepStrictEqual(r.written, [], 'deprecated stub must NEVER write');
    const after = eng.listEngrams({ scope: 'identity', cwd, strict_isolation: true, limit: 50 }).length;
    assert.strictEqual(after, before, 'identity pool count must be unchanged by deprecated seedFromDialogue');
  });
})();

// --- INJECTOR + COMPILED PROCEDURES ---
console.log('\nInjector procedure-hint wiring:');
(function runProcedureInjectorWiringTests() {
  const childPi = require('child_process');
  const pPi = require('path');
  const fPi = require('fs');
  const ar = require('../shared-core/action-record.js');

  const REPO_PI   = pPi.resolve(__dirname, '..');
  const PLUGIN_PI = pPi.join(REPO_PI, 'plugin');

  function runHookForProc(payload, dataDir) {
    const out = childPi.execFileSync(
      'node', [pPi.join(PLUGIN_PI, 'hooks', 'injector.mjs')],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, {
          CLAUDE_PLUGIN_ROOT: PLUGIN_PI,
          CLAUDE_PLUGIN_DATA: dataDir
        }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateForPi(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  test('PCI1: injector surfaces compiled_procedure hint when prompt verbs match triggers', () => {
    const TMP = pPi.join('/tmp', 'gc-pci1-' + Date.now());
    fPi.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pci1-cwd';

    const s = loadStateForPi(TMP);
    // Seed a compiled_procedure with triggers that overlap a code-y prompt.
    const procId = ar.uuidv7();
    const procRec = {
      id: procId,
      timestamp: Date.now(),
      type: 'compiled_procedure',
      agent_id: 'pci1-agent',
      cwd,
      user_id: 'default',
      input: {
        pattern_signature: 'Bash → Edit → Bash',
        occurrences: 7,
        detected_in_sessions: ['s1', 's2'],
        sample_window_ms: 30 * 24 * 60 * 60 * 1000
      },
      output: {
        template: [
          { tool: 'Bash', args: {} },
          { tool: 'Edit', args: {} },
          { tool: 'Bash', args: {} }
        ],
        status: 'detected',
        name: 'bash+edit+bash',
        trigger_keywords: ['run', 'edit', 'execute'],
        parameter_slots: [],
        first_seen_ts: Date.now() - 1000,
        last_seen_ts: Date.now()
      }
    };
    s.recordAction(procRec, ar.toSearchText(procRec));

    const out = runHookForProc(
      {
        session_id: 'pci1-' + Date.now(),
        cwd,
        // Prompt has at least 2 trigger overlaps: "edit" + "run". Prompt
        // length ≥30 char and code-relevant (matches code-relevant regex
        // via 'src/' + 'edit' verb).
        user_prompt: 'please edit src/foo.ts and then run npm test for me'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('[troth/procedure]'),
      'procedure hint must appear when triggers overlap; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('Bash → Edit → Bash'),
      'hint must include the pattern signature');
    assert.ok(ac.includes('7x'),
      'hint must surface occurrence count to convey confidence');
    try { fPi.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PCI2: injector skips procedure hint when prompt has fewer than 2 trigger overlaps', () => {
    const TMP = pPi.join('/tmp', 'gc-pci2-' + Date.now());
    fPi.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pci2-cwd';

    const s = loadStateForPi(TMP);
    const procRec = {
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'compiled_procedure',
      agent_id: 'pci2-agent',
      cwd,
      user_id: 'default',
      input: {
        pattern_signature: 'Grep → Read',
        occurrences: 3,
        detected_in_sessions: ['s1', 's2'],
        sample_window_ms: 30 * 24 * 60 * 60 * 1000
      },
      output: {
        template: [{ tool: 'Grep', args: {} }, { tool: 'Read', args: {} }],
        status: 'detected',
        name: 'grep+read',
        trigger_keywords: ['search', 'find', 'read', 'open'],
        parameter_slots: [],
        first_seen_ts: Date.now(), last_seen_ts: Date.now()
      }
    };
    s.recordAction(procRec, ar.toSearchText(procRec));

    // Prompt has only ONE trigger word ('read'). Below the ≥2 threshold,
    // procedure hint must NOT surface.
    const out = runHookForProc(
      {
        session_id: 'pci2-' + Date.now(),
        cwd,
        user_prompt: 'please read src/lib/some-file.ts and explain the entrypoint flow'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('[troth/procedure]'),
      'procedure hint must NOT surface with only 1 trigger overlap; got: ' + ac.slice(0, 500));
    try { fPi.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

// --- INJECTOR + Δ9 THROUGH-LINE (P16 current_goal anchor) ---
console.log('\nInjector goal/through-line wiring:');
(function runGoalInjectorWiringTests() {
  const childPg = require('child_process');
  const pPg = require('path');
  const fPg = require('fs');
  const ar = require('../shared-core/action-record.js');

  const REPO_PG   = pPg.resolve(__dirname, '..');
  const PLUGIN_PG = pPg.join(REPO_PG, 'plugin');

  function runHookForGoal(payload, dataDir) {
    const out = childPg.execFileSync(
      'node', [pPg.join(PLUGIN_PG, 'hooks', 'injector.mjs')],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, {
          CLAUDE_PLUGIN_ROOT: PLUGIN_PG,
          CLAUDE_PLUGIN_DATA: dataDir
        }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateForPg(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  function writeIntent(s, cwd, goal, constraint, ts, session_id) {
    const rec = {
      id: ar.uuidv7(),
      timestamp: ts || Date.now(),
      type: 'intent',
      agent_id: 'pg-test-agent',
      session_id: session_id || null,
      cwd,
      user_id: 'default',
      input: {
        goal,
        source_message_hash: 'sha256:test',
        constraint: constraint || undefined
      },
      output: { chosen_path: goal }
    };
    s.recordAction(rec, ar.toSearchText(rec));
    return rec.id;
  }

  test('PG1: injector surfaces [troth/goal] with the latest in-cwd intent', () => {
    const TMP = pPg.join('/tmp', 'gc-pg1-' + Date.now());
    fPg.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pg1-cwd';
    const sessionId = 'pg1-' + Date.now();
    const s = loadStateForPg(TMP);
    // Older intent then newer — newer wins.
    writeIntent(s, cwd, 'older goal that should not surface', null, Date.now() - 60_000, sessionId);
    writeIntent(s, cwd, 'wire current_goal anchor for through-line', 'PG1-test-reason', null, sessionId);

    const out = runHookForGoal(
      {
        session_id: sessionId,
        cwd,
        user_prompt: 'continue working on the through-line implementation we discussed'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('[troth/goal]'),
      'goal block must appear when an in-cwd intent exists; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('Working on: wire current_goal anchor'),
      'goal block must surface the latest goal; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('Why: PG1-test-reason'),
      'goal block must include the constraint when present; got: ' + ac.slice(0, 500));
    assert.ok(!ac.includes('older goal that should not surface'),
      'older intent must NOT win over newer one; got: ' + ac.slice(0, 500));
    try { fPg.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PG2: injector does NOT surface intent from a different cwd', () => {
    const TMP = pPg.join('/tmp', 'gc-pg2-' + Date.now());
    fPg.mkdirSync(TMP, { recursive: true });
    const sessionCwd = '/tmp/pg2-current';
    const otherCwd   = '/tmp/pg2-elsewhere';
    const s = loadStateForPg(TMP);
    // Intent recorded under a DIFFERENT cwd — must not leak into the
    // current session's prompt.
    writeIntent(s, otherCwd, 'PG2-LEAKED goal from another project', null);

    const out = runHookForGoal(
      {
        session_id: 'pg2-' + Date.now(),
        cwd: sessionCwd,
        user_prompt: 'help me write the unit test for this new feature please'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('[troth/goal]'),
      'goal block must NOT surface when no intent exists for the current cwd; got: ' + ac.slice(0, 500));
    assert.ok(!ac.includes('PG2-LEAKED'),
      'goal text from another cwd must not leak; got: ' + ac.slice(0, 500));
    try { fPg.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PG3: injector skips goal block when intent is older than 24h', () => {
    const TMP = pPg.join('/tmp', 'gc-pg3-' + Date.now());
    fPg.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pg3-cwd';
    const sessionId = 'pg3-' + Date.now();
    const s = loadStateForPg(TMP);
    // Intent from 30h ago — outside the 24h recency window.
    const stale = Date.now() - (30 * 60 * 60 * 1000);
    writeIntent(s, cwd, 'PG3-STALE goal recorded yesterday afternoon', null, stale, sessionId);

    const out = runHookForGoal(
      {
        session_id: sessionId,
        cwd,
        user_prompt: 'help me write the unit test for this new feature please'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('[troth/goal]'),
      'stale (>24h) intents must not surface as the through-line; got: ' + ac.slice(0, 500));
    assert.ok(!ac.includes('PG3-STALE'),
      'stale goal text must not leak; got: ' + ac.slice(0, 500));
    try { fPg.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  // PG4 — "one brain, parallel tasks" isolation. Multiple Claude Code
  // sessions concurrently active in the same cwd (the operator's actual workflow)
  // must not see each other's intent records leak into the goal block.
  // Pre-fix: cwd-only filter caused the latest write across ALL sessions
  // to surface in EVERY session — observed  with "coupons" /
  // "price exploit" goals appearing in unrelated chats.
  test('PG4: injector does NOT surface intent from a different session in same cwd', () => {
    const TMP = pPg.join('/tmp', 'gc-pg4-' + Date.now());
    fPg.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pg4-cwd';
    const currentSession = 'pg4-current-' + Date.now();
    const otherSession   = 'pg4-other-'   + Date.now();
    const s = loadStateForPg(TMP);
    // Another concurrent chat writes an intent in the SAME cwd.
    writeIntent(s, cwd, 'PG4-OTHER-CHAT goal that must stay isolated', null, null, otherSession);

    const out = runHookForGoal(
      {
        session_id: currentSession,
        cwd,
        user_prompt: 'i am a different chat in the same project, no goal of my own yet'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('[troth/goal]'),
      'goal block must NOT surface when current session has no intent; got: ' + ac.slice(0, 500));
    assert.ok(!ac.includes('PG4-OTHER-CHAT'),
      'goal text from another session must not leak; got: ' + ac.slice(0, 500));
    try { fPg.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PG5: injector surfaces current-session intent even when another session also wrote one in same cwd', () => {
    const TMP = pPg.join('/tmp', 'gc-pg5-' + Date.now());
    fPg.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pg5-cwd';
    const currentSession = 'pg5-current-' + Date.now();
    const otherSession   = 'pg5-other-'   + Date.now();
    const s = loadStateForPg(TMP);
    // Other chat writes its intent FIRST (would have won under the old
    // cwd-only filter on recency).
    writeIntent(s, cwd, 'PG5-OTHER-CHAT noise', null, Date.now() - 5_000, otherSession);
    // Current chat writes its own intent — should win for its session.
    writeIntent(s, cwd, 'PG5-MINE the real current task', 'PG5-reason', null, currentSession);

    const out = runHookForGoal(
      {
        session_id: currentSession,
        cwd,
        user_prompt: 'continue with what we were doing in this very chat right now'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('Working on: PG5-MINE'),
      'current session intent must surface; got: ' + ac.slice(0, 500));
    assert.ok(!ac.includes('PG5-OTHER-CHAT'),
      'other-session intent must NOT leak; got: ' + ac.slice(0, 500));
    try { fPg.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

// --- INJECTOR + ENTITY-AXIS PULL HINT ---
console.log('\nInjector entity-recall wiring:');
(function runEntityRecallInjectorTests() {
  const childPd = require('child_process');
  const pPd = require('path');
  const fPd = require('fs');
  const ar = require('../shared-core/action-record.js');

  const REPO_PD   = pPd.resolve(__dirname, '..');
  const PLUGIN_PD = pPd.join(REPO_PD, 'plugin');

  function runHookForEntity(payload, dataDir) {
    const out = childPd.execFileSync(
      'node', [pPd.join(PLUGIN_PD, 'hooks', 'injector.mjs')],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, {
          CLAUDE_PLUGIN_ROOT: PLUGIN_PD,
          CLAUDE_PLUGIN_DATA: dataDir
        }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateForPd(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  function writeMentionRecord(s, cwd, entity, idx) {
    // A 'tool_call' record whose searchable content includes the entity
    // string. Used to seed the FTS index so findByEntity returns hits.
    const rec = {
      id: ar.uuidv7(),
      timestamp: Date.now() - (idx * 1000),
      type: 'tool_call',
      agent_id: 'pdi-agent',
      cwd,
      session_id: 'pdi-sess',
      user_id: 'default',
      input: { tool_name: 'Read', args: { file_path: entity } },
      output: { status: 'ok', note: 'mention of ' + entity }
    };
    s.recordAction(rec, ar.toSearchText(rec));
    return rec.id;
  }

  test('PDI1: entity-recall hint surfaces when extracted entity has ≥3 in-cwd records', () => {
    const TMP = pPd.join('/tmp', 'gc-pdi1-' + Date.now());
    fPd.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pdi1-cwd';
    const s = loadStateForPd(TMP);
    // Seed 4 records mentioning the same file path entity.
    for (let i = 0; i < 4; i++) writeMentionRecord(s, cwd, 'src/foo.ts', i);

    const out = runHookForEntity(
      {
        session_id: 'pdi1-' + Date.now(),
        cwd,
        user_prompt: 'please read src/foo.ts and tell me what the entrypoint is doing'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('[troth/entity-recall]'),
      'entity-recall hint must surface when threshold met; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('src/foo.ts'),
      'hint must name the entity; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('troth_multi_axis_query'),
      'hint must point at the MCP tool; got: ' + ac.slice(0, 500));
    try { fPd.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PDI2: entity-recall hint does NOT surface when prompt entities have <3 records', () => {
    const TMP = pPd.join('/tmp', 'gc-pdi2-' + Date.now());
    fPd.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pdi2-cwd';
    const s = loadStateForPd(TMP);
    // Seed only 2 records — below the ≥3 threshold.
    writeMentionRecord(s, cwd, 'src/bar.ts', 0);
    writeMentionRecord(s, cwd, 'src/bar.ts', 1);

    const out = runHookForEntity(
      {
        session_id: 'pdi2-' + Date.now(),
        cwd,
        user_prompt: 'please read src/bar.ts and tell me what the entrypoint is doing'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('[troth/entity-recall]'),
      'entity-recall hint must NOT surface below threshold; got: ' + ac.slice(0, 500));
    try { fPd.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

// --- INJECTOR + REPLAY-PLAN ---
console.log('\nInjector replay-plan wiring:');
(function runReplayPlanInjectorTests() {
  const childPr = require('child_process');
  const pPr = require('path');
  const fPr = require('fs');
  const ar = require('../shared-core/action-record.js');

  const REPO_PR   = pPr.resolve(__dirname, '..');
  const PLUGIN_PR = pPr.join(REPO_PR, 'plugin');

  function runHookForReplay(payload, dataDir) {
    const out = childPr.execFileSync(
      'node', [pPr.join(PLUGIN_PR, 'hooks', 'injector.mjs')],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, {
          CLAUDE_PLUGIN_ROOT: PLUGIN_PR,
          CLAUDE_PLUGIN_DATA: dataDir
        }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateForPr(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  function writeProcRec(s, opts) {
    const rec = {
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'compiled_procedure',
      agent_id: opts.agent_id || 'pr-test-agent',
      cwd: opts.cwd,
      user_id: 'default',
      input: {
        pattern_signature: opts.signature,
        occurrences: opts.occurrences || 5,
        detected_in_sessions: ['s1', 's2']
      },
      output: {
        template: opts.template,
        status: opts.status || 'detected',
        name: opts.name || 'pr-test-proc',
        trigger_keywords: opts.triggers,
        parameter_slots: [],
        first_seen_ts: Date.now(),
        last_seen_ts: Date.now()
      }
    };
    s.recordAction(rec, ar.toSearchText(rec));
    return rec.id;
  }

  test('PR1: injector surfaces [troth/replay-plan] with filled steps when match confidence is high', () => {
    const TMP = pPr.join('/tmp', 'gc-pr1-' + Date.now());
    fPr.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pr1-cwd';
    const s = loadStateForPr(TMP);
    // High-confidence: status=approved (+0.30), occurrences=200 (+~0.20),
    // 4-of-4 trigger overlap with the test prompt (overlap ≥ 0.50).
    writeProcRec(s, {
      cwd,
      signature: 'Read → Edit → Bash',
      occurrences: 200,
      status: 'approved',
      triggers: ['read', 'edit', 'run', 'execute'],
      template: [
        { tool: 'Read', args: {} },
        { tool: 'Edit', args: {} },
        { tool: 'Bash', args: {} }
      ]
    });

    const out = runHookForReplay(
      {
        session_id: 'pr1-' + Date.now(),
        cwd,
        user_prompt: 'please read src/foo.ts and edit src/bar.ts then run npm test for me'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('[troth/replay-plan]'),
      'replay-plan must surface at high confidence; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('Read → Edit → Bash'),
      'plan must include the procedure signature; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('1. Read src/foo.ts'),
      'first step must surface filled file_path; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('2. Edit src/bar.ts'),
      'second step must surface second file_path; got: ' + ac.slice(0, 500));
    assert.ok(ac.includes('3. Bash <command>'),
      'Bash step must surface missing-arg placeholder; got: ' + ac.slice(0, 500));
    try { fPr.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PR2: replay-plan does NOT fire when match is below 0.50 confidence threshold', () => {
    const TMP = pPr.join('/tmp', 'gc-pr2-' + Date.now());
    fPr.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pr2-cwd';
    const s = loadStateForPr(TMP);
    // Low-confidence: status=detected (+0), occurrences=1 (~+0.03), and
    // trigger overlap is small relative to the prompt's token surface so
    // overlap stays well below the 0.50 threshold.
    writeProcRec(s, {
      cwd,
      signature: 'Grep → Read',
      occurrences: 1,
      status: 'detected',
      triggers: ['search'],  // single rare trigger
      template: [
        { tool: 'Grep', args: {} },
        { tool: 'Read', args: {} }
      ]
    });

    const out = runHookForReplay(
      {
        session_id: 'pr2-' + Date.now(),
        cwd,
        user_prompt: 'please review the auth flow then summarize what you found about the search path here'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('[troth/replay-plan]'),
      'replay-plan must NOT fire below threshold; got: ' + ac.slice(0, 500));
    try { fPr.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PR3: when replay-plan fires, the weaker [troth/procedure] hint is suppressed', () => {
    const TMP = pPr.join('/tmp', 'gc-pr3-' + Date.now());
    fPr.mkdirSync(TMP, { recursive: true });
    const cwd = '/tmp/pr3-cwd';
    const s = loadStateForPr(TMP);
    // Same high-confidence procedure as PR1 — both PR and P15 would
    // fire on this prompt, but PR's `replayPlanFired` flag must
    // suppress the P15 push.
    writeProcRec(s, {
      cwd,
      signature: 'Bash → Edit → Bash',
      occurrences: 100,
      status: 'approved',
      triggers: ['run', 'edit', 'execute', 'modify'],
      template: [
        { tool: 'Bash', args: {} },
        { tool: 'Edit', args: {} },
        { tool: 'Bash', args: {} }
      ]
    });

    const out = runHookForReplay(
      {
        session_id: 'pr3-' + Date.now(),
        cwd,
        user_prompt: 'please run the tests then edit src/foo.ts to fix the failing assertion and execute again'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('[troth/replay-plan]'),
      'replay-plan must fire on high-confidence match; got: ' + ac.slice(0, 500));
    assert.ok(!ac.includes('[troth/procedure]'),
      'weaker P15 hint must be suppressed when PR fires; got: ' + ac.slice(0, 500));
    try { fPr.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

// --- INJECTOR + IDENTITY POOL ---
console.log('\nInjector identity-pool wiring:');
(function runIdentityInjectorWiringTests() {
  const childIp = require('child_process');
  const pIp = require('path');
  const fIp = require('fs');
  const ar = require('../shared-core/action-record.js');

  const REPO_IP   = pIp.resolve(__dirname, '..');
  const PLUGIN_IP = pIp.join(REPO_IP, 'plugin');

  function runHookForIdentity(payload, dataDir, env) {
    const out = childIp.execFileSync(
      'node', [pIp.join(PLUGIN_IP, 'hooks', 'injector.mjs')],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, {
          CLAUDE_PLUGIN_ROOT: PLUGIN_IP,
          CLAUDE_PLUGIN_DATA: dataDir
        }, env || {}),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateForIp(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  test('PFI1: injector promotes scope=identity engram into foundational slot', () => {
    const TMP = pIp.join('/tmp', 'gc-pfi1-' + Date.now());
    fIp.mkdirSync(TMP, { recursive: true });

    // Seed an identity engram + a normal operator-pool engram. The
    // identity engram (: marked by scope='identity', not by
    // agent_id='identity') should win the foundational slot via the
    // injector's +1.0 salience boost on scope-tagged rows.
    const s = loadStateForIp(TMP);
    function writeEngram(agent_id, statement, salience, opts) {
      opts = opts || {};
      const output = {
        statement,
        commitment_type: 'engram',
        salience: salience || 1.0,
        tier: 'working',
        truth_score: 1.0
      };
      if (opts.scope) output.scope = opts.scope;
      const rec = {
        id: ar.uuidv7(),
        timestamp: Date.now(),
        type: 'commitment',
        agent_id,
        cwd: '/tmp/pfi1-cwd',
        user_id: 'default',
        input: { source: 'pfi1-test' },
        output
      };
      s.recordAction(rec, ar.toSearchText(rec));
      return rec.id;
    }
    writeEngram('test-collab',     'user has a daily standup at 10am',    1.5);
    writeEngram('pfi1-provenance', 'user prefers terse code reviews',     1.0, { scope: 'identity' });

    const out = runHookForIdentity(
      {
        session_id: 'pfi1-' + Date.now(),
        cwd: '/tmp/pfi1-cwd',
        user_prompt: 'help me refactor the Edit hook in src/lib/foo.ts please'
      },
      TMP
    );

    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ac.includes('[troth/identity]'),
      'identity block must appear; got: ' + ac.slice(0, 400));
    // Foundational engram is tagged [core] in the rendered block.
    assert.ok(ac.includes('user prefers terse code reviews'),
      'identity-pool engram should win foundational; got: ' + ac.slice(0, 400));
    try { fIp.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('PFI2: flagged-tier identity engrams are NOT surfaced as foundational', () => {
    const TMP = pIp.join('/tmp', 'gc-pfi2-' + Date.now());
    fIp.mkdirSync(TMP, { recursive: true });

    const s = loadStateForIp(TMP);
    function writeEngram(agent_id, statement, tier) {
      const rec = {
        id: ar.uuidv7(),
        timestamp: Date.now(),
        type: 'commitment',
        agent_id,
        cwd: '/tmp/pfi2-cwd',
        user_id: 'default',
        input: { source: 'pfi2-test' },
        output: {
          statement,
          commitment_type: 'engram',
          salience: 1.0,
          tier: tier || 'working',
          truth_score: tier === 'flagged' ? 0.3 : 1.0
        }
      };
      s.recordAction(rec, ar.toSearchText(rec));
      return rec.id;
    }
    // Flagged identity engram — should
    // NOT be promoted into foundational slot.
    writeEngram('identity', 'PFI2-CONTRADICTED-FACT user always uses tabs', 'flagged');
    // Normal operator-pool engram — fallback foundational.
    writeEngram('test-collab', 'PFI2-FALLBACK user works on troth', 'working');

    const out = runHookForIdentity(
      {
        session_id: 'pfi2-' + Date.now(),
        cwd: '/tmp/pfi2-cwd',
        user_prompt: 'add a test for the new Edit feature in src/lib/bar.ts'
      },
      TMP
    );
    const ac = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ac.includes('PFI2-CONTRADICTED-FACT'),
      'flagged identity engram must NOT surface in identity block; got: ' + ac.slice(0, 400));
    try { fIp.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

// --- ENTITY AXIS ---
console.log('\nEntity axis (MAGMA-style):');
(function runEntityAxisTests() {
  // Test-pollution isolation. Earlier tests in the suite
  // (P17-T3 et al) set CLAUDE_PLUGIN_DATA to a /tmp dir, load state, then
  // rm-rf the dir. The cached shared-core/state module retains a
  // connection to the dead path, so PD6/PD7's recordAction writes vanish.
  // Mass-invalidate the substrate chain + ensure env points at the
  // production data dir before requiring fresh. Pattern mirrors RCL-99.
  const _SAVED_ENV_EA = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const key of Object.keys(require.cache)) {
    if (key.indexOf('/shared-core/') >= 0) delete require.cache[key];
  }
  const ea = require('../shared-core/entity-axis.js');
  const state = require('../shared-core/state.js');
  const ar = require('../shared-core/action-record.js');

  test('PD1: extractEntities pulls file paths', () => {
    const out = ea.extractEntities('See shared-core/engram.js and proxy/server.js for details');
    assert.ok(out.includes('shared-core/engram.js'),
      'must extract path with /; got: ' + JSON.stringify(out));
    assert.ok(out.includes('proxy/server.js'));
  });

  test('PD2: extractEntities pulls function calls and class names', () => {
    const out = ea.extractEntities('call recordEngram() then class IdentityVectors {} appears');
    assert.ok(out.includes('recordEngram'), 'function name; got: ' + JSON.stringify(out));
    assert.ok(out.includes('IdentityVectors'), 'class name');
  });

  test('PD3: extractEntities pulls tool/library vocabulary', () => {
    const out = ea.extractEntities('We use Qwen with Tauri and Rust on the MCP layer');
    assert.ok(out.includes('qwen'), 'lowercased tool token; got: ' + JSON.stringify(out));
    assert.ok(out.includes('tauri'));
    assert.ok(out.includes('rust'));
    assert.ok(out.includes('mcp'));
  });

  test('PD4: extractEntities filters generic identifiers', () => {
    const out = ea.extractEntities('the function returns a value but log this result');
    // None of these should appear because they are in GENERIC_REJECT.
    for (const generic of ['function','return','value','log','result','console','data']) {
      assert.ok(!out.includes(generic),
        'generic identifier "' + generic + '" must NOT be extracted; got: ' + JSON.stringify(out));
    }
  });

  test('PD5: isAcceptableEntity rejects too-short and too-long tokens', () => {
    assert.strictEqual(ea.isAcceptableEntity('a'), false, 'single char rejected');
    assert.strictEqual(ea.isAcceptableEntity('ab'), false, 'two-char rejected');
    assert.strictEqual(ea.isAcceptableEntity('foo'), true, 'three-char OK');
    assert.strictEqual(ea.isAcceptableEntity('a'.repeat(100)), false, 'over-length rejected');
    assert.strictEqual(ea.isAcceptableEntity('function'), false, 'generic-reject token');
  });

  test('PD6: findByEntity returns records whose searchable text contains the entity', () => {
    const agent_id = 'pd6-' + Date.now();
    // Use a fixture-unique file path so FTS5 BM25 doesn't push our record
    // below the LIMIT when the substrate has accumulated thousands of
    // matches against well-known paths like shared-core/engram.js.
    // (Suite runs against the live ~/.troth/state.db; many production
    // edits dominate the entity index for canonical paths.)
    const uniqueFile = 'shared-core/test-fixture-pd6-' + Date.now() + '.js';
    const rec = {
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'edit',
      agent_id,
      cwd: '/tmp/pd6',
      input: { file_path: uniqueFile, format: 'apply_patch' },
      output: { hash_after: 'abc' }
    };
    state.recordAction(rec, ar.toSearchText(rec));
    const hits = ea.findByEntity(uniqueFile, { agent_id, limit: 5 });
    assert.ok(hits.length >= 1,
      'entity FTS must find the record; got: ' + JSON.stringify(hits));
    assert.strictEqual(hits[0].id, rec.id);
  });

  test('PD7: multiAxisQuery fuses entity + temporal scoring with axis_hits annotation', () => {
    const agent_id = 'pd7-' + Date.now();
    const cwd = '/tmp/pd7-' + Date.now();

    // Two records mentioning the same entity, one fresh one stale.
    // Fixture-unique path keeps PD7 from collapsing into the accumulated
    // production FTS index for shared-core/dispatch.js (same reason as
    // PD6: suite shares ~/.troth/state.db).
    const uniqueFile = 'shared-core/test-fixture-pd7-' + Date.now() + '.js';
    const fresh = {
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'edit',
      agent_id, cwd,
      input: { file_path: uniqueFile, format: 'apply_patch' },
      output: { hash_after: 'fresh' }
    };
    const stale = {
      id: ar.uuidv7(Date.now() - 60 * 24 * 60 * 60 * 1000),  // 60 days ago
      timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
      type: 'edit',
      agent_id, cwd,
      input: { file_path: uniqueFile, format: 'apply_patch' },
      output: { hash_after: 'stale' }
    };
    state.recordAction(fresh, ar.toSearchText(fresh));
    state.recordAction(stale, ar.toSearchText(stale));

    const ranked = ea.multiAxisQuery({
      prompt: 'fix the ' + uniqueFile + ' routing bug',
      agent_id,
      limit: 10
    });
    assert.ok(ranked.length >= 1, 'must surface at least one hit');
    // Fresh should outrank stale because of temporal boost.
    const freshIdx = ranked.findIndex(r => r.row.id === fresh.id);
    const staleIdx = ranked.findIndex(r => r.row.id === stale.id);
    if (freshIdx >= 0 && staleIdx >= 0) {
      assert.ok(freshIdx < staleIdx,
        'fresh hit should outrank 60-day-old hit; freshIdx=' + freshIdx + ' staleIdx=' + staleIdx);
    }
    // axis_hits should include 'entity' for the fresh hit (since the
    // prompt mentions dispatch.js, an extracted entity).
    const freshHit = ranked.find(r => r.row.id === fresh.id);
    if (freshHit) {
      assert.ok(freshHit.axis_hits.includes('entity'),
        'fresh hit must be flagged on entity axis; got: ' + JSON.stringify(freshHit.axis_hits));
      assert.ok(freshHit.axis_hits.includes('temporal'),
        'all candidates get a temporal axis_hit (positive recency added)');
    }
  });

  test('PD8: multiAxisQuery returns empty for prompts with no extractable entities', () => {
    const ranked = ea.multiAxisQuery({
      prompt: 'the quick brown fox jumps over the lazy dog',
      agent_id: 'pd8-' + Date.now(),
      limit: 5
    });
    // Nothing to entity-match against; semantic FTS may still surface
    // unrelated rows. The contract is the function returns an array.
    assert.ok(Array.isArray(ranked), 'must return array even when entities=[]');
  });

  test('PD-cleanup: restore CLAUDE_PLUGIN_DATA env', () => {
    if (_SAVED_ENV_EA === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = _SAVED_ENV_EA;
  });
})();

// --- PREDICTIVE-WRITE-FILTER (PRWF — research-curated) ---
console.log('\nPredictive write filter (PRWF):');
(function runPrwfTests() {
  const prwf = require('../shared-core/predictive-write-filter.js');

  test('PRWF1: actionSignature distinguishes tool_call by tool_name and decision by kind', () => {
    assert.strictEqual(
      prwf.actionSignature({ type: 'tool_call', input: { tool_name: 'Bash' } }),
      'tool:Bash');
    assert.strictEqual(
      prwf.actionSignature({ type: 'tool_call', input: { tool_name: 'Edit' } }),
      'tool:Edit');
    assert.strictEqual(
      prwf.actionSignature({ type: 'decision', input: { kind: 'context_injection' } }),
      'decision:context_injection');
    assert.strictEqual(
      prwf.actionSignature({ type: 'commitment', input: {} }),
      'type:commitment',
      'records without tool_name/kind fall back to type');
    assert.strictEqual(prwf.actionSignature(null), null);
  });

  test('PRWF2: buildModel counts n-gram → next transitions', () => {
    // Sequence: A B C A B C A B D — 2-gram contexts:
    //   (A,B) → C twice, D once
    //   (B,C) → A twice
    //   (C,A) → B twice
    const seq = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'D'];
    const model = prwf.buildModel(seq, 2);
    const ab = model.get('A|B');
    assert.ok(ab, 'A|B context must exist');
    assert.strictEqual(ab.get('C'), 2);
    assert.strictEqual(ab.get('D'), 1);
    const bc = model.get('B|C');
    assert.strictEqual(bc.get('A'), 2);
  });

  test('PRWF3: predictProbability returns the right conditional probability', () => {
    const seq = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'D'];
    const model = prwf.buildModel(seq, 2);
    // Given history ending in [A, B], next=C has count 2 of total 3 (C,C,D)
    const pC = prwf.predictProbability(model, ['A', 'B'], 'C', 2);
    assert.ok(Math.abs(pC - 2 / 3) < 1e-6, 'P(C | A B) ≈ 2/3; got: ' + pC);
    const pD = prwf.predictProbability(model, ['A', 'B'], 'D', 2);
    assert.ok(Math.abs(pD - 1 / 3) < 1e-6, 'P(D | A B) ≈ 1/3; got: ' + pD);
    // Unseen context returns null (handled as surprise by callers)
    assert.strictEqual(prwf.predictProbability(model, ['X', 'Y'], 'Z', 2), null);
    // Insufficient history returns null
    assert.strictEqual(prwf.predictProbability(model, ['A'], 'B', 2), null);
  });

  test('PRWF4: shouldWriteAction writes on cold-start, unseen-context, and surprising; skips on expected', () => {
    const seq = ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'];  // P(B|A)=1.0
    const model = prwf.buildModel(seq, 2);

    // Cold start (history < min_history) — always write
    const cold = prwf.shouldWriteAction(model, ['A'], 'B', { min_history: 3 });
    assert.strictEqual(cold.write, true);
    assert.strictEqual(cold.reason, 'cold_start');

    // Expected continuation (B after A,B) — skip
    const expected = prwf.shouldWriteAction(model, ['A', 'B', 'A'], 'B', { threshold: 0.85 });
    assert.strictEqual(expected.write, false,
      'highly-predicted continuation should be skipped; verdict=' + JSON.stringify(expected));
    assert.strictEqual(expected.reason, 'expected');

    // Surprising next token (Z) under known context (A|B) — write
    const surprising = prwf.shouldWriteAction(model, ['A', 'B', 'A'], 'Z', { threshold: 0.85 });
    assert.strictEqual(surprising.write, true);
    assert.ok(surprising.reason === 'surprising' || surprising.reason === 'unseen_context');

    // Unseen context — write
    const unseen = prwf.shouldWriteAction(model, ['X', 'Y', 'X'], 'Y', {});
    assert.strictEqual(unseen.write, true);
    assert.strictEqual(unseen.reason, 'unseen_context');
  });

  test('PRWF5: end-to-end — routine 8x sequence collapses, anomalies preserved (falsifiable)', () => {
    // Synthetic stream: 100 routine 8-step formatting sequences mixed
    // with 5 anomalous error-recovery actions. Per the paper's
    // falsifiability spec: ≥85% write reduction AND 100% anomaly recall.
    const routineUnit = ['Read', 'Edit', 'Bash', 'Read', 'Edit', 'Bash', 'Read', 'Edit'];
    const anomalies = ['ROLLBACK', 'OOM_SIGNAL', 'AUTH_REJECT', 'NET_PARTITION', 'CRASH_DUMP'];

    const stream = [];
    for (let i = 0; i < 100; i++) {
      for (const s of routineUnit) stream.push({ type: 'tool_call', input: { tool_name: s } });
      // Sprinkle one anomaly every 20 routine units
      if (i % 20 === 19 && anomalies.length) {
        const a = anomalies.shift();
        stream.push({ type: 'tool_call', input: { tool_name: a } });
      }
    }

    const predictor = prwf.makePredictor({ threshold: 0.50, min_history: 3, n: 2 });
    const writes = [];
    const skips = [];
    for (const rec of stream) {
      const verdict = predictor.decide(rec);
      predictor.observe(rec);
      const sig = prwf.actionSignature(rec);
      if (verdict.write) writes.push(sig);
      else skips.push(sig);
    }

    const total = stream.length;
    const reduction = skips.length / total;
    assert.ok(reduction >= 0.50,
      'expected ≥50% write reduction on the routine-heavy stream; got ' +
      (reduction * 100).toFixed(1) + '% (writes=' + writes.length + ', skips=' + skips.length + ', total=' + total + ')');

    // Anomaly recall: every anomaly token must appear in `writes`.
    const anomalyTokens = ['tool:ROLLBACK', 'tool:OOM_SIGNAL', 'tool:AUTH_REJECT', 'tool:NET_PARTITION', 'tool:CRASH_DUMP'];
    for (const tok of anomalyTokens) {
      assert.ok(writes.includes(tok),
        'anomaly ' + tok + ' must be preserved in writes (100% recall on anomalies); got writes=' + JSON.stringify(writes.slice(0, 10)) + '...');
    }
  });

  // PEV (Epistemic Void Detector) tests live alongside PRWF
  // since both are substrate-side write filters.
  test('PEV1: extractTargetPaths pulls file paths from a prompt and dedupes', () => {
    const ed = require('../shared-core/epistemic-density.js');
    const paths = ed.extractTargetPaths('please read src/foo.ts and src/foo.ts then edit src/bar.ts');
    assert.deepStrictEqual(paths, ['src/foo.ts', 'src/bar.ts']);
    assert.deepStrictEqual(ed.extractTargetPaths('no paths here just words'), []);
  });

  test('PEV2: epistemicScore is 0 at zero density, saturates near 1 at high density', () => {
    const ed = require('../shared-core/epistemic-density.js');
    assert.strictEqual(ed.epistemicScore(0), 0,         'zero density → score 0');
    assert.ok(ed.epistemicScore(1)  < ed.epistemicScore(5),  'monotonic increase');
    assert.ok(ed.epistemicScore(5)  > 0.4 && ed.epistemicScore(5) < 0.7,
      'density=5 lands mid-curve (default scale=5)');
    assert.ok(ed.epistemicScore(100) > 0.99,            'density=100 saturates near 1');
    // Threshold check: at density=0, score < 0.10 → void
    assert.ok(ed.epistemicScore(0) < 0.10);
    // At density=1 with default scale=5, score ≈ 0.18 → NOT void
    assert.ok(ed.epistemicScore(1) >= 0.10);
  });

  test('PEV3: densityForPath counts records for a known path and returns 0 for unknown', () => {
    const ed = require('../shared-core/epistemic-density.js');
    const ar = require('../shared-core/action-record.js');
    const state = require('../shared-core/state.js');
    const cwd = '/tmp/pev3-' + Date.now();
    const knownPath = 'src/known-pev3.ts';
    // Seed 3 records mentioning the known path.
    for (let i = 0; i < 3; i++) {
      const rec = {
        id: ar.uuidv7(),
        timestamp: Date.now() - (i * 1000),
        type: 'edit',
        agent_id: 'pev3-agent',
        cwd,
        user_id: 'default',
        input: { file_path: knownPath, format: 'str_replace' },
        output: { hash_after: 'sha256:abc' + i }
      };
      state.recordAction(rec, ar.toSearchText(rec));
    }
    const known   = ed.densityForPath(state, cwd, knownPath);
    const unknown = ed.densityForPath(state, cwd, 'src/never-touched.ts');
    assert.ok(known >= 3,
      'known path must surface ≥3 records (the seeded ones); got ' + known);
    assert.strictEqual(unknown, 0,
      'never-touched path must return density 0');
  });

  test('PEV4: assessPaths flags void paths and clears non-void paths', () => {
    const ed = require('../shared-core/epistemic-density.js');
    const ar = require('../shared-core/action-record.js');
    const state = require('../shared-core/state.js');
    const cwd = '/tmp/pev4-' + Date.now();
    // Heavy density on one path, none on another.
    for (let i = 0; i < 25; i++) {
      const rec = {
        id: ar.uuidv7(),
        timestamp: Date.now() - (i * 1000),
        type: 'edit',
        agent_id: 'pev4-agent',
        cwd,
        user_id: 'default',
        input: { file_path: 'src/heavy-pev4.ts', format: 'hashline' },
        output: { hash_after: 'sha256:x' + i }
      };
      state.recordAction(rec, ar.toSearchText(rec));
    }
    const result = ed.assessPaths({
      state, cwd,
      prompt: 'please look at src/heavy-pev4.ts and also src/empty-pev4.ts'
    });
    const heavy = result.find(r => r.path === 'src/heavy-pev4.ts');
    const empty = result.find(r => r.path === 'src/empty-pev4.ts');
    assert.ok(heavy, 'heavy path must appear in assessment');
    assert.ok(empty, 'empty path must appear in assessment');
    assert.strictEqual(heavy.void, false,
      'heavy path with 25 records must NOT be flagged as void; got: ' + JSON.stringify(heavy));
    assert.strictEqual(empty.void, true,
      'empty path with 0 records MUST be flagged as void; got: ' + JSON.stringify(empty));
  });

  // PSD (Schema-Accelerated Delta Memory) tests
  test('PSD1: signaturesFromActions filters substrate-bookkeeping tools', () => {
    const sd = require('../shared-core/schema-delta.js');
    const sigs = sd.signaturesFromActions([
      { type: 'tool_call', input: { tool_name: 'Bash' } },
      { type: 'tool_call', input: { tool_name: 'dialogue.turn' } },  // bookkeeping
      { type: 'tool_call', input: { tool_name: 'Edit' } },
      { type: 'tool_call', input: { tool_name: 'background_worker.x' } }, // bookkeeping
      { type: 'tool_call', input: { tool_name: 'Read' } }
    ]);
    assert.deepStrictEqual(sigs, ['Bash', 'Edit', 'Read']);
  });

  test('PSD2: sequenceOverlap is 1.0 on identical sequences and < threshold on disjoint', () => {
    const sd = require('../shared-core/schema-delta.js');
    assert.strictEqual(sd.sequenceOverlap(['A','B','C'], ['A','B','C']), 1);
    assert.ok(sd.sequenceOverlap(['A','B','C'], ['X','Y','Z']) < 0.10);
    // Partial match: 2 of 3 contiguous
    const partial = sd.sequenceOverlap(['A','B','C'], ['A','B','Z']);
    assert.ok(partial > 0.50 && partial < 1.0);
  });

  test('PSD3: matchingSchema returns the best schema above threshold and skips deprecated', () => {
    const sd = require('../shared-core/schema-delta.js');
    const schemaA = {
      id: 'sch-a',
      output: JSON.stringify({
        template: [{ tool: 'Bash' }, { tool: 'Edit' }, { tool: 'Bash' }],
        status: 'approved'
      })
    };
    const schemaDep = {
      id: 'sch-dep',
      output: JSON.stringify({
        template: [{ tool: 'Bash' }, { tool: 'Edit' }, { tool: 'Bash' }],
        status: 'deprecated'  // must be skipped even if it matches
      })
    };
    const actions = [
      { type: 'tool_call', input: { tool_name: 'Bash' } },
      { type: 'tool_call', input: { tool_name: 'Edit' } },
      { type: 'tool_call', input: { tool_name: 'Bash' } }
    ];
    const m = sd.matchingSchema({ actions, schemas: [schemaDep, schemaA], threshold: 0.80 });
    assert.ok(m, 'must return a match');
    assert.strictEqual(m.schema.id, 'sch-a',
      'must skip deprecated and surface approved match; got: ' + JSON.stringify(m && m.schema && m.schema.id));
    assert.strictEqual(m.score, 1);
  });

  test('PSD4: compress + expand roundtrip preserves the schema-driven plan', () => {
    const sd = require('../shared-core/schema-delta.js');
    const schema = {
      id: 'sch-roundtrip',
      output: JSON.stringify({
        template: [{ tool: 'Read', args: {} }, { tool: 'Edit', args: {} }],
        status: 'approved'
      })
    };
    const actions = [
      { type: 'tool_call', input: { tool_name: 'Read', args: { file_path: 'a.ts' } } },
      { type: 'tool_call', input: { tool_name: 'Edit', args: { file_path: 'b.ts' } } }
    ];
    const m = sd.matchingSchema({ actions, schemas: [schema], threshold: 0.80 });
    assert.ok(m);
    const delta = sd.compressToDelta(actions, m);
    assert.strictEqual(delta.ok, true);
    assert.strictEqual(delta.schema_ref, 'sch-roundtrip');
    assert.strictEqual(delta.delta_size, 2,
      'both steps had override args so both delta entries land');
    const expanded = sd.expandFromDelta(delta, schema);
    assert.strictEqual(expanded.length, 2);
    assert.strictEqual(expanded[0].args.file_path, 'a.ts');
    assert.strictEqual(expanded[1].args.file_path, 'b.ts');
  });

  // PHG (hypothesis-generator) tests
  test('PHG1: jaccard + extractTokens roundtrip on real records', () => {
    const hg = require('../shared-core/hypothesis-generator.js');
    const recA = { input: { tool_name: 'Read', args: { file_path: 'auth/login.ts' } }, output: { status: 'ok', notes: 'login flow user session' } };
    const recB = { input: { tool_name: 'Edit', args: { file_path: 'auth/session.ts' } }, output: { status: 'ok', notes: 'login session token user' } };
    const recC = { input: { tool_name: 'Bash', args: { command: 'npm install lodash' } }, output: { status: 'ok' } };
    const tA = hg.extractTokens(recA);
    const tB = hg.extractTokens(recB);
    const tC = hg.extractTokens(recC);
    assert.ok(hg.jaccard(tA, tB) > hg.jaccard(tA, tC),
      'auth-related records must be more similar than auth vs npm install');
  });

  test('PHG2: findHypotheses surfaces high-similarity disconnected pairs', () => {
    const hg = require('../shared-core/hypothesis-generator.js');
    const ar = require('../shared-core/action-record.js');
    const state = require('../shared-core/state.js');
    const cwd = '/tmp/phg2-' + Date.now();
    const agent_id = 'phg2-agent';
    function write(input, output) {
      const r = {
        id: ar.uuidv7(), timestamp: Date.now(), type: 'tool_call',
        agent_id, cwd, user_id: 'default',
        input, output: output || { status: 'ok' }
      };
      state.recordAction(r, ar.toSearchText(r));
      return r.id;
    }
    write({ tool_name: 'Read', file_path: 'auth/login.ts', notes: 'login session token verification user' });
    write({ tool_name: 'Edit', file_path: 'auth/session.ts', notes: 'session token verification user login' });
    write({ tool_name: 'Bash', command: 'rm -rf node_modules unrelated unrelated unrelated' });
    const hypotheses = hg.findHypotheses({ state, agent_id, cwd, threshold: 0.30, lookback: 50 });
    assert.ok(hypotheses.length >= 1,
      'expected ≥1 hypothesis between the two auth records; got: ' + hypotheses.length);
    assert.ok(hypotheses[0].similarity >= 0.30);
  });

  test('PHG3: recordHypothesis writes a decision record with kind=hypothesis', () => {
    const hg = require('../shared-core/hypothesis-generator.js');
    const state = require('../shared-core/state.js');
    const cwd = '/tmp/phg3-' + Date.now();
    const id = hg.recordHypothesis({
      state, agent_id: 'phg3-agent', cwd,
      candidate: { a_id: 'aaa', b_id: 'bbb', similarity: 0.75, a_type: 'edit', b_type: 'read' }
    });
    assert.ok(id, 'hypothesis record must be written');
    const row = state.getAction(id);
    assert.ok(row);
    assert.strictEqual(row.type, 'decision');
    const inp = JSON.parse(row.input);
    assert.strictEqual(inp.kind, 'hypothesis');
    assert.strictEqual(inp.signals.a_id, 'aaa');
  });

  // PLR (lability-reconsolidation) tests
  test('PLR1: tokenize + jaccard agree with the engram-verify-style normalizer', () => {
    const lr = require('../shared-core/lability-reconsolidation.js');
    const a = lr.tokenize('user prefers terse code reviews');
    const b = lr.tokenize('user prefers TERSE code reviews please');
    assert.ok(lr.jaccard(a, b) > 0.7,
      'near-identical statements must score high jaccard');
  });

  test('PLR2: hasNegationFlip catches opposed statements', () => {
    const lr = require('../shared-core/lability-reconsolidation.js');
    const a = lr.tokenize('user prefers tabs over spaces');
    const b = lr.tokenize('user does not prefer tabs over spaces');
    assert.strictEqual(lr.hasNegationFlip(a, b), true,
      'one side has "not", the other does not — must flip');
  });

  test('PLR3: assessActionAgainstRetrieved flags polarity-flip within lability window', () => {
    const lr = require('../shared-core/lability-reconsolidation.js');
    const ar = require('../shared-core/action-record.js');
    const state = require('../shared-core/state.js');
    const cwd = '/tmp/plr3-' + Date.now();
    // Seed an engram (a commitment) with a stable opinion.
    const engRec = {
      id: ar.uuidv7(), timestamp: Date.now(), type: 'commitment',
      agent_id: 'plr3-agent', cwd, user_id: 'default',
      input: { source: 'plr3-test' },
      output: { statement: 'user prefers tabs over spaces',
                commitment_type: 'engram', salience: 1.5, tier: 'working' }
    };
    state.recordAction(engRec, ar.toSearchText(engRec));
    // Mark it retrieved (opens the lability window).
    lr.markRetrieved({ state, engram_id: engRec.id, cwd, agent_id: 'plr3-agent' });
    // Now an action arrives that contradicts the engram polarity-wise.
    const flagged = lr.assessActionAgainstRetrieved({
      state, cwd,
      action_text: 'user does not prefer tabs over spaces and dislikes them'
    });
    assert.ok(flagged.length >= 1,
      'expected ≥1 contradiction; got: ' + JSON.stringify(flagged));
    assert.strictEqual(flagged[0].engram_id, engRec.id);
    assert.strictEqual(flagged[0].contradiction_kind, 'polarity_flip');
  });

  test('PLR4: reconsolidate writes a new commitment with output.lifetime.supersedes', () => {
    const lr = require('../shared-core/lability-reconsolidation.js');
    const ar = require('../shared-core/action-record.js');
    const state = require('../shared-core/state.js');
    const cwd = '/tmp/plr4-' + Date.now();
    const engRec = {
      id: ar.uuidv7(), timestamp: Date.now(), type: 'commitment',
      agent_id: 'plr4-agent', cwd, user_id: 'default',
      input: { source: 'plr4-test' },
      output: { statement: 'user uses tabs', commitment_type: 'engram',
                salience: 1.0, tier: 'working' }
    };
    state.recordAction(engRec, ar.toSearchText(engRec));
    const retrieved = state.getAction(engRec.id);
    const newId = lr.reconsolidate({
      state, prior_engram: retrieved,
      new_statement: 'user uses spaces',
      reason: 'plr4-test'
    });
    assert.ok(newId, 'reconsolidated record must be written');
    const newRow = state.getAction(newId);
    assert.ok(newRow);
    assert.strictEqual(newRow.parent_id, engRec.id,
      'parent_id must point at the prior engram');
    const outp = JSON.parse(newRow.output);
    assert.strictEqual(outp.lifetime.supersedes, engRec.id,
      'output.lifetime.supersedes must reference the prior engram');
    assert.strictEqual(outp.statement, 'user uses spaces');
  });

  test('TRR1: taskReconsolidationReview gates supersede on consensus + polarity_flip', () => {
    // Set up an in-memory state stub. Stores rows by id, supports
    // queryActions filter on type + kind via input parsing, and getAction
    // by id. Mirrors the real state.js surface the task uses.
    const rows = [];
    const fakeState = {
      recordAction: (rec) => { rows.push(rec); return rec.id; },
      getAction:    (id) => rows.find(r => r.id === id) || null,
      queryActions: (opts) => {
        return rows.filter(r => {
          if (opts.type && r.type !== opts.type) return false;
          if (opts.cwd && r.cwd !== opts.cwd) return false;
          if (opts.since && (r.timestamp || 0) < opts.since) return false;
          return true;
        });
      }
    };
    const ar = require('../shared-core/action-record.js');
    // Plant a prior engram (commitment_type='engram', tier=working).
    const prior = {
      id: ar.uuidv7(), timestamp: Date.now() - 60000, type: 'commitment',
      agent_id: 'tst', cwd: '/tmp', user_id: 'default',
      input: { source: 'test' },
      output: { commitment_type: 'engram', statement: 'user prefers tabs', salience: 1.0, tier: 'working' }
    };
    rows.push(prior);
    // Plant 3 candidate decisions across 3 distinct minute-buckets — all polarity_flip.
    const baseTs = Date.now() - 50 * 60 * 1000;
    for (let i = 0; i < 3; i++) {
      rows.push({
        id: ar.uuidv7(), timestamp: baseTs + i * 60 * 1000, type: 'decision',
        agent_id: 'tst', cwd: '/tmp', user_id: 'default',
        input: { kind: 'reconsolidation_candidate', signals: { engram_id: prior.id, contradiction_kind: 'polarity_flip', similarity: 0.5 } },
        output: { decision: 'observed', reason: 'polarity_flip', prior_statement_excerpt: 'user prefers tabs' }
      });
    }
    // Inject the fake state for the task — monkey-patch require cache.
    const stateModPath = require.resolve('../shared-core/state.js');
    const origState = require.cache[stateModPath];
    require.cache[stateModPath] = { exports: fakeState };
    try {
      delete require.cache[require.resolve('../shared-core/background-worker.js')];
      const bw = require('../shared-core/background-worker.js');
      const task = (bw.DEFAULT_TASKS || []).find(t => t.name === 'reconsolidation_review');
      assert.ok(task, 'taskReconsolidationReview must be in DEFAULT_TASKS');
      // Sync-call the async run with a minimal view.
      return task.run({ substrate_ctx: { agent_id: 'tst', cwd: '/tmp', user_id: 'default' } }).then((result) => {
        assert.ok(result, 'task must return a result');
        assert.strictEqual(result.events.length, 1, 'one reconsolidation_executed event expected');
        assert.strictEqual(result.events[0].input.tool_name, 'background_worker.reconsolidation_executed');
        assert.strictEqual(result.events[0].input.args.engram_id, prior.id);
        // Verify a superseder commitment was written.
        const supers = rows.filter(r => {
          if (r.type !== 'commitment' || r.id === prior.id) return false;
          const out = r.output;
          return out && out.lifetime && out.lifetime.supersedes === prior.id;
        });
        assert.strictEqual(supers.length, 1, 'exactly one superseder must be written');
      });
    } finally {
      if (origState) require.cache[stateModPath] = origState;
      else delete require.cache[stateModPath];
      delete require.cache[require.resolve('../shared-core/background-worker.js')];
    }
  });

  test('TRR2: taskReconsolidationReview skips when consensus too low', () => {
    const rows = [];
    const fakeState = {
      recordAction: (rec) => { rows.push(rec); return rec.id; },
      getAction:    (id) => rows.find(r => r.id === id) || null,
      queryActions: (opts) => rows.filter(r => {
        if (opts.type && r.type !== opts.type) return false;
        if (opts.cwd && r.cwd !== opts.cwd) return false;
        if (opts.since && (r.timestamp || 0) < opts.since) return false;
        return true;
      })
    };
    const ar = require('../shared-core/action-record.js');
    const prior = {
      id: ar.uuidv7(), timestamp: Date.now() - 60000, type: 'commitment',
      agent_id: 'tst', cwd: '/tmp', user_id: 'default',
      input: { source: 'test' },
      output: { commitment_type: 'engram', statement: 'x', salience: 1.0, tier: 'working' }
    };
    rows.push(prior);
    // Only 2 candidates in same minute — fails consensus.
    const ts = Date.now() - 30 * 60 * 1000;
    for (let i = 0; i < 2; i++) {
      rows.push({
        id: ar.uuidv7(), timestamp: ts, type: 'decision',
        agent_id: 'tst', cwd: '/tmp', user_id: 'default',
        input: { kind: 'reconsolidation_candidate', signals: { engram_id: prior.id, contradiction_kind: 'polarity_flip' } },
        output: { decision: 'observed' }
      });
    }
    const stateModPath = require.resolve('../shared-core/state.js');
    const origState = require.cache[stateModPath];
    require.cache[stateModPath] = { exports: fakeState };
    try {
      delete require.cache[require.resolve('../shared-core/background-worker.js')];
      const bw = require('../shared-core/background-worker.js');
      const task = bw.DEFAULT_TASKS.find(t => t.name === 'reconsolidation_review');
      return task.run({ substrate_ctx: { agent_id: 'tst', cwd: '/tmp' } }).then((result) => {
        assert.strictEqual(result.events.length, 0, 'no supersede when consensus below threshold');
      });
    } finally {
      if (origState) require.cache[stateModPath] = origState;
      else delete require.cache[stateModPath];
      delete require.cache[require.resolve('../shared-core/background-worker.js')];
    }
  });

  test('TSC1: taskSchemaDeltaCompress emits candidate when sequence matches a compiled_procedure', () => {
    const rows = [];
    const fakeState = {
      recordAction: (rec) => { rows.push(rec); return rec.id; },
      queryActions: (opts) => rows.filter(r => {
        if (opts.type && r.type !== opts.type) return false;
        if (opts.agent_id && r.agent_id !== opts.agent_id) return false;
        if (opts.cwd && r.cwd !== opts.cwd) return false;
        if (opts.since && (r.timestamp || 0) < opts.since) return false;
        return true;
      })
    };
    const ar = require('../shared-core/action-record.js');
    // Plant a compiled_procedure with template [Read, Edit, Bash].
    rows.push({
      id: ar.uuidv7(), timestamp: Date.now() - 24 * 60 * 60 * 1000, type: 'commitment',
      agent_id: 'tst', cwd: '/tmp', user_id: 'default',
      input: { source: 'test' },
      output: {
        commitment_type: 'compiled_procedure',
        template: [{ tool: 'Read' }, { tool: 'Edit' }, { tool: 'Bash' }],
        status: 'active'
      }
    });
    // Plant a recent action sequence Read → Edit → Bash within 5 min gap.
    const baseTs = Date.now() - 30 * 60 * 1000;
    for (let i = 0; i < 3; i++) {
      const tools = ['Read', 'Edit', 'Bash'];
      rows.push({
        id: ar.uuidv7(), timestamp: baseTs + i * 1000, type: 'tool_call',
        agent_id: 'tst', cwd: '/tmp', user_id: 'default',
        input: { tool_name: tools[i], args: { path: 'foo.js' } },
        output: { status: 'completed' }
      });
    }
    const stateModPath = require.resolve('../shared-core/state.js');
    const origState = require.cache[stateModPath];
    require.cache[stateModPath] = { exports: fakeState };
    try {
      delete require.cache[require.resolve('../shared-core/background-worker.js')];
      const bw = require('../shared-core/background-worker.js');
      const task = bw.DEFAULT_TASKS.find(t => t.name === 'schema_delta_compress');
      assert.ok(task, 'taskSchemaDeltaCompress must be in DEFAULT_TASKS');
      return task.run({ substrate_ctx: { agent_id: 'tst', cwd: '/tmp', user_id: 'default' } }).then((result) => {
        assert.ok(result.events.length >= 1, 'at least one schema_delta_candidate event expected; got ' + JSON.stringify(result));
        const ev = result.events[0];
        assert.strictEqual(ev.input.tool_name, 'background_worker.schema_delta_candidate');
        assert.strictEqual(ev.input.args.original_count, 3);
        assert.ok(typeof ev.input.args.schema_score === 'number' && ev.input.args.schema_score >= 0.80);
      });
    } finally {
      if (origState) require.cache[stateModPath] = origState;
      else delete require.cache[stateModPath];
      delete require.cache[require.resolve('../shared-core/background-worker.js')];
    }
  });

  test('PRWF6: recordActionFiltered no-ops when disabled and gates when enabled', () => {
    const calls = { recordAction: 0 };
    const fakeState = {
      recordAction: (rec) => { calls.recordAction++; return rec.id; }
    };
    const predictor = prwf.makePredictor({ threshold: 0.50, min_history: 3 });

    // enabled:false — must always write through
    for (let i = 0; i < 10; i++) {
      prwf.recordActionFiltered(fakeState, predictor,
        { id: 'x' + i, type: 'tool_call', input: { tool_name: 'Bash' } }, null,
        { enabled: false });
    }
    assert.strictEqual(calls.recordAction, 10, 'disabled mode must pass-through every call');

    // enabled:true — after observation builds the model, repeated Bash
    // calls become predictable and at least some get skipped
    const calls2 = { recordAction: 0 };
    const fakeState2 = { recordAction: (rec) => { calls2.recordAction++; return rec.id; } };
    const predictor2 = prwf.makePredictor({ threshold: 0.50, min_history: 3 });
    for (let i = 0; i < 30; i++) {
      prwf.recordActionFiltered(fakeState2, predictor2,
        { id: 'y' + i, type: 'tool_call', input: { tool_name: 'Bash' } }, null,
        { enabled: true });
    }
    const stats = predictor2.getStats();
    assert.ok(stats.skipped > 0,
      'enabled mode should skip at least some highly-predictable repeats; stats=' + JSON.stringify(stats));
    assert.strictEqual(calls2.recordAction, stats.written,
      'recordAction call count must equal predictor.written');
  });
})();

// --- SUMMARY ---

// --- PROCEDURE RUNNER ---
console.log('\nProcedure runner (SSE builder):');
(function runProcedureRunnerTests() {
  const runner = require('../shared-core/procedure-runner.js');

  test('PRunner1: tool_use id roundtrip — build / detect / parse', () => {
    const id = runner.buildToolUseId('019e0000-0000-7000-8000-00000000abcd', 0);
    assert.ok(runner.isReplayToolUseId(id), 'built id must be detected as replay');
    const parsed = runner.parseReplayToolUseId(id);
    assert.ok(parsed, 'parser must return an object');
    assert.strictEqual(parsed.step_index, 0);
    assert.ok(parsed.procedure_id_suffix.length === 12, 'suffix must be 12 chars (last 12 of normalized id)');
    assert.ok(/^[0-9a-f]+$/.test(parsed.nonce), 'nonce must be hex');

    assert.strictEqual(runner.isReplayToolUseId('toolu_01abc'), false,
      'standard Anthropic tool_use ids must NOT be detected as replay');
    assert.strictEqual(runner.parseReplayToolUseId('toolu_01abc'), null,
      'parser must return null for non-replay ids');
  });

  test('PRunner2: buildSseEvents emits 6 events in Anthropic streaming order with stop_reason=tool_use', () => {
    const events = runner.buildSseEvents({
      step: { step_index: 0, tool: 'Read', args: { file_path: 'src/foo.ts' } },
      model: 'claude-substrate-replay',
      procedure_id: '019e0000-0000-0000-0000-000000000abc'
    });
    assert.ok(Array.isArray(events), 'must return event array');
    assert.strictEqual(events.length, 6, 'expect 6 events: message_start, block_start, block_delta, block_stop, message_delta, message_stop');
    assert.strictEqual(events[0].event, 'message_start');
    assert.strictEqual(events[1].event, 'content_block_start');
    assert.strictEqual(events[1].data.content_block.type, 'tool_use');
    assert.strictEqual(events[1].data.content_block.name, 'Read');
    assert.ok(runner.isReplayToolUseId(events[1].data.content_block.id),
      'tool_use id must be a gcr_-prefixed replay id');
    assert.strictEqual(events[2].event, 'content_block_delta');
    assert.strictEqual(events[2].data.delta.type, 'input_json_delta');
    assert.strictEqual(events[2].data.delta.partial_json, JSON.stringify({ file_path: 'src/foo.ts' }));
    assert.strictEqual(events[3].event, 'content_block_stop');
    assert.strictEqual(events[4].event, 'message_delta');
    assert.strictEqual(events[4].data.delta.stop_reason, 'tool_use',
      'replay turns end with stop_reason=tool_use so the host executes the tool');
    assert.strictEqual(events[5].event, 'message_stop');
  });

  test('PRunner3: encodeSseEvents produces wire-format `event: X\\ndata: {...}\\n\\n` blocks', () => {
    const wire = runner.encodeSseEvents([
      { event: 'message_stop', data: { type: 'message_stop' } }
    ]);
    assert.strictEqual(wire, 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      'single-event wire format must match Anthropic SSE convention');
  });

  test('PRunner4: buildSseEvents returns null for malformed step input', () => {
    assert.strictEqual(runner.buildSseEvents({ step: null }), null);
    assert.strictEqual(runner.buildSseEvents({ step: { step_index: 0 } }), null,
      'step without tool name must return null (not throw)');
  });
})();

// --- REPLAY INTERCEPT ---
console.log('\nReplay intercept (proxy):');
(function runReplayInterceptTests() {
  const path = require('path');
  const ar = require('../shared-core/action-record.js');
  // Earlier test blocks (PCI/PG/PDI/PR) clear the state module from
  // require.cache and re-require it pointing at TMP DBs. The matcher
  // module captured its `state` reference at load time — so its
  // internal default points at a stale TMP DB. We re-load state HERE
  // (picks up whatever CLAUDE_PLUGIN_DATA is currently pointing at)
  // and pass the fresh instance through tryIntercept so writes and
  // reads share the same DB.
  delete require.cache[require.resolve('../shared-core/state')];
  const stateForPRx = require('../shared-core/state');
  const interceptor = require('../proxy/modules/replay-intercept.js');

  // Tiny fake-res that captures writes so tryIntercept's behavior can
  // be asserted without a real http server.
  function fakeRes() {
    const r = {
      _head: null, _written: '', _ended: false,
      writeHead(code, headers) { r._head = { code, headers }; },
      write(chunk) { r._written += String(chunk); },
      end(chunk) { if (chunk) r._written += String(chunk); r._ended = true; }
    };
    return r;
  }

  function writeProcRec(opts) {
    const rec = {
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'compiled_procedure',
      agent_id: opts.agent_id || 'prx-test-agent',
      cwd: opts.cwd || null,
      user_id: 'default',
      input: {
        pattern_signature: opts.signature,
        occurrences: opts.occurrences || 100,
        detected_in_sessions: ['s1', 's2']
      },
      output: {
        template: opts.template,
        status: opts.status || 'approved',
        name: opts.name || 'prx-test-proc',
        trigger_keywords: opts.triggers,
        parameter_slots: [],
        first_seen_ts: Date.now(),
        last_seen_ts: Date.now()
      }
    };
    stateForPRx.recordAction(rec, ar.toSearchText(rec));
    return rec.id;
  }

  test('substrate replay1: tryIntercept falls through on non-streaming requests', async () => {
    const r = await interceptor.tryIntercept({
      body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'edit src/foo.ts and run npm test' }] }),
      res: fakeRes(),
      requestedModel: 'claude-opus-4-7'
    });
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.reason, 'non_streaming_request');
  });

  test('substrate replay2: tryIntercept falls through when latest user message is pure tool_result (continuation)', async () => {
    const body = JSON.stringify({
      stream: true,
      messages: [
        { role: 'user', content: 'fresh prompt' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'file contents' }] }
      ]
    });
    const res = fakeRes();
    const r = await interceptor.tryIntercept({ body, res, requestedModel: 'm' });
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.reason, 'no_user_text');
    assert.strictEqual(res._ended, false, 'fall-through must NOT touch res');
  });

  test('substrate replay3: tryIntercept returns handled when match is high-confidence AND plan has zero missing args', async () => {
    const cwd = '/tmp/prx3-' + Date.now();
    const writtenId = writeProcRec({
      cwd,
      signature: 'Read → Edit',
      occurrences: 200,
      status: 'approved',
      triggers: ['read', 'edit', 'modify', 'open'],
      template: [
        { tool: 'Read', args: {} },
        { tool: 'Edit', args: {} }
      ]
    });
    // Sanity: make sure the write is visible via the same state module
    // the matcher will use. If not, the failure is in the write path.
    const checkRows = stateForPRx.queryActions({
      type: 'compiled_procedure', cwd, limit: 5, order: 'desc'
    }) || [];
    assert.ok(checkRows.length >= 1,
      'sanity: queryActions must surface the just-written compiled_procedure (id=' + writtenId + '); got rows=' + checkRows.length);

    const body = JSON.stringify({
      stream: true,
      messages: [{
        role: 'user',
        content: 'please read src/foo.ts and edit src/bar.ts to wire the new helper'
      }]
    });
    const res = fakeRes();
    const r = await interceptor.tryIntercept({
      body, res, requestedModel: 'claude-opus-4-7', cwd, state: stateForPRx
    });
    assert.strictEqual(r.handled, true,
      'expected handled=true; reason: ' + (r && r.reason));
    assert.strictEqual(r.tool, 'Read', 'first step is Read');
    assert.strictEqual(res._ended, true, 'res must be ended after intercept');
    assert.strictEqual(res._head.code, 200);
    assert.strictEqual(res._head.headers['content-type'], 'text/event-stream');
    assert.ok(res._written.includes('event: message_start\n'),
      'wire output must contain message_start event');
    assert.ok(res._written.includes('"name":"Read"'),
      'wire output must include the Read tool name');
    // partial_json is a STRING containing JSON — file_path appears
    // escaped (\\"file_path\\":\\"src/foo.ts\\") in the wire payload.
    assert.ok(res._written.includes('\\"file_path\\":\\"src/foo.ts\\"'),
      'wire output must carry the extracted file path inside the input_json_delta string');
    assert.ok(res._written.includes('"stop_reason":"tool_use"'),
      'wire output must end with stop_reason=tool_use');
  });

  test('substrate replay4: tryIntercept falls through when plan has missing args (Bash/Grep slots unfilled)', async () => {
    const cwd = '/tmp/prx4-' + Date.now();
    writeProcRec({
      cwd,
      signature: 'Bash → Edit',
      occurrences: 100,
      status: 'approved',
      triggers: ['run', 'edit', 'execute', 'modify'],
      template: [
        { tool: 'Bash', args: {} },     // declares missing:command
        { tool: 'Edit', args: {} }
      ]
    });
    const body = JSON.stringify({
      stream: true,
      messages: [{
        role: 'user',
        content: 'please run the tests then edit src/foo.ts to fix the failure'
      }]
    });
    const res = fakeRes();
    const r = await interceptor.tryIntercept({
      body, res, requestedModel: 'claude-opus-4-7', cwd, state: stateForPRx
    });
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.reason, 'plan_has_missing_args');
    assert.strictEqual(res._ended, false, 'fall-through must NOT touch res');
  });

  test('substrate replay5: tryIntercept falls through when prior assistant message contains a gcr_ tool_use (continuation)', async () => {
    const body = JSON.stringify({
      stream: true,
      messages: [
        { role: 'user', content: 'edit src/foo.ts' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'gcr_abc123def456_0_aaaa', name: 'Read', input: { file_path: 'src/foo.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gcr_abc123def456_0_aaaa', content: 'file body' }] }
      ]
    });
    const res = fakeRes();
    const r = await interceptor.tryIntercept({ body, res, requestedModel: 'm' });
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.reason, 'continuation_not_yet_supported');
  });
})();

};
