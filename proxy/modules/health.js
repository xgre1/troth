// SPDX-License-Identifier: AGPL-3.0-only
// Health monitoring — periodic provider liveness checks.
//
// Runs in background, pings each enabled provider with a tiny request every
// N minutes. Surfaces dead providers in /api/stats so dashboard can warn
// before user hits a real failure.

const https = require('https');

const PROBES = {
  alibaba: { hostname: 'dashscope-intl.aliyuncs.com', path: '/compatible-mode/v1/chat/completions', authHeader: 'Authorization' },
  deepinfra: { hostname: 'api.deepinfra.com', path: '/v1/openai/chat/completions', authHeader: 'Authorization' },
  anthropic: { hostname: 'api.anthropic.com', path: '/v1/messages', authHeader: 'x-api-key' },
  openrouter: { hostname: 'openrouter.ai', path: '/api/v1/chat/completions', authHeader: 'Authorization' },
};

let healthState = {}; // provider → { lastChecked, latencyMs, ok, error }
let checkTimer = null;

// Probe with HEAD request to avoid token cost
function probe(provider, opts) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.request({
      hostname: opts.hostname,
      path: opts.path,
      method: 'HEAD',
      timeout: 5000,
      headers: { 'User-Agent': 'troth-health/1.0' },
    }, (res) => {
      const latencyMs = Date.now() - start;
      // Any response (even 4xx) means the host is alive.
      // Only network errors / timeouts mean it's dead.
      resolve({ ok: true, latencyMs, statusCode: res.statusCode });
      res.resume();
    });
    req.on('error', (e) => resolve({ ok: false, latencyMs: Date.now() - start, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latencyMs: 5000, error: 'TIMEOUT' }); });
    req.end();
  });
}

async function checkAll(enabledProviders) {
  const results = {};
  for (const provider of enabledProviders) {
    const opts = PROBES[provider];
    if (!opts) continue;
    const r = await probe(provider, opts);
    results[provider] = { ...r, lastChecked: Date.now() };
  }
  healthState = results;
  return results;
}

function start(getEnabledProviders, intervalMs) {
  intervalMs = intervalMs || 5 * 60 * 1000; // 5 minutes
  if (checkTimer) clearInterval(checkTimer);
  // Immediate check
  setTimeout(() => checkAll(getEnabledProviders()), 5000);
  checkTimer = setInterval(() => checkAll(getEnabledProviders()), intervalMs);
}

function stop() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

function getStats() { return healthState; }

module.exports = { start, stop, checkAll, probe, getStats };
