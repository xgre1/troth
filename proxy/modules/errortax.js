// SPDX-License-Identifier: AGPL-3.0-only
// Error taxonomy — classify non-2xx API responses so patterns are visible.
//
// Without classification, all 400/429/5xx show up as a single "errors" counter
// and the operator can't tell a transient overload from a structural break
// (deprecated param, cap overflow, rate limit). This module buckets by
// recognizable patterns so /api/stats reveals WHAT is wrong, not just that
// something is.
//
var CLASSES = {
  range_input_length:        'Alibaba Range of input length exceeded (per-model cap hit)',
  thinking_budget_rejected:  'model rejected thinking.budget_tokens (strip missed?)',
  sampling_params_rejected:  'model rejected temperature/top_p/top_k (strip missed?)',
  context_too_long:          'Context exceeds model window',
  credit_insufficient:       'Provider balance exhausted',
  auth_error:                '401/403 authentication or permission',
  rate_limit:                '429 rate limit',
  overloaded:                '529 overloaded_error',
  bad_request_other:         '400 with no recognized subcategory',
  server_error:              '5xx server error',
  unknown:                   'unclassified error'
};

var state = {
  total: 0,
  byClass: {},      // class → count
  byModel: {},      // model → { class → count }
  lastByClass: {}   // class → { status, msg, model, at }
};

// classify(status, message) → class key.
function classify(status, message) {
  var msg = (message || '').toString();
  var lower = msg.toLowerCase();
  // Pattern-first (more specific) so generic 400 doesn't swallow a known case.
  if (/range of input length should be \[1,/i.test(msg)) return 'range_input_length';
  if (/budget_tokens/i.test(msg) && /(deprecat|unsupported|not\s+support|no\s+longer\s+support|not\s+allowed|invalid)/i.test(lower)) return 'thinking_budget_rejected';
  if (/(temperature|top_p|top_k)/i.test(msg) && /(not\s+support|unsupported|invalid|must\s+be|no\s+longer)/i.test(lower)) return 'sampling_params_rejected';
  if (/context.*(exceed|too long|window)/i.test(lower) || /max.*context.*length/i.test(lower)) return 'context_too_long';
  if (/insufficient.*(balance|credit|funds)/i.test(lower) || /payment required/i.test(lower)) return 'credit_insufficient';
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status === 400) return 'bad_request_other';
  if (status >= 500 && status < 600) return 'server_error';
  return 'unknown';
}

function record(status, message, model) {
  state.total++;
  var cls = classify(status, message);
  state.byClass[cls] = (state.byClass[cls] || 0) + 1;
  var m = model || 'unknown';
  if (!state.byModel[m]) state.byModel[m] = {};
  state.byModel[m][cls] = (state.byModel[m][cls] || 0) + 1;
  state.lastByClass[cls] = {
    status: status,
    msg: (message || '').toString().slice(0, 200),
    model: m,
    at: Date.now()
  };
  // Persist to substrate so analytics survives restart. Module label uses
  // the model so dashboard can break down errors per provider.
  try {
    var s = require('../../shared-core/state.js');
    if (s && typeof s.recordModuleError === 'function') {
      s.recordModuleError({
        module: 'router.' + (m === 'unknown' ? 'unknown' : m.split('-')[0].split('/')[0]),
        kind: cls,
        message: status + ' ' + (message || ''),
        model: m
      });
    }
  } catch (_) { /* persistence must never break the in-memory path */ }
  return cls;
}

function getStats() {
  // Shape: { total, byClass, byModel, lastByClass, descriptions }
  return {
    module: 'errortax',
    total: state.total,
    byClass: Object.assign({}, state.byClass),
    byModel: JSON.parse(JSON.stringify(state.byModel)),
    lastByClass: JSON.parse(JSON.stringify(state.lastByClass)),
    descriptions: CLASSES
  };
}

function reset() {
  state.total = 0;
  state.byClass = {};
  state.byModel = {};
  state.lastByClass = {};
}

module.exports = {
  classify: classify,
  record: record,
  getStats: getStats,
  reset: reset,
  CLASSES: CLASSES
};
