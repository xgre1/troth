// SPDX-License-Identifier: AGPL-3.0-only
// Token cost calculator — track $$ per provider.
//
// Real provider rates, $/M tokens. Full sweep verified 2026-08-07 against
// each provider's official pricing page; per-block notes carry the sources.
// Used by /api/stats to surface running costs and by dashboard to show
// projected monthly burn.

const RATES = {
  // Anthropic. Verify against https://anthropic.com/pricing — placeholder
  // entries marked below should be confirmed before relying on the savings
  // number for billing decisions.
  'claude-opus-4.7':       { in: 5.00, out: 25.00, cached_in: 0.50 },  // placeholder — same as 4.6 until Anthropic publishes 4.7 list price
  'claude-opus-4.6':       { in: 5.00, out: 25.00, cached_in: 0.50 },
  'claude-sonnet-4.6':     { in: 3.00, out: 15.00, cached_in: 0.30 },
  // Claude 5 family + Haiku 4.5 list prices, verified 2026-08 against
  // platform.claude.com (cache-read ~0.1x input).
  'claude-fable-5':        { in: 10.00, out: 50.00, cached_in: 1.00 },
  'claude-opus-5':         { in: 5.00,  out: 25.00, cached_in: 0.50 },
  'claude-opus-4.8':       { in: 5.00,  out: 25.00, cached_in: 0.50 },
  // Sonnet 5 bills an intro price ($2/$10) through 2026-08-31; the list
  // price below is the steady state from September on.
  'claude-sonnet-5':       { in: 3.00,  out: 15.00, cached_in: 0.30 },
  'claude-haiku-4.5':      { in: 1.00,  out: 5.00,  cached_in: 0.10 },
  // OpenAI
  'gpt-5.4':               { in: 2.50, out: 15.00, cached_in: 0.25 },
  // Standard tier; the old 0.625/5.00 pair was the 50% batch rate.
  'gpt-5':                 { in: 1.25, out: 10.00, cached_in: 0.125 },
  // Google
  // Base tier (<=200k prompt). gemini-3-pro is the catalog id for the same
  // Pro pricing (Google's list name is Gemini 3.1 Pro Preview).
  'gemini-3.1-pro':        { in: 2.00, out: 12.00, cached_in: 0.20 },
  'gemini-3-pro':          { in: 2.00, out: 12.00, cached_in: 0.20 },
  'gemini-3-flash':        { in: 0.50, out: 3.00, cached_in: 0.05 },
  // Alibaba (flat rate per plan, not per-token; provide reference rate)
  'qwen-max':              { in: 0,    out: 0,    cached_in: 0,   plan: 'flat' },  // alias older clients may send
  'qwen3-max':             { in: 0,    out: 0,    cached_in: 0,   plan: 'flat' },
  'qwen3.6-plus':          { in: 0,    out: 0,    cached_in: 0,   plan: 'flat' },
  'minimax-m2.5':          { in: 0,    out: 0,    cached_in: 0,   plan: 'flat' },
  'glm-5.1':               { in: 1.40, out: 4.40, cached_in: 0.26 },
  // Moonshot (Kimi). Verified  against platform.kimi.ai/docs/pricing/chat-*.
  // `in` is the cache-miss rate; `cached_in` is the cache-hit rate.
  'kimi-k3':                    { in: 3.00, out: 15.00, cached_in: 0.30 },
  'kimi-k2.7-code':             { in: 0.95, out: 4.00,  cached_in: 0.19 },
  'kimi-k2.7-code-highspeed':   { in: 1.90, out: 8.00,  cached_in: 0.38 },
  'kimi-k2.6':                  { in: 0.95, out: 4.00,  cached_in: 0.16 },
  // xAI (Grok). Verified 2026-08-07 against docs.x.ai/docs/models, below-200k
  // tier. xAI publishes cached-input rates now.
  'grok-4.3':                   { in: 1.25, out: 2.50,  cached_in: 0.20 },
  'grok-4.5':                   { in: 2.00, out: 6.00,  cached_in: 0.30 },
  'grok-build-0.1':             { in: 1.00, out: 2.00,  cached_in: 0.20 },
  // Kimi-for-Coding MEMBERSHIP lane (kimi_sub): flat plan, zero marginal $.
  // These are the ids that lane ACTUALLY sends; without them they fell into
  // the rateFor() null path and showed $0 by accident rather than by intent
  //.
  'k3':                        { in: 0, out: 0, cached_in: 0, plan: 'flat' },
  'k3[1m]':                    { in: 0, out: 0, cached_in: 0, plan: 'flat' },
  'kimi-for-coding':           { in: 0, out: 0, cached_in: 0, plan: 'flat' },
  'kimi-for-coding-highspeed': { in: 0, out: 0, cached_in: 0, plan: 'flat' },
  // ChatGPT-subscription lane (openai_sub): same flat-plan semantics.
  'gpt-5.5':                   { in: 0, out: 0, cached_in: 0, plan: 'flat' },
  'gpt-5.6-sol':               { in: 0, out: 0, cached_in: 0, plan: 'flat' },
  // DeepSeek. v4 rates verified  against api-docs.deepseek.com /
  // devtk.ai mirrors: $0.435/M cache-miss in, $0.003625/M cached, $0.87/M out.
  'deepseek-v4-pro':       { in: 0.435, out: 0.87, cached_in: 0.003625 },
  'deepseek-v4':           { in: 0.435, out: 0.87, cached_in: 0.003625 },
  // The pricing page warns a significant increase is coming; recheck on the
  // next sweep.
  'deepseek-v4-flash':     { in: 0.14, out: 0.28, cached_in: 0.0028 },
  'deepseek-chat':         { in: 0.27, out: 1.10, cached_in: 0.03 },
  // DeepInfra standard tier; the old 0.14/0.28 pair was DeepSeek's own
  // first-party v4-flash price, not DeepInfra's.
  'deepseek-ai/DeepSeek-V3-0324': { in: 0.24, out: 0.90, cached_in: 0.135 },
  // No published cached rate for Maverick; cached_in mirrors input.
  'meta-llama/Llama-4-Maverick':  { in: 0.20, out: 0.80, cached_in: 0.20 },
  // DeepInfra delisted the base 235B id; priced at its live successor
  // (Qwen3-235B-A22B-Instruct-2507). The catalog id needs a refresh.
  'Qwen/Qwen3-235B-A22B':         { in: 0.09, out: 0.55, cached_in: 0.09 },
  // OpenRouter (free)
  'minimax/minimax-m2.5:free': { in: 0, out: 0, cached_in: 0, plan: 'free' },
  // NIM
  'deepseek-ai/deepseek-v3.1': { in: 0, out: 0, cached_in: 0, plan: 'free' },
  'deepseek-ai/deepseek-v3.2': { in: 0, out: 0, cached_in: 0, plan: 'free' },
  'openai/gpt-oss-120b':       { in: 0, out: 0, cached_in: 0, plan: 'free' },
  // Custom (OpenAI-compatible): no fixed pricing is possible. The operator
  // points this provider at ANY OpenAI-shaped endpoint (NVIDIA NIM, vLLM,
  // LiteLLM, self-hosted) with a free-text model id we cannot enumerate, so
  // there is no RATES row to add. This is handled EXACTLY like `local`: the
  // model won't match rateFor(), and calculateCost() below returns
  // { cost: 0, unknown: true } for it, the file's standard idiom for
  // unknown/unpriced models. If a custom model id happens to substring-match
  // a known row (e.g. 'deepseek-ai/DeepSeek-V3-0324' served via NIM) it will
  // reuse that row's rate, which is the closest honest estimate available.
};

function rateFor(modelName) {
  if (!modelName) return null;
  // Rows ingested from Claude Code's own session logs carry a ' (plan)'
  // marker (see shared-core/claude-usage-ingest.js): those tokens are
  // covered by the operator's flat Claude plan. Priced ahead of every
  // lookup so no unsuffixed sibling entry can substring-claim them at API
  // rates.
  if (/ \(plan\)$/.test(modelName)) return { in: 0, out: 0, cached_in: 0, plan: 'flat' };
  // Exact match first
  if (RATES[modelName]) return RATES[modelName];
  //  Anthropic-style versioned IDs use dashes for version
  // ('claude-haiku-4-5-20251001') while RATES uses dots ('claude-haiku-4.5').
  // Normalize both sides so 'claude-haiku-4-5-…' resolves to 'claude-haiku-4.5'.
  // Also handle '-YYYYMMDD' date suffixes by progressive truncation.
  const norm = modelName.toLowerCase()
    // claude-haiku-4-5 → claude-haiku-4.5 (last two digits joined as decimal)
    .replace(/(claude-(?:opus|sonnet|haiku|3-5-sonnet|3-haiku)-(\d))-(\d)(?=$|-)/g, '$1.$3');
  for (const k of Object.keys(RATES)) {
    if (norm.includes(k.toLowerCase())) return RATES[k];
  }
  // Substring fallback for non-Anthropic shapes.
  for (const k of Object.keys(RATES)) {
    if (modelName.toLowerCase().includes(k.toLowerCase())) return RATES[k];
  }
  return null;
}

// Vendor list price for models a plan covers. rateFor() returns zero for them,
// which is what the operator is CHARGED; this is what the same tokens would
// cost bought per token, so a comparison has something real on the other side.
// Verified against the vendor catalogue 2026-08-19.
const API_LIST_RATES = {
  'gpt-5.6-sol':               { in: 2.50, out: 15.00, cached_in: 0.25 },
  'gpt-5.6-sol-pro':           { in: 2.50, out: 15.00, cached_in: 0.25 },
  'gpt-5.6-terra':             { in: 2.50, out: 15.00, cached_in: 0.25 },
  'gpt-5.6-luna':              { in: 2.50, out: 15.00, cached_in: 0.25 },
  'gpt-5.5':                   { in: 5.00, out: 30.00, cached_in: 0.50 },
  'gpt-5.5-pro':               { in: 30.00, out: 180.00, cached_in: 3.00 },
  'k3':                        { in: 3.00, out: 15.00, cached_in: 0.30 },
  'k3[1m]':                    { in: 3.00, out: 15.00, cached_in: 0.30 },
  'kimi-for-coding':           { in: 0.71, out: 3.50, cached_in: 0.15 },
  'kimi-for-coding-highspeed': { in: 0.71, out: 3.50, cached_in: 0.15 }
};

// What these tokens would have cost bought per token, cache reads priced as
// cache reads. A plan-covered model resolves to its list price here instead of
// the zero it is charged at.
function apiRateFor(modelName) {
  if (!modelName) return null;
  const bare = String(modelName).replace(/ \(plan\)$/, '');
  if (API_LIST_RATES[bare]) return API_LIST_RATES[bare];
  const direct = RATES[bare];
  if (direct && direct.plan !== 'flat' && direct.plan !== 'free') return direct;
  const viaLookup = rateFor(bare);
  if (viaLookup && viaLookup.plan !== 'flat' && viaLookup.plan !== 'free') return viaLookup;
  for (const k of Object.keys(API_LIST_RATES)) {
    if (bare.toLowerCase().includes(k.toLowerCase())) return API_LIST_RATES[k];
  }
  return null;
}

function costAtApiRates(modelName, inputTokens, outputTokens, cachedInputTokens) {
  const rate = apiRateFor(modelName);
  if (!rate) return 0;
  const cached = cachedInputTokens || 0;
  const uncached = Math.max(0, (inputTokens || 0) - cached);
  return (uncached / 1e6) * (rate.in || 0) +
         (cached / 1e6) * (rate.cached_in != null ? rate.cached_in : (rate.in || 0)) +
         ((outputTokens || 0) / 1e6) * (rate.out || 0);
}

function calculateCost(modelName, inputTokens, outputTokens, cachedInputTokens) {
  const rate = rateFor(modelName);
  if (!rate) return { cost: 0, currency: 'USD', model: modelName, unknown: true };
  if (rate.plan === 'free') return { cost: 0, currency: 'USD', model: modelName, plan: 'free' };
  if (rate.plan === 'flat') return { cost: 0, currency: 'USD', model: modelName, plan: 'flat (subscription)' };

  cachedInputTokens = cachedInputTokens || 0;
  const uncachedInput = Math.max(0, (inputTokens || 0) - cachedInputTokens);
  const cost = (uncachedInput / 1_000_000) * rate.in
    + (cachedInputTokens / 1_000_000) * rate.cached_in
    + ((outputTokens || 0) / 1_000_000) * rate.out;
  return { cost: Math.round(cost * 1_000_000) / 1_000_000, currency: 'USD', model: modelName, breakdown: { in: rate.in, out: rate.out, cached_in: rate.cached_in } };
}

// Track running totals across the session
let totals = {}; // model → { input, cached_input, output, totalCost }

function recordUsage(modelName, inputTokens, outputTokens, cachedInputTokens) {
  if (!modelName) return;
  try {
    const names = require('../../shared-core/engine-names.js');
    const bare = String(modelName).replace(/ \(plan\)$/, '');
    if (names.toProvider(bare) !== bare) return;
  } catch (_) { /* name table absent: record as given */ }
  // Persist alongside the in-memory totals: those reset on every proxy
  // restart (several times a day on a dev machine), which made the dashboard
  // a per-boot view while claiming to be usage truth. Fail-open: history is
  // a feature, the request path is plumbing.
  try { require('../../shared-core/state.js').recordProxyUsage(modelName, inputTokens, outputTokens, cachedInputTokens); } catch (_) {}
  if (!totals[modelName]) totals[modelName] = { input: 0, cached_input: 0, output: 0, totalCost: 0, requests: 0 };
  const t = totals[modelName];
  t.input += inputTokens || 0;
  t.cached_input += cachedInputTokens || 0;
  t.output += outputTokens || 0;
  t.requests++;
  t.totalCost += calculateCost(modelName, inputTokens, outputTokens, cachedInputTokens).cost;
}

function getTotals() {
  const out = {};
  let grandTotal = 0;
  for (const [model, t] of Object.entries(totals)) {
    out[model] = {
      requests: t.requests,
      input: t.input,
      cached_input: t.cached_input,
      output: t.output,
      cost: Math.round(t.totalCost * 1_000_000) / 1_000_000,
    };
    grandTotal += t.totalCost;
  }
  return { perModel: out, grandTotalUSD: Math.round(grandTotal * 1_000_000) / 1_000_000 };
}

function reset() { totals = {}; }

module.exports = { rateFor, apiRateFor, calculateCost, costAtApiRates, recordUsage, getTotals, reset, RATES, API_LIST_RATES };
