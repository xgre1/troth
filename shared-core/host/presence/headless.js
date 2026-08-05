// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// host.presence fallback backend — server/headless presence derived from
// control-channel + scheduled night window, with NO native idle source. The
// real backend (presence/macos.js, the troth-presence-macos Swift daemon,
// the presence layer) provides true operator_present/seconds_idle from the OS.
//
// Until then this gives the continuous-life loop a usable, fail-safe presence
// signal: it never claims the operator is deep-asleep unless the configured
// night window says so AND there has been no recent control-channel activity.
// Conservative by design — a wrong "present" only suppresses autonomy (safe);
// a wrong "deep_asleep" could let autonomy run while the operator is active
// (unsafe), so we bias toward "present".

let _lastActivityMs = 0;

// Called by the control channel on any operator-signed request so headless
// presence has a real "operator was here" signal.
function noteActivity(tsMs) {
  _lastActivityMs = typeof tsMs === 'number' ? tsMs : Date.now();
}

function _nightWindow() {
  // TROTH_NIGHT_WINDOW="23-7" (start-end hours, local). Empty → never night.
  const raw = process.env.TROTH_NIGHT_WINDOW || '';
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  return { start: Number(m[1]) % 24, end: Number(m[2]) % 24 };
}

function _inNightWindow(now) {
  const w = _nightWindow();
  if (!w) return false;
  const h = now.getHours();
  return w.start <= w.end ? (h >= w.start && h < w.end) : (h >= w.start || h < w.end);
}

module.exports = {
  name: 'headless',
  noteActivity,

  probe() {
    return { backend: 'headless', available: true, native_idle: false };
  },

  // { operator_present, seconds_idle, deep_asleep }
  state(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const idleMs = _lastActivityMs ? Math.max(0, now - _lastActivityMs) : Infinity;
    const seconds_idle = idleMs === Infinity ? null : Math.round(idleMs / 1000);
    const RECENT_MS = 5 * 60 * 1000; // active within 5 min = present
    const recentlyActive = idleMs < RECENT_MS;
    const night = _inNightWindow(new Date(now));
    // deep_asleep only if it's the night window AND no recent activity.
    const deep_asleep = night && !recentlyActive;
    // present if recently active, OR (conservatively) not deep-asleep.
    const operator_present = recentlyActive || !deep_asleep;
    return { operator_present, seconds_idle, deep_asleep, source: 'headless' };
  },

  // Dead-man-switch lives in the existing presence.js (presence_proof). The
  // host.presence contract exposes it via the active backend; headless
  // delegates to the substrate presence module.
  deadManSwitch() {
    try { return require('../../presence.js'); } catch (_) { return null; }
  },
};
