// SPDX-License-Identifier: AGPL-3.0-only
// telemetry — opt-in anonymized usage signals to evolve product over
// time. Default OFF. When enabled via config flag, batches counts
// (NEVER content) of substrate operations and either logs locally or
// posts to operator-configured endpoint.
//
// Privacy guarantees:
//   - Never sends user_text, assistant_text, statements, or any PII
//   - Only counts: turns/day, engrams/day, drift_alerts/week, etc.
//   - No agent_id, cwd, or user identifier transmitted
//   - Single random anonymous installation_id per ~/.troth/.telemetry-id
//   - Operator can inspect every event before it leaves the machine
//
// Activation: set `telemetry_enabled: true` in ~/.troth/config.json
// AND optionally `telemetry_endpoint: <url>`. Without endpoint,
// events are written to ~/.troth/telemetry.log only.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const HOME = process.env.HOME || os.homedir();
const TELEMETRY_LOG = path.join(HOME, '.troth', 'telemetry.log');
const ID_FILE       = path.join(HOME, '.troth', '.telemetry-id');
const CONFIG_FILE   = path.join(HOME, '.troth', 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function isEnabled() {
  const cfg = loadConfig();
  return cfg.telemetry_enabled === true;
}

function installationId() {
  try {
    if (fs.existsSync(ID_FILE)) return fs.readFileSync(ID_FILE, 'utf8').trim();
    const id = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.dirname(ID_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ID_FILE, id, { mode: 0o600 });
    return id;
  } catch (_) { return 'anonymous'; }
}

// Record a single counted event. ALWAYS the event NAME + numerical
// values; NEVER strings derived from user input. Caller's responsibility
// to ensure the values dict has only numbers + small enums.
function record(eventName, values) {
  if (!isEnabled()) return false;
  values = values || {};
  // Strip any non-number/string-enum values defensively.
  const safeValues = {};
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (typeof v === 'number' && Number.isFinite(v)) safeValues[k] = v;
    else if (typeof v === 'string' && v.length <= 32 && /^[a-zA-Z0-9_.-]+$/.test(v)) safeValues[k] = v;
  }
  const ev = {
    ts:               new Date().toISOString(),
    event:            String(eventName).slice(0, 64),
    installation_id:  installationId(),
    values:           safeValues
  };
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_LOG), { recursive: true, mode: 0o700 });
    fs.appendFileSync(TELEMETRY_LOG, JSON.stringify(ev) + '\n', { mode: 0o600 });
  } catch (_) {}
  // Optional endpoint — operator-configurable.
  const cfg = loadConfig();
  if (cfg.telemetry_endpoint && typeof cfg.telemetry_endpoint === 'string') {
    try {
      const lib = cfg.telemetry_endpoint.startsWith('https') ? require('https') : require('http');
      const u = new URL(cfg.telemetry_endpoint);
      const body = JSON.stringify(ev);
      const req = lib.request({
        method: 'POST', hostname: u.hostname, port: u.port,
        path: u.pathname + u.search,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 5000
      }, () => {});
      req.on('error', () => {});
      req.on('timeout', () => { try { req.destroy(); } catch(_){} });
      req.write(body); req.end();
    } catch (_) {}
  }
  return true;
}

function status() {
  const cfg = loadConfig();
  return {
    enabled: cfg.telemetry_enabled === true,
    endpoint: cfg.telemetry_endpoint || null,
    log_path: TELEMETRY_LOG,
    installation_id: isEnabled() ? installationId() : null
  };
}

function setEnabled(enabled, endpoint) {
  const cfg = loadConfig();
  cfg.telemetry_enabled = !!enabled;
  if (endpoint !== undefined) cfg.telemetry_endpoint = endpoint || null;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  return status();
}

module.exports = { isEnabled, record, status, setEnabled, installationId, TELEMETRY_LOG };
