// SPDX-License-Identifier: AGPL-3.0-only
// AgentMarket — competitive dispatch across multiple agents/providers.
//
// Given a task and N candidate agent functions, fan out in parallel, collect
// each attempt's ActionRecord, score by verification, pick the winner.
// Losing attempts are preserved as learning data (negative examples) —
// never thrown away. Over time the scoring function can learn from them.
//
// This module is the substrate layer of AgentMarket. It does NOT spawn
// Docker containers or talk to LLM providers directly — that's bin/
// runner.js's job. Here we provide a generic race() primitive that takes
// async agent callables and orchestrates the scoring + logging.
//
// Callers use this as:
//
//   const agents = [
//     { id: 'qwen',    run: async () => await runQwenEdit(task) },
//     { id: 'opus',    run: async () => await runOpusEdit(task) },
//     { id: 'deepseek', run: async () => await runDeepSeekEdit(task) }
//   ];
//   const result = await race(state, { task, agents, verify });
//   // result.winner is the ActionRecord of the winning attempt
//   // result.attempts is all attempts (winners + losers)
//
// See the substrate design notes "Layer 3 — AgentMarket".

const actionRecord = require('./action-record');
const verification = require('./verification');

// Default scoring: use verification verdict + cost. Callers can override
// via opts.score. Returns a number where higher is better.
function defaultScore(attempt) {
  if (!attempt || !attempt.record) return -Infinity;
  const v = attempt.record.verification || {};
  const verdict = verification.verdict(v);
  const base = verdict === 'pass' ? 100 : verdict === 'partial' ? 50 : 0;
  // Bonus for matching tests + AST. Penalty for latency and tokens.
  const astOk   = v.ast   && v.ast.ok   ? 10 : 0;
  const testsOk = v.tests && v.tests.ok ? 20 : 0;
  const typesOk = v.types && v.types.ok ? 5  : 0;
  const latencyPenalty = Math.min(attempt.latency_ms || 0, 60000) / 6000;    // up to -10 points for 1-min
  const tokenPenalty   = Math.min((attempt.tokens || 0) / 1000, 50);          // up to -50 for 50K+ tokens
  return base + astOk + testsOk + typesOk - latencyPenalty - tokenPenalty;
}

// Run agents in parallel, score results, return winner. Each agent's
// `run()` MUST resolve to an object of shape:
//
//   { record: ActionRecord, tokens?: number }
//
// Everything else is optional. If `run()` throws or returns an invalid
// record, that agent is logged as a failed attempt with score -Infinity.
async function race(state, opts) {
  if (!state || !opts || !Array.isArray(opts.agents) || !opts.agents.length) {
    return { ok: false, reason: 'invalid_args' };
  }
  const task      = opts.task || null;
  const scoreFn   = typeof opts.score === 'function' ? opts.score : defaultScore;
  const task_id   = opts.task_id || ('market-' + Date.now());
  const parentId  = opts.parent_id || null;
  const session_id = opts.session_id || 'market';
  const cwd        = opts.cwd || null;

  // Launch all agents simultaneously. Each wrapped so throws don't cancel
  // siblings.
  const t0 = Date.now();
  const attempts = await Promise.all(opts.agents.map(async agent => {
    const agentStart = Date.now();
    let result = null;
    let error = null;
    try {
      result = await agent.run({ task, task_id });
    } catch (e) {
      error = String(e && e.message || e);
    }
    const latency_ms = Date.now() - agentStart;

    // Validate: agent.run MUST produce a record with verification.
    let record = result && result.record ? result.record : null;
    let tokens = result && typeof result.tokens === 'number' ? result.tokens : null;
    let valid = false;
    if (record) {
      const validation = actionRecord.validate(record);
      valid = validation.ok;
      if (!valid) error = error || 'record_invalid:' + JSON.stringify(validation.errors.slice(0, 3));
    } else if (!error) {
      error = 'no_record_returned';
    }

    return {
      agent_id:  agent.id,
      record:    valid ? record : null,
      tokens,
      latency_ms,
      error
    };
  }));

  const total_ms = Date.now() - t0;

  // Score every attempt.
  for (const a of attempts) a.score = a.record ? scoreFn(a) : -Infinity;

  // Persist losers AND winner as separate ActionRecords. Each attempt gets
  // its parent_id set to a synthetic "market run" record so the whole
  // race becomes a causality subgraph.
  const marketRun = actionRecord.create({
    type: 'decision',
    agent_id: 'troth-market',
    session_id,
    cwd,
    parent_id: parentId,
    input: {
      kind: 'market_run',
      task_id,
      task_summary: typeof task === 'string' ? task.slice(0, 200) : null,
      agents: opts.agents.map(a => a.id)
    },
    output: {
      decision: 'race_completed',
      agent_count: opts.agents.length,
      total_latency_ms: total_ms
    }
  });
  state.recordAction(marketRun, actionRecord.toSearchText(marketRun));

  // Pick winner.
  const ranked = attempts
    .filter(a => a.record)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const winner = ranked[0] || null;

  // Persist each attempt's record (if it was valid) linked to the market
  // run parent. If the agent's run() already wrote to the substrate, the
  // id will collide and the insert is a no-op — which is fine.
  for (const a of attempts) {
    if (!a.record) continue;
    // Reparent to the market run for causality.
    if (!a.record.parent_id) a.record.parent_id = marketRun.id;
    if (!a.record.id) a.record.id = actionRecord.create({ type: a.record.type, agent_id: a.record.agent_id }).id;
    state.recordAction(a.record, actionRecord.toSearchText(a.record));
  }

  // Emit a summary decision: who won, by how much.
  const summary = actionRecord.create({
    type: 'decision',
    agent_id: 'troth-market',
    session_id,
    cwd,
    parent_id: marketRun.id,
    input: {
      kind: 'market_winner',
      task_id,
      contenders: attempts.map(a => ({ agent_id: a.agent_id, score: a.score, error: a.error }))
    },
    output: {
      decision: winner ? ('winner:' + winner.agent_id) : 'no_winner',
      reason: winner ? 'highest_score' : 'all_failed',
      winning_score: winner ? winner.score : null
    }
  });
  state.recordAction(summary, actionRecord.toSearchText(summary));

  return {
    ok:       !!winner,
    task_id,
    market_run_id: marketRun.id,
    summary_id:    summary.id,
    winner,
    attempts,
    total_ms
  };
}

// ── Historical analysis ──────────────────────────────────────────────────

// Aggregate past market runs to answer: which agent wins which class of
// task? Returns counts per (agent_id × task-class) over the last N runs.
// Callers use this to inform routing decisions or tier assignment.
function analyzeWinners(state, opts) {
  opts = opts || {};
  const limit = Math.min(parseInt(opts.limit || 500), 5000);

  // Find all 'market_winner' summary records.
  const rows = state.queryActions
    ? state.queryActions({ type: 'decision', limit, order: 'desc' })
    : [];

  const winsByAgent = new Map();
  const lossesByAgent = new Map();
  for (const row of rows) {
    const rec = actionRecord.fromRow(row);
    if (!rec.input || rec.input.kind !== 'market_winner') continue;
    const out = rec.output || {};
    // Winner
    const winMatch = String(out.decision || '').match(/^winner:(.+)$/);
    if (winMatch) {
      const a = winMatch[1];
      winsByAgent.set(a, (winsByAgent.get(a) || 0) + 1);
    }
    // Losers: contenders array minus winner
    const contenders = Array.isArray(rec.input.contenders) ? rec.input.contenders : [];
    const winnerId = winMatch ? winMatch[1] : null;
    for (const c of contenders) {
      if (c.agent_id !== winnerId) {
        lossesByAgent.set(c.agent_id, (lossesByAgent.get(c.agent_id) || 0) + 1);
      }
    }
  }

  const summary = {};
  const agents = new Set([...winsByAgent.keys(), ...lossesByAgent.keys()]);
  for (const agent of agents) {
    const w = winsByAgent.get(agent) || 0;
    const l = lossesByAgent.get(agent) || 0;
    const total = w + l;
    summary[agent] = {
      wins: w,
      losses: l,
      total,
      win_rate: total > 0 ? w / total : null
    };
  }
  return summary;
}

module.exports = {
  race,
  analyzeWinners,
  defaultScore
};
