// SPDX-License-Identifier: AGPL-3.0-only
// Auth-mode detection — identify how Claude Code authenticated the inbound request.
//
// Two modes matter for our architecture:
//   'api-key' — x-api-key header present (BYOK, pay-per-token Anthropic API).
//               Body modifications are safe: Anthropic's cch attestation is
//               NOT validated on API-key traffic.
//   'oauth'   — Authorization: Bearer ... header (consumer Pro/Max subscription).
//               On OUR path, this is still safe because callAnthropic substitutes
//               the auth with providers.anthropic.apiKey before forwarding. We
//               never relay the user's OAuth token to Anthropic under a modified
//               body — the cch trap only fires on OAuth-auth + modified-body.
//
// We log and track auth-mode for observability (billing transparency: if a user
// configured a subscription but troth is routing via their separate API key,
// they should see that in the stats).
//
//  Claude Code Proxy Authentication Research.md §Authentication Precedence]

var state = {
  apiKeyRequests: 0,
  oauthRequests: 0,
  noAuthRequests: 0,
  firstOauthWarnedAt: 0
};

function detect(headers) {
  if (!headers) return 'none';
  // Normalize header keys to lowercase for robust matching (Node.js req.headers is already lowercase).
  var keys = Object.keys(headers);
  var hasApiKey = false;
  var hasBearer = false;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i].toLowerCase();
    if (k === 'x-api-key' && headers[keys[i]]) hasApiKey = true;
    if (k === 'authorization' && typeof headers[keys[i]] === 'string' && /^Bearer\s+/i.test(headers[keys[i]])) {
      hasBearer = true;
    }
  }
  // Precedence: Anthropic's own hierarchy puts x-api-key above Bearer when both present.
  // [research: Authentication Precedence Hierarchy, line 68-75]
  if (hasApiKey) return 'api-key';
  if (hasBearer) return 'oauth';
  return 'none';
}

function record(mode) {
  if (mode === 'api-key') state.apiKeyRequests++;
  else if (mode === 'oauth') {
    state.oauthRequests++;
    if (!state.firstOauthWarnedAt) {
      state.firstOauthWarnedAt = Date.now();
      console.log('[authmode] OAuth subscription Bearer token detected on inbound request. troth will substitute the configured Anthropic API key if one is set; billing falls on that API key, not the subscription.');
    }
  } else state.noAuthRequests++;
}

function getStats() {
  return {
    module: 'authmode',
    apiKeyRequests: state.apiKeyRequests,
    oauthRequests: state.oauthRequests,
    noAuthRequests: state.noAuthRequests,
    firstOauthAt: state.firstOauthWarnedAt || null
  };
}

module.exports = { detect: detect, record: record, getStats: getStats };
