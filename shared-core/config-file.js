// SPDX-License-Identifier: AGPL-3.0-only
// config-file.js: the ONE write path for ~/.troth/config.json.
//
// Motivation: several writers each did their own lenient
// read-merge-write (JSON.parse catch -> {} / DEFAULTS), so one transient
// parse failure (torn write, transient FS error) made the next writer
// rewrite config.json without every field the lenient reader had lost.
// That is how config fields silently vanished. The rules here:
//
//   1. Fresh read at write time; a cached copy is never written back.
//   2. A file that exists but does not parse REFUSES the write (throw).
//      "Start from {}" is only correct when the file does not exist.
//   3. Atomic replace: same-directory temp file + rename, so a crash
//      mid-write cannot leave a torn half-file for rule 2 to trip on.
//   4. Dir 0700, file 0600 (providers can carry secrets).
//
// Readers may stay lenient (defaulting on a broken file is fine when the
// result is never written back). Writers route through updateConfig().
//
// Path resolution honors TROTH_CONFIG_PATH / TROTH_CONFIG_DIR (same as
// transport-config.js and l4-config.js) so tests and exotic setups can
// redirect; the default is ~/.troth/config.json.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function configDir() {
  const home = process.env.HOME || os.homedir();
  return process.env.TROTH_CONFIG_DIR || path.join(home, '.troth');
}

function configPath() {
  return process.env.TROTH_CONFIG_PATH || path.join(configDir(), 'config.json');
}

// Strict read for WRITE paths: {} only when the file does not exist.
function readForWrite(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw new Error('config_read_failed: ' + p + ': ' + (e && e.message));
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      'config_corrupt_refusing_write: ' + p + ' is not valid JSON (' +
      (e && e.message) + '). Overwriting it would erase every field in it; ' +
      'inspect and fix the file (or delete it to start fresh), then retry.');
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('config_corrupt_refusing_write: ' + p + ' top level is not an object');
  }
  return cfg;
}

// updateConfig(mutator): mutator receives the freshly-read config object
// and returns the object to persist (returning undefined keeps the mutated
// input). Throws instead of writing when the existing file is corrupt.
// Returns the persisted object.
function updateConfig(mutator) {
  const p = configPath();
  const current = readForWrite(p);
  let next = mutator(current);
  if (next === undefined) next = current;
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('config_update_invalid: mutator must produce an object');
  }
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  return next;
}

// Shallow-merge convenience.
function patchConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('config_patch_invalid: patch must be an object');
  }
  return updateConfig((cfg) => Object.assign(cfg, patch));
}

module.exports = { configPath, readForWrite, updateConfig, patchConfig };
