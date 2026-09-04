// SPDX-License-Identifier: AGPL-3.0-only
// The ONE model catalog. Curated ids per provider, each with a default,
// verified against the vendors' own docs and model APIs on the date each
// block names. A hand-written list carries ids the vendors have already
// retired, which is the rot this module exists to end: verify against the
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
  // Kimi Code membership, verified 2026-09-04 against platform.kimi.ai
  // (K3, K2.7 Code, K2.6 are the listed models).
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
  // ChatGPT-account Codex endpoint, verified 2026-09-04 by streaming one
  // reply through each id with a ChatGPT account. Only plain gpt ids are
  // accepted there; the "*-codex" API-only ids and the bare 'gpt-5.6' alias
  // are refused. The transport falls back down this list when an id is
  // retired upstream, so a stale pick degrades instead of blacking the lane.
  openai_sub: {
    label: 'ChatGPT (subscription)',
    dflt: 'gpt-6-astra',
    models: [
      { id: 'gpt-6-astra',   label: 'GPT-6 Astra',   note: 'Default · newest flagship' },
      { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol',   note: 'The model behind paid ChatGPT plans · faster' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Lighter tier' }
    ]
  },
  // Verified 2026-09-04 against platform.claude.com models overview.
  anthropic: {
    label: 'Claude (Anthropic API key)',
    dflt: 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5',  label: 'Sonnet 5',  note: 'Default · balanced speed + depth · 1M ctx' },
      { id: 'claude-opus-5',    label: 'Opus 5',    note: 'Flagship · deepest reasoning · 1M ctx' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'Mythos tier · most capable (needs a plan that includes it)' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest, cheapest tier · 200K ctx' },
      { id: 'claude-fable-5',   label: 'Fable 5',   note: 'Previous Fable' },
      { id: 'claude-opus-4-8',  label: 'Opus 4.8',  note: 'Previous flagship' }
    ]
  },
  // The Coding Plan lane, verified 2026-09-04 against the Model Studio
  // coding-plan page (Pro plan, 90K requests a month).
  alibaba: {
    label: 'Alibaba Coding Plan',
    dflt: 'qwen3-max',
    models: [
      { id: 'qwen3-max',        label: 'Qwen3 Max',        note: 'Default · flagship · Coding Plan eligible' },
      { id: 'qwen3.7-plus',     label: 'Qwen3.7 Plus',     note: 'Newest plan model · vision' },
      { id: 'qwen3.6-plus',     label: 'Qwen3.6 Plus',     note: 'Plan model · vision' },
      { id: 'qwen3-coder-next', label: 'Qwen3 Coder Next', note: 'Coding specialist' },
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', note: 'Coding specialist' },
      { id: 'glm-5',            label: 'GLM-5',            note: 'Long context · plan eligible' },
      { id: 'minimax-m2.5',     label: 'MiniMax M2.5',     note: 'Strong coder · plan eligible' },
      { id: 'kimi-k2.5',        label: 'Kimi K2.5',        note: 'Via the coding plan · vision' }
    ]
  },
  // Moonshot platform API, verified 2026-09-04 against platform.kimi.ai.
  // moonshot-v1-* and the k2 / k2.5 API series are discontinued and absent.
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
  // Verified 2026-09-04 against api-docs.deepseek.com: exactly these two
  // text models, both 1M ctx; older ids (v3.x, r1, -chat aliases) 404.
  deepseek: {
    label: 'DeepSeek',
    dflt: 'deepseek-v4-pro',
    models: [
      { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro',   note: 'Default · flagship reasoning · 1M ctx' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: 'Faster and cheaper tier · 1M ctx' }
    ]
  },
  // Verified 2026-09-04 against api.deepinfra.com/models/list.
  deepinfra: {
    label: 'DeepInfra',
    dflt: 'deepseek-ai/DeepSeek-V4-Flash',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash', note: 'Default' },
      { id: 'Qwen/Qwen3.6-35B-A3B',          label: 'Qwen3.6 35B-A3B',   note: 'MoE · cheap' },
      { id: 'Qwen/Qwen3.5-27B',              label: 'Qwen3.5 27B',       note: 'Dense' }
    ]
  },
  // OpenRouter serves hundreds of slugs; the catalog carries the routed
  // default plus known-good rows, and any configured slug is kept as-is.
  // Verified 2026-09-04 against the live /models list.
  openrouter: {
    label: 'OpenRouter',
    dflt: 'minimax/minimax-m3:free',
    models: [
      { id: 'minimax/minimax-m3:free',   label: 'MiniMax M3 (free)',   note: 'Default · $0' },
      { id: 'z-ai/glm-5.2:free',         label: 'GLM-5.2 (free)',      note: '$0' },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5',     note: 'Via OpenRouter' },
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash',  note: 'Low cost' }
    ]
  },
  // xAI, verified 2026-09-04 against docs.x.ai.
  xai: {
    label: 'xAI (Grok)',
    dflt: 'grok-4.3',
    models: [
      { id: 'grok-4.3',       label: 'Grok 4.3',       note: 'Default · 1M ctx · cheapest' },
      { id: 'grok-4.6',       label: 'Grok 4.6',       note: 'Newest flagship · 500K ctx' },
      { id: 'grok-4.5',       label: 'Grok 4.5',       note: 'Flagship · 500K ctx' },
      { id: 'grok-build-0.1', label: 'Grok Build 0.1', note: 'Coding specialist · 256K ctx' }
    ]
  },
  // Verified 2026-09-04 against ai.google.dev/gemini-api/docs/models and
  // the pricing page; the dateless gemini-3-pro / gemini-3-flash ids are gone.
  google_ai: {
    label: 'Google Gemini',
    dflt: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash',      label: 'Gemini 3.8 Flash',      note: 'Default · newest Flash · 1M ctx' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', note: 'Deepest reasoning · 1M ctx' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', note: 'Cheapest cloud' }
    ]
  },
  // Verified 2026-09-04 against integrate.api.nvidia.com/v1/models.
  nvidia: {
    label: 'NVIDIA NIM',
    dflt: 'deepseek-ai/deepseek-v4-flash-0731',
    models: [
      { id: 'deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', note: 'Default · free tier' },
      { id: 'deepseek-ai/deepseek-v4-pro-0813',   label: 'DeepSeek V4 Pro',   note: 'Free tier' },
      { id: 'moonshotai/kimi-k3',                 label: 'Kimi K3',           note: 'Free tier' },
      { id: 'nvidia/nemotron-3-super-120b-a12b',  label: 'Nemotron 3 Super',  note: 'NVIDIA · free tier' }
    ]
  },
  // Verified 2026-09-04 against docs.z.ai pricing.
  zai: {
    label: 'Z.AI (GLM)',
    dflt: 'glm-5.3',
    models: [
      { id: 'glm-5.3',       label: 'GLM-5.3',       note: 'Default · flagship' },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', note: 'Cheapest tier' },
      { id: 'glm-5.2',       label: 'GLM-5.2',       note: 'Previous flagship' },
      { id: 'glm-5.1',       label: 'GLM-5.1',       note: 'Previous' }
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
