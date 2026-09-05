#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// Background jobs: a long command started detached returns a job id at once;
// job_wait returns when the job ends or prints something new; job_stop and the
// daemon's exit kill the whole process group, so nothing outlives them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const jobs = require(path.join(REPO, 'shared-core', 'tools', 'jobs.js'));
const { REGISTRY } = require(path.join(REPO, 'shared-core', 'tools', 'index.js'));
const permission = require(path.join(REPO, 'shared-core', 'tools', 'permission.js'));
const sp = require(path.join(REPO, 'shared-core', 'tools', 'system-prompt.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = 'job-probe-' + process.pid;
const alive = (m) => String(spawnSync('pgrep', ['-f', m], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).length;

console.log('\n=== background jobs ===\n');

(async () => {
  let first = null;
  await t('a job starts detached and answers at once with an id and a log', async () => {
    const t0 = Date.now();
    const r = jobs.start('sleep 30; echo ' + MARK + '-a', {});
    assert.ok(r.ok && r.job && /^job-\d+$/.test(r.job.id), JSON.stringify(r).slice(0, 200));
    assert.ok(Date.now() - t0 < 1000, 'answered at once');
    assert.strictEqual(r.job.state, 'running');
    assert.ok(fs.existsSync(r.job.log_path), 'the log exists: ' + r.job.log_path);
    first = r.job.id;
    await sleep(300);
    assert.ok(alive(MARK + '-a') > 0, 'the process is running');
  });

  await t('job_status reads without waiting; job_wait waits its seconds while nothing happens', async () => {
    const s = jobs.status({ job_id: first });
    assert.strictEqual(s.job.state, 'running');
    const t0 = Date.now();
    const w = await jobs.wait({ job_id: first, seconds: 1 }, {});
    const ms = Date.now() - t0;
    assert.ok(ms >= 900 && ms < 2500, 'waited about a second: ' + ms);
    assert.strictEqual(w.job.state, 'running');
    assert.strictEqual(w.grew, false);
  });

  await t('job_wait returns early when the job prints something, with the tail', async () => {
    const r = jobs.start('sleep 1; echo hello-' + MARK + '; sleep 30', {});
    const t0 = Date.now();
    const w = await jobs.wait({ job_id: r.job.id, seconds: 20 }, {});
    assert.ok(Date.now() - t0 < 5000, 'returned on output, not on the timeout');
    assert.strictEqual(w.grew, true);
    assert.ok(/hello-/.test(w.job.log_tail), 'the tail carries the line: ' + w.job.log_tail);
    assert.strictEqual(w.job.state, 'running');
  });

  await t('job_wait returns when the job ends, with the exit code', async () => {
    const r = jobs.start('sleep 1; exit 3', {});
    const w = await jobs.wait({ job_id: r.job.id, seconds: 20 }, {});
    assert.strictEqual(w.job.state, 'done');
    assert.strictEqual(w.job.exit_code, 3);
  });

  await t('job_stop ends the whole process group', async () => {
    const s = await jobs.stop({ job_id: first }, {});
    assert.strictEqual(s.job.state, 'done', JSON.stringify(s.job).slice(0, 200));
    assert.strictEqual(s.job.stopped_by, 'job_stop');
    await sleep(300);
    assert.strictEqual(alive(MARK + '-a'), 0, 'nothing left of the job');
  });

  await t('the shell tool starts a job with run_in_background and names the road ahead', async () => {
    const r = await REGISTRY.Bash.run({ command: 'sleep 30; echo ' + MARK + '-b', run_in_background: true }, {});
    assert.ok(r.ok && r.job && r.job.id, JSON.stringify(r).slice(0, 200));
    assert.ok(/job_wait/.test(r.note), r.note);
    assert.strictEqual(jobs.status({}).jobs.filter((j) => j.state === 'running').length >= 2, true, 'two jobs still run');
  });

  await t('an unknown id is named, never a crash', async () => {
    const w = await jobs.wait({ job_id: 'job-999' }, {});
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, 'job_not_found');
  });

  await t('the exit path stops every running job', async () => {
    const n = jobs.stopAll('daemon_exit');
    assert.ok(n >= 2, 'jobs were running: ' + n);
    for (let i = 0; i < 30 && alive(MARK); i++) await sleep(100);
    assert.strictEqual(alive(MARK), 0, 'nothing outlives the daemon');
  });

  await t('waiting and reading are read-only; stopping is a write', async () => {
    assert.strictEqual(permission.classify('job_wait'), 'read');
    assert.strictEqual(permission.classify('job_status'), 'read');
    assert.strictEqual(permission.classify('job_stop'), 'write');
  });

  await t('the prompt names the road for long work where the job tools are available, and only there', async () => {
    const withTools = String(sp.buildSystemPrompt({ agent_id: 'partner', cwd: process.cwd(), available_tools: ['Bash', 'job_wait', 'job_status', 'job_stop'] }));
    assert.ok(/run_in_background/.test(withTools) && /job_wait/.test(withTools), 'the prompt names run_in_background and job_wait');
    const without = String(sp.buildSystemPrompt({ agent_id: 'partner', cwd: process.cwd(), available_tools: ['Read'] }));
    assert.ok(!/job_wait/.test(without), 'no phantom road without the tools');
    const text = withTools;
    assert.ok(!/NO background execution/.test(text), 'the old denial is gone');
  });

  console.log('\nshell-jobs: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
