// SPDX-License-Identifier: AGPL-3.0-only
// Counterfactual replay engine.
//
// Because the substrate is append-only and every action has parent_id +
// verification + cost slots, we can answer:
//   "at turn N the agent picked path A. What would have happened if it
//   had picked path B instead?"
// The engine does NOT execute LLM calls itself. It:
//   1. Proposes alternative paths from the intent's
//      output.alternatives_considered.
//   2. Creates a counterfactual_branch row (status='candidate').
//   3. Estimates the cost of materializing the branch (no agent invoked).
//   4. Diffs the branch's outcome_summary vs the original subtree
//      (cost + verification deltas).
//   5. Lets the caller (CLI / future Memory Studio drag) materialize
//      the branch by injecting a configurable agent driver.
//
// Replay materialization requires an external `agent` callback because
// agent inference is non-deterministic and out-of-scope for substrate
// code. The CLI passes a sandbox-runner; tests pass a deterministic
// mock that records the substituted path's outcome.

const actionRecord = require('./action-record');
const cost = require('./cost');

// ── Propose alternatives from the intent's stored shape ──────────────────
function proposeAlternatives(state, intent_id) {
  if (!state || !intent_id) return [];
  const row = state.getAction(intent_id);
  if (!row || row.type !== 'intent') return [];
  const rec = actionRecord.fromRow(row);
  const alts = (rec.output && rec.output.alternatives_considered) || [];
  if (!Array.isArray(alts)) return [];
  // Each alt becomes a candidate branch description.
  return alts.map((alt, i) => ({
    index: i,
    intent_id,
    chosen_path_original: rec.output.chosen_path || null,
    substituted_path: typeof alt === 'string' ? alt : (alt.path || JSON.stringify(alt)),
    rationale_hint: typeof alt === 'object' && alt.rationale ? alt.rationale : null
  }));
}

// ── Walk the intent's downstream subtree to compute "original" baseline ───
// Reuses cost.attributeCost for $ + token totals and counts verification
// outcomes (passes/fails) in the subtree.
function originalBaseline(state, intent_id, opts) {
  opts = opts || {};
  const cost_view = cost.attributeCost(state, intent_id, { depth_limit: opts.depth_limit || 10 });
  const db = state._dbForQuery && state._dbForQuery();
  let pass = 0, fail = 0, neutral = 0;
  if (db) {
    // Count verification outcomes in the subtree. We re-run the recursive
    // CTE over parent_id + edges (mirrors attributeCost).
    const sql = `
      WITH RECURSIVE walk(node_id, depth) AS (
        SELECT @root, 0
        UNION
        SELECT ar.id, w.depth + 1 FROM action_records ar
        JOIN walk w ON ar.parent_id = w.node_id WHERE w.depth < 10
        UNION
        SELECT e.to_id, w.depth + 1 FROM action_record_edges e
        JOIN walk w ON e.from_id = w.node_id WHERE w.depth < 10
      )
      SELECT
        SUM(CASE WHEN json_extract(verification,'$.ast.ok')=1 OR json_extract(verification,'$.tests.ok')=1 THEN 1 ELSE 0 END) AS pass,
        SUM(CASE WHEN json_extract(verification,'$.ast.ok')=0 OR json_extract(verification,'$.tests.ok')=0 THEN 1 ELSE 0 END) AS fail,
        COUNT(*) AS total
      FROM action_records WHERE id IN (SELECT node_id FROM walk)
    `;
    try {
      const r = db.prepare(sql).get({ root: intent_id });
      pass = r.pass || 0;
      fail = r.fail || 0;
      neutral = (r.total || 0) - pass - fail;
    } catch (_) {}
  }
  return {
    intent_id,
    cost: cost_view ? { usd: cost_view.total_usd, input_tokens: cost_view.total_input_tokens, output_tokens: cost_view.total_output_tokens, confidence: cost_view.confidence } : null,
    verification: { pass, fail, neutral },
    node_count: cost_view ? cost_view.node_count : 0
  };
}

// ── Create a candidate branch ─────────────────────────────────────────────
function createCandidate(state, intent_id, substituted_path, opts) {
  if (!state || !intent_id || !substituted_path) return null;
  opts = opts || {};
  // Estimate cost: dry-run = baseline cost × heuristic factor (default 1.0
  // we have no model evidence yet). Caller can override with explicit
  // cost_estimate.
  const baseline = originalBaseline(state, intent_id);
  const factor = typeof opts.cost_factor === 'number' ? opts.cost_factor : 1.0;
  const est = (baseline.cost && baseline.cost.usd ? baseline.cost.usd : 0) * factor;
  return state.createBranch({
    branch_point_id: intent_id,
    substituted_path,
    status: 'candidate',
    parent_branch_id: opts.parent_branch_id || null,
    cost_estimate: est
  });
}

// ── Materialize a branch via an injected agent driver ─────────────────────
// agent: async function ({intent, substituted_path, baseline}) → outcome
//   outcome shape: { satisfied:bool, cost_usd:number, verification:{pass,fail},
//                    edits:[{file_path, hash_after}], notes:string }
// The function flips status to 'materialized', writes the agent's reported
// cost_estimate + outcome_summary onto the branch row. Substrate stays
// untouched — replayed actions are NOT inserted as ActionRecords by
// default (test mode). A future hook can opt into mirroring them with
// outcome.branch_id set so they isolate from canonical causality.
async function materializeBranch(state, branch_id, agent, opts) {
  opts = opts || {};
  if (!state || !branch_id) return { ok: false, error: 'missing_args' };
  const branch = state.getBranch(branch_id);
  if (!branch) return { ok: false, error: 'branch_not_found' };
  if (branch.status !== 'candidate') return { ok: false, error: 'wrong_status', status: branch.status };
  const intent = state.getAction(branch.branch_point_id);
  if (!intent) return { ok: false, error: 'intent_not_found' };
  const baseline = originalBaseline(state, branch.branch_point_id);
  let outcome;
  try {
    outcome = await agent({
      intent: actionRecord.fromRow(intent),
      substituted_path: branch.substituted_path,
      baseline
    });
  } catch (e) {
    return { ok: false, error: 'agent_threw', message: e.message };
  }
  if (!outcome || typeof outcome !== 'object') return { ok: false, error: 'bad_outcome_shape' };
  const summary = {
    satisfied: !!outcome.satisfied,
    cost_usd: typeof outcome.cost_usd === 'number' ? outcome.cost_usd : 0,
    verification: outcome.verification || { pass: 0, fail: 0 },
    edits: Array.isArray(outcome.edits) ? outcome.edits.length : 0,
    notes: outcome.notes || null
  };
  state.setBranchStatus(branch_id, 'materialized', {
    cost_estimate: summary.cost_usd,
    outcome_summary: summary
  });
  return { ok: true, branch_id, summary };
}

function discardBranch(state, branch_id) {
  if (!state || !branch_id) return false;
  return state.setBranchStatus(branch_id, 'discarded');
}

// ── Diff: branch outcome vs original subtree baseline ────────────────────
function diffBranch(state, branch_id) {
  if (!state || !branch_id) return null;
  const branch = state.getBranch(branch_id);
  if (!branch) return null;
  const baseline = originalBaseline(state, branch.branch_point_id);
  const summary = branch.outcome_summary || {};
  const branchCost = (typeof summary.cost_usd === 'number' ? summary.cost_usd : null);
  const baselineCost = baseline.cost ? baseline.cost.usd : null;
  return {
    branch_id,
    branch_status: branch.status,
    intent_id: branch.branch_point_id,
    chosen_path_original: (() => {
      const r = state.getAction(branch.branch_point_id);
      if (!r) return null;
      try { return (JSON.parse(r.output) || {}).chosen_path || null; }
      catch { return null; }
    })(),
    substituted_path: branch.substituted_path,
    cost: {
      original_usd: baselineCost,
      branch_usd: branchCost,
      delta_usd: (branchCost != null && baselineCost != null) ? (branchCost - baselineCost) : null,
      pct_change: (branchCost != null && baselineCost && baselineCost > 0)
        ? ((branchCost - baselineCost) / baselineCost) * 100 : null
    },
    verification: {
      original: baseline.verification,
      branch: summary.verification || null,
      satisfied: branch.status === 'materialized' ? !!summary.satisfied : null
    },
    cheaper: (branchCost != null && baselineCost != null) ? branchCost < baselineCost : null,
    safer:   (summary.verification && (summary.verification.fail || 0) <= (baseline.verification.fail || 0))
  };
}

module.exports = {
  proposeAlternatives,
  originalBaseline,
  createCandidate,
  materializeBranch,
  discardBranch,
  diffBranch
};
