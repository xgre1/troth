// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The operator's stop button for background upkeep.
//
// The drain embeds locally: 51ms of CPU per 800 characters, measured, and a
// backlog of a few thousand passages keeps the fans up for an hour. That is
// the right trade while the machine is idle and the wrong one while its owner
// is on a call, on battery, or watching the laptop cook — and until now the
// only ways to stop it were killing the proxy or setting an environment
// variable and restarting. Neither is a button, and neither is reversible by
// someone who did not build this.
//
// So: one file, one meaning. Its EXISTENCE is the pause; deleting it resumes.
// A file rather than a table because every topology must agree — the proxy's
// maintenance worker, the entity daemon's full worker and the hooks' one-shot
// scheduler are three processes, and a pause honoured by one of them is not a
// pause. It also means an operator whose UI is down can `rm` it, and a crashed
// process can never leave the machine paused in a way nothing can read.
//
// Deliberately NOT a kill switch for memory itself: recall, capture and the
// spool keep working while paused. What stops is only the work that costs
// watts. Whatever queues up during a pause is still there afterwards.
const fs = require('fs');
const path = require('path');
const { trothDir } = require('./troth-home.js');

function gatePath() { return path.join(trothDir(), 'maintenance-paused.json'); }

/** Is background upkeep paused? Cheap enough for a 30s tick and a UI poll. */
function isPaused() {
  try {
    const raw = fs.readFileSync(gatePath(), 'utf8');
    let j = {};
    try { j = JSON.parse(raw) || {}; } catch (_) { j = {}; }
    return {
      paused: true,
      since: Number(j.since) || null,
      by: j.by ? String(j.by) : null,
      reason: j.reason ? String(j.reason) : null
    };
  } catch (_) {
    // Anything unreadable — absent, unparseable, permission-denied — means
    // NOT paused. Fail-open is correct here and only here: the failure mode
    // of a wrong `true` is a substrate that silently stops learning, which is
    // exactly the invisible-stall class of bug this whole card exists to end.
    return { paused: false, since: null, by: null, reason: null };
  }
}

/** Stop background upkeep until someone resumes it. Survives restarts. */
function pause(opts) {
  opts = opts || {};
  try {
    fs.mkdirSync(trothDir(), { recursive: true });
    fs.writeFileSync(gatePath(), JSON.stringify({
      since: Date.now(),
      by: opts.by ? String(opts.by).slice(0, 60) : 'operator',
      reason: opts.reason ? String(opts.reason).slice(0, 200) : null
    }, null, 2), { mode: 0o600 });
    return { ok: true, paused: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Let it run again. Idempotent — resuming what is already running is fine. */
function resume() {
  try { fs.unlinkSync(gatePath()); } catch (_) { /* already running */ }
  return { ok: true, paused: false };
}

module.exports = { isPaused, pause, resume, gatePath };
