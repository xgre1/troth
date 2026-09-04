#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The scheduler's cadence survives the process. Both runners now share one
// persisted ledger; this holds the contract: a recorded run is visible to the
// NEXT process before any task fires.

require('./hermetic-db.js');
const assert = require('assert');
const crypto = require('crypto');
const bw = require('../shared-core/background-worker.js');
const state = require('../shared-core/state.js');

const cwd = process.cwd();

// A world where nothing ever ran: every task is due.
let m = bw.hydrateLastRunFromRecords(cwd);
assert.strictEqual(m.get('backup') || 0, 0, 'empty ledger must read as never-ran');

// One recorded run — the exact shape both runners write.
state.recordAction({
  id: crypto.randomUUID(), timestamp: Date.now(), type: 'decision',
  agent_id: 'scheduler-test', cwd,
  input: { kind: 'background_task_run', task: 'backup', signals: { scheduler: true } },
  output: { decision: 'ran', reason: 'startWorker' }
});

// A "restart": a fresh read of the ledger sees it, so backup is not due.
m = bw.hydrateLastRunFromRecords(cwd);
const age = Date.now() - (m.get('backup') || 0);
assert.ok(age >= 0 && age < 60000, 'restart must inherit the recorded run, got age=' + age);

// Unrelated cwd stays isolated — another project's runs are not ours.
const other = bw.hydrateLastRunFromRecords('/nonexistent/other-project');
assert.strictEqual(other.get('backup') || 0, 0, 'ledger is per-cwd');

console.log('PASS background-scheduler-ledger: cadence survives restart, per-cwd');
