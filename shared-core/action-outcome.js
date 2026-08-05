// SPDX-License-Identifier: AGPL-3.0-only
// ActionRecord outcome updates — event-sourced, append-only.
//
// The core ActionRecord is written once at action time. But outcomes emerge
// later: was the edit accepted, or reverted 2 turns later? Did this lead to
// a commit? How long until the next action on the same file?
//
// Rather than mutate the original record (breaks append-only integrity), we
// emit separate `outcome_event` rows that reference the original by id.
// At query time, we fold the events into a materialized outcome.
//
// Why event sourcing here:
//   - Preserves history: we can see the full timeline of an action's outcome
//     evolving ("accepted" then later "reverted"), not just the latest state.
//   - Multiple observers can report: test runner marks accepted, critic
//     marks reverted, commit hook marks led_to_commit — all independent.
//   - Audit trail: every outcome change is attributable to a source.
//
// The materialized view (computed on read) answers simple questions with one
// query. Write path is trivially concurrent-safe (just append).
//
// See the substrate design notes.

const actionRecord = require('./action-record');

// Outcome events are themselves ActionRecords of a special sub-type.
// Convention: type='decision', input.kind='outcome_event', input.target=<id>.
// This keeps them in the same table (no separate outcome_events table) and
// lets callers query "all outcomes for action X" with the standard query API.

function emitOutcomeEvent(state, action_id, agent_id, event) {
  if (!state || !action_id || !agent_id || !event || !event.kind) return null;
  const rec = actionRecord.create({
    type: 'decision',
    agent_id,
    session_id: event.session_id || null,
    cwd: event.cwd || null,
    parent_id: action_id,                   // causality: this outcome is about action_id
    input: {
      kind: 'outcome_event',
      target: action_id,
      outcome_kind: event.kind,             // 'accepted' | 'reverted' | 'commit_linked' | 'time_to_next'
      source: event.source || agent_id,     // who observed this (test runner, critic, commit hook)
      data: event.data || {}
    },
    output: {
      decision: event.kind
    }
  });
  return state.recordAction(rec, actionRecord.toSearchText(rec));
}

// ── Typed outcome emitters ────────────────────────────────────────────────

function markAccepted(state, action_id, agent_id, opts) {
  opts = opts || {};
  return emitOutcomeEvent(state, action_id, agent_id, {
    kind: 'accepted',
    source: opts.source,
    session_id: opts.session_id,
    cwd: opts.cwd,
    data: { note: opts.note || null }
  });
}

function markReverted(state, action_id, agent_id, opts) {
  opts = opts || {};
  return emitOutcomeEvent(state, action_id, agent_id, {
    kind: 'reverted',
    source: opts.source,
    session_id: opts.session_id,
    cwd: opts.cwd,
    data: {
      reason: opts.reason || null,
      reverted_by_action_id: opts.reverted_by || null
    }
  });
}

function linkCommit(state, action_id, agent_id, opts) {
  opts = opts || {};
  if (!opts.commit_sha) return null;
  return emitOutcomeEvent(state, action_id, agent_id, {
    kind: 'commit_linked',
    source: opts.source || 'commit_hook',
    session_id: opts.session_id,
    cwd: opts.cwd,
    data: { commit_sha: opts.commit_sha, branch: opts.branch || null }
  });
}

function recordTimeToNext(state, action_id, agent_id, opts) {
  opts = opts || {};
  if (typeof opts.time_ms !== 'number') return null;
  return emitOutcomeEvent(state, action_id, agent_id, {
    kind: 'time_to_next',
    source: opts.source,
    session_id: opts.session_id,
    cwd: opts.cwd,
    data: {
      time_ms: opts.time_ms,
      next_action_id: opts.next_action_id || null
    }
  });
}

// ── Materialized outcome view ─────────────────────────────────────────────
// Given an action_id, fold all outcome events to answer: was this
// accepted/reverted/committed? What's the latest state? Newer events
// override older ones for the same kind (last writer wins per field), but
// the event log retains all of them so audit is preserved.
function getOutcome(state, action_id) {
  if (!state || !action_id) return null;

  // Pull all outcome events that reference this action as parent and have
  // input.kind='outcome_event'. We use queryActions with parent_id then
  // filter for outcome events (can't use SQL JSON filter portably).
  const events = (state.queryActions({ parent_id: action_id, order: 'asc' }) || [])
    .map(r => {
      let input; try { input = JSON.parse(r.input || '{}'); } catch { input = {}; }
      let output; try { output = JSON.parse(r.output || '{}'); } catch { output = {}; }
      return { ...r, input, output };
    })
    .filter(r => r.input && r.input.kind === 'outcome_event');

  const outcome = {
    accepted: null,        // null = unknown, true = accepted, false = reverted
    reverted: false,
    reverted_reason: null,
    reverted_by: null,
    led_to_commit: null,
    commit_branch: null,
    time_to_next_action_ms: null,
    next_action_id: null,
    event_count: events.length,
    last_event_ts: null,
    sources: new Set()
  };

  for (const ev of events) {
    const kind = ev.input.outcome_kind;
    const data = ev.input.data || {};
    outcome.last_event_ts = Math.max(outcome.last_event_ts || 0, ev.timestamp);
    if (ev.input.source) outcome.sources.add(ev.input.source);
    if (kind === 'accepted') {
      outcome.accepted = true;
      outcome.reverted = false;
    } else if (kind === 'reverted') {
      outcome.accepted = false;
      outcome.reverted = true;
      outcome.reverted_reason = data.reason || outcome.reverted_reason;
      outcome.reverted_by = data.reverted_by_action_id || outcome.reverted_by;
    } else if (kind === 'commit_linked') {
      outcome.led_to_commit = data.commit_sha || outcome.led_to_commit;
      outcome.commit_branch = data.branch || outcome.commit_branch;
    } else if (kind === 'time_to_next') {
      outcome.time_to_next_action_ms = data.time_ms != null ? data.time_ms : outcome.time_to_next_action_ms;
      outcome.next_action_id = data.next_action_id || outcome.next_action_id;
    }
  }

  outcome.sources = Array.from(outcome.sources);
  return outcome;
}

// List outcome events verbatim for audit / UI.
function listOutcomeEvents(state, action_id) {
  if (!state || !action_id) return [];
  return (state.queryActions({ parent_id: action_id, order: 'asc' }) || [])
    .map(r => {
      let input; try { input = JSON.parse(r.input || '{}'); } catch { input = {}; }
      return { ...r, input };
    })
    .filter(r => r.input && r.input.kind === 'outcome_event');
}

module.exports = {
  // Emitters
  markAccepted,
  markReverted,
  linkCommit,
  recordTimeToNext,
  emitOutcomeEvent,
  // Readers
  getOutcome,
  listOutcomeEvents
};
