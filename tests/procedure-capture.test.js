#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// Procedural memory, the capture side: the prompt asks for a procedure only
// where decision_record is a tool; the tool writes the decision shape as a
// procedural engram; a plain statement asked to be procedural lands as
// semantic with the request kept for audit; recall keeps at most two
// procedures in a cut so the other classes are still heard.
const assert = require('assert');
const path = require('path');
const engram = require('../shared-core/engram.js');
const state = require('../shared-core/state.js');
const recall = require('../shared-core/recall.js');
const sp = require('../shared-core/tools/system-prompt.js');
const permission = require('../shared-core/tools/permission.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const ctx = { agent_id: 'proc-test', user_id: 'op', cwd: process.cwd() };
const classOf = (id) => { const r = state.getAction(id); let out = {}; try { out = JSON.parse(r.output); } catch (_) {} return { memory_class: r.memory_class, requested: out.requested_memory_class || null }; };

(async () => {
  console.log('procedure-capture');

  await t('the prompt asks for procedure capture only when decision_record is a tool, and the voice prompt stays under its cap', () => {
    const toolRunner = require('../shared-core/tools/runner.js');
    const names = toolRunner.unifiedToolsArray().map((s) => s.function && s.function.name);
    assert.ok(names.includes('decision_record'), 'decision_record is on the unified surface');
    const withIt = sp.buildSystemPrompt({ agent_id: 'p', cwd: '/no/such/ws', available_tools: names, audio: true });
    assert.ok(withIt.includes('Procedure capture:'), 'the capture line is present');
    assert.ok(withIt.length <= sp.DEFAULT_MAX_CHARS, 'voice prompt fits the cap: ' + withIt.length + ' > ' + sp.DEFAULT_MAX_CHARS);
    assert.ok(withIt.indexOf('(truncated)') === -1, 'nothing sliced');
    const without = sp.buildSystemPrompt({ agent_id: 'p', cwd: '/no/such/ws', available_tools: names.filter((n) => n !== 'decision_record') });
    assert.ok(!without.includes('Procedure capture:'), 'no tool, no ask');
    assert.strictEqual(permission.classify('decision_record'), 'write');
  });

  await t('decision_record writes the decision shape as a procedural engram under a decision scope', async () => {
    const tool = require('../shared-core/tools/runner.js').unifiedRegistry().decision_record;
    assert.ok(tool && tool.schema.function.name === 'decision_record');
    const r = await tool.run({
      strategy: 'Run both test roads before a push',
      trigger: 'About to push a change to the working repository',
      steps: ['run the targeted tests', 'run the full road and the standalone road', 'read the skip count', 'push only when both are green'],
      provenance: { model: 'test', verdict: 'test_passed' }
    }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(/^decision:/.test(r.scope), 'decision scope: ' + r.scope);
    const c = classOf(r.id);
    assert.strictEqual(c.memory_class, 'procedural');
    const bad = await tool.run({ strategy: 'x' }, ctx);
    assert.strictEqual(bad.ok, false, 'an incomplete record is refused: ' + JSON.stringify(bad));
  });

  await t('a plain statement asked to be procedural lands as semantic with the request kept; the shape keeps the class', () => {
    const plain = engram.recordEngram(Object.assign({}, ctx, { statement: 'we chose one mind over two things talking', memory_class: 'procedural', source: 'test' }));
    assert.deepStrictEqual(classOf(plain), { memory_class: 'semantic', requested: 'procedural' });
    const shaped = engram.recordEngram(Object.assign({}, ctx, { statement: 'DECISION — check the wall first\nWHEN: a tool refuses legitimate work\nSTEPS:\n  1. read the wall\n  2. give the work a road', memory_class: 'procedural', source: 'test' }));
    assert.strictEqual(classOf(shaped).memory_class, 'procedural');
    const untouched = engram.recordEngram(Object.assign({}, ctx, { statement: 'a plain fact about the world', source: 'test' }));
    assert.strictEqual(classOf(untouched).memory_class, 'episodic', 'nothing else changes');
  });

  await t('recall keeps at most two procedures in a cut of three and the other classes still land', async () => {
    const token = 'zebra-lantern';
    for (let i = 1; i <= 4; i++) {
      engram.recordEngram(Object.assign({}, ctx, { statement: 'DECISION — ' + token + ' procedure ' + i + '\nWHEN: the ' + token + ' question comes up ' + i + '\nSTEPS:\n  1. do the ' + token + ' thing ' + i, scope: 'decision:' + token + '-' + i, source: 'test', salience: 1.5 }));
    }
    engram.recordEngram(Object.assign({}, ctx, { statement: 'The ' + token + ' guide says the lantern is lit at dusk', scope: 'docs:' + token, source: 'test', salience: 1.5 }));
    engram.recordEngram(Object.assign({}, ctx, { statement: 'We talked about the ' + token + ' lantern and the dusk rule yesterday', source: 'test', salience: 1.5 }));
    const hits = await recall.recall({ query: token + ' lantern dusk question', class: 'all', limit: 3, cwd: process.cwd(), skip_embedding_rerank: true, off_loop: false });
    assert.strictEqual(hits.length, 3, 'three hits: ' + JSON.stringify(hits.map((h) => [h.class, String(h.statement).slice(0, 40)])));
    const proc = hits.filter((h) => h.class === 'procedural').length;
    assert.ok(proc <= 2, 'at most two procedures: ' + proc);
    assert.ok(hits.some((h) => h.class !== 'procedural'), 'another class made the cut: ' + JSON.stringify(hits.map((h) => h.class)));
    const all = await recall.recall({ query: token + ' procedure', class: 'procedural', limit: 5, cwd: process.cwd(), skip_embedding_rerank: true, off_loop: false });
    assert.ok(all.length >= 3, 'an explicit procedural ask is not capped: ' + all.length);
  });

  console.log('\nprocedure-capture: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
