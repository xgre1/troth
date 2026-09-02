// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// identity-promotion — second-pass consolidation.
//
// wm_consolidation already collapses identical EMPHASIZED dialogue.turn
// fragments into ONE scope='consolidated:dialogue' engram with the
// 'operator emphasized: <fragment>' canonical statement. That gets the
// fragment off the working pile and into a durable record at memory_class=
// 'episodic'. It does NOT yet reach the always-on identity envelope —
// composeEnvelope reads only scope='identity' anchors + identity engrams.
//
// Acceptance criterion: 'a fact stated 3× appears in the always-on
// envelope next day with no "remember" command.' This module is the bridge:
// scan consolidated:dialogue engrams whose underlying fragment has been
// stated MIN_REPS times in the working trace; promote each to a
// scope='identity' engram (idempotent — write once per fragment).
// Day-rollover is approximated by either an explicit min_age_ms (so the
// promotion is a delay, not a same-turn elevation) or by a caller-supplied
// time floor. The default min_age_ms is 12h — close to "next day" without
// requiring an actual midnight crossing the test can't simulate.
//
// Pure-substrate: no LLM call. The PROMOTION decision is grounded in
// turn-frequency + emphasis, both of which are observable post-hoc.

const engram = require('./engram.js');
const state  = require('./state.js');

const CONSOLIDATED_SCOPE = 'consolidated:self';
const IDENTITY_SCOPE     = 'identity';
const DEFAULT_MIN_REPS   = 3;
const DEFAULT_MIN_AGE_MS = 12 * 60 * 60 * 1000;  // "next day"
// The consolidated statement IS the fact, in the operator's words; nothing
// to strip. Kept as a function so callers read the same way as before.
function _bareFragment(stmt) {
  return typeof stmt === 'string' ? stmt.trim() : '';
}
// What wm_consolidation stamped on the row: the attesting-turn count and the
// kind of fact, when it did.
function _stamped(engramId) {
  try {
    const rows = state.getActionsByIds([engramId]) || [];
    const out = rows[0] && (typeof rows[0].output === 'string' ? JSON.parse(rows[0].output) : rows[0].output);
    const p = (out && out.payload) || {};
    return { reps: Number.isFinite(p.reps) ? p.reps : null, fact_kind: typeof p.fact_kind === 'string' ? p.fact_kind : null };
  } catch (_) { return { reps: null, fact_kind: null }; }
}

// Count dialogue.turn rows whose user_text contains the fragment.
// Substring match — close enough for the "stated N times" criterion.
function _countTurnsContaining(fragment, opts) {
  opts = opts || {};
  const since = (typeof opts.since === 'number') ? opts.since : 0;
  const db = state._dbForQuery();
  // Bound the scan by a reasonable recency window so this stays cheap on
  // a long-lived substrate. Caller may pass since=0 to scan all.
  const rows = db.prepare(
    "SELECT json_extract(input,'$.args.user_text') AS ut FROM action_records " +
    "WHERE type='tool_call' AND json_extract(input,'$.tool_name')='dialogue.turn' AND timestamp >= ?"
  ).all(since);
  let n = 0;
  for (const r of rows) {
    if (typeof r.ut === 'string' && r.ut.indexOf(fragment) >= 0) n++;
  }
  return n;
}

// Build the set of fragments already on scope='identity' so promotion is
// idempotent. Uses the same fragment-key match as the promotion target.
function _alreadyPromoted() {
  const rows = engram.listEngrams({
    scope: IDENTITY_SCOPE, principal: null, audience: 'all', limit: 5000
  }) || [];
  const out = new Set();
  for (const r of rows) {
    if (r && typeof r.statement === 'string') out.add(_normalizeKey(r.statement));
  }
  return out;
}

function _normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// runOnce({ now?, min_reps?, min_age_ms?, since?, limit?, agent_id?,
//           user_id?, cwd? }) → { scanned, promoted, skipped, ids }
function runOnce(opts) {
  opts = opts || {};
  const now      = (typeof opts.now === 'function') ? opts.now() : Date.now();
  const minReps  = (typeof opts.min_reps   === 'number') ? opts.min_reps   : DEFAULT_MIN_REPS;
  const minAgeMs = (typeof opts.min_age_ms === 'number') ? opts.min_age_ms : DEFAULT_MIN_AGE_MS;
  const limit    = (typeof opts.limit      === 'number') ? opts.limit      : 200;
  const turnsSince = (typeof opts.since    === 'number') ? opts.since      : 0;

  const candidates = engram.listEngrams({
    scope: CONSOLIDATED_SCOPE, principal: null, audience: 'all', limit
  }) || [];
  const promotedAlready = _alreadyPromoted();

  let scanned = 0, promoted = 0, skipped = 0;
  const ids = [];
  for (const c of candidates) {
    if (!c || typeof c.statement !== 'string') continue;
    scanned++;
    const frag = _bareFragment(c.statement);
    if (!frag) { skipped++; continue; }
    if (promotedAlready.has(_normalizeKey(frag))) { skipped++; continue; }
    const cTs = (typeof c.ts === 'number') ? c.ts : (typeof c.timestamp === 'number' ? c.timestamp : 0);
    if (now - cTs < minAgeMs) { skipped++; continue; }
    const stamped = _stamped(c.id);
    const counted = _countTurnsContaining(frag, { since: turnsSince });
    const reps = stamped.reps != null ? Math.max(stamped.reps, counted) : counted;
    if (reps < minReps) { skipped++; continue; }
    const id = engram.recordEngram({
      agent_id: opts.agent_id || 'identity-promotion',
      user_id:  opts.user_id  || 'operator',
      cwd:      opts.cwd      || null,
      statement: frag,
      scope:    IDENTITY_SCOPE,
      source:   'identity-promotion.runOnce',
      source_authority: 'plr_evolved',
      salience: 1.0 + Math.min(2.0, (reps - minReps) * 0.25),
      auto_verify: false,
      extra_output: { payload: { promoted_from: c.id, reps, fragment_chars: frag.length, fact_kind: stamped.fact_kind || 'fact' } }
    });
    if (id) {
      promoted++;
      promotedAlready.add(_normalizeKey(frag));
      ids.push(id);
    } else {
      skipped++;
    }
  }
  return { scanned, promoted, skipped, ids };
}

module.exports = {
  runOnce,
  CONSOLIDATED_SCOPE,
  IDENTITY_SCOPE,
  DEFAULT_MIN_REPS,
  DEFAULT_MIN_AGE_MS,
  _bareFragment,
  _normalizeKey,
};
