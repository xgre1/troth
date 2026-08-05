// SPDX-License-Identifier: AGPL-3.0-only
// modtoggle.js — per-request module-toggle reader for use INSIDE modules.
// Same semantics as server.js isModuleEnabled (read fresh per call so
// dashboard switches apply without restart; anything missing = ENABLED).
// Exists because injector/critic can't require server.js (circular) — and
// before this, 9 of the 16 dashboard toggles were written to config but
// read by NOTHING: the switch moved, behavior didn't.
const fs = require('fs');
const path = require('path');
const CONFIG_FILE = process.env.TROTH_CONFIG_PATH ||
  path.join(process.env.TROTH_CONFIG_DIR || path.join(require('os').homedir(), '.troth'), 'config.json');

function isModuleEnabled(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.modules || typeof cfg.modules !== 'object') return true;
    return cfg.modules[name] !== false;
  } catch (_) {
    return true;
  }
}

module.exports = { isModuleEnabled };
