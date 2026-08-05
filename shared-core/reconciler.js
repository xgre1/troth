// SPDX-License-Identifier: AGPL-3.0-only
// Reconciler — the entity design primitive.
//
// "Post-output verifier; checks LLM output against active commitments;
// triggers re-prompt loops on conflict."
//
// disagreement.js handles INPUT side (user contradicts substrate). The
// Reconciler handles OUTPUT side (substrate's own LLM reply contradicts
// substrate's own commitments). Without it, a sycophantic LLM can drift
// the substrate's voice mid-reply — committing the substrate to positions
// it doesn't actually hold, which then re-feed the engram store and
// corrupt identity over time.
//
// Pure verification. No I/O. Caller decides whether to:
//   re-prompt the LLM with an explicit corrective preface
//   emit a `decision` action of kind=`reconciliation_alert`
//   block the response entirely (rare; only on hard_commitment violation)
//
// Verdict shape:
//   {
//     ok,                          // true = consistent; false = conflict
//     conflicts: [{                // empty when ok
//       commitment_id,
//       commitment_kind,           // anchor | hard | hypothesis |...
//       commitment_statement,
//       evidence,                  // the offending span from the LLM reply
//       severity,                  // 'block' | 'reprompt' | 'flag'
//       reason                     // human-readable why
//     }],
//     reprompt_preface             // string the caller can prepend on retry
//   }
//
// Severity heuristic:
//   hard commitment violated → 'block'  (must not ship; reprompt or refuse)
//   anchor/methodology       → 'reprompt'
//   opinion/hypothesis       → 'flag'  (log only; substrate may revise)
//
// This module is intentionally deterministic. LLM-driven adjudication
// (an "is this consistent with the commitment?" classifier) is a future
// extension; deterministic catches the obvious cases first.

const dis = require('./disagreement.js');

const ELIGIBLE_KINDS = new Set(['anchor', 'hard', 'hypothesis', 'opinion', 'methodology']);

const SEVERITY_BY_KIND = {
  hard:         'block',
  anchor:       'reprompt',
  methodology:  'reprompt',
  hypothesis:   'flag',
  opinion:      'flag'
};

// Reuse disagreement.detect — same heuristic stack (negation markers,
// opposite-pair flips, polarity inversion). The semantic question is
// identical: "does this text contradict this commitment?" The difference
// is who emitted the text (user vs LLM) and what the substrate does next.
function reconcile(replyText, commitments, opts) {
  opts = opts || {};
  const text = String(replyText || '').trim();
  if (!text || !Array.isArray(commitments) || !commitments.length) {
    return { ok: true, conflicts: [], reprompt_preface: null };
  }

  // Filter to eligible kinds — refusals + factuals + engrams skipped.
  const eligible = commitments.filter(c =>
    c && c.output && ELIGIBLE_KINDS.has(c.output.commitment_type));

  if (!eligible.length) {
    return { ok: true, conflicts: [], reprompt_preface: null };
  }

  const detection = dis.detect(text, eligible);
  if (!detection || !detection.contradicts || !detection.hits.length) {
    return { ok: true, conflicts: [], reprompt_preface: null };
  }

  const conflicts = detection.hits.map(h => {
    const c = eligible.find(e => e.id === h.commitment_id);
    const kind = (c && c.output && c.output.commitment_type) || 'opinion';
    return {
      commitment_id: h.commitment_id,
      commitment_kind: kind,
      commitment_statement: (c && c.output && c.output.statement) || '',
      evidence: h.evidence || text.slice(0, 200),
      severity: SEVERITY_BY_KIND[kind] || 'flag',
      reason: h.reason || 'reply contradicts commitment'
    };
  });

  // Highest severity wins (block > reprompt > flag) for top-line ok.
  const hasBlock    = conflicts.some(c => c.severity === 'block');
  const hasReprompt = conflicts.some(c => c.severity === 'reprompt');

  // Build a structured preface the caller can prepend on retry. Lists
  // each conflicting commitment + tells the LLM exactly what to do:
  // either defend (with explicit reason) or formally propose revision.
  const lines = [
    '## Reconciliation gate — your previous reply contradicts the substrate.',
    '',
    'Active commitments you crossed:'
  ];
  for (const c of conflicts) {
    lines.push('  · [' + c.commitment_kind + '] ' + c.commitment_statement);
  }
  lines.push('');
  lines.push('Re-emit your reply in one of two modes:');
  lines.push('1. DEFEND — keep the same conclusion, but cite the substrate commitment + the reason your reply does not actually contradict it.');
  lines.push('2. REVISE — formally propose updating the commitment. Use the structure: "I propose revising commitment X because Y. New commitment text: Z."');
  lines.push('Silent agreement is not an option.');

  return {
    ok: !hasBlock && !hasReprompt,
    conflicts,
    reprompt_preface: lines.join('\n'),
    severity: hasBlock ? 'block' : (hasReprompt ? 'reprompt' : 'flag')
  };
}

module.exports = { reconcile, ELIGIBLE_KINDS, SEVERITY_BY_KIND };
