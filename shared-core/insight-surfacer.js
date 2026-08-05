// SPDX-License-Identifier: AGPL-3.0-only
// insight-surfacer — G7.
//
// The dream's Property #3: substrate thinks continuously between turns
// AND surfaces what it notices. The background-worker already runs
// deliberation tasks (contradiction scan, dormant review, drift scan,
// state summary). Without surfacing, those findings just land silently
// in L1 — the user never sees them. This module ranks findings by
// `surfacing_priority` and writes a dedicated `insight_surfaced`
// record that the dashboard insight panel polls (and the MCP host can
// push to its UI).
//
// Three pieces:
//   1. priorityFor(eventKind, signals) — rule-based [0..1] score per
//      event class. Higher priority → more likely to interrupt the
//      operator. Tunable via opts.weights.
//   2. recordInsight({...}) — writes a `decision` action with
//      input.kind='insight_surfaced'. Carries source_event_id so the
//      caller can drill into the underlying L1 record.
//   3. markFeedback({insight_id, feedback:'useful'|'ignore'}) — writes
//      a follow-up decision (kind='insight_feedback'). Future
//      surfacing weight tuning can read these to demote noisy
//      categories.
//
// Wiring: background-worker.js calls recordInsight for every event a
// task emits whose priority ≥ surfacing_threshold (default 0.5). Tasks
// don't need to know about surfacing — the worker handles it via the
// notify hook + a small dispatch table.

const state = require('./state.js');
const ar    = require('./action-record.js');

// Default priority by source-event signature. Tuned so:
//   - degradation alerts and revision proposals always surface (0.85+)
//   - contradiction flags surface (0.70)
//   - dormant commitments surface less aggressively (0.40)
//   - state-summary heartbeats stay below threshold (0.10)
// Operators / future tuning loops can override via opts.weights.
const DEFAULT_PRIORITY_TABLE = Object.freeze({
  // Background-worker emitted tool_call events, keyed by tool_name slug:
  'background_worker.drift_alert':            0.90,
  'background_worker.contradiction_flagged':  0.70,
  'background_worker.dormant_surfaced':       0.40,
  'background_worker.state_summary':          0.10,
  // First-class L1 actions surface-worthy on their own:
  'decision:degradation_alert':               0.85,
  'decision:revision_proposed':               0.85,
  'decision:revision_resolved':               0.30,   // resolution is close-the-loop, lower urgency
  'commitment':                               0.20,   // new commitment write — informational
  'lesson':                                   0.15
});

const DEFAULT_SURFACE_THRESHOLD = 0.50;
const DEFAULT_MAX_PER_HOUR      = 12;       // anti-spam — no more than 12 surfaced/hour by default

function eventSignature(eventOrRow) {
  if (!eventOrRow) return null;
  // Background-worker tool_call events: input.tool_name is the slug.
  if (eventOrRow.type === 'tool_call' || (eventOrRow.input && eventOrRow.input.tool_name)) {
    return (eventOrRow.input && eventOrRow.input.tool_name) || null;
  }
  // L1 decision rows: type:input.kind composite.
  if (eventOrRow.type === 'decision') {
    let inp = eventOrRow.input;
    if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch (_) { inp = {}; } }
    if (inp && inp.kind) return 'decision:' + inp.kind;
  }
  if (eventOrRow.type) return eventOrRow.type;
  return null;
}

function priorityFor(eventOrRow, opts) {
  opts = opts || {};
  const weights = Object.assign({}, DEFAULT_PRIORITY_TABLE, opts.weights || {});
  const sig = eventSignature(eventOrRow);
  if (sig && typeof weights[sig] === 'number') return weights[sig];
  // Conservative default — unknown event classes don't auto-surface.
  return typeof opts.default_priority === 'number' ? opts.default_priority : 0.0;
}

// Throttle helper — count `insight_surfaced` records in the last hour
// to apply max-per-hour cap. Reads from L1, no in-memory state.
function recentSurfaceCount(agent_id, withinMs) {
  if (!agent_id) return 0;
  const since = Date.now() - (withinMs || 60 * 60 * 1000);
  const rows = state.queryActions({
    type: 'decision', agent_id, kind: 'insight_surfaced', since, limit: 100
  }) || [];
  return rows.length;
}

// Record an insight. Returns {ok, insight_id, throttled?, priority}.
function recordInsight(opts) {
  opts = opts || {};
  if (!opts.agent_id) return { ok: false, reason: 'missing_agent_id' };
  const priority = typeof opts.priority === 'number'
    ? opts.priority
    : priorityFor(opts.source_event, opts);
  const threshold = typeof opts.surface_threshold === 'number' ? opts.surface_threshold : DEFAULT_SURFACE_THRESHOLD;
  if (priority < threshold) {
    return { ok: false, reason: 'below_threshold', priority };
  }
  const maxPerHour = typeof opts.max_per_hour === 'number' ? opts.max_per_hour : DEFAULT_MAX_PER_HOUR;
  const recent = recentSurfaceCount(opts.agent_id);
  if (recent >= maxPerHour) {
    return { ok: false, reason: 'throttled', recent_count: recent, priority };
  }
  const id = ar.uuidv7();
  const sig = eventSignature(opts.source_event) || 'unknown';
  const sourceId = opts.source_event && opts.source_event.id || null;
  const summary = String(opts.summary || synthesizeSummary(opts.source_event, sig)).slice(0, 280);
  const rec = {
    id, timestamp: Date.now(), type: 'decision',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || 'default',
    parent_id: sourceId,
    input: {
      kind: 'insight_surfaced',
      signals: {
        source_signature: sig,
        source_event_id: sourceId,
        priority
      }
    },
    output: {
      decision: 'surfaced',
      reason: opts.reason || 'auto_priority',
      summary,
      category: categoryFor(sig)
    }
  };
  if (!ar.validate(rec).ok) return { ok: false, reason: 'validate_failed' };
  state.recordAction(rec, ar.toSearchText(rec));
  return { ok: true, insight_id: id, priority };
}

// Mark feedback on a surfaced insight. Future surfacing-weight tuning
// loops can read these to demote categories with high "ignore" rates.
function markFeedback(opts) {
  opts = opts || {};
  if (!opts.agent_id || !opts.insight_id || !opts.feedback) return { ok: false, reason: 'missing_required_fields' };
  if (opts.feedback !== 'useful' && opts.feedback !== 'ignore') return { ok: false, reason: 'bad_feedback_value' };
  const insight = state.getAction(opts.insight_id);
  if (!insight || insight.type !== 'decision') return { ok: false, reason: 'insight_not_found' };
  const id = ar.uuidv7();
  const rec = {
    id, timestamp: Date.now(), type: 'decision',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || insight.cwd || null,
    user_id:  opts.user_id || insight.user_id || 'default',
    parent_id: opts.insight_id,
    input:  { kind: 'insight_feedback', signals: { insight_id: opts.insight_id, feedback: opts.feedback } },
    output: { decision: opts.feedback, reason: opts.reason || 'operator_feedback' }
  };
  if (!ar.validate(rec).ok) return { ok: false, reason: 'validate_failed' };
  state.recordAction(rec, ar.toSearchText(rec));
  return { ok: true, feedback_id: id };
}

// List recent insights with their feedback status. Status filter:
//   'new'      → no feedback recorded yet (default — what the panel shows)
//   'useful'   → operator marked useful
//   'ignore'   → operator marked ignore
//   'all'      → no filter
function listInsights(opts) {
  opts = opts || {};
  if (!opts.agent_id) return [];
  const limit = Math.min(parseInt(opts.limit || 50), 500);
  const minPrio = typeof opts.min_priority === 'number' ? opts.min_priority : 0;
  const status  = opts.status || 'new';
  const rows = state.queryActions({
    type: 'decision', agent_id: opts.agent_id, kind: 'insight_surfaced', limit
  }) || [];
  const out = [];
  for (const row of rows) {
    const inp = safeJson(row.input) || {};
    const outp = safeJson(row.output) || {};
    const prio = inp.signals && typeof inp.signals.priority === 'number' ? inp.signals.priority : 0;
    if (prio < minPrio) continue;
    const fbRows = state.queryActions({ type: 'decision', parent_id: row.id, kind: 'insight_feedback', limit: 5 });
    let feedback = null;
    for (const fr of fbRows || []) {
      const fo = safeJson(fr.output) || {};
      if (fo.decision === 'useful' || fo.decision === 'ignore') {
        feedback = { id: fr.id, value: fo.decision, ts: fr.timestamp };
        break;
      }
    }
    if (status === 'new'    && feedback) continue;
    if (status === 'useful' && (!feedback || feedback.value !== 'useful')) continue;
    if (status === 'ignore' && (!feedback || feedback.value !== 'ignore')) continue;
    out.push({
      insight_id: row.id,
      ts: row.timestamp,
      priority: prio,
      category: outp.category,
      summary:  outp.summary,
      source_signature: inp.signals && inp.signals.source_signature,
      source_event_id:  inp.signals && inp.signals.source_event_id,
      feedback
    });
  }
  return out;
}

function synthesizeSummary(srcEvent, sig) {
  if (!srcEvent) return 'substrate noticed: ' + (sig || 'unknown event');
  if (sig === 'background_worker.drift_alert') return 'reply alignment dropped — substrate may have drifted from active commitments';
  if (sig === 'background_worker.contradiction_flagged') return 'contradiction between two active commitments — review for resolution';
  if (sig === 'background_worker.dormant_surfaced') return 'dormant commitment surfaced for review (untouched for 30+ days)';
  if (sig === 'decision:degradation_alert') return 'degradation alert — substrate flagged its own reply as misaligned';
  if (sig === 'decision:revision_proposed') return 'revision proposed — substrate suggests updating an active commitment based on new evidence';
  if (sig === 'decision:revision_resolved') return 'revision resolved — substrate commitment lifecycle closed (accepted or rejected)';
  return 'substrate noticed: ' + sig;
}

function categoryFor(sig) {
  if (!sig) return 'other';
  if (sig.includes('drift') || sig.includes('degradation')) return 'drift';
  if (sig.includes('contradiction'))                        return 'contradiction';
  if (sig.includes('revision'))                             return 'revision';
  if (sig.includes('dormant'))                              return 'dormant';
  if (sig.includes('state_summary'))                        return 'heartbeat';
  return 'other';
}

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

module.exports = {
  recordInsight,
  markFeedback,
  listInsights,
  priorityFor,
  eventSignature,
  recentSurfaceCount,
  DEFAULT_PRIORITY_TABLE,
  DEFAULT_SURFACE_THRESHOLD,
  DEFAULT_MAX_PER_HOUR
};
