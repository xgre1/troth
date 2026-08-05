// SPDX-License-Identifier: AGPL-3.0-only
// Cross-request deduplication — detect if same request was already processed
// recently and return cached response.
//
// Useful for: Claude Code occasionally sends duplicate requests (race
// conditions, retries). Avoid re-running expensive operations.

const crypto = require('crypto');

const cache = new Map(); // requestHash → { response, ts }
const TTL_MS = 30 * 1000; // 30s — short, just for true dupes
const MAX_ENTRIES = 100;

function hashRequest(bodyStr) {
  // Hash the messages + tools + system + model + thinking config.
  // Including `model` prevents cross-model contamination: identical bodies
  // sent to Opus 4.6 and 4.7 produce different token sequences (tokenizer
  // changed in 4.7) so their responses must be cached separately.
  try {
    const data = JSON.parse(bodyStr);
    const sig = JSON.stringify({
      model: data.model,                          // segments by model family
      messages: data.messages,
      tools: (data.tools || []).map(t => t.name).sort(),
      system: typeof data.system === 'string' ? data.system : JSON.stringify(data.system),
      max_tokens: data.max_tokens,
      thinking: data.thinking,                    // thinking config affects response shape
      output_config: data.output_config,          // effort/task_budget affect response
    });
    return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  } catch (e) { return null; }
}

function check(bodyStr) {
  const h = hashRequest(bodyStr);
  if (!h) return null;
  const entry = cache.get(h);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) { cache.delete(h); return null; }
  return entry.response;
}

function store(bodyStr, response) {
  const h = hashRequest(bodyStr);
  if (!h) return;
  if (cache.size >= MAX_ENTRIES) {
    // Evict oldest
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(h, { response, ts: Date.now() });
}

function getStats() { return { entries: cache.size, ttlMs: TTL_MS }; }

module.exports = { check, store, hashRequest, getStats };
