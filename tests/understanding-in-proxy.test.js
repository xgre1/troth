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
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

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

console.log('\nunderstanding-in-proxy: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
