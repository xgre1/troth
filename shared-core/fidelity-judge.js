// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Judge model-resolution for the fidelity critic.
//
// Policy: a CHEAP REASONING model, cross-family vs the producer (so it is never
// "Claude judging Claude"), free-first. NEVER a non-reasoning flash model (weak
// judgment / high false-PASS, the operator rejected it). NEVER Anthropic BYOK API
// serially (ToS). GPT subscription (openai_sub) is an allowed cross-family fallback;
// Claude subscription is NOT available as a judge (Anthropic third-party OAuth is
// banned, so the only Anthropic path is BYOK, which we exclude).
//
// orderJudgeChain is a PURE function (no network) so the policy is unit-testable.
// makeJudge wires the policy to injected, already-normalized call adapters
// (each adapter returns text|null) so execution is testable with mocks too.

const llmFamily = require('./tools/llm-family.js');

// Refuse these for judgment regardless of availability: the non-reasoning "flash"
// tier. minimax is explicitly NOT flash (it is a reasoning model whose id contains
// the substring "mini"); gemini/word-boundary edge cases are handled in the regex.
function isFlashModel(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (/minimax/.test(m)) return false;
  return /(flash|nano|instant|haiku|\bmini\b|-mini|mini-|-lite|lite-)/.test(m);
}

// Candidate reasoning providers in PREFERENCE order (free-first). Anthropic BYOK
// and google_ai (gemini flash) are deliberately absent. The two flat-rate
// subscriptions ride LAST, because they spend plan quota rather than
// per-token credit: kimi_sub before openai_sub, so an operator who has both
// does not have every judgment land on one of them.
// Cross-family sorting still moves the right
// one forward per producer, so Kimi output is never judged by Kimi.
const CANDIDATES = [
  { provider: 'local',      model: function (p) { return p.local && p.local.model; } },
  { provider: 'alibaba',    model: function (p) { return (p.alibaba && p.alibaba.model) || 'qwen3-max'; } },
  { provider: 'deepseek',   model: function (p) { return (p.deepseek && p.deepseek.model) || 'deepseek-v4-pro'; } },
  { provider: 'deepinfra',  model: function (p) { return p.deepinfra && p.deepinfra.model; } },
  { provider: 'openrouter', model: function (p) { return p.openrouter && p.openrouter.model; } },
  { provider: 'zai',        model: function (p) { return (p.zai && p.zai.model) || 'glm-5.3'; } },
  { provider: 'kimi_sub',   model: function (p) { return (p.kimi_sub && p.kimi_sub.model) || 'kimi-for-coding'; } },
  { provider: 'openai_sub', model: function (p) { return (p.openai_sub && p.openai_sub.model) || 'gpt-6-astra'; } }
];

function isAvailable(providers, name) {
  const p = providers && providers[name];
  if (!p || !p.enabled) return false;
  if (name === 'openai_sub') return true;   // OAuth token presence checked at call time
  if (name === 'local') return true;        // liveness gated separately via opts.localUp
  return !!p.apiKey;
}

const _FAMILY_PROVIDER = { qwen: 'alibaba', deepseek: 'deepseek', openai: 'openai_sub', anthropic: 'anthropic', google: 'google_ai', minimax: 'openrouter' };
const _ID_PROVIDER = [
  { re: /^(k\d|kimi)/,   provider: 'kimi_sub' },
  { re: /^glm/,          provider: 'zai' },
  { re: /^grok/,         provider: 'xai' },
  { re: /^qwen/,         provider: 'alibaba' },
  { re: /^deepseek/,     provider: 'deepseek' },
  { re: /^(gpt-|o\d)/,   provider: 'openai_sub' },
  { re: /^claude/,       provider: 'anthropic' },
  { re: /^gemini/,       provider: 'google_ai' },
];
function _providerForModel(providers, modelId) {
  // Configuration first, inference second. Vendor ids the family table cannot
  // see (k3, glm-5.1, grok-4.3 all resolve to "unknown") would fall through
  // to local-or-null, so an explicit operator pick was SILENTLY skipped and the
  // chain quietly judged with something else. Whatever an enabled provider is
  // configured to serve is the ground truth for who owns that model.
  const want = String(modelId || '').trim().toLowerCase();
  if (want) {
    for (const name of Object.keys(providers || {})) {
      const p = providers[name];
      if (!p || !p.enabled) continue;
      if (p.model && String(p.model).trim().toLowerCase() === want) return name;
    }
  }
  // A gguf file or a path IS local, whatever vendor name it carries. This must
  // come before any vendor matching: a locally installed Qwen3.6-*.gguf would
  // otherwise be dispatched to Alibaba's cloud.
  if (providers.local && providers.local.enabled && (/\.gguf$/.test(want) || want.indexOf('/') !== -1)) return 'local';
  const fam = llmFamily.familyOf(modelId);
  if (_FAMILY_PROVIDER[fam] && providers[_FAMILY_PROVIDER[fam]]) return _FAMILY_PROVIDER[fam];
  // Vendor id patterns for the ids familyOf() reports as "unknown". Without
  // these, k3 / glm-5.1 / grok-4.3 fell to the local catch-all and were
  // dispatched to the wrong lane.
  for (let i = 0; i < _ID_PROVIDER.length; i++) {
    if (_ID_PROVIDER[i].re.test(want) && providers[_ID_PROVIDER[i].provider]) return _ID_PROVIDER[i].provider;
  }
  return null;
}

// Build the ordered chain of {provider, model} attempts.
// opts: { producerModel, pick, localUp }
function orderJudgeChain(providers, opts) {
  opts = opts || {};
  providers = providers || {};
  const chain = [];
  const seen = {};
  function push(provider, model, allowFlash) {
    if (!model) return;
    if (!allowFlash && isFlashModel(model)) return;   // never AUTO-pick flash
    const key = provider + '|' + model;
    if (seen[key]) return;
    seen[key] = 1;
    chain.push({ provider: provider, model: model });
  }

  // 1. Explicit operator pick (Advanced) wins, even flash (opt-in, warned in UI).
  if (opts.pick) push(_providerForModel(providers, opts.pick) || 'pick', opts.pick, true);

  // 2. Auto candidates, free-first; local only if live; never flash.
  const avail = CANDIDATES
    .filter(function (c) { return (c.provider !== 'local' || opts.localUp) && isAvailable(providers, c.provider); })
    .map(function (c) { return { provider: c.provider, model: c.model(providers) }; })
    .filter(function (c) { return !!c.model && !isFlashModel(c.model); });

  // 3. Cross-family-first relative to the producer (avoid same-family circularity).
  if (opts.producerModel) {
    avail.sort(function (a, b) {
      const ax = llmFamily.isCrossFamily(opts.producerModel, a.model) ? 0 : 1;
      const bx = llmFamily.isCrossFamily(opts.producerModel, b.model) ? 0 : 1;
      return ax - bx;   // stable: preserves free-first order within each group
    });
  }
  avail.forEach(function (c) { push(c.provider, c.model, false); });
  return chain;
}

// Wire the policy to injected, normalized adapters. adapters:
//   { providers: object|fn, isLocalAvailable?: fn,
//     call: { local(body,model)->Promise<text|null>, alibaba(...), deepseek(...),
//             deepinfra(...), openrouter(...), zai(...), openai_sub(...) },
//     buildBody?: (prompt)->bodyStr }
// Returns judge(prompt) -> Promise<string|null>, fail-open on everything.
function makeJudge(adapters, opts) {
  opts = opts || {};
  adapters = adapters || {};
  const call = adapters.call || {};
  return async function judge(prompt) {
    try {
      const providers = (typeof adapters.providers === 'function') ? adapters.providers() : (adapters.providers || {});
      const localUp = adapters.isLocalAvailable ? !!adapters.isLocalAvailable() : false;
      const chain = orderJudgeChain(providers, { producerModel: opts.producerModel, pick: opts.pick, localUp: localUp });
      const body = adapters.buildBody ? adapters.buildBody(prompt)
        : JSON.stringify({ model: 'any', max_tokens: 1200, stream: false, messages: [{ role: 'user', content: prompt }] });
      for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        const fn = call[step.provider];
        if (typeof fn !== 'function') continue;
        let text = null;
        try { text = await fn(body, step.model); } catch (_) { text = null; }
        if (text && String(text).trim()) return text;
      }
      return null;   // nothing usable -> fail-open
    } catch (_) {
      return null;
    }
  };
}

module.exports = { orderJudgeChain, makeJudge, isFlashModel, CANDIDATES };
