// SPDX-License-Identifier: AGPL-3.0-only
// Config validator — sanity-check ~/.troth/config.json on startup.
//
// Catches: invalid provider entries, missing API keys when enabled, malformed
// routing prefs, unknown module names. Surfaces warnings to startup logs.

const fs = require('fs');
const path = require('path');

const VALID_PROVIDERS = ['alibaba', 'deepinfra', 'anthropic', 'nvidia', 'deepseek', 'openrouter', 'local', 'zai', 'openai_sub', 'google_ai', 'moonshot', 'xai', 'custom_openai'];
const VALID_ROUTING_MODES = ['auto', 'local', 'smart', 'anthropic', 'fallback'];
const VALID_MODULES = ['injector', 'cleaner', 'verifier', 'guardian', 'pinning', 'loopguard', 'hotcache', 'codelens', 'compressor', 'vision'];

function validate(cfgPath) {
  const warnings = [];
  const errors = [];

  if (!fs.existsSync(cfgPath)) {
    return { ok: true, warnings: ['No config file at ' + cfgPath + ' — using defaults'], errors: [] };
  }

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { return { ok: false, errors: ['Config JSON parse error: ' + e.message], warnings: [] }; }

  // Providers
  if (cfg.providers) {
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (!VALID_PROVIDERS.includes(name)) {
        warnings.push('Unknown provider "' + name + '" — valid: ' + VALID_PROVIDERS.join(', '));
      }
      // custom_openai is key-OPTIONAL (self-hosted vLLM/LiteLLM may need none);
      // a present base_url is what makes it usable, so don't warn on a missing
      // key for it; warn on a missing base_url instead.
      if (name === 'custom_openai') {
        if (p.enabled && !p.base_url) {
          warnings.push('Provider "custom_openai" enabled but no base_url set');
        }
      } else if (p.enabled && !p.apiKey && !p.host && name !== 'local') {
        warnings.push('Provider "' + name + '" enabled but no apiKey set');
      }
    }
  }

  // Routing
  if (cfg.routing && cfg.routing.mode && !VALID_ROUTING_MODES.includes(cfg.routing.mode)) {
    errors.push('Invalid routing.mode "' + cfg.routing.mode + '" — valid: ' + VALID_ROUTING_MODES.join(', '));
  }

  // Modules
  if (cfg.modules) {
    for (const [name, enabled] of Object.entries(cfg.modules)) {
      if (!VALID_MODULES.includes(name)) {
        warnings.push('Unknown module toggle "' + name + '" — ignored');
      }
      if (typeof enabled !== 'boolean') {
        warnings.push('Module "' + name + '" value should be true/false');
      }
    }
  }

  // Budget sanity
  if (cfg.budget) {
    if (cfg.budget.perSessionUSD && (cfg.budget.perSessionUSD < 0 || cfg.budget.perSessionUSD > 10000)) {
      warnings.push('Suspicious budget.perSessionUSD: ' + cfg.budget.perSessionUSD);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validate, VALID_PROVIDERS, VALID_ROUTING_MODES, VALID_MODULES };
