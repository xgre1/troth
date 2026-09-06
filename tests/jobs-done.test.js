#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A job tells the turn that started it when it ends: the same view job_status
// gives (state, exit code, the log tail), so a surface can hand it back to the
// partner to say. A job started with no listener ends quietly.
const assert = require('assert');
const path = require('path');
const jobs = require(path.join(__dirname, '..', 'shared-core', 'tools', 'jobs.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(40); return pred(); }

console.log('\n=== a job reports its end ===\n');

(async () => {
  await t('the turn that started a job hears its end with the exit code and the last lines', async () => {
    const ended = [];
    const r = jobs.start('echo finished-line; exit 3', { cwd: process.cwd(), on_job_end: (j) => ended.push(j) });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(await until(() => ended.length > 0, 5000), 'the end arrived');
    assert.strictEqual(ended.length, 1);
    assert.strictEqual(ended[0].id, r.job.id);
    assert.strictEqual(ended[0].state, 'done');
    assert.strictEqual(ended[0].exit_code, 3);
    assert.ok(/finished-line/.test(ended[0].log_tail), ended[0].log_tail);
  });

  await t('a job started with no listener ends quietly', async () => {
    const r = jobs.start('echo quiet', { cwd: process.cwd() });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(await until(() => !!jobs._jobs.get(r.job.id).ended_at, 5000), 'the job ended');
    assert.strictEqual(jobs._jobs.get(r.job.id).exit_code, 0);
  });

  console.log('\njobs-done: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
