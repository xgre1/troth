// SPDX-License-Identifier: AGPL-3.0-only
// session-grants.js — ground the partner opened for itself, this process only.
//
// The operator's registry (~/.troth/opened-folders.json) stays operator
// surface: nothing here writes it. What the partner may do is stand a folder
// of the operator's own work onto opened ground for the life of one session —
// witnessed rather than permitted: the grant demands a stated purpose, the
// caller photographs the tree before applying it, and the grant dies with the
// process. Two grounds are never openable by any hand: partner project ground
// (foreign code keeps its jail) and the tree holding the substrate.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const _grants = new Map();   // realpath → { purpose, at }

const PURPOSE_MAX = 300;

function _under(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

function _realOrNull(p) {
  try { return fs.realpathSync(p); } catch (_) { return null; }
}

function grant(dir, purpose) {
  if (typeof dir !== 'string' || !dir.length) {
    return { ok: false, error: 'no directory given' };
  }
  const why = String(purpose === undefined || purpose === null ? '' : purpose)
    .replace(/\s+/g, ' ').trim();
  if (!why) {
    return { ok: false,
             error: 'a one-line purpose is required — it is the record of why this ground opened' };
  }
  // The callers' contract accepts ~-relative spellings; expand before resolving.
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~' + path.sep)) {
    dir = path.join(os.homedir(), dir.slice(1));
  }
  const real = _realOrNull(dir);
  if (real === null) return { ok: false, error: 'no such directory: ' + dir };
  let st;
  try { st = fs.statSync(real); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) return { ok: false, error: 'not a directory: ' + real };

  const gp = require('./ground-policy.js');
  const wsRoot  = gp.workspaceRoot();
  const realWs  = _realOrNull(wsRoot);
  if (_under(real, wsRoot) || (realWs !== null && _under(real, realWs))) {
    return { ok: false,
             error: 'refused: ' + real + ' is partner project ground — foreign code keeps '
                  + 'its jail; work there runs inside it' };
  }
  const troth = _realOrNull(gp.trothDir()) || path.resolve(gp.trothDir());
  if (_under(real, troth) || _under(troth, real)) {
    return { ok: false,
             error: 'refused: ' + real + ' holds or contains the substrate directory — '
                  + 'nothing opens it' };
  }

  _grants.set(real, { purpose: why.slice(0, PURPOSE_MAX), at: new Date().toISOString() });
  return { ok: true, root: real, purpose: why.slice(0, PURPOSE_MAX) };
}

function list() {
  return Array.from(_grants.keys());
}

function entries() {
  return Array.from(_grants, ([root, g]) => ({ root, purpose: g.purpose, at: g.at }));
}

function _reset() { _grants.clear(); }

module.exports = { grant, list, entries, _reset, PURPOSE_MAX };
