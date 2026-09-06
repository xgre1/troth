// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Background jobs: a long-running shell command started detached, followed
// with job_wait, read with job_status, ended with job_stop. A job is the
// daemon's own process: it outlives the reply and never the daemon (stopAll
// runs on exit). Output goes to a log file under the state dir; a wait returns
// when the job ends or the log grows, so a poll never has to be re-issued.
//
// Road: bare. A job is the daemon's own work and runs with the operator's
// environment, exactly like a foreground command.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KILL_GRACE_MS  = 2000;
const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S     = 120;
const POLL_MS        = 250;
const TAIL_LINES     = 40;
const TAIL_BYTES     = 4096;
const HEAD_CHARS     = 80;

// One job table per process, whichever module instance asks: held on the
// process itself, it survives a cleared module cache.
const G = global.__troth_jobs || (global.__troth_jobs = { jobs: new Map(), seq: 0 });
const jobs = G.jobs;

function jobsDir() {
  // The same data dir state.js resolves: next to the state database.
  let base = process.env.STATE_DB_PATH ? path.dirname(process.env.STATE_DB_PATH) : '';
  if (!base) {
    const plug = String(process.env.CLAUDE_PLUGIN_DATA || '');
    base = (plug && !plug.includes('/.claude/plugins/data/')) ? plug : path.join(os.homedir(), '.troth');
  }
  const dir = path.join(base, 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function head(command) {
  const one = String(command || '').replace(/\s+/g, ' ').trim();
  return one.length > HEAD_CHARS ? one.slice(0, HEAD_CHARS - 1) + '…' : one;
}

function logSize(job) {
  try { return fs.statSync(job.log_path).size; } catch (_) { return 0; }
}

function logTail(job) {
  let fd = null;
  try {
    const size = logSize(job);
    if (!size) return '';
    fd = fs.openSync(job.log_path, 'r');
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-TAIL_LINES).join('\n');
  } catch (_) { return ''; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

function view(job) {
  const end = job.ended_at || Date.now();
  return {
    id:         job.id,
    state:      job.ended_at ? 'done' : 'running',
    exit_code:  job.exit_code,
    signal:     job.signal,
    stopped_by: job.stopped_by || null,
    elapsed_s:  Math.round((end - job.started_at) / 1000),
    command:    head(job.command),
    pid:        job.pid,
    log_path:   job.log_path,
    log_tail:   logTail(job)
  };
}

function signalTree(job, sig) {
  try { process.kill(-job.pid, sig); return true; } catch (_) {}
  try { process.kill(job.pid, sig); return true; } catch (_) {}
  return false;
}

function start(command, ctx) {
  ctx = ctx || {};
  if (typeof command !== 'string' || !command.trim()) {
    return { error: 'bad_args', detail: 'command (string, non-empty) is required' };
  }
  const cwd = ctx.cwd || undefined;
  const id = 'job-' + (++G.seq);
  const log_path = path.join(jobsDir(), id + '-' + process.pid + '.log');
  let fd;
  try { fd = fs.openSync(log_path, 'a'); } catch (e) { return { error: 'log_unwritable', detail: e && e.message || String(e) }; }
  let child;
  try {
    child = spawn('bash', ['-c', command], { stdio: ['ignore', fd, fd], detached: true, cwd });
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) {}
    return { error: 'spawn_failed', detail: e && e.message || String(e) };
  }
  try { fs.closeSync(fd); } catch (_) {}
  const job = { id, pid: child.pid, command, started_at: Date.now(), ended_at: null, exit_code: null, signal: null, log_path, road: 'bare', stopped_by: null };
  jobs.set(id, job);
  if (typeof ctx.on_job_start === 'function') {
    try { ctx.on_job_start(view(job)); } catch (_) {}
  }
  child.on('exit', (code, signal) => {
    job.ended_at = Date.now();
    job.exit_code = typeof code === 'number' ? code : null;
    job.signal = signal || null;
    if (typeof ctx.on_job_end === 'function') {
      try { ctx.on_job_end(view(job)); } catch (_) {}
    }
  });
  child.on('error', (e) => {
    job.ended_at = Date.now();
    job.exit_code = null;
    job.signal = null;
    try { fs.appendFileSync(log_path, '\n[job failed to start: ' + (e && e.message || e) + ']\n'); } catch (_) {}
  });
  child.unref();
  if (typeof ctx.shouldCancel === 'function') {
    const poll = setInterval(() => {
      if (job.ended_at) { clearInterval(poll); return; }
      let asked = false;
      try { asked = !!ctx.shouldCancel(); } catch (_) { asked = false; }
      if (!asked) return;
      clearInterval(poll);
      job.stopped_by = 'operator_cancel';
      signalTree(job, 'SIGTERM');
      const t = setTimeout(() => { if (!job.ended_at) signalTree(job, 'SIGKILL'); }, KILL_GRACE_MS);
      if (t.unref) t.unref();
    }, POLL_MS);
    if (poll.unref) poll.unref();
  }
  return Object.assign({ ok: true, started: true, note: 'follow it with job_wait; it keeps running after this reply' }, { job: view(job) });
}

function get(id) {
  const job = jobs.get(String(id || ''));
  return job || null;
}

function status(args) {
  args = args || {};
  if (args.job_id) {
    const job = get(args.job_id);
    if (!job) return { ok: false, error: 'job_not_found', job_id: String(args.job_id) };
    return { ok: true, job: view(job) };
  }
  const list = [...jobs.values()].map((j) => { const v = view(j); delete v.log_tail; return v; });
  return { ok: true, jobs: list };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function wait(args, ctx) {
  args = args || {}; ctx = ctx || {};
  const job = get(args.job_id);
  if (!job) return { ok: false, error: 'job_not_found', job_id: String(args.job_id || '') };
  const asked = parseInt(args.seconds, 10);
  const seconds = Math.max(1, Math.min(MAX_WAIT_S, isNaN(asked) ? DEFAULT_WAIT_S : asked));
  const size0 = logSize(job);
  const t0 = Date.now();
  let grew = false;
  while (!job.ended_at && Date.now() - t0 < seconds * 1000) {
    if (typeof ctx.shouldCancel === 'function') { let c = false; try { c = !!ctx.shouldCancel(); } catch (_) {} if (c) break; }
    await sleep(POLL_MS);
    if (logSize(job) > size0) { grew = true; break; }
  }
  return { ok: true, waited_s: Math.round((Date.now() - t0) / 1000), grew, job: view(job) };
}

async function stop(args, ctx) {
  args = args || {};
  const job = get(args.job_id);
  if (!job) return { ok: false, error: 'job_not_found', job_id: String(args.job_id || '') };
  if (!job.ended_at) {
    job.stopped_by = (ctx && ctx.reason) || 'job_stop';
    signalTree(job, 'SIGTERM');
    const t0 = Date.now();
    while (!job.ended_at && Date.now() - t0 < KILL_GRACE_MS) await sleep(100);
    if (!job.ended_at) { signalTree(job, 'SIGKILL'); const t1 = Date.now(); while (!job.ended_at && Date.now() - t1 < 1500) await sleep(100); }
  }
  return { ok: true, job: view(job) };
}

// On daemon exit: every running job gets SIGTERM now and SIGKILL after the
// grace, on timers that never hold the process open.
function stopAll(reason) {
  const running = [...jobs.values()].filter((j) => !j.ended_at);
  for (const job of running) {
    job.stopped_by = reason || 'daemon_exit';
    signalTree(job, 'SIGTERM');
    const t = setTimeout(() => { if (!job.ended_at) signalTree(job, 'SIGKILL'); }, KILL_GRACE_MS);
    if (t.unref) t.unref();
  }
  return running.length;
}

const job_wait = {
  schema: { type: 'function', function: {
    name: 'job_wait',
    description: 'Wait for a background job (started with Bash run_in_background). Returns when the job ends, when it prints something new, or after `seconds`; the reply carries its state, exit code and the last lines of its output. Use this instead of re-running a status command.',
    parameters: { type: 'object', properties: {
      job_id:  { type: 'string', description: 'The job id from the start reply, e.g. job-1' },
      seconds: { type: 'integer', description: 'Longest wait in seconds (default 30, max 120)', minimum: 1, maximum: MAX_WAIT_S }
    }, required: ['job_id'] }
  } },
  run: (args, ctx) => wait(args, ctx)
};

const job_status = {
  schema: { type: 'function', function: {
    name: 'job_status',
    description: 'State of a background job without waiting: running or done, exit code, elapsed time, the last lines of its output. Without job_id: every job started this session.',
    parameters: { type: 'object', properties: {
      job_id: { type: 'string', description: 'A job id; omit to list all jobs' }
    } }
  } },
  run: (args) => status(args)
};

const job_stop = {
  schema: { type: 'function', function: {
    name: 'job_stop',
    description: 'End a background job: its whole process group gets SIGTERM, then SIGKILL after two seconds.',
    parameters: { type: 'object', properties: {
      job_id: { type: 'string', description: 'The job id to stop' }
    }, required: ['job_id'] }
  } },
  run: (args, ctx) => stop(args, ctx)
};

module.exports = { start, status, wait, stop, stopAll, job_wait, job_status, job_stop, _jobs: jobs, KILL_GRACE_MS, MAX_WAIT_S };
