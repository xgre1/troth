// SPDX-License-Identifier: AGPL-3.0-only
// project-id — cwd → canonical project identifier.
//
// Substrate needs a stable project_id
// to route project_thesis engrams to the right project, and to scope
// canonical doc registry per project.
//
// Resolution priority:
//   1..troth/project.json walk-up — explicit operator declaration
//   2..git root basename — git repo's enclosing directory name
//   3. cwd basename — last-resort fallback
//   4. '__ephemeral__' — /tmp paths, CI=true, scratch dirs
//
// Pure-function: no DB writes, no env mutation. Cheap (filesystem stats
// only; cached via Map for hot-path callers like the entity prefix
// provider).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const _cache = new Map();   // cwd → projectId
const CACHE_TTL_MS = 60 * 1000;    // 1min — covers many recall cycles, expires for CI / test isolation

// Ephemeral cwd shapes: /tmp/*, CI=true env, scratch markers in path.
// These should never anchor a real project_thesis — return a stable
// __ephemeral__ sentinel so callers can route to a no-thesis fallback.
function _isEphemeralCwd(cwd) {
  if (!cwd) return true;
  if (cwd.startsWith('/tmp/') || cwd === '/tmp') return true;
  if (cwd.startsWith('/private/tmp/')) return true;
  if (cwd.includes('/scratch/') || cwd.endsWith('/scratch')) return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  return false;
}

// Walk up from cwd looking for.troth/project.json. Returns the project
// id from its 'id' field if present, else null. Stops at filesystem root.
function _readProjectJson(cwd) {
  let dir = cwd;
  for (let i = 0; i < 32 && dir && dir !== '/'; i++) {
    const candidate = path.join(dir, '.troth', 'project.json');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.id === 'string' && parsed.id) return parsed.id;
      }
    } catch (_) { /* not here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Walk up from cwd looking for a.git directory. Returns the basename of
// that.git's enclosing directory (i.e. the repo root name). Null if no
// .git found.
function _findGitRootBasename(cwd) {
  let dir = cwd;
  for (let i = 0; i < 32 && dir && dir !== '/'; i++) {
    try {
      const stat = fs.statSync(path.join(dir, '.git'));
      // .git can be a dir (normal repo) or a file (worktree). Both count.
      if (stat) return path.basename(dir);
    } catch (_) { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Public API. Returns a project_id string, never null.
//
// Priority 1 (.troth/project.json explicit override) is checked BEFORE the
// ephemeral-cwd heuristic on purpose: the whole point of an explicit
// operator declaration is to override path-shape guessing, including the
// "this looks like a scratch dir" guess. Without this ordering, ANY repo
// checked out under /tmp or /private/tmp (e.g. a CI runner workspace, or a
// git worktree under a tmp-rooted scratch dir) silently loses its declared
// project_id and every caller falls back to '__ephemeral__' regardless of
// the override file sitting right there on disk — surfaced  by
// AC-PLUGIN-3 failing only when the checkout itself lived under
// /private/tmp/ (worktree scratch dir), independent of suite order.
function resolveProjectId(cwd) {
  const c = cwd || process.cwd();
  const cached = _cache.get(c);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.id;
  const explicit = _readProjectJson(c);
  if (explicit) {
    _cache.set(c, { id: explicit, ts: Date.now() });
    return explicit;
  }
  if (_isEphemeralCwd(c)) return '__ephemeral__';
  const gitBasename = _findGitRootBasename(c);
  if (gitBasename) {
    _cache.set(c, { id: gitBasename, ts: Date.now() });
    return gitBasename;
  }
  // The HOME directory is not a project. It was falling through to the
  // basename rule below and resolving to the macOS account name, so every
  // pane opened from home shared one project identity and inherited whatever
  // the last one had been doing, regardless of which repo that was (operator
  // report). A new pane starts in home by default, which made this
  // the common case rather than the edge case. Home, its parent, and the
  // filesystem root all mean "no project here".
  const home = os.homedir();
  if (c === home || c === path.dirname(home) || c === '/') {
    _cache.set(c, { id: '__ephemeral__', ts: Date.now() });
    return '__ephemeral__';
  }
  // Last resort: cwd basename. Generic enough to be useful even outside
  // a git repo (e.g. operator working in a Documents subfolder).
  const cwdBase = path.basename(c) || '__ephemeral__';
  _cache.set(c, { id: cwdBase, ts: Date.now() });
  return cwdBase;
}

// Test / migration helper: clear the resolution cache so subsequent
// resolveProjectId calls re-walk. Not for production hot path.
function _clearCache() { _cache.clear(); }

module.exports = {
  resolveProjectId,
  _isEphemeralCwd,
  _clearCache
};
