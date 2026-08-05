// SPDX-License-Identifier: AGPL-3.0-only
// Per-model Alibaba DashScope-intl context caps.
//
// Initial table sourced from April 2026 research:
//
// Several Alibaba Coding Plan models advertise 1M context but the
// dashscope-intl endpoint rejects input above a much lower threshold
// with "InternalError.Algo.InvalidParameter: Range of input length
// should be [1, N]". We enforce per-model caps to short-circuit before
// the round-trip, AND parse the Range error at runtime to shrink caps
// dynamically (Alibaba can tighten them silently).

var CAPS = {
  'qwen3-max':    262144,   // full, matches advertised
  'qwen-max':     262144,
  'qwen-plus':    131072,
  'qwen3.6-plus': 170000,   // 1M advertised → ~170K real on Coding Plan
  'minimax-m2.5': 205000,   // 1M advertised → ~205K real on Coding Plan
  'kimi-k2.5':    262144,   // full
  'glm-5.1':      204800    // via Z.ai Coding Plan (P1.4 will re-route)
};

var DEFAULT_CAP = 131072;   // conservative fallback for unknown models

// Per-model OUTPUT (max_tokens) caps. Same shape as CAPS but for the
// generation side. Discovered live: qwen-max → 8192 ("Range of max_tokens
// should be [1, 8192]" rejection). Other models default to "no cap" so
// passthrough behaviour is preserved when we don't know — runtime
// discovery fills the table on rejection. Don't hardcode unverified
// values; let the parser learn them.
var OUTPUT_CAPS = {
  'qwen-max':     8192,   // observed  dashscope-intl
  'qwen-max-latest': 8192
};

function getOutputCap(model) {
  if (!model) return null;
  if (OUTPUT_CAPS[model] !== undefined) return OUTPUT_CAPS[model];
  return null;  // unknown — caller treats as "no cap, send as-is"
}

// Update OUTPUT_CAPS from a runtime rejection. Called by router when it
// parses a max_tokens-range error from Alibaba.
function updateOutputCap(model, newCap) {
  if (!model || !newCap || typeof newCap !== 'number') return false;
  var current = OUTPUT_CAPS[model] === undefined ? Infinity : OUTPUT_CAPS[model];
  if (newCap < current) {
    OUTPUT_CAPS[model] = newCap;
    stats.runtimeUpdates++;
    console.log('[alibabaCaps] Shrunk output cap for ' + model + ': ' + (current === Infinity ? 'unset' : current) + ' → ' + newCap + ' (learned from API error)');
    return true;
  }
  return false;
}

// Parse the output-side variant: "Range of max_tokens should be [1, 8192]".
function parseOutputRangeError(errorText) {
  if (!errorText || typeof errorText !== 'string') return null;
  var m = errorText.match(/Range of max_tokens should be \[1,\s*(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

var stats = {
  runtimeUpdates: 0,
  rejections: 0,
  lastError: null
};

function getCap(model) {
  if (!model) return DEFAULT_CAP;
  if (CAPS[model] !== undefined) return CAPS[model];
  return DEFAULT_CAP;
}

// Only shrink, never grow, from runtime discovery.
// The whole point is that real limit < advertised. If Alibaba ever loosens,
// we'll keep the conservative cap and the user can bump it manually.
function updateCap(model, newCap) {
  if (!model || !newCap || typeof newCap !== 'number') return false;
  var current = CAPS[model] === undefined ? DEFAULT_CAP : CAPS[model];
  if (newCap < current) {
    CAPS[model] = newCap;
    stats.runtimeUpdates++;
    console.log('[alibabaCaps] Shrunk cap for ' + model + ': ' + current + ' → ' + newCap + ' (learned from API error)');
    return true;
  }
  return false;
}

// Parse error messages like:
//   "Range of input length should be [1, 169984]"
//   "Range of input length should be [1,204800]"
// Returns extracted integer cap, or null.
function parseRangeError(errorText) {
  if (!errorText || typeof errorText !== 'string') return null;
  var m = errorText.match(/Range of input length should be \[1,\s*(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

// Detect Alibaba's "Free Quota Only toggle depleted" error:
//   "AllocationQuota.FreeTierOnly" — thrown when toggle is ON and free quota=0.
// Separate from "Range" errors; indicates we should try another versioned model.
// [docs: alibabacloud.com/help/en/model-studio/new-free-quota]
function isFreeTierDepleted(status, errorText) {
  if (status === 403 && errorText && /AllocationQuota\.FreeTierOnly/i.test(errorText)) return true;
  if (errorText && /free\s*(tier|quota).*(exhaust|deplet|empt|exceed)/i.test(errorText)) return true;
  return false;
}

// Free-tier fallback chain: ordered list of versioned Alibaba models that each
// carry their OWN 1M free quota pool. If one is exhausted, try the next.
// Exposed so router.js can rotate through them on AllocationQuota errors.
var FREE_TIER_CHAIN = [
  'qwen3-max-2026-01-23',  // newest 1M free
  'qwen3-max-2025-09-23',  // older 1M free
  'qwen3-max-preview',     // preview 1M free
  'qwen-max',              // stable 1M free
  'qwen-max-latest'        // separate 1M free
];

function recordRejection(model, estimatedTokens) {
  stats.rejections++;
  stats.lastError = { model: model, estTokens: estimatedTokens, at: Date.now() };
}

function getStats() {
  return {
    module: 'alibabaCaps',
    caps: Object.assign({}, CAPS),
    defaultCap: DEFAULT_CAP,
    runtimeUpdates: stats.runtimeUpdates,
    rejections: stats.rejections,
    lastError: stats.lastError
  };
}

module.exports = {
  getCap: getCap,
  updateCap: updateCap,
  parseRangeError: parseRangeError,
  getOutputCap: getOutputCap,
  updateOutputCap: updateOutputCap,
  parseOutputRangeError: parseOutputRangeError,
  isFreeTierDepleted: isFreeTierDepleted,
  FREE_TIER_CHAIN: FREE_TIER_CHAIN,
  recordRejection: recordRejection,
  getStats: getStats,
  CAPS: CAPS,
  OUTPUT_CAPS: OUTPUT_CAPS,
  DEFAULT_CAP: DEFAULT_CAP
};
