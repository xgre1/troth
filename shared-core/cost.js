// SPDX-License-Identifier: AGPL-3.0-only
// Cost attribution graph.
//
// Walks the causal DAG (parent_id + action_record_edges) and attributes
// total cost to root intents. Lets us answer:
//   "this OAuth refactor cost $4.20 across 137 actions and 12 sub-intents"
// a question Letta/Mem0/Zep cannot answer because they lack causal
// edges + verification slots + cost slots in one substrate.
//
// Cost-per-record is event-sourced via the same pattern as outcomes:
//   recordCost(state, action_id, agent_id, opts) emits a type='decision'
//   record with input.kind='cost_event', parent_id=action_id, input.data
//   carrying { input_tokens, output_tokens, cached_tokens, usd, model,
//   provider }. Multiple sources (proxy actual, plugin estimate) can
//   emit independently; getCost folds them, last-writer-wins per field
//   but the event log preserves all observations.
//
// Pure read functions (attributeCost / costByIntent / costOfFailure)
// take state as DI; no DB writes from those paths.

const actionRecord = require('./action-record');

// ── Cost event emitter ────────────────────────────────────────────────────

function recordCost(state, action_id, agent_id, opts) {
  if (!state || !action_id || !agent_id || !opts) return null;
  const data = {
    input_tokens:  opts.input_tokens  | 0,
    output_tokens: opts.output_tokens | 0,
    cached_tokens: opts.cached_tokens | 0,
    usd:           typeof opts.usd === 'number' && Number.isFinite(opts.usd) ? opts.usd : 0,
    model:         opts.model || null,
    provider:      opts.provider || null,
    confidence:    opts.confidence || (opts.source === 'estimate' ? 'estimate' : 'measured')
  };
  const rec = actionRecord.create({
    type: 'decision',
    agent_id,
    session_id: opts.session_id || null,
    cwd:        opts.cwd || null,
    parent_id:  action_id,
    input: {
      kind: 'cost_event',
      target: action_id,
      source: opts.source || agent_id,
      data
    },
    output: { decision: 'cost_recorded' }
  });
  return state.recordAction(rec, actionRecord.toSearchText(rec));
}

// ── Materialized cost view ────────────────────────────────────────────────
// Fold all cost_event children of an action into a single { usd, tokens,
// breakdown } shape. Last-writer-wins per source.
function getCost(state, action_id) {
  if (!state || !action_id) return null;
  const events = (state.queryActions({ parent_id: action_id, order: 'asc' }) || [])
    .map(r => {
      let input; try { input = JSON.parse(r.input || '{}'); } catch { input = {}; }
      return { ts: r.timestamp, input };
    })
    .filter(r => r.input && r.input.kind === 'cost_event');
  if (events.length === 0) return null;

  // Sum per source so we can show "actual + estimate" separately.
  const bySource = {};
  let total_usd = 0, total_in = 0, total_out = 0, total_cached = 0;
  let last_ts = 0;
  for (const ev of events) {
    const src = ev.input.source || 'unknown';
    const d = ev.input.data || {};
    bySource[src] = bySource[src] || { usd: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, count: 0 };
    bySource[src].usd          += d.usd          || 0;
    bySource[src].input_tokens += d.input_tokens || 0;
    bySource[src].output_tokens+= d.output_tokens|| 0;
    bySource[src].cached_tokens+= d.cached_tokens|| 0;
    bySource[src].count        += 1;
    bySource[src].model         = d.model || bySource[src].model;
    bySource[src].provider      = d.provider || bySource[src].provider;
    total_usd    += d.usd          || 0;
    total_in     += d.input_tokens || 0;
    total_out    += d.output_tokens|| 0;
    total_cached += d.cached_tokens|| 0;
    last_ts = Math.max(last_ts, ev.ts);
  }

  // Prefer 'measured' over 'estimate' when both present for the SAME action:
  // dedupe by taking the highest-precedence observation only.
  const measured = events.filter(e => (e.input.data || {}).confidence === 'measured');
  const authoritative = measured.length > 0 ? 'measured' : 'estimate';

  return {
    action_id,
    usd: total_usd,
    input_tokens: total_in,
    output_tokens: total_out,
    cached_tokens: total_cached,
    by_source: bySource,
    authoritative,            // 'measured' if any measured event exists, else 'estimate'
    event_count: events.length,
    last_event_ts: last_ts
  };
}

// ── Attribution: walk descendants of an action and sum cost ────────────────
// Uses recursive CTE over BOTH parent_id and action_record_edges (any
// label) so an intent → produces_edit → edit subtree is fully covered.
//
// Returns { root_id, total_usd, total_input_tokens, total_output_tokens,
// node_count, by_type, deepest_path, confidence }.
function attributeCost(state, root_id, opts) {
  if (!state || !root_id) return null;
  opts = opts || {};
  const depth_limit = Math.min(parseInt(opts.depth_limit || 12), 25);

  const db = state._dbForQuery && state._dbForQuery();
  if (!db) return null;

  // Collect all descendants via recursive CTE that follows BOTH parent_id
  // and any outbound edge in action_record_edges. UNION dedupes nodes.
  const sql = `
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT @root, 0
      UNION
      SELECT ar.id, w.depth + 1
      FROM action_records ar
      JOIN walk w ON ar.parent_id = w.node_id
      WHERE w.depth < ${depth_limit}
      UNION
      SELECT e.to_id, w.depth + 1
      FROM action_record_edges e
      JOIN walk w ON e.from_id = w.node_id
      WHERE w.depth < ${depth_limit}
    )
    SELECT node_id, MIN(depth) AS depth FROM walk GROUP BY node_id
  `;
  let nodes;
  try { nodes = db.prepare(sql).all({ root: root_id }); }
  catch { return null; }

  if (!nodes.length) return { root_id, total_usd: 0, node_count: 0, by_type: {}, deepest_path: 0, confidence: 'no_data' };

  // For each node, fetch its row + cost. Cost is tallied from cost_event
  // children. We exclude cost_event records themselves from the by_type
  // breakdown (they're metadata, not work).
  let total_usd = 0, total_in = 0, total_out = 0;
  const by_type = {};
  let measured_seen = false, estimate_seen = false;
  let deepest = 0;

  for (const n of nodes) {
    const row = state.getAction(n.node_id);
    if (!row) continue;
    if (n.depth > deepest) deepest = n.depth;

    // Skip cost_event records when bucketing by_type (they ARE the cost,
    // they aren't "work" being attributed).
    let inp; try { inp = JSON.parse(row.input || '{}'); } catch { inp = {}; }
    const isCostEvent = row.type === 'decision' && inp && inp.kind === 'cost_event';
    const isOutcomeEvent = row.type === 'decision' && inp && inp.kind === 'outcome_event';
    if (!isCostEvent && !isOutcomeEvent) {
      by_type[row.type] = (by_type[row.type] || 0) + 1;
    }

    // Get cost from descendants of THIS node (folded view).
    const c = getCost(state, n.node_id);
    if (c) {
      total_usd += c.usd;
      total_in  += c.input_tokens;
      total_out += c.output_tokens;
      if (c.authoritative === 'measured') measured_seen = true;
      else estimate_seen = true;
    }
  }

  return {
    root_id,
    total_usd,
    total_input_tokens:  total_in,
    total_output_tokens: total_out,
    node_count: nodes.length,
    by_type,
    deepest_path: deepest,
    confidence: measured_seen && !estimate_seen ? 'measured'
              : measured_seen && estimate_seen  ? 'mixed'
              : estimate_seen                    ? 'estimate'
              : 'no_cost_data'
  };
}

// ── Cost-per-intent leaderboard ───────────────────────────────────────────
// For every intent in scope (cwd / session / since), compute attributeCost.
// Returns sorted list, most-expensive first.
function costByIntent(state, opts) {
  if (!state) return [];
  opts = opts || {};
  const intents = state.queryActions({
    type: 'intent',
    session_id: opts.session_id,
    cwd: opts.cwd,
    since: opts.since,
    limit: opts.limit || 100
  }) || [];
  const out = [];
  for (const r of intents) {
    const att = attributeCost(state, r.id, { depth_limit: opts.depth_limit || 12 });
    if (!att) continue;
    let inp; try { inp = JSON.parse(r.input || '{}'); } catch { inp = {}; }
    out.push({
      intent_id: r.id,
      goal: inp.goal || null,
      timestamp: r.timestamp,
      total_usd: att.total_usd,
      node_count: att.node_count,
      by_type: att.by_type,
      confidence: att.confidence
    });
  }
  out.sort((a, b) => b.total_usd - a.total_usd);
  return out;
}

// ── Cost of failure ───────────────────────────────────────────────────────
// Aggregate cost across actions whose outcome.reverted=true OR which are
// the parent of an avoided_path record (P16.5 I1, future). For now we
// approximate via verification.ast.ok=false / tests.ok=false.
function costOfFailure(state, opts) {
  if (!state) return { total_usd: 0, action_count: 0 };
  opts = opts || {};
  const db = state._dbForQuery && state._dbForQuery();
  if (!db) return { total_usd: 0, action_count: 0 };

  const where = ['type IN (\'edit\', \'tool_call\', \'search\')'];
  const bind  = {};
  if (opts.cwd)        { where.push('cwd = @cwd');               bind.cwd = opts.cwd; }
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }
  if (opts.since)      { where.push('timestamp >= @since');      bind.since = opts.since; }

  // Failure heuristic: any verification slot has ok:false.
  where.push(`(json_extract(verification,'$.ast.ok') = 0 OR json_extract(verification,'$.tests.ok') = 0)`);

  let total_usd = 0, count = 0;
  const sql = `SELECT id FROM action_records WHERE ${where.join(' AND ')} LIMIT @lim`;
  bind.lim = opts.limit || 1000;
  const rows = db.prepare(sql).all(bind);
  for (const r of rows) {
    const c = getCost(state, r.id);
    if (c) { total_usd += c.usd; count += 1; }
  }
  return { total_usd, action_count: count };
}

// ── Proxy-side helper: link cost to the active plugin session ─────────────
// The proxy doesn't directly know which ActionRecord caused the LLM
// request that just completed. We bridge by:
//   1. Reading state.isPluginActive() to learn the active session_id.
//   2. Picking the most-recent linkable action in that session within
//      `lookback_ms` (default 60s). Linkable types: intent | tool_call |
//      edit | search.
//   3. Calling recordCost on it.
// If no plugin session active, or no recent action, we silently skip —
// preventing orphan cost_events with no causal parent.
//
// Returns the cost_event id on success, null if skipped.
function recordCostForActiveSession(state, agent_id, opts) {
  if (!state || !agent_id || !opts) return null;
  if (!state.isPluginActive) return null;
  const presence = state.isPluginActive(60_000);
  if (!presence || !presence.active || !presence.session_id) return null;

  const lookback = opts.lookback_ms || 60_000;
  const since = Date.now() - lookback;
  const linkable = ['intent', 'tool_call', 'edit', 'search'];
  // Walk types in priority order: intent → edit → tool_call → search.
  let target = null;
  for (const t of linkable) {
    const rows = state.queryActions({
      type: t, session_id: presence.session_id, since, limit: 1, order: 'desc'
    }) || [];
    if (rows.length) { target = rows[0]; break; }
  }
  if (!target) return null;

  return recordCost(state, target.id, agent_id, {
    ...opts,
    session_id: presence.session_id,
    cwd: opts.cwd || target.cwd || null,
    source: opts.source || 'proxy_measured'
  });
}

module.exports = {
  recordCost,
  getCost,
  attributeCost,
  costByIntent,
  costOfFailure,
  recordCostForActiveSession
};
