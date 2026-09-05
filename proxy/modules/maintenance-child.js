// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The proxy's side of the maintenance worker: starts bin/troth-maintenance.js,
// reads its lines into the proxy log, keeps it alive (an exit starts it
// again after a pause that grows while it keeps failing, capped), and
// presents the handle the proxy already reads — noteForegroundActivity(),
// skipped_tasks, last_tick_error(), stop() — so the readiness view and the
// doctor see the worker the same way whichever process hosts it.
const path = require('path');
const readline = require('readline');
const spawnPurpose = require('../../shared-core/tools/spawn-purpose.js');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'troth-maintenance.js');
const RESTART_MIN_MS = 5000;
const RESTART_MAX_MS = 5 * 60 * 1000;
const STEADY_MS = 10 * 60 * 1000;
const FOREGROUND_EVERY_MS = 2000;

function start(opts) {
  opts = opts || {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  // The worker only USES the embedder; the proxy owns starting it, so two
  // processes never race to spawn one server on one port.
  const env = Object.assign({}, process.env, { TROTH_EMBED_SPAWN: '0' }, opts.env || {});
  const entry = opts.entry || ENTRY;
  let child = null, stopped = false, restarts = 0, pauseMs = RESTART_MIN_MS, restartTimer = null;
  let lastStatus = null, lastNote = null, lastForeground = 0, startedAt = 0;
  let taskNames = [], runSeq = 0;
  const pendingRuns = new Map();
  const readyWaiters = [];
  const RUN_WAIT_MS = Math.max(parseInt(process.env.TROTH_MAINT_RUN_WAIT_MS || '600000', 10) || 600000, 1000);

  function send(o) {
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (_) {}
  }

  function spawnOnce() {
    if (stopped) return;
    startedAt = Date.now();
    try {
      child = spawnPurpose.spawn('maintenance', process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      child = null;
      log('Maintenance worker could not start: ' + (e && e.message || e));
      scheduleRestart();
      return;
    }
    const pid = child.pid;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let m = null;
      try { m = JSON.parse(line); } catch (_) { m = null; }
      if (!m || typeof m !== 'object') { if (line.trim()) log('[maintenance] ' + line.trim()); return; }
      if (m.kind === 'status') { lastStatus = Object.assign({ _at: Date.now() }, m); return; }
      if (m.kind === 'note') { lastNote = Object.assign({ _at: Date.now() }, m); log('[maintenance] ' + m.task + ': ' + (m.notes || []).join(' | ')); return; }
      if (m.kind === 'ready') {
        taskNames = Array.isArray(m.tasks) ? m.tasks.slice() : [];
        log('Maintenance worker up beside the loop (pid ' + m.pid + ', ' + taskNames.length + ' tasks)');
        const waiting = readyWaiters.splice(0);
        for (const w of waiting) { clearTimeout(w.timer); w.resolve(true); }
        return;
      }
      if (m.kind === 'ran') {
        const p = pendingRuns.get(String(m.id));
        if (!p) return;
        pendingRuns.delete(String(m.id));
        clearTimeout(p.timer);
        p.resolve({ ok: !!m.ok, task: m.task || null, notes: Array.isArray(m.notes) ? m.notes : [], events: m.events || 0, ms: m.ms || 0, error: m.error || null, tasks: Array.isArray(m.tasks) ? m.tasks : undefined });
        return;
      }
      if (m.kind === 'stall') { log('[maintenance] WORKER STALL ' + m.ms + 'ms | task: ' + (m.task || '-')); return; }
      if (m.kind === 'fatal') { log('Maintenance worker failed: ' + m.error); return; }
    });
    child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('[maintenance] ' + s.slice(0, 400)); });
    child.on('error', (e) => log('Maintenance worker error: ' + (e && e.message || e)));
    child.on('exit', (code, signal) => {
      child = null;
      for (const [id, p] of pendingRuns) { clearTimeout(p.timer); p.reject(new Error('maintenance worker exited while running the task')); pendingRuns.delete(id); }
      if (stopped) return;
      log('Maintenance worker exited (pid ' + pid + ', code ' + code + (signal ? ', ' + signal : '') + ')');
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    // A worker that ran a good while earns a short pause again; one that
    // keeps dying waits longer each time, up to the cap.
    if (Date.now() - startedAt > STEADY_MS) pauseMs = RESTART_MIN_MS;
    restarts++;
    restartTimer = setTimeout(() => { restartTimer = null; spawnOnce(); }, pauseMs);
    restartTimer.unref();
    pauseMs = Math.min(pauseMs * 2, RESTART_MAX_MS);
  }

  spawnOnce();

  return {
    process: 'child',
    get pid() { return child ? child.pid : null; },
    get restarts() { return restarts; },
    get skipped_tasks() { return (lastStatus && lastStatus.skipped_tasks) || []; },
    last_tick_error: () => (lastStatus && lastStatus.last_tick_error) || null,
    status: () => ({
      process: 'child', alive: !!child, pid: child ? child.pid : null, restarts,
      task: (lastStatus && lastStatus.task) || null,
      last_status_at: lastStatus ? lastStatus._at : null,
      last_note: lastNote ? (lastNote.task + ': ' + (lastNote.notes || []).join(' | ')) : null,
      last_note_at: lastNote ? lastNote._at : null
    }),
    noteForegroundActivity: () => {
      const now = Date.now();
      if (now - lastForeground < FOREGROUND_EVERY_MS) return;
      lastForeground = now;
      send({ kind: 'foreground' });
    },
    askStatus: () => send({ kind: 'status' }),
    // The task names the worker announced when it came up.
    tasks: () => taskNames.slice(),
    // Resolves once the worker has announced its tasks, or after the wait.
    whenReady: (ms) => new Promise((resolve) => {
      if (taskNames.length || (!child && !restartTimer)) { resolve(taskNames.length > 0); return; }
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => { const i = readyWaiters.indexOf(w); if (i >= 0) readyWaiters.splice(i, 1); resolve(false); }, ms || 10000);
      w.timer.unref();
      readyWaiters.push(w);
    }),
    // Run one task now, by name, outside its cadence: the worker answers
    // with the task's own notes. Resolves { ok, notes, ms } or { ok:false,
    // error, tasks } for a name it does not know; rejects when the worker
    // is away or does not answer within the wait.
    runTask: (name, timeout_ms) => new Promise((resolve, reject) => {
      if (!child) { reject(new Error('maintenance worker is not running')); return; }
      const id = String(++runSeq);
      const timer = setTimeout(() => {
        pendingRuns.delete(id);
        reject(new Error('maintenance worker did not answer within ' + Math.round((timeout_ms || RUN_WAIT_MS) / 1000) + 's'));
      }, timeout_ms || RUN_WAIT_MS);
      timer.unref();
      pendingRuns.set(id, { resolve, reject, timer });
      send({ kind: 'run', id, task: String(name || '') });
    }),
    stop: () => {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (child) {
        try { child.stdin.end(); } catch (_) {}
        try { child.kill('SIGTERM'); } catch (_) {}
      }
    }
  };
}

module.exports = { start, ENTRY };
