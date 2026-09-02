#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The memory's understanding passes run where every install keeps a process
// alive: the proxy's maintenance worker. Pinned at the source, so a task
// list edit cannot silently drop them; the engine budget is what keeps the
// road affordable.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
async function runAll() { for (const [name, fn] of queue) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } } }

console.log('\n=== understanding runs in the proxy ===\n');

const src = fs.readFileSync(path.join(__dirname, '..', 'proxy', 'server.js'), 'utf8');
const listStart = src.indexOf('global.__troth_maintenance = bw.startWorker({');
const listEnd = src.indexOf('cross_process_lease: true', listStart);
const list = src.slice(listStart, listEnd);

t('the proxy maintenance worker carries both understanding tasks', () => {
  assert.ok(listStart > 0 && listEnd > listStart, 'the maintenance block is where it was');
  assert.ok(/bw\.tasks\.workingMemoryConsolidation/.test(list), 'wm_consolidation in the list');
  assert.ok(/bw\.tasks\.instanceConsolidation/.test(list), 'instance_consolidation in the list');
  assert.ok(/TROTH_UNDERSTANDING === '0'/.test(list), 'an off switch exists');
});

t('both names resolve to real tasks in the export map', () => {
  const bw = require('../shared-core/background-worker.js');
  assert.strictEqual(bw.tasks.workingMemoryConsolidation && bw.tasks.workingMemoryConsolidation.name, 'wm_consolidation');
  assert.strictEqual(bw.tasks.instanceConsolidation && bw.tasks.instanceConsolidation.name, 'instance_consolidation');
  assert.strictEqual(typeof bw.tasks.workingMemoryConsolidation.run, 'function');
  assert.strictEqual(typeof bw.tasks.instanceConsolidation.run, 'function');
  // Every name the proxy mounts exists — the proxy's list is read as text
  // and each bw.tasks.<name> is resolved against the module.
  const names = [...list.matchAll(/bw\.tasks\.([A-Za-z]+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 8, 'names found: ' + names.length);
  for (const n of names) assert.ok(bw.tasks[n] && typeof bw.tasks[n].run === 'function', 'bw.tasks.' + n + ' is a task');
});

t('an entry that is not a task never ends the loop', async () => {
  const bw = require('../shared-core/background-worker.js');
  let runs = 0;
  const notes = [];
  const good = { name: 'good', cadence_ms: 1, run: () => { runs++; return { events: [] }; } };
  const thrower = { name: 'thrower', cadence_ms: 1, run: () => { throw new Error('boom'); } };
  const h = bw.startWorker({
    tasks: [undefined, thrower, good, { name: 'nameless' }],
    submit: () => {}, getView: () => ({ substrate_ctx: {} }),
    notify: (n) => notes.push(n),
    idle_threshold_ms: 0, tick_ms: 15, first_tick_jitter_ms: 0
  });
  assert.strictEqual(h.skipped_tasks.length, 2, JSON.stringify(h.skipped_tasks));
  await new Promise((r) => setTimeout(r, 400));
  h.stop();
  assert.ok(runs >= 2, 'the good task kept running: ' + runs);
  assert.strictEqual(h.last_tick_error(), null, 'no cycle-level error');
  assert.ok(notes.some((n) => n.task === 'worker' && /not a task/.test(n.notes.join(' '))), 'the skip was announced');
});

t('the worker view names the operator agent so facts land where recall reads', () => {
  const viewStart = src.indexOf('getView:', listStart);
  const view = src.slice(viewStart, viewStart + 200);
  assert.ok(/resolveAgentId\(\)/.test(view), view);
});

t('the daily engine budget counts, caps and resets by day', () => {
  const ic = require('../shared-core/instance-consolidation.js');
  process.env.TROTH_UNDERSTANDING_DAILY_TURNS = '5';
  const b0 = ic.engineBudget();
  assert.strictEqual(b0.limit, 5);
  const before = b0.used;
  ic.spendEngine(2);
  const b1 = ic.engineBudget();
  assert.strictEqual(b1.used, before + 2);
  assert.strictEqual(b1.remaining, Math.max(0, 5 - before - 2));
  delete process.env.TROTH_UNDERSTANDING_DAILY_TURNS;
  assert.strictEqual(ic.engineBudget().limit, 400);
});

t('the doctor has a line for it', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'troth.js'), 'utf8');
  assert.ok(/name: "Memory understanding"/.test(doc));
});

runAll().then(() => {
  console.log('\nunderstanding-in-proxy: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
