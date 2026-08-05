// SPDX-License-Identifier: AGPL-3.0-only
// Global pause / kill-switch.
//
// Operator-signed emergency brake. When a global_pause engram is the
// current authority (not superseded by a global_resume), the
// not_globally_paused STVC predicate refuses all transitions tagged
// for dispatch. This is the structural kill-switch the operator must
// have before any dispatcherer ships: otherwise a runaway partner can
// only be stopped by killing the substrate process (and would resume
// from WAL on restart).
//
// Granularity:
//   - global_pause      → halts ALL dispatch
//   - scope_pause:<glob> → halts dispatch whose scope matches the glob
//
// Both are operator_confirmed engrams, signed via operator-key.js.
// Resume = a global_resume / scope_resume engram that supersedes the
// matching pause (tier-constrained supersedes / integration point protects this:
// only operator_confirmed writes can retire operator_confirmed pauses).
//
// STVC predicate: `not_globally_paused` evaluates against the proposed
// transition. The Phase 1.5 wiring covers global pause; scope-glob
// matching arrives when dispatcherers ship (Phase 2+).

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');

const GLOBAL_PAUSE_SCOPE  = 'global_pause';
const GLOBAL_RESUME_SCOPE = 'global_resume';

// Find the most recent global_pause that has NOT been superseded by a
// global_resume written after it. The model: pause and resume are
// paired markers; whichever is newer wins. Tier-constrained supersedes
// already prevents non-operator writes from forging either side.
function _activePauseEngram() {
  try {
    const pauses  = engram.listEngrams({
      principal: null, audience: 'all', scope: GLOBAL_PAUSE_SCOPE,  limit: 5
    }) || [];
    const resumes = engram.listEngrams({
      principal: null, audience: 'all', scope: GLOBAL_RESUME_SCOPE, limit: 5
    }) || [];
    if (!pauses.length) return null;
    const newestPause  = pauses[0];
    const newestResume = resumes[0] || null;
    // Strictly newer, on purpose. Engram timestamps have millisecond
    // resolution, so a pause and a resume written inside the same millisecond
    // are indistinguishable in time, and engram ids do not order reliably
    // within a millisecond either (measured: insertion order matched id order
    // in 12 of 28 same-millisecond pairs). Something has to break the tie, and
    // for a kill switch the only defensible tie-break is to stay stopped: a
    // resume that cannot be proven to come after the pause does not lift it.
    // The practical rule is that a resume must land at least one millisecond
    // after the pause it lifts, which a human operating a kill switch always
    // does, and a test racing the two must not assume otherwise.
    if (newestResume && newestResume.ts > newestPause.ts) return null;
    return newestPause;
  } catch (_) { return null; }
}

function isPaused() {
  return !!_activePauseEngram();
}

function activePause() {
  return _activePauseEngram();
}

// A resume must be able to prove it came after the pause it lifts. Engram
// timestamps have millisecond resolution and ids do not order reliably inside a
// millisecond, so when the two land together the reader keeps the system
// stopped (the safe tie-break). Rather than leave that to chance, the writer
// waits for the clock to move past the pause it is superseding. Costs at most a
// millisecond, and only when a resume follows a pause that quickly.
function _waitPastMs(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return;
  // Capped. Normally this waits under a millisecond, because the pause it is
  // superseding is already in the past. But a clock that steps backwards (NTP
  // correction, a resumed VM) or a marker written with a future timestamp would
  // otherwise spin the event loop at full CPU until the wall clock caught up,
  // and it would do it on the resume path, which is the one path that must
  // never hang. Past the cap it gives up and writes anyway: the reader's
  // tie-break then keeps the system paused, which is the safe outcome, and the
  // operator can resume again a moment later.
  const deadline = Date.now() + 50;
  while (Date.now() <= ts && Date.now() < deadline) { /* sub-millisecond in practice */ }
}

// Helper for callers (CLI, dashboard) to sign + write a pause / resume.
// Returns { ok, id } or { ok:false, error }.
function _writeSignedMarker(scope, statement, signer, opts) {
  opts = opts || {};
  const extra_output = opts.reason
    ? { reason: String(opts.reason).slice(0, 500) }
    : {};
  const canon = opKey.canonicalEngramBody({
    statement, scope, source_authority: 'operator_confirmed', extra_output
  });
  const signature = signer.sign(canon);
  if (scope === GLOBAL_RESUME_SCOPE) {
    const active = _activePauseEngram();
    if (active) _waitPastMs(active.ts);
  }
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'operator',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || 'operator',
    statement,
    source:   opts.source || ('troth-' + (scope === GLOBAL_PAUSE_SCOPE ? 'pause' : 'resume')),
    source_authority: 'operator_confirmed',
    scope,
    signature,
    extra_output,
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'write_refused' };
  return { ok: true, id };
}

function pause(signer, opts) {
  return _writeSignedMarker(
    GLOBAL_PAUSE_SCOPE,
    'global pause asserted by operator',
    signer,
    opts || {}
  );
}

function resume(signer, opts) {
  return _writeSignedMarker(
    GLOBAL_RESUME_SCOPE,
    'global pause resumed by operator',
    signer,
    opts || {}
  );
}

// STVC predicate. Invoked via state-machine.PREDICATE_KINDS lookup.
// Registered with kind='not_globally_paused'.
//
// Predicate body: { kind: 'not_globally_paused' }
// Semantics: returns 'globally_paused' string when pause is active,
// otherwise null (pass). Used by dispatchers to refuse to fire any
// intent while the substrate is paused.
function predicate(_pred, _ctx) {
  if (isPaused()) {
    const eng = _activePauseEngram();
    // listEngrams projects `reason` onto the top-level row (autonomous step
    // 1.4 projection addition). Fall back to .output.reason for
    // forward-compat in case the projection contract changes.
    const reason = (eng && eng.reason) ||
                   (eng && eng.output && eng.output.reason) ||
                   '(no reason recorded)';
    return 'globally_paused: ' + reason;
  }
  return null;
}

module.exports = {
  isPaused,
  activePause,
  pause,
  resume,
  predicate,
  GLOBAL_PAUSE_SCOPE,
  GLOBAL_RESUME_SCOPE
};
