// SPDX-License-Identifier: AGPL-3.0-only
// mode-override — the per-conversation /mode store.
//
// `/mode plan` puts ONE conversation into plan mode: the partner reads and
// proposes, and every tool that writes or runs a command is off until
// `/mode build`. The map is keyed exactly like engine-override (a tagged pane
// by its conversation_id, the CLI/voice surface by the shared untagged bucket)
// and persisted next to it so a daemon respawn keeps the operator's choice.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const engineOverride = require('./engine-override.js');

const PLAN = 'plan';
const BUILD = 'build';
const MODES = [PLAN, BUILD];

// Every tool that changes the workspace, runs a command, ends a process,
// spends money on a clip or stores a credential. Read tools stay on.
const PLAN_FORBIDDEN_TOOLS = ['Write', 'Edit', 'Bash', 'job_stop', 'image_generate', 'video_generate', 'vault_capture'];

const PLAN_PROMPT_LINE = 'PLAN MODE: read and propose; writes and commands are off for this conversation. '
  + 'Say what you would change and where; the operator turns building back on with /mode build.';

const PLAN_FORBIDDEN_HINT = 'Plan mode is on for this conversation: writes and commands are off. '
  + 'Describe the change instead; the operator turns building back on with /mode build.';

const _modes = new Map();

function _dir() {
  const home = process.env.HOME || os.homedir();
  return process.env.TROTH_CONFIG_DIR || path.join(home, '.troth');
}
function _file() {
  return process.env.TROTH_MODE_OVERRIDES_PATH || path.join(_dir(), 'mode-overrides.json');
}

function _persist() {
  try {
    const obj = {};
    for (const [k, v] of _modes.entries()) obj[k] = v;
    fs.mkdirSync(_dir(), { recursive: true, mode: 0o700 });
    const p = _file();
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (_) { /* durability is best-effort; never break a turn */ }
}

function _load() {
  _modes.clear();
  let raw;
  try { raw = fs.readFileSync(_file(), 'utf8'); } catch (_) { return; }
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) if (obj[k] === PLAN) _modes.set(k, PLAN);
}
_load();

// get(conversation_id) -> 'plan' or null (build is the absence of an entry).
function get(conversationId) {
  return _modes.get(engineOverride.bucketKey(conversationId)) || null;
}

function isPlan(conversationId) { return get(conversationId) === PLAN; }

function set(conversationId, mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (MODES.indexOf(m) < 0) return null;
  const k = engineOverride.bucketKey(conversationId);
  if (m === PLAN) _modes.set(k, PLAN); else _modes.delete(k);
  _persist();
  return m;
}

function clear(conversationId) {
  _modes.delete(engineOverride.bucketKey(conversationId));
  _persist();
}

function _reset() {
  _modes.clear();
  try { fs.unlinkSync(_file()); } catch (_) { /* no file -> nothing to clear */ }
}
function _reload() { _load(); }

module.exports = {
  PLAN, BUILD, MODES,
  PLAN_FORBIDDEN_TOOLS, PLAN_PROMPT_LINE, PLAN_FORBIDDEN_HINT,
  get, isPlan, set, clear,
  _reset, _reload
};
