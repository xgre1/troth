#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The maintenance worker in its own process. The proxy keeps one of these
// alive so nothing the upkeep does — a document read, an understanding
// pass, an import, a backup — can hold the proxy's event loop while a
// request waits on it.
//
// Protocol, one JSON object per line.
//   in  (stdin):  {kind:'foreground'}  the proxy served a request that counts
//                                       as activity (the worker is idle-gated)
//                 {kind:'status'}      answer with a status line now
//   out (stdout): {kind:'ready',pid,tasks}   {kind:'status',...} every few
//                 seconds   {kind:'note',task,notes}   {kind:'stall',ms,task}
//                 when this process's own loop held past two seconds
//                 {kind:'stopped',why}   {kind:'fatal',error}
// The proxy going away closes stdin, and the worker stops with it.
const readline = require('readline');
const maintenance = require('../shared-core/maintenance.js');

function emit(o) { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (_) {} }

let worker = null;
try {
  worker = maintenance.start({
    notify: (n) => emit({ kind: 'note', task: n.task, notes: n.notes || [], elapsed_ms: n.elapsed_ms })
  });
} catch (e) {
  emit({ kind: 'fatal', error: String(e && e.message || e) });
  process.exit(2);
}

function status() {
  let err = null;
  try { err = worker.last_tick_error(); } catch (_) {}
  return {
    kind: 'status', pid: process.pid,
    skipped_tasks: worker.skipped_tasks || [],
    last_tick_error: err ? String(err && err.message || err) : null,
    task: global.__troth_bg_task || null,
    uptime_s: Math.round(process.uptime())
  };
}

let stopping = false;
function stop(why) {
  if (stopping) return;
  stopping = true;
  try { worker.stop(); } catch (_) {}
  emit({ kind: 'stopped', why });
  setTimeout(() => process.exit(0), 50).unref();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m = null;
  try { m = JSON.parse(line); } catch (_) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.kind === 'foreground') worker.noteForegroundActivity();
  else if (m.kind === 'status') emit(status());
});
rl.on('close', () => stop('stdin closed'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

// A status line every few seconds, and this process's own loop watch.
const STATUS_MS = Math.max(parseInt(process.env.TROTH_MAINT_STATUS_MS || '15000', 10) || 15000, 500);
setInterval(() => emit(status()), STATUS_MS).unref();
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - last - 1000;
  last = now;
  if (lag > 2000) emit({ kind: 'stall', ms: lag, task: global.__troth_bg_task || null });
}, 1000).unref();

emit({ kind: 'ready', pid: process.pid, tasks: (worker._tasks || []).map((t) => t.name) });
