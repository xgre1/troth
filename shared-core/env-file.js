// SPDX-License-Identifier: AGPL-3.0-only
// env-file — minimal cross-platform .env loader. Zero deps.
//
// Purpose: API keys (Anthropic, OpenAI, OpenRouter, etc.) belong in a
// gitignored .env file, not in plaintext config.json. Cross-platform
// secret stores (macOS Keychain / Linux Secret Service / Windows
// Credential Manager) are different per OS — adding any of them as a
// hard dep breaks portability. .env is the lowest-common-denominator
// pattern that works everywhere AND keeps env propagation working
// (subshells inherit env, so the bench / proxy / bin all see keys
// without per-tool config.json wiring).
//
// Resolution order (first match wins, no overwrite of already-set env):
//   1. process.env (already set by parent shell — wins)
//   2. ~/.troth/.env (user-scoped; default location for installed app)
//   3. <projectRoot>/.env (per-project override; useful for development)
//
// Format: standard KEY=VALUE per line. Comments start with '#'. Quoted
// values (single or double) are unquoted. Whitespace around the '='
// is tolerated. Continuation lines / variable interpolation are NOT
// supported — keep the loader small and predictable.
//
// Security: this loader only INJECTS into process.env at call time; it
// never logs values, never prints them, never serializes them. Callers
// that pass values to LLM transports must be careful not to echo them.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME = process.env.HOME || os.homedir();
const USER_ENV  = process.env.TROTH_ENV_FILE || path.join(HOME, '.troth', '.env');

let _loaded = false;

function parse(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Strip inline comments only when value is unquoted. A '#' inside
    // a quoted value is a literal.
    out[key] = val;
  }
  return out;
}

// Load once per process. Subsequent calls are no-ops unless force=true.
// Returns the merged file values (NOT process.env state) for callers
// that want to know what was sourced from disk vs already-set env.
function load(opts) {
  opts = opts || {};
  if (_loaded && !opts.force) return {};
  _loaded = true;

  const sources = [];
  // Project .env first in priority order, but we apply user .env first
  // so project-level overrides win — matches how dotenv ecosystems work.
  if (opts.projectRoot) {
    sources.push(path.join(opts.projectRoot, '.env'));
  }
  sources.push(USER_ENV);

  const fileValues = {};
  // Apply in REVERSE so the highest-priority entry (project root .env)
  // overwrites the lower-priority user-level .env.
  for (let i = sources.length - 1; i >= 0; i--) {
    const filePath = sources[i];
    try {
      const txt = fs.readFileSync(filePath, 'utf8');
      const parsed = parse(txt);
      Object.assign(fileValues, parsed);
    } catch (_) { /* file absent — silent skip */ }
  }
  for (const key of Object.keys(fileValues)) {
    // Never overwrite an already-set process.env entry. The parent
    // shell wins. This lets CI / one-off invocations override file
    // values without editing files.
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = fileValues[key];
    }
  }
  return fileValues;
}

// Append-or-replace a single KEY=VALUE in the user-level .env. Atomic
// via temp + rename. Creates the directory if absent. Used by the UI
// dashboard's key-write endpoint so the dashboard stops persisting
// secrets in plaintext config.json.
function writeKey(key, value) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('env-file: invalid key name');
  }
  if (typeof value !== 'string') throw new Error('env-file: value must be string');
  const dir = path.dirname(USER_ENV);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing = '';
  try { existing = fs.readFileSync(USER_ENV, 'utf8'); } catch (_) {}
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const re = new RegExp('^\\s*' + key + '\\s*=');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = key + '=' + escape(value);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(key + '=' + escape(value));
  }
  // Pid-suffixed, like config-file.js: the CLI proxy and the app-bundled
  // proxy of the same HOME are two processes, and a fixed tmp name let one
  // writer's rename hit the other's half-written file — measured as both an
  // ENOENT throw and a silently lost update under concurrent writes.
  const tmp = USER_ENV + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, USER_ENV);
  // Restrictive perms: user-only read/write.
  try { fs.chmodSync(USER_ENV, 0o600); } catch (_) {}
  // Mirror into current process.env so the same process sees the new
  // value without a re-load cycle.
  process.env[key] = value;
  return USER_ENV;
}

function escape(v) {
  // Quote if value contains whitespace, '#', or quote chars.
  if (/[\s#"']/.test(v)) {
    return '"' + v.replace(/"/g, '\\"') + '"';
  }
  return v;
}

// For the dashboard's "is this key set?" indicator — never returns the
// VALUE, only presence + length so the UI can show "configured (51 chars)".
function probe(key) {
  const v = process.env[key];
  if (typeof v !== 'string' || !v) return { set: false, length: 0 };
  return { set: true, length: v.length };
}

// removeKey(key) — delete a credential for good.
//
// Without this there was no way to take a key back: the dashboard only wrote
// keys longer than ten characters, so clearing the field reached nothing, and
// loadProviders backfills apiKey from this file on every load. A lane the
// operator had emptied kept answering on the old credential, across restarts,
// with the UI showing it as configured.
//
// Mirrors writeKey's discipline: same key-name validation, same 0600 file,
// atomic replace, and it clears process.env so the running proxy stops using
// the value immediately rather than at the next boot.
function removeKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('env-file: invalid key name');
  }
  let existing = '';
  try { existing = fs.readFileSync(USER_ENV, 'utf8'); } catch (_) { return false; }
  const re = new RegExp('^\\s*' + key + '\\s*=');
  const kept = existing.split(/\r?\n/).filter(function (l) { return !re.test(l); });
  if (kept.length === existing.split(/\r?\n/).length) { delete process.env[key]; return false; }
  const tmp = USER_ENV + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, kept.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, USER_ENV);
  try { fs.chmodSync(USER_ENV, 0o600); } catch (_) {}
  delete process.env[key];
  return true;
}

module.exports = { load, writeKey, removeKey, parse, probe, USER_ENV_PATH: USER_ENV };
