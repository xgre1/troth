// SPDX-License-Identifier: AGPL-3.0-only
// Rate limit handling — parse provider response headers, surface limits.
//
// Different providers use different header names. We normalize and track
// the most restrictive remaining quota across providers used in this session.

const limits = {}; // provider → { remaining, reset, limit }

function parseHeaders(provider, headers) {
  if (!headers) return null;
  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];

  // Anthropic style
  if (h['anthropic-ratelimit-requests-remaining']) {
    limits[provider] = {
      remaining: parseInt(h['anthropic-ratelimit-requests-remaining']),
      reset: h['anthropic-ratelimit-requests-reset'],
      limit: parseInt(h['anthropic-ratelimit-requests-limit']),
      kind: 'requests',
    };
    return limits[provider];
  }

  // 5h utilization (Anthropic subscription)
  if (h['anthropic-ratelimit-unified-5h-utilization']) {
    limits[provider] = {
      utilization5h: parseFloat(h['anthropic-ratelimit-unified-5h-utilization']),
      utilization7d: parseFloat(h['anthropic-ratelimit-unified-7d-utilization'] || 0),
      kind: 'utilization',
    };
    return limits[provider];
  }

  // OpenAI/standard style
  if (h['x-ratelimit-remaining-requests']) {
    limits[provider] = {
      remaining: parseInt(h['x-ratelimit-remaining-requests']),
      reset: h['x-ratelimit-reset-requests'],
      limit: parseInt(h['x-ratelimit-limit-requests']),
      kind: 'requests',
    };
    return limits[provider];
  }

  // Tokens-based
  if (h['x-ratelimit-remaining-tokens']) {
    limits[provider] = {
      remaining: parseInt(h['x-ratelimit-remaining-tokens']),
      reset: h['x-ratelimit-reset-tokens'],
      limit: parseInt(h['x-ratelimit-limit-tokens']),
      kind: 'tokens',
    };
    return limits[provider];
  }

  return null;
}

// Return retry-after seconds if a 429 response — providers vary
function parseRetryAfter(headers) {
  if (!headers) return 0;
  const ra = headers['retry-after'] || headers['Retry-After'];
  if (!ra) return 0;
  const n = parseInt(ra);
  if (!isNaN(n)) return n;
  // Date format
  const dt = new Date(ra).getTime();
  if (!isNaN(dt)) return Math.max(0, Math.ceil((dt - Date.now()) / 1000));
  return 0;
}

// Get most restrictive remaining (returns 0-1.0 fraction or null)
function getMostRestrictive() {
  let worst = null;
  for (const [provider, info] of Object.entries(limits)) {
    if (info.kind === 'utilization') {
      const used = info.utilization5h || 0;
      if (worst === null || used > worst.used) worst = { provider, used };
    } else if (info.limit && info.remaining !== undefined) {
      const used = 1 - (info.remaining / info.limit);
      if (worst === null || used > worst.used) worst = { provider, used };
    }
  }
  return worst;
}

function getStats() { return { providers: Object.keys(limits).length, mostRestrictive: getMostRestrictive(), all: limits }; }

module.exports = { parseHeaders, parseRetryAfter, getMostRestrictive, getStats };
