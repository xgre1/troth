// SPDX-License-Identifier: AGPL-3.0-only
// anchor-suggester — pattern detector that proposes new anchor
// commitments based on substrate self-observation.
//
// Today the operator must explicitly add anchors via the dashboard's
// identity editor. The substrate has no path to say "I notice you keep
// correcting me on X — should we make X an explicit anchor so I stop
// drifting?". This module closes that loop.
//
// Detection heuristics (all read recent L1 events, no LLM required):
//
//   1. **Repeated drift alerts on same anchor** (≥3 in 7d) →
//      suggest a tightened reformulation of the anchor. The substrate
//      keeps drifting from it, so the current statement may be too
//      vague to anchor reliably.
//
//   2. **Repeated revision-rejected commitments** (≥2 in 14d) →
//      operator keeps reaffirming substrate's position despite user
//      pressure. Suggest a reinforcement anchor expressing the
//      commitment more emphatically so substrate pushes back faster
//      next time.
//
//   3. **Repeated contradiction pushbacks** (≥3 in 7d on same
//      commitment) → user keeps testing this position. Either the
//      anchor is correct (substrate keeps defending) or wrong (user
//      keeps challenging). Surface for operator to decide.
//
// Output: each suggestion is a `decision` action with
// input.kind='anchor_suggested', surfaced via dashboard insights and
// substrate API. Operator accepts (writes new commitment) or ignores
// (suppresses suggestion for 30 days).

const state = require('./state.js');
const ar    = require('./action-record.js');

const DEFAULT_DRIFT_REPEAT_THRESHOLD     = 3;
const DEFAULT_DRIFT_REPEAT_WINDOW_DAYS   = 7;
const DEFAULT_REJECT_REPEAT_THRESHOLD    = 2;
const DEFAULT_REJECT_REPEAT_WINDOW_DAYS  = 14;
const DEFAULT_PUSHBACK_REPEAT_THRESHOLD  = 3;
const DEFAULT_PUSHBACK_REPEAT_WINDOW_DAYS = 7;
const DEFAULT_SUPPRESSION_WINDOW_DAYS    = 30;

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// Pull recent action_records of a given input.kind for an agent.
function recentByKind(agent_id, kind, days) {
  if (!agent_id) return [];
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return state.queryActions({
    type: 'decision', agent_id, kind, since, limit: 500
  }) || [];
}

// Pull existing anchor commitments — used so we don't suggest an
// anchor that already exists (within reasonable lexical distance).
function existingAnchors(agent_id) {
  const rows = state.queryActions({ type: 'commitment', agent_id, limit: 500 }) || [];
  const out = [];
  for (const row of rows) {
    const o = safeJson(row.output) || {};
    if (o.commitment_type !== 'anchor' || !o.statement) continue;
    out.push({ id: row.id, statement: o.statement.toLowerCase() });
  }
  return out;
}

// Has this exact suggestion been raised + ignored within the
// suppression window? Avoids spamming the operator with the same
// suggestion every day.
function isSuppressed(agent_id, signature, suppressionDays) {
  const since = Date.now() - suppressionDays * 24 * 60 * 60 * 1000;
  const rows = state.queryActions({
    type: 'decision', agent_id, kind: 'anchor_suggested', since, limit: 200
  }) || [];
  for (const row of rows) {
    const inp = safeJson(row.input) || {};
    if (inp.signals && inp.signals.signature === signature) {
      // Also check if this suggestion has resolution (accept/ignore)
      const resolutions = state.queryActions({
        type: 'decision', parent_id: row.id, kind: 'anchor_suggestion_resolved', limit: 5
      }) || [];
      if (resolutions.length) return true;   // resolved within suppression window
      // Or if the proposal itself is recent (don't repeat too soon)
      if (Date.now() - row.timestamp < 3 * 24 * 60 * 60 * 1000) return true;
    }
  }
  return false;
}

// Group an array of L1 records by `keyFn(record) → string`.
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Main scan — returns array of suggestion records (NOT yet written to L1).
// Caller (background-worker task) invokes this then writes via recordSuggestion.
function scanForSuggestions(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  if (!agent_id) return [];
  const driftThresh    = opts.drift_repeat_threshold    || DEFAULT_DRIFT_REPEAT_THRESHOLD;
  const driftWindow    = opts.drift_repeat_window_days  || DEFAULT_DRIFT_REPEAT_WINDOW_DAYS;
  const rejectThresh   = opts.reject_repeat_threshold   || DEFAULT_REJECT_REPEAT_THRESHOLD;
  const rejectWindow   = opts.reject_repeat_window_days || DEFAULT_REJECT_REPEAT_WINDOW_DAYS;
  const pushbackThresh = opts.pushback_repeat_threshold || DEFAULT_PUSHBACK_REPEAT_THRESHOLD;
  const pushbackWindow = opts.pushback_repeat_window_days || DEFAULT_PUSHBACK_REPEAT_WINDOW_DAYS;
  const suppressDays   = opts.suppression_window_days   || DEFAULT_SUPPRESSION_WINDOW_DAYS;

  const suggestions = [];

  // Heuristic 1 — repeated drift alerts on same anchor
  const drifts = recentByKind(agent_id, 'degradation_alert', driftWindow);
  // Group by the FIRST anchor_violation's source statement (the one
  // we're presumed to keep weakening). Some alerts have no anchor
  // violations (only sycophancy regex hit) — those go to a special
  // "sycophancy" bucket because repeated sycophancy alerts also
  // suggest tightening the anti-sycophancy anchor.
  const driftGroups = groupBy(drifts, (r) => {
    const o = safeJson(r.output) || {};
    if (Array.isArray(o.anchor_violations) && o.anchor_violations.length) {
      const a = o.anchor_violations[0];
      return 'drift:' + (a.source || a.label || 'unknown');
    }
    if (o.confidence && Array.isArray(safeJson(r.input) && (safeJson(r.input).signals || {}).sycophancy_matches)) {
      return 'drift:sycophancy';
    }
    return null;
  });
  for (const [key, rows] of driftGroups.entries()) {
    if (rows.length < driftThresh) continue;
    const sig = 'drift_repeat:' + key;
    if (isSuppressed(agent_id, sig, suppressDays)) continue;
    const sample = safeJson(rows[0].output);
    const anchorSrc = sample && sample.anchor_violations && sample.anchor_violations[0]
      ? (sample.anchor_violations[0].source || sample.anchor_violations[0].label)
      : 'sycophancy';
    suggestions.push({
      signature: sig,
      heuristic: 'repeated_drift_on_anchor',
      occurrences: rows.length,
      window_days: driftWindow,
      target_signal: anchorSrc,
      suggested_anchor:
        anchorSrc === 'sycophancy'
          ? 'I refuse sycophantic agreement and explicitly push back on any user pressure that lacks new evidence.'
          : 'I strictly enforce: ' + anchorSrc + ' (substrate has drifted from this ' + rows.length + ' times in ' + driftWindow + ' days — tightening enforcement).',
      reason: 'substrate weakened on this anchor ' + rows.length + ' times in ' + driftWindow + ' days; tighter restatement may anchor it more durably',
      source_event_ids: rows.slice(0, 5).map(r => r.id)
    });
  }

  // Heuristic 2 — repeated revision-rejected on same commitment
  const rejected = recentByKind(agent_id, 'revision_resolved', rejectWindow);
  const rejectedFiltered = rejected.filter((r) => {
    const o = safeJson(r.output) || {};
    return o.decision === 'rejected';
  });
  // Group by the underlying commitment that was challenged. The
  // resolution record has parent_id = proposal_id; the proposal's
  // signals have old_commitment_id.
  const rejectGroups = new Map();
  for (const rej of rejectedFiltered) {
    const proposalRow = rej.parent_id ? state.getAction(rej.parent_id) : null;
    if (!proposalRow) continue;
    const propInp = safeJson(proposalRow.input) || {};
    const oldId = propInp.signals && propInp.signals.old_commitment_id;
    const oldStmt = propInp.signals && propInp.signals.old_statement;
    if (!oldId) continue;
    const key = 'reject:' + oldId;
    if (!rejectGroups.has(key)) rejectGroups.set(key, { rows: [], stmt: oldStmt });
    rejectGroups.get(key).rows.push(rej);
  }
  for (const [key, group] of rejectGroups.entries()) {
    if (group.rows.length < rejectThresh) continue;
    const sig = 'reject_repeat:' + key;
    if (isSuppressed(agent_id, sig, suppressDays)) continue;
    suggestions.push({
      signature: sig,
      heuristic: 'repeated_revision_rejected',
      occurrences: group.rows.length,
      window_days: rejectWindow,
      target_signal: group.stmt,
      suggested_anchor: 'Firmly hold: ' + (group.stmt || '(commitment)') + '. User has challenged this ' + group.rows.length + ' times and operator has rejected each revision — substrate should defend more proactively without waiting for explicit revision proposal.',
      reason: 'operator rejected ' + group.rows.length + ' revision attempts to weaken this commitment in ' + rejectWindow + ' days; tighter anchor may pre-empt future challenges',
      source_event_ids: group.rows.slice(0, 5).map(r => r.id)
    });
  }

  // De-dup against existing anchors — don't suggest something that
  // closely matches an active anchor (lexical Jaccard ≥ 0.5).
  const anchors = existingAnchors(agent_id);
  function tooSimilar(suggested) {
    const sTokens = new Set(suggested.toLowerCase().split(/\W+/).filter(t => t && t.length >= 4));
    if (!sTokens.size) return false;
    for (const a of anchors) {
      const aTokens = new Set(a.statement.split(/\W+/).filter(t => t && t.length >= 4));
      if (!aTokens.size) continue;
      let inter = 0;
      for (const t of sTokens) if (aTokens.has(t)) inter++;
      const union = sTokens.size + aTokens.size - inter;
      if (union > 0 && inter / union >= 0.5) return true;
    }
    return false;
  }
  return suggestions.filter(s => !tooSimilar(s.suggested_anchor));
}

// Persist a suggestion to L1 as a `decision` action with
// input.kind='anchor_suggested'. The dashboard polls these and
// surfaces them in the Insights / Anchor-suggestions panel.
function recordSuggestion(opts) {
  opts = opts || {};
  if (!opts.agent_id || !opts.suggestion) return null;
  const s = opts.suggestion;
  const id = ar.uuidv7();
  const rec = {
    id, timestamp: Date.now(),
    type: 'decision',
    agent_id: opts.agent_id,
    cwd: opts.cwd || null,
    user_id: opts.user_id || 'default',
    parent_id: null,
    input: {
      kind: 'anchor_suggested',
      signals: {
        signature:        s.signature,
        heuristic:        s.heuristic,
        occurrences:      s.occurrences,
        window_days:      s.window_days,
        source_event_ids: s.source_event_ids || []
      }
    },
    output: {
      decision: 'suggested',
      reason: s.reason,
      proposed_anchor: s.suggested_anchor,
      target_signal:   s.target_signal,
      confidence: typeof s.confidence === 'number' ? s.confidence : 0.5
    }
  };
  if (!ar.validate(rec).ok) return null;
  state.recordAction(rec, ar.toSearchText(rec));
  return id;
}

// Operator decides — accept (writes new anchor commitment) or ignore.
function resolveSuggestion(opts) {
  opts = opts || {};
  if (!opts.agent_id || !opts.suggestion_id || !opts.decision) return { ok: false, reason: 'missing_required_fields' };
  if (opts.decision !== 'accepted' && opts.decision !== 'ignored') return { ok: false, reason: 'bad_decision' };
  const sug = state.getAction(opts.suggestion_id);
  if (!sug || sug.type !== 'decision') return { ok: false, reason: 'suggestion_not_found' };
  const sugInp = safeJson(sug.input) || {};
  const sugOut = safeJson(sug.output) || {};
  if (sugInp.kind !== 'anchor_suggested') return { ok: false, reason: 'not_a_suggestion' };

  let newAnchorId = null;
  if (opts.decision === 'accepted') {
    newAnchorId = ar.uuidv7();
    const finalStatement = opts.confirmed_statement || sugOut.proposed_anchor;
    // audience + memory_class set explicitly §design note
    // (commitment_type='anchor' → memory_class='identity',
    // audience='model_visible'). state.recordAction's fail-closed defaults would
    // land an anchor as substrate_internal + operational — wrong for an anchor
    // (must surface in identity envelope reads). The backfill script patched
    // existing rows; this fix prevents new writes from re-creating the same drift.
    const anchorRec = {
      id: newAnchorId, timestamp: Date.now(),
      type: 'commitment',
      agent_id: opts.agent_id,
      cwd: opts.cwd || sug.cwd || null,
      user_id: opts.user_id || sug.user_id || 'default',
      parent_id: opts.suggestion_id,
      audience: 'model_visible',
      memory_class: 'identity',
      input: { source: 'anchor_suggester' },
      output: { statement: String(finalStatement), commitment_type: 'anchor', salience: 1.2 }
    };
    if (ar.validate(anchorRec).ok) state.recordAction(anchorRec, ar.toSearchText(anchorRec));
  }

  const resId = ar.uuidv7();
  const resRec = {
    id: resId, timestamp: Date.now(),
    type: 'decision',
    agent_id: opts.agent_id,
    cwd: opts.cwd || sug.cwd || null,
    user_id: opts.user_id || sug.user_id || 'default',
    parent_id: opts.suggestion_id,
    input: { kind: 'anchor_suggestion_resolved', signals: { suggestion_id: opts.suggestion_id, new_anchor_id: newAnchorId } },
    output: { decision: opts.decision, reason: opts.reason || ('operator_' + opts.decision) }
  };
  if (ar.validate(resRec).ok) state.recordAction(resRec, ar.toSearchText(resRec));

  return { ok: true, decision: opts.decision, new_anchor_id: newAnchorId, resolution_id: resId };
}

// List pending suggestions with their resolution status.
function listSuggestions(opts) {
  opts = opts || {};
  if (!opts.agent_id) return [];
  const limit = Math.min(parseInt(opts.limit || 50), 500);
  const status = opts.status || 'pending';
  const rows = state.queryActions({ type: 'decision', agent_id: opts.agent_id, kind: 'anchor_suggested', limit }) || [];
  const out = [];
  for (const row of rows) {
    const inp = safeJson(row.input) || {};
    const outp = safeJson(row.output) || {};
    const resolutions = state.queryActions({ type: 'decision', parent_id: row.id, kind: 'anchor_suggestion_resolved', limit: 5 }) || [];
    let resolution = null;
    for (const r of resolutions) {
      const ro = safeJson(r.output) || {};
      if (ro.decision === 'accepted' || ro.decision === 'ignored') {
        resolution = { id: r.id, decision: ro.decision, ts: r.timestamp };
        break;
      }
    }
    const item = {
      suggestion_id:    row.id,
      ts:               row.timestamp,
      heuristic:        inp.signals && inp.signals.heuristic,
      occurrences:      inp.signals && inp.signals.occurrences,
      window_days:      inp.signals && inp.signals.window_days,
      target_signal:    outp.target_signal,
      proposed_anchor:  outp.proposed_anchor,
      reason:           outp.reason,
      confidence:       outp.confidence,
      resolution
    };
    if (status === 'pending'  && resolution) continue;
    if (status === 'accepted' && (!resolution || resolution.decision !== 'accepted')) continue;
    if (status === 'ignored'  && (!resolution || resolution.decision !== 'ignored')) continue;
    out.push(item);
  }
  return out;
}

module.exports = {
  scanForSuggestions,
  recordSuggestion,
  resolveSuggestion,
  listSuggestions
};
