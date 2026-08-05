// SPDX-License-Identifier: AGPL-3.0-only
// Task Budgets — Opus 4.7 public beta advisory pacing.
//
// Opus 4.7 introduces task_budget: an advisory token ceiling the model SEES
// as a running countdown across the full agentic loop (thinking + tools +
// result + final output). Unlike max_tokens (hard cap, invisible to model),
// task_budget lets the model self-pace — finishing gracefully or simplifying
// reasoning to stay within budget.
//
// API: anthropic-beta header `task-budgets-`, body field
// output_config.task_budget = { type: 'tokens', total: N }. Minimum 20,000.
// task_budget ≤ max_tokens or the model may be cut off mid-task.
//
// This module is a pure transformation: takes a body string, injects a
// sensible default task_budget if none present, returns the modified body
// and the combined anthropic-beta header value.
//
var BETA_HEADER = 'task-budgets-2026-03-13';
var MIN_BUDGET = 20000;
var DEFAULT_MAX_TOKENS_FALLBACK = 32000;
var BUDGET_FRACTION_OF_MAX = 0.8;

// Returns { body: string, beta: string, injected: bool }.
// existingBeta is the current client anthropic-beta value (may be empty).
function applyTaskBudget(bodyStr, existingBeta) {
  var result = { body: bodyStr, beta: existingBeta || '', injected: false };
  try {
    var bodyObj = JSON.parse(bodyStr);
    var maxTok = bodyObj.max_tokens || DEFAULT_MAX_TOKENS_FALLBACK;
    var budgetTotal = Math.max(MIN_BUDGET, Math.floor(maxTok * BUDGET_FRACTION_OF_MAX));

    if (!bodyObj.output_config) bodyObj.output_config = {};
    if (!bodyObj.output_config.task_budget) {
      bodyObj.output_config.task_budget = { type: 'tokens', total: budgetTotal };
      result.injected = true;
    }
    result.body = JSON.stringify(bodyObj);

    // Add the beta header without clobbering anything the client already sent.
    var existing = existingBeta || '';
    if (existing.indexOf(BETA_HEADER) === -1) {
      result.beta = existing ? existing + ',' + BETA_HEADER : BETA_HEADER;
    }
  } catch (e) {
    // Leave body/beta unchanged on parse failure.
  }
  return result;
}

module.exports = {
  applyTaskBudget: applyTaskBudget,
  BETA_HEADER: BETA_HEADER,
  MIN_BUDGET: MIN_BUDGET,
  DEFAULT_MAX_TOKENS_FALLBACK: DEFAULT_MAX_TOKENS_FALLBACK,
  BUDGET_FRACTION_OF_MAX: BUDGET_FRACTION_OF_MAX
};
