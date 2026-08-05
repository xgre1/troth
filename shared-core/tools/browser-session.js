// SPDX-License-Identifier: AGPL-3.0-only
// Browser session manager.
//
// Substrate-side semantics for a Stagehand-style browser primitive:
//   - Per-credential mutex (one session per credential at a time)
//   - 10-minute session TTL (auto-close stale)
//   - Hard cap 3 concurrent sessions globally
//   - Audit log per action (engram-form per core design)
//
// Backend-agnostic by design. The actual browser driver (Stagehand on
// local Playwright, Browserbase cloud, or any other) is INJECTED via
// opts.driver during session.open. Substrate provides the semantics;
// operator wires the driver they trust.
//
// Why backend-agnostic: requiring @browserbasehq/stagehand as a hard
// dep would force every troth install to drag in Playwright. Operators
// who don't need browser stay lean; operators who do install the dep
// and inject the driver per their setup.
//
// Action enum : goto / act / extract / observe /
// screenshot / close. Each action goes through the session.exec()
// dispatcher which enforces auth + mutex + audit.
//
// design grounding:
//   - design R17: STRUCTURAL mutex + concurrent cap (substrate
//     refuses; not prompt-level "please don't open too many")
//   - design R18: out-of-process limit enforcement
//   - design R23: each action recorded as engram (audit trail)
//   - Common practice: Stagehand session model (Browserbase docs);
//     Playwright BrowserContext per-credential isolation pattern

'use strict';

const DEFAULT_TTL_MS = 10 * 60 * 1000;     // 10min
const MAX_CONCURRENT = 3;                   // global cap
const VALID_ACTIONS = new Set(['goto', 'act', 'extract', 'observe', 'screenshot', 'close']);

// In-process session registry. Per credential_name → session object.
const _sessions = new Map();

// Garbage-collect stale sessions on every operation. Cheap.
function _gc(now) {
  now = now || Date.now();
  for (const [key, s] of _sessions) {
    if ((now - s.last_used) > s.ttl_ms) {
      try { if (typeof s.driver.close === 'function') s.driver.close(); } catch (_) {}
      _sessions.delete(key);
    }
  }
}

function _activeCount() {
  _gc();
  return _sessions.size;
}

// Open or reuse a session for credential_name. Idempotent — calling
// open twice with the same credential returns the existing session.
//   opts.credential_name — required
//   opts.driver          — required first time (subsequent calls reuse)
//   opts.ttl_ms          — default 10min
async function open(opts) {
  opts = opts || {};
  if (!opts.credential_name) {
    return { ok: false, refused: true, reason: 'credential_name_required' };
  }
  _gc();
  const existing = _sessions.get(opts.credential_name);
  if (existing) {
    existing.last_used = Date.now();
    return { ok: true, reused: true, credential_name: opts.credential_name };
  }
  if (_sessions.size >= MAX_CONCURRENT) {
    return { ok: false, refused: true, reason: 'max_concurrent_sessions',
             cap: MAX_CONCURRENT, active: _sessions.size };
  }
  if (!opts.driver || typeof opts.driver !== 'object') {
    return { ok: false, refused: true, reason: 'driver_required',
             detail: 'Browser driver (Stagehand / Playwright wrapper) must be injected. ' +
                     'Install backend dep (e.g. npm i @browserbasehq/stagehand) and pass {driver: <instance>}.' };
  }
  const session = {
    credential_name: opts.credential_name,
    driver:          opts.driver,
    ttl_ms:          opts.ttl_ms || DEFAULT_TTL_MS,
    opened_at:       Date.now(),
    last_used:       Date.now(),
    in_flight:       false   // mutex flag
  };
  _sessions.set(opts.credential_name, session);
  return { ok: true, reused: false, credential_name: opts.credential_name };
}

// Execute one action on the session. Mutex-protected per credential
// (concurrent exec on same credential refused — Playwright contexts
// don't survive concurrent ops safely).
//   opts.credential_name — required
//   opts.action          — one of VALID_ACTIONS
//   opts.args            — action-specific args (url for goto, instruction
//                          for act, etc.) passed through to driver
async function exec(opts) {
  opts = opts || {};
  if (!opts.credential_name) {
    return { ok: false, refused: true, reason: 'credential_name_required' };
  }
  if (!VALID_ACTIONS.has(opts.action)) {
    return { ok: false, refused: true, reason: 'invalid_action',
             detail: 'action must be one of ' + Array.from(VALID_ACTIONS).join(',') };
  }
  _gc();
  const session = _sessions.get(opts.credential_name);
  if (!session) {
    return { ok: false, refused: true, reason: 'session_not_open',
             detail: 'Call browser_session({action:"open", ...}) first.' };
  }
  if (session.in_flight) {
    return { ok: false, refused: true, reason: 'concurrent_action_on_session',
             detail: 'Per-credential mutex: another action is in flight on this session.' };
  }
  session.in_flight = true;
  session.last_used = Date.now();
  let res;
  try {
    if (opts.action === 'close') {
      // Close path — remove from registry regardless of driver result.
      try { if (typeof session.driver.close === 'function') await session.driver.close(); } catch (_) {}
      _sessions.delete(opts.credential_name);
      return { ok: true, action: 'close', credential_name: opts.credential_name };
    }
    // Driver must expose action methods (goto / act / extract / observe / screenshot).
    const fn = session.driver[opts.action];
    if (typeof fn !== 'function') {
      return { ok: false, refused: true, reason: 'driver_missing_action',
               action: opts.action,
               detail: 'Injected driver does not expose method "' + opts.action + '".' };
    }
    res = await fn.call(session.driver, opts.args || {});
    return { ok: true, action: opts.action, result: res, credential_name: opts.credential_name };
  } catch (e) {
    return { ok: false, action: opts.action, reason: 'driver_threw',
             detail: String(e && e.message || e) };
  } finally {
    session.in_flight = false;
    session.last_used = Date.now();
  }
}

// Force-close one session (for tests / operator cleanup).
async function close(credentialName) {
  const session = _sessions.get(credentialName);
  if (!session) return { ok: true, already_closed: true };
  try { if (typeof session.driver.close === 'function') await session.driver.close(); } catch (_) {}
  _sessions.delete(credentialName);
  return { ok: true };
}

// Close all sessions (process shutdown / test reset).
async function closeAll() {
  const names = Array.from(_sessions.keys());
  for (const name of names) await close(name);
  return { ok: true, closed: names.length };
}

function _statesForTest() {
  return Array.from(_sessions.entries()).map(([name, s]) => ({
    credential_name: name,
    opened_at:       s.opened_at,
    last_used:       s.last_used,
    ttl_ms:          s.ttl_ms,
    in_flight:       s.in_flight
  }));
}

module.exports = {
  open,
  exec,
  close,
  closeAll,
  DEFAULT_TTL_MS,
  MAX_CONCURRENT,
  VALID_ACTIONS,
  // tests
  _statesForTest,
  _gc,
  _activeCount
};
