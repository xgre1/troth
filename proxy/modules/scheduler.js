// SPDX-License-Identifier: AGPL-3.0-only
// Scheduler — v6.3
//
// Reads ~/.troth/schedules.json every 60 seconds. When a schedule's
// next fire time has passed, dispatches a troth run via the runner's
// apiCreateRun and updates the last-run timestamp.
//
// Schedule format in schedules.json:
//
//   [
//     {
//       "id": "abc123",
//       "cron": "daily 9:00",         // human-readable, parsed below
//       "task": "review new PRs",
//       "cwd": "/path/to/your/project",
//       "enabled": true,
//       "lastRun": "T09:00:00Z",
//       "createdAt": "T..."
//     }
//   ]
//
// Supported cron expressions (kept simple, no full crontab parser):
//   "daily HH:MM"          — every day at HH:MM local time
//   "hourly"               — every hour at :00
//   "every Nm"             — every N minutes
//   "every Nh"             — every N hours

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const SCHEDULES_FILE = path.join(HOME, '.troth', 'schedules.json');

let runner = null;
let intervalId = null;
let schedules = [];

function loadSchedules() {
  try {
    schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    if (!Array.isArray(schedules)) schedules = [];
  } catch (e) {
    schedules = [];
  }
  return schedules;
}

function saveSchedules() {
  try {
    fs.mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2) + '\n');
  } catch (e) {
    console.error('[scheduler] Could not save schedules:', e.message);
  }
}

// Parse a human-readable cron string into { type, ...params }.
// Returns null if unparseable.
function parseCron(expr) {
  if (!expr || typeof expr !== 'string') return null;
  var s = expr.trim().toLowerCase();

  // "daily HH:MM"
  var daily = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    return { type: 'daily', hour: parseInt(daily[1], 10), minute: parseInt(daily[2], 10) };
  }

  // "hourly"
  if (s === 'hourly') {
    return { type: 'interval', minutes: 60 };
  }

  // "every Nm" or "every N minutes"
  var everyM = s.match(/^every\s+(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (everyM) {
    return { type: 'interval', minutes: parseInt(everyM[1], 10) };
  }

  // "every Nh" or "every N hours"
  var everyH = s.match(/^every\s+(\d+)\s*h(?:ours?)?$/);
  if (everyH) {
    return { type: 'interval', minutes: parseInt(everyH[1], 10) * 60 };
  }

  return null;
}

// Check if a schedule should fire now based on its cron expression
// and lastRun timestamp.
function shouldFire(schedule) {
  if (!schedule.enabled) return false;
  var parsed = parseCron(schedule.cron);
  if (!parsed) return false;

  var now = new Date();
  var lastRun = schedule.lastRun ? new Date(schedule.lastRun) : null;

  if (parsed.type === 'daily') {
    // Fire if current time is past HH:MM and we haven't fired today
    var todayTarget = new Date(now);
    todayTarget.setHours(parsed.hour, parsed.minute, 0, 0);

    if (now < todayTarget) return false; // not yet time today
    if (lastRun && lastRun >= todayTarget) return false; // already ran today
    return true;
  }

  if (parsed.type === 'interval') {
    var intervalMs = parsed.minutes * 60 * 1000;
    if (!lastRun) return true; // never ran
    return (now.getTime() - lastRun.getTime()) >= intervalMs;
  }

  return false;
}

// The main tick — called every 60 seconds by the proxy.
function tick() {
  loadSchedules();
  if (schedules.length === 0) return;

  if (!runner) {
    try { runner = require('../../bin/runner.js'); }
    catch (e) {
      console.error('[scheduler] Cannot load runner:', e.message);
      return;
    }
  }

  for (var i = 0; i < schedules.length; i++) {
    var s = schedules[i];
    if (!shouldFire(s)) continue;

    console.log('[scheduler] Firing schedule "' + s.id + '": ' + s.task);
    try {
      var result = runner.apiCreateRun(s.task, { cwd: s.cwd });
      if (result.ok) {
        console.log('[scheduler] Started run ' + result.runId + ' for schedule ' + s.id);
        s.lastRun = new Date().toISOString();
        s.lastRunId = result.runId;
      } else {
        console.error('[scheduler] Failed to start run for ' + s.id + ':', result.error);
        s.lastError = result.error;
        s.lastErrorAt = new Date().toISOString();
      }
    } catch (e) {
      console.error('[scheduler] Error firing ' + s.id + ':', e.message);
    }
  }

  saveSchedules();
}

// Firing a schedule is not a small thing. tick() calls the runner's
// apiCreateRun, which runs `git worktree add -b troth/<runId>` inside the
// operator's repository and spawns a worker against that worktree with nobody
// watching. Software should not begin doing that merely because a process
// booted, and README's feature matrix promises it does not. So the timer runs
// only when the operator asks for it by name.
//
// The schedule store, the CLI and the API stay available with the timer off:
// they are also the vessel path the partner layer drives deliberately. What is
// gated is the unattended clock, which is the part that acts on its own.
function schedulingEnabled() {
  const v = String(process.env.TROTH_ENABLE_SCHEDULER || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Start the scheduler timer. Called once from server.js at startup.
function start() {
  if (!schedulingEnabled()) {
    // Say it once at boot: an operator with schedules already on disk should
    // not be left wondering why nothing fires.
    const waiting = loadSchedules().filter(function (s) { return s.enabled !== false; }).length;
    if (waiting) {
      console.log('[scheduler] ' + waiting + ' schedule(s) on disk are NOT running. ' +
        'Set TROTH_ENABLE_SCHEDULER=1 to start the timer.');
    }
    return false;
  }
  loadSchedules();
  if (intervalId) return true;
  intervalId = setInterval(tick, 60 * 1000);
  console.log('[scheduler] Started with ' + schedules.length + ' schedule(s). ' +
    'A fired schedule creates a git worktree and runs a worker unattended.');
  return true;
}

// Stop the timer. Exists so a test can assert the gate without leaving a
// 60-second interval behind in the process that ran it.
function stop() {
  if (!intervalId) return false;
  clearInterval(intervalId);
  intervalId = null;
  return true;
}

// API functions for the CLI and dashboard

function addSchedule(cron, task, cwd) {
  var parsed = parseCron(cron);
  if (!parsed) return { ok: false, error: 'Cannot parse cron expression: "' + cron + '". Use: "daily HH:MM", "hourly", "every Nm", "every Nh"' };
  if (!task) return { ok: false, error: 'task is required' };

  loadSchedules();
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var entry = {
    id: id,
    cron: cron,
    task: task,
    cwd: cwd || process.cwd(),
    enabled: true,
    lastRun: null,
    createdAt: new Date().toISOString(),
  };
  schedules.push(entry);
  saveSchedules();
  // Storing a schedule and running one are different acts. Say which one just
  // happened, so nobody walks away believing work is queued that never fires.
  var out = { ok: true, schedule: entry, willFire: schedulingEnabled() };
  if (!out.willFire) {
    out.note = 'Saved, but the scheduler timer is off, so this will not fire. ' +
      'Start the proxy with TROTH_ENABLE_SCHEDULER=1 to run schedules unattended.';
  }
  return out;
}

function listSchedules() {
  loadSchedules();
  return schedules;
}

function removeSchedule(id) {
  loadSchedules();
  var before = schedules.length;
  schedules = schedules.filter(function(s) { return s.id !== id; });
  if (schedules.length === before) return { ok: false, error: 'schedule not found: ' + id };
  saveSchedules();
  return { ok: true };
}

function toggleSchedule(id, enabled) {
  loadSchedules();
  for (var i = 0; i < schedules.length; i++) {
    if (schedules[i].id === id) {
      schedules[i].enabled = !!enabled;
      saveSchedules();
      return { ok: true, schedule: schedules[i] };
    }
  }
  return { ok: false, error: 'schedule not found: ' + id };
}

module.exports = {
  start,
  stop,
  schedulingEnabled,
  tick,
  addSchedule,
  listSchedules,
  removeSchedule,
  toggleSchedule,
  parseCron,
};
