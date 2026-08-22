// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// engine-names — the one translation between the engine vocabularies.
//
// A single lane carries three different identifiers: the FACULTY id the entity
// and the engine-override write ('codex_oauth'), the PROVIDER id the config
// file and the router read ('openai_sub'), and the label a surface prints
// ('ChatGPT sub'). A table keyed on one vocabulary misses an id from another
// and, because every lookup here has a fallback rather than an error, returns
// something plausible and wrong: a raw identifier rendered as a model name, or
// a provider scan that holds no entry for the pinned engine.
//
// Surfaces translate here instead of keeping their own map.

const FACULTY_TO_PROVIDER = Object.freeze({
  claude_cli:      'anthropic',
  codex_oauth:     'openai_sub',
  codex:           'openai_sub',
  kimi_sub:        'kimi_sub',
  llamacpp:        'local',
  ollama:          'local',
  local:           'local',
  local_inprocess: 'local',
  gemini_cli:      'google_ai'
});

const PROVIDER_LABEL = Object.freeze({
  anthropic:  'Claude (API)',
  openai_sub: 'ChatGPT sub',
  kimi_sub:   'Kimi',
  moonshot:   'Kimi (API)',
  local:      'Local',
  openrouter: 'OpenRouter',
  google_ai:  'Gemini',
  deepseek:   'DeepSeek',
  alibaba:    'Qwen',
  deepinfra:  'DeepInfra',
  xai:        'Grok',
  zai:        'GLM'
});

// Accepts either vocabulary and returns the PROVIDER id — the key the config
// file and the router are indexed by. Unknown ids pass through unchanged so a
// provider added to config alone still resolves.
function toProvider(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return FACULTY_TO_PROVIDER[s] || s;
}

// Human label for either vocabulary. Returns '' when the id is unknown, so a
// caller can decide between omitting the field and printing the raw id — the
// one thing a surface must never do silently.
function labelFor(id) {
  return PROVIDER_LABEL[toProvider(id)] || '';
}

module.exports = { FACULTY_TO_PROVIDER, PROVIDER_LABEL, toProvider, labelFor };
