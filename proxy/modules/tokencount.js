// SPDX-License-Identifier: AGPL-3.0-only
// Token counting — ground-truth counts via Anthropic's count_tokens endpoint.
//
// Our char-based estimator (chars/4, chars/3.2 for 4.7) is fast but drifts,
// especially for non-prose content. The /v1/messages/count_tokens endpoint
// returns the exact count Anthropic would charge for a given body+model,
// free of charge and rate-limited separately from generation.
//
// Usage pattern: call sparingly. Per-request counting adds a network
// round-trip to the hot path. We cache results by (model, body-hash) with a
// 60s TTL so a client looping on the same body doesn't pay repeated calls.
// Callers use this for:
//   - pre-flight cap checks (is this request near the per-model limit?)
//   - calibrating the char-based estimator (logActualVsEstimated drift)
//   - Task Budgets planning (what's the real input size?)
//
//  counting; https://platform.claude.com/docs/en/build-with-claude/token-counting]

var https = require('https');
var crypto = require('crypto');

var CACHE_TTL_MS = 60 * 1000;
var MAX_CACHE_ENTRIES = 200;
var cache = new Map();  // key: model + "::" + hash → { count, ts }

var stats = {
  calls: 0,
  cacheHits: 0,
  errors: 0,
  totalLatencyMs: 0,
  driftSamples: [],     // ring buffer of recent {model, est, actual, delta}
  maxDriftSamples: 50
};

function hashBody(bodyStr) {
  return crypto.createHash('sha256').update(bodyStr || '').digest('hex').slice(0, 24);
}

function cacheKey(model, bodyStr) {
  return (model || 'unknown') + '::' + hashBody(bodyStr);
}

function getCached(model, bodyStr) {
  var k = cacheKey(model, bodyStr);
  var entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(k); return null; }
  return entry.count;
}

function setCached(model, bodyStr, count) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest
    var oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(cacheKey(model, bodyStr), { count: count, ts: Date.now() });
}

// Async. Returns Promise<number|null>. Never throws — caller checks null.
// apiKey must be provided (Anthropic BYOK). If missing, returns null.
function countTokens(bodyStr, apiKey) {
  if (!apiKey) return Promise.resolve(null);
  var parsed;
  try { parsed = JSON.parse(bodyStr); } catch (e) { return Promise.resolve(null); }

  var model = parsed.model || 'claude-sonnet-4-20250514';
  var cached = getCached(model, bodyStr);
  if (cached !== null) { stats.cacheHits++; return Promise.resolve(cached); }

  // count_tokens accepts the same shape as /v1/messages but returns only { input_tokens }.
  // We forward model, system, messages, and tools — the fields that affect the count.
  var countBody = {
    model: model,
    messages: parsed.messages || [],
  };
  if (parsed.system !== undefined) countBody.system = parsed.system;
  if (parsed.tools !== undefined) countBody.tools = parsed.tools;

  var postData = JSON.stringify(countBody);
  var startedAt = Date.now();
  stats.calls++;

  return new Promise(function(resolve) {
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages/count_tokens',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      timeout: 15000
    }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        stats.totalLatencyMs += Date.now() - startedAt;
        if (res.statusCode !== 200) {
          stats.errors++;
          resolve(null);
          return;
        }
        try {
          var data = JSON.parse(body);
          var count = typeof data.input_tokens === 'number' ? data.input_tokens : null;
          if (count !== null) setCached(model, bodyStr, count);
          resolve(count);
        } catch (e) { stats.errors++; resolve(null); }
      });
    });
    req.on('error', function() { stats.errors++; resolve(null); });
    req.on('timeout', function() { stats.errors++; req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// Record drift sample (estimated vs actual) for later calibration analysis.
function logActualVsEstimated(model, estimated, actual) {
  if (!model || typeof estimated !== 'number' || typeof actual !== 'number' || actual <= 0) return;
  var delta = (estimated - actual) / actual;  // positive = we over-estimated
  stats.driftSamples.push({ model: model, est: estimated, actual: actual, delta: delta, at: Date.now() });
  if (stats.driftSamples.length > stats.maxDriftSamples) stats.driftSamples.shift();
}

function getStats() {
  var avgLatency = stats.calls > 0 ? Math.round(stats.totalLatencyMs / stats.calls) : 0;
  var meanDrift = null;
  if (stats.driftSamples.length > 0) {
    var sum = 0;
    for (var i = 0; i < stats.driftSamples.length; i++) sum += stats.driftSamples[i].delta;
    meanDrift = sum / stats.driftSamples.length;
  }

  // per-model drift breakdown so a silent tokenizer shift on one model
  // (like 4.6 → 4.7's 1.0-1.35× inflation) is visible without mixing into
  // the global mean.
  var perModel = {};
  for (var j = 0; j < stats.driftSamples.length; j++) {
    var s = stats.driftSamples[j];
    var m = s.model || 'unknown';
    if (!perModel[m]) perModel[m] = { samples: 0, sum: 0, sumSquares: 0, lastAt: 0 };
    perModel[m].samples++;
    perModel[m].sum += s.delta;
    perModel[m].sumSquares += s.delta * s.delta;
    if (s.at > perModel[m].lastAt) perModel[m].lastAt = s.at;
  }
  var perModelOut = {};
  Object.keys(perModel).forEach(function(m) {
    var e = perModel[m];
    var mean = e.sum / e.samples;
    var variance = (e.sumSquares / e.samples) - (mean * mean);
    var stddev = variance > 0 ? Math.sqrt(variance) : 0;
    perModelOut[m] = {
      samples: e.samples,
      meanDrift: mean,
      stddev: stddev,
      lastAt: e.lastAt
    };
  });

  return {
    module: 'tokencount',
    calls: stats.calls,
    cacheHits: stats.cacheHits,
    errors: stats.errors,
    cacheSize: cache.size,
    avgLatencyMs: avgLatency,
    driftSampleCount: stats.driftSamples.length,
    meanDrift: meanDrift,
    perModelDrift: perModelOut
  };
}

function clearCache() { cache.clear(); }
function clearDrift() { stats.driftSamples.length = 0; }

module.exports = {
  countTokens: countTokens,
  logActualVsEstimated: logActualVsEstimated,
  getStats: getStats,
  clearCache: clearCache,
  clearDrift: clearDrift,
  hashBody: hashBody,
  // Expose for tests
  _cache: cache,
  CACHE_TTL_MS: CACHE_TTL_MS
};
