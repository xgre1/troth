// SPDX-License-Identifier: AGPL-3.0-only
// shared-core/features.js
//
// Single source of truth for Troth's optional intelligence features.
// Resolves each feature's enabled-state with a clear precedence so the
// partner behaves the SAME across all surfaces (Tauri app runtime, the
// Claude-Code plugin hooks, external MCP) and never depends on a shell
// .zshrc the end user doesn't have:
//
//   1. explicit env override  (TROTH_<FLAG>=1|0|true|false|on|off)  — dev / ops
//   2. ~/.troth/config.json   "features": { "<name>": true|false }  — user / app UI
//   3. built-in default below                                       — ships ON
//
// Defaults ON for the capture/intelligence path so a FRESH install gets a
// real partner out of the box (the bug this fixes: hooks were gated on env
// that only existed in the dev's shell). decision_capture (v1) stays opt-in:
// measured 0/7 capture on real coding prompts — intent_decisions (v2) is the
// workhorse and is ON.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME        = process.env.HOME || os.homedir();
// Match l4-config.js resolution so app + hooks read the SAME config file.
const CONFIG_DIR  = process.env.TROTH_CONFIG_DIR  || path.join(HOME, '.troth');
const CONFIG_PATH = process.env.TROTH_CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

// name -> { env: <override var>, default: <built-in ON/OFF> }
const FEATURES = Object.freeze({
  intent_decisions:   { env: 'TROTH_INTENT_DECISIONS',   default: true  }, // v2 — the workhorse
  capture_intent:     { env: 'TROTH_CAPTURE_INTENT',     default: true  },
  dmn_push:           { env: 'TROTH_DMN_PUSH',           default: true  }, // rate-limited cross-project surfacing
  topic_shift:        { env: 'TROTH_TOPIC_SHIFT',        default: true  },
  negative_knowledge: { env: 'TROTH_NEGATIVE_KNOWLEDGE', default: true  },
  decision_capture:   { env: 'TROTH_DECISION_CAPTURE',   default: false }, // v1 — low recall, opt-in
  how_rails:          { env: 'TROTH_HOW_RAILS',          default: false }, // Layer 2 deterministic HOW-rule enforcement; operator-specific, opt-in
  fidelity:           { env: 'TROTH_FIDELITY',           default: false }, // Layer 3 LLM fidelity critic (out-of-band, opt-in)
  verify_evidence_block: { env: 'TROTH_VERIFY_EVIDENCE_BLOCK', default: false }, // #51 — promote the verify-evidence HOW-rule from WARN to BLOCK, only when its FP-clean window holds
});

const TRUE_SET  = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const FALSE_SET = new Set(['0', 'false', 'off', 'no', 'disabled']);

let _cache = null;
let _cacheMtime = -1;
function _configFeatures() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (_cache && st.mtimeMs === _cacheMtime) return _cache;       // memoize; re-read only on change
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cache = (cfg && cfg.features && typeof cfg.features === 'object') ? cfg.features : {};
    _cacheMtime = st.mtimeMs;
  } catch (_) {
    _cache = {};            // missing / invalid config → no override, fall to default
    _cacheMtime = -1;
  }
  return _cache;
}

// Is an optional feature enabled? Unknown names are OFF (fail-closed).
function isEnabled(name) {
  const spec = FEATURES[name];
  if (!spec) return false;

  // 1. explicit env override (dev / ops)
  const ev = process.env[spec.env];
  if (ev != null && ev !== '') {
    const v = String(ev).trim().toLowerCase();
    if (TRUE_SET.has(v))  return true;
    if (FALSE_SET.has(v)) return false;
    // unrecognized value → ignore, fall through to config/default
  }

  // 2. user / app config.json "features" block
  const feats = _configFeatures();
  if (feats && Object.prototype.hasOwnProperty.call(feats, name) && typeof feats[name] === 'boolean') {
    return feats[name];
  }

  // 3. built-in default (ships ON for the intelligence path)
  return spec.default;
}

// Resolved snapshot of every feature — for the dashboard / debug / status.
function all() {
  const out = {};
  for (const name of Object.keys(FEATURES)) out[name] = isEnabled(name);
  return out;
}

module.exports = { isEnabled, all, FEATURES, CONFIG_PATH };
