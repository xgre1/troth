// SPDX-License-Identifier: AGPL-3.0-only
// Concern surfacer — RETIRED  — kept as fallback only.
//
// DRIFT NOTE: per design §4 this module
// is drifted from the entity design It writes discrete
// scope='concern:active' engrams; the canonical substrate-native path
// is `recall.js _gatherConcernTokens` (Fix A) which biases retrieval
// continuously via topicBoost — concerns become a PROPERTY of every
// recall, not a discrete artifact. Production data (state DB 7d):
// concern:active scope produced 1 engram in 7 days — operationally dead.
//
// NOT WIRED into the live cognition loop. Continuous-thinking scheduler
// would invoke surfaceConcerns() but is itself opt-in default-off and
// fired only 2 times in 7 days (production telemetry).
//
// Retention rationale: code preserved as documented fallback for goal-
// classes where Klinger-as-recall-bias is empirically wrong (TBD which
// classes; needs benchmark). Once recall.js _gatherConcernTokens default
// flips to ON post-test-suite-investigation, delete this module.
//
// Original design (preserved below):
// Klinger 1987/2013 "current concerns": the mind continuously tracks
// goals + commitments that are unfinished, biases attention toward
// them. When something has been open AND untouched for a while, it
// becomes a *current concern* worth re-surfacing — otherwise the mind
// loses thread.
//
// This module scans the substrate for aging open goals + commitments,
// writes ONE 'concern:active' engram per fire bundling the top-K aging
// items, and returns the engram id for telemetry.
//
// Cost: zero LLM. Pure SQL + parse.

'use strict';

const engram      = require('./engram.js');
const typedGoal   = require('./typed-goal.js');
const typedCommit = require('./typed-commitment.js');
const state       = require('./state.js');

const DEFAULT_AGING_MS = 60 * 60 * 1000;    // 1h since last activity
const DEFAULT_TOP_K    = 5;
const CONCERN_SCOPE    = 'concern:active';

// Get last-activity timestamp for a goal_id by scanning recent briefings
// + status markers. Cheap point lookup since briefings are indexed by
// goal_id.
function _lastActivityForGoal(goalId, goalTs) {
  if (!goalId) return goalTs || 0;
  let latest = goalTs || 0;
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: goalId, limit: 20 }) || [];
    for (const r of rows) if (r.timestamp > latest) latest = r.timestamp;
  } catch (_) {}
  try {
    if (typeof state.listBriefings === 'function') {
      const briefings = state.listBriefings({ limit: 200 }) || [];
      for (const b of briefings) {
        if (b.goal_id === goalId && b.ts > latest) latest = b.ts;
      }
    }
  } catch (_) {}
  return latest;
}

function _lastActivityForCommitment(commitmentId, commitmentTs) {
  if (!commitmentId) return commitmentTs || 0;
  let latest = commitmentTs || 0;
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: commitmentId, limit: 20 }) || [];
    for (const r of rows) if (r.timestamp > latest) latest = r.timestamp;
  } catch (_) {}
  return latest;
}

// Scan for aging open items. Returns aging items sorted by oldest first.
//   opts.aging_ms — minimum staleness (default 1h)
//   opts.top_k    — bundle cap (default 5)
//   opts.now      — for tests
function findAgingConcerns(opts) {
  opts = opts || {};
  const now      = opts.now || Date.now();
  const agingMs  = typeof opts.aging_ms === 'number' ? opts.aging_ms : DEFAULT_AGING_MS;
  const topK     = Math.max(1, Math.min(20, opts.top_k || DEFAULT_TOP_K));
  const cutoff   = now - agingMs;

  const aging = [];

  // Open goals
  try {
    const goals = typedGoal.listGoals({ status: 'open', limit: 200 });
    for (const g of goals) {
      const lastTouched = _lastActivityForGoal(g.id, g.ts);
      if (lastTouched < cutoff) {
        aging.push({
          kind:        'goal',
          id:          g.id,
          statement:   g.statement,
          last_touched_ts: lastTouched,
          age_ms:      now - lastTouched,
          deadline:    g.deadline,
          project_id:  g.project_id
        });
      }
    }
  } catch (_) {}

  // Active commitments
  try {
    const commits = typedCommit.listCommitments({ status: 'active', limit: 200 });
    for (const c of commits) {
      const lastTouched = _lastActivityForCommitment(c.id, c.ts);
      if (lastTouched < cutoff) {
        aging.push({
          kind:        'commitment',
          id:          c.id,
          statement:   c.claim,
          last_touched_ts: lastTouched,
          age_ms:      now - lastTouched,
          deadline:    c.deadline
        });
      }
    }
  } catch (_) {}

  // Oldest first — what the mind has been ignoring longest needs surfacing most
  aging.sort((a, b) => a.last_touched_ts - b.last_touched_ts);
  return aging.slice(0, topK);
}

// Surface one bundled concern engram. Returns
//   { surfaced: bool, engram_id?, count?, reason? }
function surfaceConcerns(opts) {
  opts = opts || {};
  const aging = findAgingConcerns(opts);
  if (!aging.length) return { surfaced: false, reason: 'no_aging_items' };

  const lines = ['CURRENT CONCERNS (aging > ' +
                 Math.round((opts.aging_ms || DEFAULT_AGING_MS) / 60000) + 'min):'];
  for (const a of aging) {
    const ageH = (a.age_ms / 3600000).toFixed(1);
    lines.push('- [' + a.kind + ' ' + ageH + 'h stale] ' +
               String(a.statement || '(no statement)').slice(0, 160));
  }

  const id = engram.recordEngram({
    agent_id:  opts.agent_id || 'l4-concern-surfacer',
    cwd:       opts.cwd || null,
    user_id:   opts.user_id || null,
    statement: lines.join('\n').slice(0, 800),
    salience:  1,
    scope:     CONCERN_SCOPE,
    source:    opts.source || 'l4:continuous-thinking',
    audience:  'model_visible',     // visible — the mind should re-engage with these
    memory_class: 'episodic',
    extra_output: {
      surfaced_items: aging.map(a => ({
        kind: a.kind, id: a.id, age_ms: a.age_ms, deadline: a.deadline || null
      }))
    }
  });

  if (!id) return { surfaced: false, reason: 'engram_record_failed' };
  return { surfaced: true, engram_id: id, count: aging.length };
}

module.exports = {
  surfaceConcerns,
  findAgingConcerns,
  CONCERN_SCOPE,
  DEFAULT_AGING_MS,
  DEFAULT_TOP_K,
  _lastActivityForGoal,
  _lastActivityForCommitment
};
