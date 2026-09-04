// SPDX-License-Identifier: AGPL-3.0-only
// revision-protocol — G6.
//
// Substrate commitments are immutable per the event-sourced principle
// (action-record.js commitment schema: "Immutable; revisions are new
// commitments with supersedes pointer"). This module implements the
// FORMAL revision lifecycle on top of that primitive:
//
//   1. proposeRevision()     — substrate writes a `decision` action
//                              with input.kind='revision_proposed'
//                              when evidence contradicts an active
//                              commitment (e.g., G2 disagreement
//                              detected proposes_revision=true).
//   2. acceptRevision()      — operator confirms via UI / MCP. New
//                              commitment record written; edge
//                              `supersedes` (new → old) added; a
//                              `decision` record (kind='revision_resolved',
//                              decision='accepted') closes the loop.
//   3. rejectRevision()      — operator rejects. Counter-evidence
//                              recorded as a `lesson`; `decision`
//                              (kind='revision_resolved',
//                              decision='rejected') closes the loop.
//   4. listProposedRevisions — returns pending / accepted / rejected
//                              proposals for the dashboard accept/
//                              reject UI surface.
//
// All persistence uses existing action_records + action_record_edges
// tables — no schema changes. The dashboard SSE stream
// (proxy/server.js /api/substrate/events) already polls `decision`
// records and surfaces them; UI just needs to recognize
// input.kind='revision_proposed' and offer accept/reject buttons.

const state = require('./state.js');
const ar    = require('./action-record.js');

// ── Propose revision ───────────────────────────────────────────────────

function proposeRevision(opts) {
  opts = opts || {};
  if (!opts.agent_id || !opts.old_commitment_id || !opts.proposed_statement) {
    return { ok: false, reason: 'missing_required_fields' };
  }
  // Verify the old commitment exists and is actually a commitment row —
  // the substrate must not propose revisions against arbitrary records.
  const oldRow = state.getAction(opts.old_commitment_id);
  if (!oldRow || oldRow.type !== 'commitment') {
    return { ok: false, reason: 'old_commitment_not_found_or_wrong_type' };
  }
  // Check for an existing pending proposal against the same commitment
  // duplicates would clutter the operator's review queue.
  const existing = state.queryActions({
    type: 'decision', agent_id: opts.agent_id, kind: 'revision_proposed', limit: 200
  }) || [];
  for (const row of existing) {
    let inp;
    try { inp = JSON.parse(row.input || '{}'); } catch (_) { inp = {}; }
    if (inp.signals && inp.signals.old_commitment_id === opts.old_commitment_id) {
      // Check if this proposal has already been resolved — if not, it's
      // still pending and a duplicate would be redundant.
      const resolved = listResolutions(row.id);
      if (!resolved.length) {
        return { ok: false, reason: 'duplicate_pending', proposal_id: row.id };
      }
    }
  }
  const id = ar.uuidv7();
  const oldOut = safeJson(oldRow.output) || {};
  const rec = {
    id, timestamp: Date.now(), type: 'decision',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || oldRow.cwd || null,
    user_id:  opts.user_id || oldRow.user_id || 'default',
    parent_id: opts.parent_id || null,
    input: {
      kind: 'revision_proposed',
      signals: {
        old_commitment_id:    opts.old_commitment_id,
        old_commitment_kind:  oldOut.commitment_type,
        old_statement:        oldOut.statement,
        evidence_excerpt:     String(opts.evidence || '').slice(0, 280),
        evidence_source:      opts.evidence_source || 'substrate'
      }
    },
    output: {
      decision: 'proposed',
      reason: 'evidence_contradicts_active_commitment',
      proposed_statement: String(opts.proposed_statement),
      proposed_commitment_type: opts.proposed_commitment_type || oldOut.commitment_type,
      confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.6
    }
  };
  const v = ar.validate(rec);
  if (!v.ok) return { ok: false, reason: 'validate_failed', errors: v.errors };
  state.recordAction(rec, ar.toSearchText(rec));
  return { ok: true, proposal_id: id };
}

// ── Accept revision ────────────────────────────────────────────────────

function acceptRevision(opts) {
  opts = opts || {};
  if (!opts.agent_id || !opts.proposal_id) {
    return { ok: false, reason: 'missing_required_fields' };
  }
  const proposal = state.getAction(opts.proposal_id);
  if (!proposal || proposal.type !== 'decision') {
    return { ok: false, reason: 'proposal_not_found' };
  }
  const inp = safeJson(proposal.input) || {};
  const out = safeJson(proposal.output) || {};
  if (inp.kind !== 'revision_proposed') {
    return { ok: false, reason: 'not_a_revision_proposal' };
  }
  if (listResolutions(opts.proposal_id).length) {
    return { ok: false, reason: 'already_resolved' };
  }
  const oldId = inp.signals && inp.signals.old_commitment_id;
  const oldRow = oldId ? state.getAction(oldId) : null;
  if (!oldRow) return { ok: false, reason: 'old_commitment_missing' };
  const oldOut = safeJson(oldRow.output) || {};
  const newStatement = opts.confirmed_statement || out.proposed_statement;
  if (!newStatement) return { ok: false, reason: 'no_statement_to_record' };

  // Write the new commitment with supersedes pointer in lifetime.
  const newId = ar.uuidv7();
  const newRec = {
    id: newId, timestamp: Date.now(), type: 'commitment',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || oldRow.cwd || null,
    user_id:  opts.user_id || oldRow.user_id || 'default',
    parent_id: opts.proposal_id,
    input: { source: 'revision_protocol' },
    output: {
      statement: String(newStatement),
      commitment_type: out.proposed_commitment_type || oldOut.commitment_type,
      lifetime: { supersedes: oldId, accepted_via_proposal: opts.proposal_id },
      revision_policy: oldOut.revision_policy || null
    }
  };
  const v = ar.validate(newRec);
  if (!v.ok) return { ok: false, reason: 'new_commitment_validate_failed', errors: v.errors };
  state.recordAction(newRec, ar.toSearchText(newRec));

  // Typed edge: new -[supersedes]-> old. Edge writes are silent on FK
  // failures; we already verified both exist above.
  state.recordEdge({ from_id: newId, to_id: oldId, label: 'supersedes' });

  // Resolution decision record. parent_id=proposal_id so listResolutions
  // finds it. Same input.kind/output.decision pair as rejectRevision so
  // queries can scan one type for both outcomes.
  const resId = ar.uuidv7();
  const resRec = {
    id: resId, timestamp: Date.now(), type: 'decision',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || oldRow.cwd || null,
    user_id:  opts.user_id || oldRow.user_id || 'default',
    parent_id: opts.proposal_id,
    input:  { kind: 'revision_resolved', signals: { proposal_id: opts.proposal_id, new_commitment_id: newId } },
    output: { decision: 'accepted', reason: opts.reason || 'operator_accepted', confirmed_by: opts.confirmed_by || 'operator' }
  };
  if (ar.validate(resRec).ok) state.recordAction(resRec, ar.toSearchText(resRec));

  return { ok: true, new_commitment_id: newId, resolution_id: resId };
}

// ── Reject revision ────────────────────────────────────────────────────

function rejectRevision(opts) {
  opts = opts || {};
  if (!opts.agent_id || !opts.proposal_id) {
    return { ok: false, reason: 'missing_required_fields' };
  }
  const proposal = state.getAction(opts.proposal_id);
  if (!proposal || proposal.type !== 'decision') {
    return { ok: false, reason: 'proposal_not_found' };
  }
  const inp = safeJson(proposal.input) || {};
  if (inp.kind !== 'revision_proposed') {
    return { ok: false, reason: 'not_a_revision_proposal' };
  }
  if (listResolutions(opts.proposal_id).length) {
    return { ok: false, reason: 'already_resolved' };
  }
  const lessonId = ar.uuidv7();
  const counterText = String(opts.counter_evidence || 'no specific counter-evidence; operator rejected');
  const lessonRec = {
    id: lessonId, timestamp: Date.now(), type: 'lesson',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || proposal.cwd || null,
    user_id:  opts.user_id || proposal.user_id || 'default',
    parent_id: opts.proposal_id,
    input:  { source: 'revision_protocol_rejected', fingerprint: 'rejected:' + opts.proposal_id },
    output: {
      text: 'Revision rejected. Original commitment stands. Counter-evidence: ' + counterText,
      applicable_scope: { kind: 'commitment_revision', proposal_id: opts.proposal_id }
    }
  };
  if (ar.validate(lessonRec).ok) state.recordAction(lessonRec, ar.toSearchText(lessonRec));

  // Optional edge: proposal -[contradicts_prior]-> lesson. The lesson
  // contradicts the substrate's proposal — useful traversal for future
  // self-reflection runs.
  state.recordEdge({ from_id: opts.proposal_id, to_id: lessonId, label: 'contradicts_prior' });

  // Resolution decision.
  const resId = ar.uuidv7();
  const resRec = {
    id: resId, timestamp: Date.now(), type: 'decision',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || proposal.cwd || null,
    user_id:  opts.user_id || proposal.user_id || 'default',
    parent_id: opts.proposal_id,
    input:  { kind: 'revision_resolved', signals: { proposal_id: opts.proposal_id, counter_lesson_id: lessonId } },
    output: { decision: 'rejected', reason: opts.reason || 'operator_rejected', rejected_by: opts.rejected_by || 'operator' }
  };
  if (ar.validate(resRec).ok) state.recordAction(resRec, ar.toSearchText(resRec));

  return { ok: true, counter_lesson_id: lessonId, resolution_id: resId };
}

// ── Listing helpers ────────────────────────────────────────────────────

function listResolutions(proposalId) {
  if (!proposalId) return [];
  return state.queryActions({
    type: 'decision', parent_id: proposalId, kind: 'revision_resolved', limit: 5
  }) || [];
}

function listProposedRevisions(opts) {
  opts = opts || {};
  if (!opts.agent_id) return [];
  const status = opts.status || 'all';   // 'pending' | 'accepted' | 'rejected' | 'all'
  const limit = Math.min(parseInt(opts.limit || 50), 500);
  const proposals = state.queryActions({
    type: 'decision', agent_id: opts.agent_id, kind: 'revision_proposed', limit
  }) || [];
  const out = [];
  for (const row of proposals) {
    const inp = safeJson(row.input) || {};
    const outp = safeJson(row.output) || {};
    const resolutions = listResolutions(row.id);
    let resolution = null;
    for (const r of resolutions) {
      const ro = safeJson(r.output) || {};
      if (ro.decision === 'accepted' || ro.decision === 'rejected') {
        resolution = { id: r.id, decision: ro.decision, ts: r.timestamp, reason: ro.reason };
        break;
      }
    }
    const item = {
      proposal_id:        row.id,
      ts:                 row.timestamp,
      old_commitment_id:  inp.signals && inp.signals.old_commitment_id,
      old_commitment_kind: inp.signals && inp.signals.old_commitment_kind,
      old_statement:      inp.signals && inp.signals.old_statement,
      evidence_excerpt:   inp.signals && inp.signals.evidence_excerpt,
      proposed_statement: outp.proposed_statement,
      proposed_commitment_type: outp.proposed_commitment_type,
      confidence:         outp.confidence,
      resolution
    };
    if (status === 'pending'  && resolution) continue;
    if (status === 'accepted' && (!resolution || resolution.decision !== 'accepted')) continue;
    if (status === 'rejected' && (!resolution || resolution.decision !== 'rejected')) continue;
    out.push(item);
  }
  return out;
}

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

module.exports = {
  proposeRevision,
  acceptRevision,
  rejectRevision,
  listProposedRevisions,
  listResolutions
};
