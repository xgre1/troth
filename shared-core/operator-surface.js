// SPDX-License-Identifier: AGPL-3.0-only
// Operator surface protocol.
//
// Push channel from partner to operator. Four urgency tiers, each
// capability-gated so the partner can't escalate beyond what the
// operator pre-authorized.
//
//   info       — collected, surfaced on next foreground tick summary
//                (e.g., "since we last spoke I observed X, Y, Z")
//   notify     — push via configured channel (terminal notification,
//                push, email digest), no interrupt
//   interrupt  — desktop modal / phone vibrate — gets attention now
//   wake       — phone ringing 3am — life-or-death only
//
// Default capabilities give the partner ONLY info + notify. interrupt
// + wake require explicit operator-confirmed capability grants — they
// are reserved for things like "the deploy you authorized just failed,
// the prod site is down" not "the build I was working on finished".
//
// The 4-tier biorhythm respect (Addendum Part 2 §Biorhythm) is enforced
// at PUSH-CHANNEL ROUTING time (a future channels module), not here.
// This module's STVC predicate gates which urgency tier the partner is
// ALLOWED to emit — channel routing then decides whether to deliver
// based on operator_calendar + do-not-disturb windows.
//
// Engram shape:
//   class: commitment (engram default)
//   scope: 'operator_surface'
//   source_authority: 'llm_inferred' (partner is the writer)
//   extra_output: {
//     urgency:      'info' | 'notify' | 'interrupt' | 'wake'
//     subject:      one-line summary
//     body:         optional long-form
//     intent_ref:   optional engram_id pointing at an intent that
//                   triggered this surface (e.g., seal request)
//     surface_kind: 'observation' | 'seal_request' | 'budget_alert' |
//                   'completion' | 'error' | 'idle_report' (extensible)
//     consumed:     boolean — flipped to true by operator-side reader
//                   (CLI `troth inbox`, dashboard) so info-tier rows
//                   don't keep re-surfacing.
//   }

'use strict';

const engram = require('./engram.js');

const OPERATOR_SURFACE_SCOPE = 'operator_surface';

const URGENCY_RANK = { info: 1, notify: 2, interrupt: 3, wake: 4 };

function _isValidUrgency(u) { return u in URGENCY_RANK; }

// Default urgency capabilities every operator gets at bootstrap. The
// design note's design: info + notify by default, interrupt + wake only
// via explicit operator-confirmed capability minting.
const DEFAULT_PARTNER_MAX_URGENCY = 'notify';

// Write an operator_surface engram. Returns { ok, id, urgency } or
// { ok:false, error }.
function recordOperatorSurface(opts) {
  opts = opts || {};
  const urgency = opts.urgency || 'info';
  if (!_isValidUrgency(urgency)) {
    return { ok: false, error: 'bad_urgency_value', detail: 'must be info|notify|interrupt|wake' };
  }
  const subject = opts.subject ? String(opts.subject).slice(0, 200) : null;
  if (!subject) return { ok: false, error: 'subject_required' };
  const body = opts.body ? String(opts.body).slice(0, 4000) : null;
  const extra_output = {
    urgency,
    subject,
    body,
    intent_ref:   opts.intent_ref || null,
    surface_kind: opts.surface_kind || 'observation',
    consumed:     false,
    created_at_ms: Date.now()
  };
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'partner',
    user_id:  opts.user_id  || 'operator',
    cwd:      opts.cwd      || null,
    statement: '[' + urgency + '] ' + subject,
    source:   'operator-surface.recordOperatorSurface',
    source_authority: 'llm_inferred',   // partner authors, never operator-tier
    scope:    OPERATOR_SURFACE_SCOPE,
    extra_output,
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'surface_write_refused' };
  return { ok: true, id, urgency };
}

// List recent operator_surface engrams (most-recent first). Filters by
// urgency tier or consumed status when opts set.
function listOperatorSurface(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(200, opts.limit || 25));
  try {
    const pool = engram.listEngrams({
      principal: null, audience: 'all',
      scope: OPERATOR_SURFACE_SCOPE, limit: limit * 3
    }) || [];
    let rows = pool;
    if (opts.urgency) {
      const allowed = new Set(Array.isArray(opts.urgency) ? opts.urgency : [opts.urgency]);
      rows = rows.filter(r => allowed.has(_urgencyOf(r)));
    }
    if (opts.unconsumed_only) {
      rows = rows.filter(r => !_consumedOf(r));
    }
    return rows.slice(0, limit);
  } catch (_) { return []; }
}

function _urgencyOf(row) {
  // listEngrams projection doesn't currently surface the urgency
  // field by name; it's inside extra_output. We added a simple
  // statement prefix '[urgency] subject' as a fallback parsing target.
  const stmt = row && row.statement;
  if (typeof stmt === 'string') {
    const m = stmt.match(/^\[(info|notify|interrupt|wake)\]/);
    if (m) return m[1];
  }
  return 'info';
}
function _consumedOf(row) {
  // Same projection gap — for v1 we treat unprojected as unconsumed.
  // implementation step dashboard will read raw via state.getAction.
  return false;
}

// STVC predicate: surface_urgency_within_capability. Gates which
// urgency tier the partner can emit. Looks for an active
// capability:operator_surface:<max_urgency> engram; defaults to
// 'notify' when none present.
//
// Predicate body: { kind: 'surface_urgency_within_capability' }
// Silent pass for non-operator_surface scopes.
function _maxAllowedUrgency() {
  // Find capability engrams whose scope matches operator_surface
  // urgency grant.
  try {
    const pool = engram.listEngrams({
      principal: null, audience: 'all', limit: 300
    }) || [];
    let best = URGENCY_RANK[DEFAULT_PARTNER_MAX_URGENCY];
    let bestName = DEFAULT_PARTNER_MAX_URGENCY;
    for (const e of pool) {
      if (typeof e.scope !== 'string') continue;
      if (e.scope.indexOf('capability:operator_surface:') !== 0) continue;
      if (e.revoked) continue;
      if (typeof e.expiry === 'number' && e.expiry > 0 && e.expiry < Date.now()) continue;
      const tail = e.scope.slice('capability:operator_surface:'.length);
      const r = URGENCY_RANK[tail];
      if (r && r > best) { best = r; bestName = tail; }
    }
    return bestName;
  } catch (_) {
    return DEFAULT_PARTNER_MAX_URGENCY;
  }
}

function predicate(_pred, ctx) {
  const r = ctx.proposed || {};
  const out = (r.output && typeof r.output === 'object') ? r.output : null;
  const scope = (out && out.scope) || r.scope || null;
  if (scope !== OPERATOR_SURFACE_SCOPE) return null;
  const urg = (out && out.urgency) || r.urgency || 'info';
  if (!_isValidUrgency(urg)) return 'bad_urgency: ' + urg;
  const maxAllowed = _maxAllowedUrgency();
  if (URGENCY_RANK[urg] > URGENCY_RANK[maxAllowed]) {
    return 'urgency_exceeds_capability: requested=' + urg + ' max_allowed=' + maxAllowed;
  }
  return null;
}

module.exports = {
  recordOperatorSurface,
  listOperatorSurface,
  predicate,
  URGENCY_RANK,
  DEFAULT_PARTNER_MAX_URGENCY,
  OPERATOR_SURFACE_SCOPE
};
