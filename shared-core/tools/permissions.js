// SPDX-License-Identifier: AGPL-3.0-only
// permissions.js — the operator's OK, given once, kept as a permission.
//
// A wall that stops a command does not hand the operator the command to run
// themselves. It names what it needs: the operator's OK for that shape of
// command. The partner asks in plain words; the operator answers; the
// partner calls the tool again carrying the answer. "once" covers that call,
// "session" this process, "always" is written to permissions.json in the
// substrate directory and holds in every later session, with the operator's
// words and the moment beside it. Secrets (keys, tokens, the shell rc tree)
// have no permission road: the wall there is not a question.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE_NAME = 'permissions.json';
const SCOPES = ['once', 'session', 'always'];
const WORDS_MIN = 2;
const WORDS_MAX = 300;

function configDir() {
  return process.env.TROTH_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.troth');
}

function filePath() { return path.join(configDir(), FILE_NAME); }

// Binaries that read the machine and nothing else: the process-inspect road.
const INSPECT_BINS = new Set([
  'ps', 'top', 'lsof', 'pgrep', 'pstree', 'uptime', 'who', 'w', 'vm_stat', 'iostat', 'netstat',
  'sw_vers', 'system_profiler', 'sysctl', 'df', 'du', 'diskutil', 'ioreg', 'launchctl', 'pmset',
]);
// Text tools a read may flow through.
const FILTER_BINS = new Set([
  'grep', 'egrep', 'fgrep', 'awk', 'sed', 'sort', 'uniq', 'head', 'tail', 'cut', 'tr', 'wc',
  'cat', 'column', 'paste', 'xargs', 'tee', 'echo', 'printf', 'date', 'sleep', 'true', 'false',
]);
const SIGNAL_BINS = new Set(['kill', 'killall', 'pkill']);

// The first word of every stage of a pipeline or a sequence: the binaries
// a command line runs. `sudo`, `env`, `nice`, `time` and `command` are
// stripped as prefixes; a subshell, backticks or a redirect into a file
// mean the shape is not a plain read and no road is named.
function _binaries(command) {
  const s = String(command || '');
  if (/[`$(<>]/.test(s.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$[0-9]+/g, ''))) return null;
  const stages = s.split(/\|\||&&|;|\|/).map((x) => x.trim()).filter(Boolean);
  if (!stages.length) return null;
  const bins = [];
  for (const st of stages) {
    let words = st.split(/\s+/);
    while (words.length && /^(sudo|env|nice|time|command|exec)$/.test(words[0])) {
      words.shift();
      while (words.length && /^-/.test(words[0])) words.shift();
      if (words.length && words[0] === 'sudo') continue;
    }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (!words.length) return null;
    bins.push(path.basename(words[0]));
  }
  return bins;
}

// The road a command line asks for on walled ground, or null when it asks
// for nothing a wall holds back.
function roadFor(command) {
  const bins = _binaries(command);
  if (!bins) return null;
  const first = bins[0];
  if (first === 'log' && /^\s*(sudo\s+)?log\s+(show|stream|collect)\b/.test(String(command || ''))) return 'unified-log';
  if (SIGNAL_BINS.has(first) && bins.slice(1).every((b) => FILTER_BINS.has(b) || INSPECT_BINS.has(b))) return 'signal';
  if (INSPECT_BINS.has(first) && bins.slice(1).every((b) => INSPECT_BINS.has(b) || FILTER_BINS.has(b))) return 'process-inspect';
  return null;
}

// The first binary of a command line, for the general unwalled road.
function firstBinary(command) {
  const bins = _binaries(command);
  return bins && bins[0] ? bins[0] : null;
}

function keyFor(kind, detail) {
  return String(kind) + ':' + String(detail || '').replace(/[^A-Za-z0-9_.+-]/g, '_').slice(0, 80);
}

function _readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(j && j.permissions) ? j.permissions : [];
  } catch (_) { return []; }
}

function _writeAll(list) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ permissions: list }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath());
}

const _session = new Map();

// The standing permission for a key: one given for always (on disk) or for
// this session (in memory), or null.
function standing(key) {
  if (_session.has(key)) return _session.get(key);
  const hit = _readAll().find((p) => p && p.key === key);
  return hit || null;
}

// Check the answer the partner carries: { scope, words }. Returns
// { ok, scope, words } or { ok: false, error }.
function parseAnswer(raw) {
  if (raw === true) return { ok: true, scope: 'once', words: 'acknowledged' };
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'no permission carried' };
  const scope = SCOPES.includes(raw.scope) ? raw.scope : 'once';
  const words = String(raw.words || '').trim();
  if (words.length < WORDS_MIN) return { ok: false, error: 'permission needs the operator\'s words (what they said)' };
  return { ok: true, scope, words: words.slice(0, WORDS_MAX) };
}

// Keep the operator's OK for a key, by scope.
function grant(key, answer, purpose) {
  const entry = { key, scope: answer.scope, words: answer.words, purpose: String(purpose || '').slice(0, 200), at: new Date().toISOString() };
  if (answer.scope === 'session') _session.set(key, entry);
  if (answer.scope === 'always') {
    const list = _readAll().filter((p) => p && p.key !== key);
    list.push(entry);
    _writeAll(list);
  }
  return entry;
}

function revoke(key) {
  _session.delete(key);
  const list = _readAll();
  const kept = list.filter((p) => p && p.key !== key);
  if (kept.length !== list.length) _writeAll(kept);
}

function list() {
  return _readAll().concat(Array.from(_session.values()));
}

// The words a refusal carries: what is needed and how the OK travels.
function needed(key, what, why) {
  return '[troth-bash] needs the operator\'s OK (' + key + '): ' + what + (why ? ' ' + why : '')
    + ' Ask the operator in plain words. With their OK, call run again with the same command and'
    + ' permission: { words: "<what they said>", scope: "once" | "session" | "always" }.'
    + ' "always" is kept in ' + FILE_NAME + ' and never asked again.';
}

function _reset() { _session.clear(); }

module.exports = { roadFor, firstBinary, keyFor, standing, parseAnswer, grant, revoke, list, needed, filePath, configDir, FILE_NAME, SCOPES, _binaries, _reset };
