// SPDX-License-Identifier: AGPL-3.0-only
// derive-config.js — coherence by derivation.
//
// Backbone / dispatch preference / backbone engine must never ship as BLIND
// defaults: "troth" and local-first no matter what the operator actually
// configured. That is where the whole class traces from — a Claude-subscription-
// only install ran the troth loop around an inner `claude -p` that had no
// substrate MCP and no memory rule, a Kimi-only install would get the same
// shape, and the pure open-repo CLI had nobody to say otherwise (the app
// writes explicit env; desktop-config does not exist there; config.json
// never carries these keys).
//
// The fix is DERIVATION, not another default: detect what engines this
// machine can actually serve, and compute the coherent shape from that.
// Detection beats declaration — everything below reads DISK truth
// (config.json, credential files, model files), so every surface on the
// machine computes the SAME answer with no store synchronization.
//
// Three hard rules, learned the expensive way:
// - PURE core: deriveCoherentConfig(detected) touches nothing. Tests drive
//   it with fabricated detections; detectEngines() is the only impure part.
// - ABSENT-ONLY: deriveEnvFill returns values ONLY for env keys that are
//   unset. The app always passes a full env (brain_entity.rs), operators
//   export overrides, troth-chat fills from desktop-config — all of those
//   outrank this module by construction. A pin (TROTH_ENTITY_LLM_PIN=1)
//   silences it entirely: the pin owns the surface (pin_rides_backbone
//   handles the kimi edge on the app side before the env ever gets here).
// - NEVER STORED: derived values are computed at each consumer, written
//   nowhere. Storing them would mint exactly the stale-default disease this
//   module exists to kill.
//
// Consumers: bin/troth-entity.js boot (fills absent env before the mode
// consts freeze) — which covers every chat surface, REPL, and voice, since
// they all spawn the entity. The proxy router already derives its own
// dispatch_prefer on absence (proxy/modules/router.js:764, narrower rule:
// local.enabled); aligning it to this detector is a follow-up, not a
// dependency. Kill-switch: TROTH_DERIVE=0.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function _home() { return process.env.HOME || os.homedir(); }

// Lenient config read — a missing or corrupt config.json means "nothing
// configured", never a throw (config-file.js readForWrite throws on corrupt
// by design; detection must not).
function _readConfig() {
  try {
    const p = process.env.TROTH_CONFIG_PATH
      || path.join(process.env.TROTH_CONFIG_DIR || path.join(_home(), '.troth'), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (cfg && typeof cfg === 'object') ? cfg : {};
  } catch (_) { return {}; }
}

// Claude Code binary — same probe order as bin/troth.js findClaude (PATH,
// then the known install locations; `where` on Windows).
function _hasClaudeBinary() {
  try {
    require('child_process').execFileSync(
      process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'pipe' });
    return true;
  } catch (_) { /* not on PATH — probe known locations */ }
  const h = _home();
  return [
    path.join(h, '.claude', 'local', 'claude'),
    path.join(h, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ].some((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

// Claude subscription credentials. File roads live under HOME (hermetic-test
// safe); the keychain road reads the USER keychain regardless of HOME, so it
// is skipped inside the hermetic suite (_TROTH_TEST_HOME) — otherwise every
// test on a developer Mac would "detect" the developer's own login and the
// suite's boots would stop being reproducible.
function _hasClaudeCredentials() {
  const h = _home();
  for (const p of [
    path.join(h, '.claude', '.credentials.json'),
    path.join(h, '.troth', 'claude-faculty-home', '.credentials.json')
  ]) {
    try { if (JSON.parse(fs.readFileSync(p, 'utf8'))) return true; } catch (_) {}
  }
  if (process.env._TROTH_TEST_HOME) return false;
  if (process.platform !== 'darwin') return false;
  try {
    const out = require('child_process').execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return !!(out && out.trim());
  } catch (_) { return false; }
}

// API-key env fallbacks for the BYOK arm — the subset that matters for
// "does ANY per-token lane exist", mirroring slash/executor.js
// providerHasCredential's env road without importing the whole executor.
const _ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', deepinfra: 'DEEPINFRA_API_KEY',
  google_ai: 'GOOGLE_AI_API_KEY', xai: 'XAI_API_KEY', zai: 'ZAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY', alibaba: 'ALIBABA_API_KEY'
};

// The impure half: what can THIS machine actually serve, right now.
function detectEngines() {
  const cfg = _readConfig();
  const providers = (cfg && cfg.providers) || {};

  const claude_sub = _hasClaudeBinary() && _hasClaudeCredentials();
  const kimi_sub = !!(String(process.env.TROTH_KIMI_SUB_KEY || '').trim()
    || (providers.kimi_sub && providers.kimi_sub.enabled && providers.kimi_sub.apiKey));
  let openai_sub = false;
  try { openai_sub = !!require('./codex-token-store.js').load(); } catch (_) {}

  let api_providers = 0;
  for (const [name, p] of Object.entries(providers)) {
    if (['local', 'custom_openai', 'kimi_sub', 'openai_sub'].includes(name)) continue;
    if (!p || p.enabled === false) continue;
    if (p.apiKey || (_ENV_KEYS[name] && String(process.env[_ENV_KEYS[name]] || '').trim())) api_providers++;
  }
  if (providers.custom_openai && providers.custom_openai.enabled !== false
      && providers.custom_openai.base_url) api_providers++;

  let local = !!(providers.local && providers.local.enabled !== false && providers.local.host);
  if (!local) {
    // In-process engine: a chat model actually on disk (either models dir).
    try { local = !!require('./local-server.js').resolveModelPath(); } catch (_) {}
  }

  return { claude_sub, kimi_sub, openai_sub, api_providers, local };
}

// The pure half. One rule table, every output carries its reason.
function deriveCoherentConfig(d) {
  d = d || {};
  const engines = [];
  if (d.claude_sub) engines.push('claude_sub');
  if (d.kimi_sub) engines.push('kimi_sub');
  if (d.openai_sub) engines.push('openai_sub');
  if (d.api_providers > 0) engines.push('api');
  if (d.local) engines.push('local');

  const out = {
    backbone: 'troth', backbone_engine: null,
    dispatch_prefer: '', entity_transport: '', reasons: []
  };

  if (engines.length === 0) {
    out.reasons.push('nothing configured: troth defaults, surfaces say not-set-up');
    return out;
  }
  if (engines.length === 1 && d.claude_sub) {
    out.backbone = 'claude_cli'; out.backbone_engine = 'claude';
    out.dispatch_prefer = 'hosted';
    out.reasons.push('Claude subscription is the only engine: Claude Code runs the loop (substrate MCP + memory rule ride that backbone)');
    return out;
  }
  if (engines.length === 1 && d.kimi_sub) {
    // Kimi answers only inside the claude CLI harness: pinning it as its own
    // backbone loops the entity against itself and it stops responding.
    out.backbone = 'claude_cli'; out.backbone_engine = 'kimi';
    out.dispatch_prefer = 'hosted';
    out.reasons.push('Kimi membership is the only engine: it serves inside the Claude Code harness');
    return out;
  }
  if (engines.length === 1 && d.local) {
    out.dispatch_prefer = 'local'; out.entity_transport = 'local';
    out.reasons.push('local is the only engine: local-first, troth loop');
    return out;
  }
  // Multiple engines, or any per-token lane: the troth loop is the arbiter.
  out.dispatch_prefer = d.local && engines.length === 1 ? 'local' : 'hosted';
  out.reasons.push('multiple engines (' + engines.join(', ') + '): troth loop arbitrates, quality leads, local serves where it wins');
  return out;
}

// Absent-only env fill for the entity boot. Returns ONLY keys the caller
// should set; empty object when a pin owns the surface, the kill-switch is
// on, or everything is already stated.
function deriveEnvFill(env, detected) {
  env = env || process.env;
  if (String(env.TROTH_DERIVE || '') === '0') return {};
  if (env.TROTH_ENTITY_LLM_PIN === '1') return {};
  const d = deriveCoherentConfig(detected || detectEngines());
  const fill = {};
  if (!env.TROTH_ENTITY_BACKBONE && d.backbone === 'claude_cli') {
    fill.TROTH_ENTITY_BACKBONE = 'claude_cli';
    if (!env.TROTH_CLAUDE_ENGINE && d.backbone_engine && d.backbone_engine !== 'claude') {
      fill.TROTH_CLAUDE_ENGINE = d.backbone_engine;
    }
  }
  if (!env.TROTH_ENTITY_DISPATCH_PREFER && d.dispatch_prefer) {
    fill.TROTH_ENTITY_DISPATCH_PREFER = d.dispatch_prefer;
  }
  return fill;
}

module.exports = { detectEngines, deriveCoherentConfig, deriveEnvFill };
