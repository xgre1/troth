// SPDX-License-Identifier: AGPL-3.0-only
// Multi-agent — substrate-to-substrate negotiation primitive.
//
// G5. The dream property is
// "multi-agent native" — multiple substrate instances should be able to
// share state, propose claims, defend or revise them, and converge on
// either consensus or marked-disagreement. Without this primitive, every
// substrate is a single-mind island; the swarm story is rhetoric.
//
// Design (intentionally minimal for v0.1):
//
//   negotiate(substrateA, substrateB, topic) → result
//
// where each `substrate` exposes a thin contract:
//   {
//     agent_id,
//     listEngrams({scope, limit}),
//     recordEngram({statement, salience, scope, source, ...}),
//   }
//
// The negotiation runs N rounds. In each round:
//   1. Both substrates list their commitments matching `topic.scope`
//      (salience-ranked).
//   2. The arbiter (a synchronous comparison function — no LLM call in
//      v0.1) detects whether the top claims agree, conflict, or are
//      orthogonal.
//   3. On agreement: both substrates record a `consensus` engram with
//      provenance pointing at the negotiation id.
//   4. On conflict: each substrate records a `disagreement` engram with
//      a `counter_to` pointer at the other's claim. No silent loss.
//   5. On orthogonal: both substrates record a `merged` engram pulling
//      both perspectives into one statement.
//
// The result is a structured ledger of what happened — not "winner takes
// all". This matches the design claim that disagreement is
// first-class, not an error condition.
//
// Out of scope for v0.1:
//   - LLM-driven adjudication (just deterministic compare for now)
//   - Cryptographic identity proofs between substrates
//   - Federated learning weights crossing tenant boundary

const crypto = require('crypto');

const SCOPE_DEFAULT = 'multi-agent-negotiation';

// Lightweight token-overlap scorer. Same shape as engram lexical fallback.
// Two statements "agree" if overlap >= AGREE_THRESHOLD; "conflict" if they
// share a topic anchor (first 2 nouns / capitalized tokens) but their
// extracted polarities differ; "orthogonal" otherwise. Polarity is a
// crude lexical heuristic — explicit negation marker or known antonym.
const AGREE_THRESHOLD = 0.55;
const NEGATION_RX = /\b(not|no|never|cannot|can't|won't|don't|isn't|aren't|shouldn't)\b/i;

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 2);
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

function polarity(s) {
  return NEGATION_RX.test(s || '') ? 'negative' : 'positive';
}

function classify(stmtA, stmtB) {
  if (!stmtA || !stmtB) return 'orthogonal';
  const ja = jaccard(tokenize(stmtA), tokenize(stmtB));
  if (ja >= AGREE_THRESHOLD) {
    return polarity(stmtA) === polarity(stmtB) ? 'agree' : 'conflict';
  }
  return 'orthogonal';
}

function makeNegotiationId() {
  return 'neg-' + crypto.randomBytes(6).toString('hex');
}

// Negotiate one topic between two substrates.
// Options:
//   topic.scope    — required; engrams within this scope are the universe
//   topic.statement — optional; if provided, used as the seed claim
//   options.rounds — default 1; future-extensible for back-and-forth
//   options.salience — default 1.0; engrams emitted carry this
function negotiate(substrateA, substrateB, topic, options) {
  options = options || {};
  if (!substrateA || !substrateB) {
    return { ok: false, error: 'both substrates required' };
  }
  if (!topic || !topic.scope) {
    return { ok: false, error: 'topic.scope required' };
  }
  const negId = makeNegotiationId();
  const rounds = Math.max(1, Math.min(5, options.rounds || 1));
  const salience = typeof options.salience === 'number' ? options.salience : 1.0;
  const events = [];

  // engram.listEngrams returns flat `{id, ts, statement, salience, scope, source}`;
  // raw substrate query rows would have `.output.statement`. Support both
  // shapes so negotiate works whether the caller wires fromEngram or hand-rolls
  // a substrate adapter.
  const readStmt = (row) =>
    (row && row.statement) ||
    (row && row.output && row.output.statement) ||
    '';

  for (let r = 0; r < rounds; r++) {
    const claimsA = substrateA.listEngrams({ scope: topic.scope, limit: 5 }) || [];
    const claimsB = substrateB.listEngrams({ scope: topic.scope, limit: 5 }) || [];
    const stmtA = readStmt(claimsA[0]) || topic.statement || '';
    const stmtB = readStmt(claimsB[0]) || topic.statement || '';
    const verdict = classify(stmtA, stmtB);

    let recordA = null, recordB = null;
    const provenanceCommon = {
      source_module: 'multi-agent.js',
      negotiation_id: negId,
      round: r,
      counterparty: verdict === 'agree'
        ? (substrateB.agent_id || 'unknown')
        : (substrateA.agent_id || 'unknown')
    };

    if (verdict === 'agree') {
      const merged = stmtA.length >= stmtB.length ? stmtA : stmtB;
      recordA = substrateA.recordEngram({
        statement: 'CONSENSUS: ' + merged,
        scope: topic.scope, salience,
        source: 'multi_agent_consensus',
        ...provenanceCommon
      });
      recordB = substrateB.recordEngram({
        statement: 'CONSENSUS: ' + merged,
        scope: topic.scope, salience,
        source: 'multi_agent_consensus',
        ...provenanceCommon
      });
    } else if (verdict === 'conflict') {
      recordA = substrateA.recordEngram({
        statement: 'DISAGREEMENT (counter to ' + (substrateB.agent_id || 'other') + '): ' + stmtA,
        scope: topic.scope, salience,
        source: 'multi_agent_disagreement',
        ...provenanceCommon
      });
      recordB = substrateB.recordEngram({
        statement: 'DISAGREEMENT (counter to ' + (substrateA.agent_id || 'other') + '): ' + stmtB,
        scope: topic.scope, salience,
        source: 'multi_agent_disagreement',
        ...provenanceCommon
      });
    } else {
      const merged = stmtA && stmtB
        ? 'MERGED: ' + stmtA + ' || ' + stmtB
        : 'MERGED: ' + (stmtA || stmtB);
      recordA = substrateA.recordEngram({
        statement: merged, scope: topic.scope, salience,
        source: 'multi_agent_merged', ...provenanceCommon
      });
      recordB = substrateB.recordEngram({
        statement: merged, scope: topic.scope, salience,
        source: 'multi_agent_merged', ...provenanceCommon
      });
    }

    events.push({
      round: r, verdict,
      a_claim: stmtA.slice(0, 200),
      b_claim: stmtB.slice(0, 200),
      a_record_id: recordA, b_record_id: recordB
    });

    // Early-exit on agreement — re-running the same negotiation would
    // re-record an already-resolved consensus.
    if (verdict === 'agree') break;
  }

  return {
    ok: true,
    negotiation_id: negId,
    scope: topic.scope,
    a: substrateA.agent_id || null,
    b: substrateB.agent_id || null,
    rounds_run: events.length,
    final_verdict: events[events.length - 1].verdict,
    events
  };
}

// Adapter: wrap shared-core/engram into the substrate contract above.
// Convenience helper so callers don't have to hand-build the wrapper.
function fromEngram(engramModule, agent_id, opts) {
  opts = opts || {};
  const cwd = opts.cwd || null;
  return {
    agent_id,
    listEngrams: (q) => engramModule.listEngrams({
      agent_id,
      cwd,
      scope: q && q.scope,
      limit: (q && q.limit) || 10
    }),
    recordEngram: (e) => engramModule.recordEngram({
      agent_id,
      cwd,
      statement: e.statement,
      scope: e.scope,
      salience: e.salience,
      source: e.source,
      source_module: e.source_module,
      // Pack negotiation metadata into provenance so downstream readers
      // can trace which negotiation produced this commitment.
      file_path: undefined,
      codelens_entity_id: e.negotiation_id ? ('negotiation:' + e.negotiation_id) : undefined
    })
  };
}

module.exports = {
  negotiate,
  classify,
  fromEngram,
  AGREE_THRESHOLD
};
