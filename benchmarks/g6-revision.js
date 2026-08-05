#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// g6-revision — G6.
//
// Acceptance (per the plan):
//   5 evidence-triggering scenarios → substrate proposes revision in
//   ≥ 4/5, user accepts/rejects, L1 reflects choice.
//
// Procedure:
//   1. Seed 5 anchor commitments under a fresh agent.
//   2. For each scenario, feed the user's evidence-bearing message
//      through G2 disagreement.detect. When proposes_revision=true,
//      auto-propose a revision via revision-protocol.proposeRevision.
//   3. Verify each proposal landed in L1; listProposedRevisions shows
//      pending=5.
//   4. Operator simulator: accept 3, reject 2 with counter-evidence.
//   5. Verify L1 final state — 3 new commitments superseding their
//      originals, 2 lessons recording counter-evidence, 5 resolved
//      proposals.
//
// No LLM calls, no embedding calls — pure substrate-side validation
// of the propose / accept / reject lifecycle and the G2→G6 wiring.

const fs    = require('fs');
const path  = require('path');

const dis   = require('../shared-core/disagreement.js');
const rp    = require('../shared-core/revision-protocol.js');
const state = require('../shared-core/state.js');
const ar    = require('../shared-core/action-record.js');

const AGENT = 'g6-bench-' + Date.now();
const CWD   = '/tmp/g6-bench';

const COMMITMENTS = [
  { kind: 'anchor',  statement: 'the user prefers tabs over spaces in source code' },
  { kind: 'opinion', statement: 'troth uses SQLite for L1 storage and that choice is correct given the single-file portability requirement' },
  { kind: 'anchor',  statement: 'Local llama-server inference on Mac Studio is preferred over hosted APIs for substrate work' },
  { kind: 'anchor',  statement: 'the user prefers helix editor for code' },
  { kind: 'opinion', statement: 'Rust is the right language for performance-critical the user projects (e.g., argus tokenizer)' }
];

// 5 evidence-triggering scenarios. Each pairs (a) the user message
// carrying evidence with (b) the proposed new commitment statement.
// Scenarios 1, 3, 5 will be ACCEPTED; 2, 4 will be REJECTED with
// counter-evidence (mimics operator real-world adjudication).
const SCENARIOS = [
  {
    id: 's1', accept: true,
    target_idx: 0,
    user_text: 'New benchmark data shows spaces are objectively faster to read in dense code; turns out tabs are worse for shared codebases.',
    proposed: 'the user prefers spaces over tabs in source code (revised after benchmark evidence on dense-code readability)'
  },
  {
    id: 's2', accept: false,
    target_idx: 1,
    user_text: 'Just learned Postgres now ships with a single-file deployment mode in v17, the SQLite advantage is gone.',
    proposed: 'troth should use Postgres in single-file mode for L1 storage'
  },
  {
    id: 's3', accept: true,
    target_idx: 2,
    user_text: 'New data: hosted Anthropic API now offers data residency guarantees and zero-retention contracts; the privacy concerns we cited are resolved per updated guidance.',
    proposed: 'Hosted Anthropic API is acceptable for substrate work given updated zero-retention guidance'
  },
  {
    id: 's4', accept: false,
    target_idx: 3,
    user_text: 'The latest benchmark shows neovim now matches helix in startup time; turns out our prior data was stale.',
    proposed: 'the user can use neovim instead of helix for code'
  },
  {
    id: 's5', accept: true,
    target_idx: 4,
    user_text: 'Updated research on safe Rust subset finds Zig matches performance with simpler ergonomics; turns out for argus-style tokenizers the difference is negligible.',
    proposed: 'Zig is acceptable as an alternative to Rust for performance-critical the user projects (argus tokenizer scope)'
  }
];

// ── Helpers ────────────────────────────────────────────────────────────

function seedCommitments() {
  const out = [];
  for (const c of COMMITMENTS) {
    const id = ar.uuidv7();
    const rec = {
      id, timestamp: Date.now(), type: 'commitment',
      agent_id: AGENT, cwd: CWD, user_id: 'default', parent_id: null,
      input:  { source: 'g6_bench_seed' },
      output: { statement: c.statement, commitment_type: c.kind }
    };
    state.recordAction(rec, ar.toSearchText(rec));
    out.push({ id, ...c });
  }
  return out;
}

async function main() {
  const tStart = Date.now();
  console.error('[g6] G6 revision protocol bench  agent=' + AGENT);
  console.error('[g6] seeding ' + COMMITMENTS.length + ' commitments...');
  const seeded = seedCommitments();
  console.error('[g6] seeded ids: ' + seeded.map(s => s.id.slice(0,8)).join(', '));

  // Step 1: detect + propose
  console.error('[g6] running detection + propose...');
  const proposals = [];
  for (const sc of SCENARIOS) {
    const target = seeded[sc.target_idx];
    const cmList = seeded.map(s => ({
      id: s.id,
      output: { commitment_type: s.kind, statement: s.statement }
    }));
    const det = dis.detect(sc.user_text, cmList);
    const proposesRevision = det.proposes_revision;
    let proposalRes = null;
    if (proposesRevision) {
      proposalRes = rp.proposeRevision({
        agent_id: AGENT, cwd: CWD,
        old_commitment_id: target.id,
        proposed_statement: sc.proposed,
        evidence: sc.user_text,
        evidence_source: 'g2_disagreement_proposes_revision'
      });
    }
    proposals.push({
      scenario: sc.id, target_id: target.id,
      detection_proposes_revision: proposesRevision,
      detection_contradicts: det.contradicts,
      proposal_ok: proposalRes && proposalRes.ok,
      proposal_id: proposalRes && proposalRes.proposal_id
    });
    console.error('[g6] ' + sc.id + ' proposes_revision=' + proposesRevision +
                  ' proposal_ok=' + (proposalRes && proposalRes.ok));
  }

  const proposedCount = proposals.filter(p => p.proposal_ok).length;
  const detectionCount = proposals.filter(p => p.detection_proposes_revision).length;

  // Step 2: list pending
  const pending = rp.listProposedRevisions({ agent_id: AGENT, status: 'pending' });
  console.error('[g6] pending after propose=' + pending.length);

  // Step 3: accept / reject per scenario decisions
  console.error('[g6] simulating operator decisions...');
  const decisions = [];
  for (const p of proposals) {
    if (!p.proposal_ok) { decisions.push({ scenario: p.scenario, skipped: true, reason: 'no_proposal' }); continue; }
    const sc = SCENARIOS.find(x => x.id === p.scenario);
    let res;
    if (sc.accept) {
      res = rp.acceptRevision({ agent_id: AGENT, proposal_id: p.proposal_id, confirmed_by: 'g6_bench_operator' });
    } else {
      res = rp.rejectRevision({
        agent_id: AGENT, proposal_id: p.proposal_id,
        counter_evidence: 'Operator review: ' + (sc.id === 's2'
          ? 'Postgres v17 single-file mode still requires a separate process at runtime — not equivalent to SQLite.'
          : 'Marketing claim, no peer-reviewed benchmark on substrate workload — original commitment stands.'),
        rejected_by: 'g6_bench_operator'
      });
    }
    decisions.push({ scenario: p.scenario, action: sc.accept ? 'accept' : 'reject', ok: res.ok, result: res });
  }

  // Step 4: verify final L1 state
  const finalAccepted = rp.listProposedRevisions({ agent_id: AGENT, status: 'accepted' });
  const finalRejected = rp.listProposedRevisions({ agent_id: AGENT, status: 'rejected' });
  const finalPending  = rp.listProposedRevisions({ agent_id: AGENT, status: 'pending' });

  // Verify supersedes edges exist for the 3 accepted
  let supersedeEdgesCount = 0;
  for (const acc of decisions.filter(d => d.action === 'accept' && d.ok)) {
    const edges = state.queryEdges({ from_id: acc.result.new_commitment_id, label: 'supersedes' });
    if (edges.length >= 1) supersedeEdgesCount++;
  }
  // Verify counter-evidence lessons exist for the 2 rejected
  let counterLessonsCount = 0;
  for (const rej of decisions.filter(d => d.action === 'reject' && d.ok)) {
    const lr = state.getAction(rej.result.counter_lesson_id);
    if (lr && lr.type === 'lesson') counterLessonsCount++;
  }

  const acceptedTarget = SCENARIOS.filter(s => s.accept).length;   // 3
  const rejectedTarget = SCENARIOS.filter(s => !s.accept).length;  // 2

  const acceptance = {
    detection_proposes_revision_count: detectionCount,
    proposals_written:                 proposedCount,
    pending_after_propose:             pending.length,
    accepted_after_decisions:          finalAccepted.length,
    rejected_after_decisions:          finalRejected.length,
    pending_after_decisions:           finalPending.length,
    supersedes_edges:                  supersedeEdgesCount,
    counter_lessons:                   counterLessonsCount,
    pass: detectionCount >= 4 &&
          proposedCount === detectionCount &&
          finalAccepted.length === acceptedTarget &&
          finalRejected.length === rejectedTarget &&
          finalPending.length === 0 &&
          supersedeEdgesCount === acceptedTarget &&
          counterLessonsCount === rejectedTarget
  };

  const elapsed = Date.now() - tStart;
  const summary = { acceptance, elapsed_ms: elapsed };

  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(outDir, 'g6-revision-' + stamp + '.json');
  const mdPath   = path.join(outDir, 'g6-revision-' + stamp + '.md');
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, proposals, decisions }, null, 2));

  const md = [];
  md.push('# G6 — Revision Protocol Bench — ' + new Date().toISOString());
  md.push('');
  md.push('Agent: `' + AGENT + '`  ');
  md.push('Scenarios: ' + SCENARIOS.length + ' (3 accept-expected, 2 reject-expected)  ');
  md.push('Elapsed: ' + (elapsed/1000).toFixed(1) + 's');
  md.push('');
  md.push('## Acceptance');
  md.push('- Detection proposes_revision (target ≥ 4): **' + detectionCount + '/5**');
  md.push('- Proposals written: ' + proposedCount + '/' + detectionCount);
  md.push('- After operator decisions: accepted=**' + finalAccepted.length + '/' + acceptedTarget +
          '** rejected=**' + finalRejected.length + '/' + rejectedTarget +
          '** pending=' + finalPending.length);
  md.push('- supersedes edges (accepted only): **' + supersedeEdgesCount + '/' + acceptedTarget + '**');
  md.push('- counter-evidence lessons (rejected only): **' + counterLessonsCount + '/' + rejectedTarget + '**');
  md.push('- **Verdict:** ' + (acceptance.pass ? '✅ PASS' : '❌ FAIL'));
  md.push('');
  md.push('## Per-scenario detail');
  md.push('');
  md.push('| ID | Target idx | Detected | Proposed | Decision | OK |');
  md.push('|---|---|---|---|---|---|');
  for (const p of proposals) {
    const sc = SCENARIOS.find(x => x.id === p.scenario);
    const dec = decisions.find(d => d.scenario === p.scenario) || {};
    md.push('| ' + p.scenario +
            ' | ' + sc.target_idx +
            ' | ' + (p.detection_proposes_revision ? '✅' : '❌') +
            ' | ' + (p.proposal_ok ? '✅' : '⛔') +
            ' | ' + (dec.action || '—') +
            ' | ' + (dec.ok ? '✅' : (dec.skipped ? '—' : '❌')) + ' |');
  }
  fs.writeFileSync(mdPath, md.join('\n'));
  console.error('\n[g6] DONE → ' + jsonPath);
  console.error('[g6]      → ' + mdPath);
  console.log(JSON.stringify({ json: jsonPath, md: mdPath, summary }, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}

module.exports = { COMMITMENTS, SCENARIOS };
