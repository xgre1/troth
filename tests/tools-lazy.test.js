#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The engine is handed the core tools and one door, tool_load; a tool loaded
// through that door is advertised on the next round of the same turn.
const assert = require('assert');
const path = require('path');
const SHARED = path.join(__dirname, '..', 'shared-core');
const tr = require(path.join(SHARED, 'tools', 'runner.js'));
const { makeOrchestrator } = require(path.join(SHARED, 'llm-orchestrator.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const names = (arr) => arr.map((s) => s && s.function && s.function.name).filter(Boolean);

console.log('\n=== lazy tools ===\n');
(async () => {
  await t('the core set carries the everyday tools and the door, at a fraction of the full schema', () => {
    const core = tr.coreToolsArray(), full = tr.unifiedToolsArray();
    const cn = names(core);
    for (const n of ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'web_search', 'web_fetch', 'engram_record', 'engram_search', 'operator_request', 'tool_load']) assert.ok(cn.includes(n), n + ' is core');
    assert.ok(!cn.includes('video_generate') && !cn.includes('intent_emit'), 'the heavy tools wait behind the door');
    assert.ok(!names(full).includes('tool_load'), 'the full list has no door');
    assert.ok(JSON.stringify(core).length < JSON.stringify(full).length / 3, 'core is under a third of the full schema');
  });
  await t('the door names what it opens and refuses what does not exist', async () => {
    const reg = tr.unifiedRegistry();
    assert.ok(/video_generate/.test(reg.tool_load.schema.function.description), 'the description lists the deferred tools');
    const a = await reg.tool_load.run({ name: 'video_generate' });
    assert.strictEqual(a.ok, true); assert.strictEqual(a.schema.function.name, 'video_generate');
    const b = await reg.tool_load.run({ name: 'no_such_tool' });
    assert.strictEqual(b.ok, false); assert.ok(Array.isArray(b.available) && b.available.includes('video_generate'));
    const c = await reg.tool_load.run({ name: 'tool_load' });
    assert.strictEqual(c.ok, false, 'the door does not load itself');
  });
  await t('a loaded tool is advertised on the next round of the same turn', async () => {
    const seen = [];
    let i = 0;
    const transport = {
      async stream(req) {
        seen.push(names(req.options && req.options.tools || []));
        const n = i++;
        return (async function* () {
          if (n === 0) yield { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool_load', arguments: JSON.stringify({ name: 'video_generate' }) } }] };
          else yield { delta: 'loaded and ready' };
          yield { done: true };
        })();
      },
      abort() {}
    };
    const orch = makeOrchestrator({ transport, faculty_label: 'test' });
    const runner = tr.makeRunner({ agent_id: 'lazy-test', cwd: process.cwd(), user_id: 'u' });
    const res = await orch.composeAgentic(
      { prompt: 'make a video', messages: [{ role: 'user', content: 'make a video' }], options: { tools: tr.coreToolsArray(), max_iterations: 4 } },
      { tool_runner: runner }
    );
    assert.ok(seen.length >= 2, 'two rounds ran: ' + seen.length);
    assert.ok(!seen[0].includes('video_generate'), 'round one had only the core');
    assert.ok(seen[1].includes('video_generate'), 'round two carries the loaded tool: ' + seen[1].join(','));
    assert.ok(seen[1].includes('tool_load'), 'the door stays open');
    assert.ok(/loaded and ready/.test(res.text || ''), 'the turn finished with the engine text: ' + JSON.stringify(res).slice(0, 200));
  });
  console.log('\ntools-lazy: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
