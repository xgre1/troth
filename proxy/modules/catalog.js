// SPDX-License-Identifier: AGPL-3.0-only
// The ONE model catalog. Curated ids per provider, each with a default,
// live-verified against the vendors' own docs and model APIs: Moonshot
// 2026-07-18 against platform.kimi.ai (the k2/k2.5 API series is
// discontinued), DeepSeek 2026-06-12 against api.deepseek.com/models
// (older ids 404), xAI 2026-07-18 against docs.x.ai, local models against
// upstream llama.cpp and model-card docs in June 2026. An earlier draft
// hand-wrote its own list and carried three ids the vendors had already
// retired — the exact rot this module exists to end. Verify against the
// vendor, never invent.
//
// Curated and pinned on purpose: ids never auto-refresh from vendor feeds,
// so nothing changes under the operator between releases.
//
// Consumers: GET /api/catalog → dashboard provider cards and the first-run
// onboarding; the terminal wizard requires this file directly. One list,
// every surface — free-text model fields with placeholder guidance were
// where ids rotted per-surface.
'use strict';

var CATALOG = {
  kimi_sub: {
    label: 'Kimi Code (subscription)',
    dflt: 'k3',
    // The app offers these four on the same membership flow — its merged
    // card routes them through the coding endpoint. Same list, verbatim.
    models: [
      { id: 'k3',                       label: 'Kimi K3',                  note: 'Default · flagship · 1M ctx' },
      { id: 'kimi-k2.7-code',           label: 'Kimi K2.7 Code',           note: 'Coding specialist · 256K ctx' },
      { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed', note: 'Coding · ~180 tok/s · 256K ctx' },
      { id: 'kimi-k2.6',                label: 'Kimi K2.6',                note: 'General · cheaper · 256K ctx' }
    ]
  },
  openai_sub: {
    label: 'ChatGPT (subscription)',
    dflt: 'gpt-5.6-sol',
    models: [
      { id: 'gpt-5.6-sol',  label: 'GPT-5.6',      note: 'Default · recommended for coding + knowledge work' },
      { id: 'gpt-5.5',      label: 'GPT-5.5',      note: 'Previous generation' },
      { id: 'gpt-5.4',      label: 'GPT-5.4',      note: 'Solid all-rounder' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', note: 'Faster, lower-cost for lighter tasks' }
    ]
  },
  anthropic: {
    label: 'Claude (Anthropic API key)',
    dflt: 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5',  label: 'Sonnet 5',  note: 'Default · balanced speed + depth' },
      { id: 'claude-opus-5',    label: 'Opus 5',    note: 'Flagship · deepest reasoning' },
      { id: 'claude-fable-5',   label: 'Fable 5',   note: 'Mythos tier · most capable (needs a plan that includes it)' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest, cheapest tier' },
      { id: 'claude-opus-4-8',  label: 'Opus 4.8',  note: 'Previous flagship' }
    ]
  },
  // The Coding Plan lane: the plan's eligible backbones (90K req/mo Pro).
  alibaba: {
    label: 'Alibaba Coding Plan',
    dflt: 'qwen3-max',
    models: [
      { id: 'qwen3-max',        label: 'Qwen3 Max',        note: 'Default · flagship · Coding Plan eligible' },
      { id: 'qwen3-coder-480b', label: 'Qwen3 Coder 480B', note: 'MoE code-specialist' },
      { id: 'minimax-m2.5',     label: 'MiniMax M2.5',     note: 'Strong coder · plan eligible' },
      { id: 'glm-5.1',          label: 'GLM-5.1',          note: 'Long context · plan eligible' },
      { id: 'kimi-k2.5',        label: 'Kimi K2.5',        note: 'Via the coding plan' }
    ]
  },
  // Moonshot platform API, verified 2026-07-18. moonshot-v1-* and the
  // k2 / k2.5 API series are discontinued and deliberately absent.
  moonshot: {
    label: 'Kimi (per-token API key)',
    dflt: 'kimi-k3',
    models: [
      { id: 'kimi-k3',                  label: 'Kimi K3',                  note: 'Default · flagship · 1M ctx' },
      { id: 'kimi-k2.7-code',           label: 'Kimi K2.7 Code',           note: 'Coding specialist · 256K ctx' },
      { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed', note: 'Coding · ~180 tok/s · 256K ctx' },
      { id: 'kimi-k2.6',                label: 'Kimi K2.6',                note: 'General · cheaper · 256K ctx' }
    ]
  },
  // Live-verified 2026-06-12 against api.deepseek.com/models: exactly
  // these two; older ids (v3.5, r1, -chat aliases) are gone and would 404.
  deepseek: {
    label: 'DeepSeek',
    dflt: 'deepseek-v4-pro',
    models: [
      { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro',   note: 'Default · flagship reasoning' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: 'Faster and cheaper tier' }
    ]
  },
  deepinfra: {
    label: 'DeepInfra',
    dflt: 'deepseek-ai/DeepSeek-V3-0324',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3-0324', label: 'DeepSeek V3',  note: 'Default' },
      { id: 'Qwen/Qwen3-235B-A22B',         label: 'Qwen3 235B',   note: 'MoE flagship' },
      { id: 'meta-llama/Llama-4-Maverick',  label: 'Llama 4',      note: 'Meta' }
    ]
  },
  // OpenRouter serves thousands of slugs; the catalog carries the routed
  // default plus known-good rows, and any configured slug is kept as-is.
  openrouter: {
    label: 'OpenRouter',
    dflt: 'minimax/minimax-m2.5:free',
    models: [
      { id: 'minimax/minimax-m2.5:free', label: 'MiniMax M2.5 (free)', note: 'Default · $0' },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5',     note: 'Via OpenRouter' },
      { id: 'deepseek/deepseek-chat',    label: 'DeepSeek chat',       note: 'Low cost' }
    ]
  },
  // xAI, verified 2026-07-18 against docs.x.ai. grok-4.1-fast retired 2026-05-15.
  xai: {
    label: 'xAI (Grok)',
    dflt: 'grok-4.3',
    models: [
      { id: 'grok-4.3',       label: 'Grok 4.3',       note: 'Default · flagship · 1M ctx' },
      { id: 'grok-4.5',       label: 'Grok 4.5',       note: 'Newer flagship · 500K ctx' },
      { id: 'grok-build-0.1', label: 'Grok Build 0.1', note: 'Coding specialist · 256K ctx' }
    ]
  },
  google_ai: {
    label: 'Google Gemini',
    dflt: 'gemini-3-pro',
    models: [
      { id: 'gemini-3-pro',   label: 'Gemini 3 Pro',   note: 'Default · current Google flagship' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', note: 'Cheapest cloud · pennies per M tokens' }
    ]
  },
  nvidia: {
    label: 'NVIDIA NIM',
    dflt: 'deepseek-ai/deepseek-v3.1',
    models: [
      { id: 'deepseek-ai/deepseek-v3.1', label: 'DeepSeek v3.1', note: 'Free tier' }
    ]
  },
  zai: {
    label: 'Z.AI (GLM)',
    dflt: 'glm-5.1',
    models: [
      { id: 'glm-5.1', label: 'GLM-5.1', note: 'Default' }
    ]
  },
  // RAM-tier organized; the note carries
  // the tier so a dropdown alone is enough to pick sanely.
  local: {
    label: 'Local (llama.cpp / Ollama / LM Studio)',
    dflt: 'qwen3.6-35b-a3b-mtp',
    models: [
      { id: 'qwen3.6-35b-a3b-mtp', label: 'Qwen3.6 35B-A3B MTP', note: 'Default · MoE · 3B active · 24+ GB Mac' },
      { id: 'gemma-4-e4b',         label: 'Gemma 4 E4B',         note: 'Google small · 8 GB Mac' },
      { id: 'qwen3.5-9b',          label: 'Qwen3.5 9B',          note: 'Dense · 16 GB Mac' },
      { id: 'gemma-4-26b-a4b',     label: 'Gemma 4 26B-A4B',     note: 'Google MoE · 4B active · 256K ctx' },
      { id: 'gemma-4-31b',         label: 'Gemma 4 31B',         note: 'Dense flagship · 32+ GB' },
      { id: 'qwen3.5-122b-a10b',   label: 'Qwen3.5 122B-A10B',   note: 'Large MoE · 64+ GB' },
      { id: 'deepseek-v4-flash',   label: 'DeepSeek V4 Flash',   note: 'MIT · 128+ GB · custom llama.cpp' },
      { id: 'qwen3-coder-next',    label: 'Qwen3-Coder-Next',    note: 'Coding-agent specialist' }
    ]
  }
};

function getCatalog() { return CATALOG; }

module.exports = { getCatalog: getCatalog };
