#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A stopped turn ends the background jobs it started: the job's process group
// gets SIGTERM within the poll interval and the job reads stopped_by
// operator_cancel. A job started by another turn, or one started with no stop
// hook, keeps running until job_stop or the daemon's exit.
const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');
const SHARED = path.join(__dirname, '..', 'shared-core');
const jobs = require(path.join(SHARED, 'tools', 'jobs.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = 'troth-jobs-cancel-probe-' + process.pid;
// Two lines, so bash stays resident with the marker in its argv instead of
// exec'ing sleep and losing it.
const probe = (tag) => 'sleep 30 # ' + MARK + '-' + tag + '\necho done';
function alive(tag) { try { return execSync('pgrep -f "' + MARK + '-' + tag + '" || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch (_) { return -1; }
}
function turn() {
  const c = { cancelled: false };
  return { ctx: { cwd: process.cwd(), shouldCancel: () => c.cancelled }, stop: () => { c.cancelled = true; } };
}
async function untilEnded(id, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = jobs._jobs.get(id);
    if (j && j.ended_at) return j;
    await sleep(100);
  }
  return jobs._jobs.get(id);
}

console.log('\n=== a stopped turn ends the jobs it started ===\n');
(async () => {
  await t('the job of a stopped turn ends within the grace period', async () => {
    const a = turn();
    const r = jobs.start(probe('one'), a.ctx);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
    await sleep(500);
    assert.ok(alive('one') >= 1, 'the job is running before the stop');
    const t0 = Date.now();
    a.stop();
    const j = await untilEnded(r.job.id, 5000);
    const ms = Date.now() - t0;
    assert.ok(j && j.ended_at, 'the job ended after the stop');
    assert.strictEqual(j.stopped_by, 'operator_cancel');
    assert.ok(ms < 4000, 'it ended within the grace period: ' + ms + ' ms');
    await sleep(300);
    assert.strictEqual(alive('one'), 0, 'nothing under the job survives');
  });

  await t('a job started by another turn keeps running', async () => {
    const a = turn(), b = turn();
    const ra = jobs.start(probe('keep'), a.ctx);
    const rb = jobs.start(probe('drop'), b.ctx);
    await sleep(500);
    b.stop();
    const jb = await untilEnded(rb.job.id, 5000);
    assert.ok(jb && jb.ended_at, 'the stopped turn\'s job ended');
    assert.ok(alive('keep') >= 1, 'the other turn\'s job is still running');
    const ja = jobs._jobs.get(ra.job.id);
    assert.ok(ja && !ja.ended_at && !ja.stopped_by, 'and was never marked stopped');
    await jobs.stop({ job_id: ra.job.id }, { reason: 'test_cleanup' });
    await sleep(300);
    assert.strictEqual(alive('keep'), 0, 'cleanup ended it');
  });

  await t('a job started with no stop hook is left alone', async () => {
    const r = jobs.start(probe('bare'), { cwd: process.cwd() });
    await sleep(800);
    assert.ok(alive('bare') >= 1, 'still running');
    await jobs.stop({ job_id: r.job.id }, { reason: 'test_cleanup' });
    await sleep(300);
    assert.strictEqual(alive('bare'), 0, 'cleanup ended it');
  });

  console.log('\njobs-cancel: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
