// SPDX-License-Identifier: AGPL-3.0-only
// project-id — cwd → canonical project identifier.
//
// Substrate needs a stable project_id
// to route project_thesis engrams to the right project, and to scope
// canonical doc registry per project.
//
// Resolution priority:
//   1..troth/project.json walk-up — explicit operator declaration
//   2. CI — a build machine is nobody's project, whatever it checked out
//   3..git root basename — a repository is a project wherever it sits,
//      including under a throwaway root
//   4. '__ephemeral__' — throwaway roots (any _tempRoots()), scratch dirs,
//      home, home's parent, /
//   5. cwd basename — last-resort fallback
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

// Ephemeral cwd shapes: throwaway roots, CI, scratch markers in the path.
// These should never anchor a real project_thesis — return a stable
// __ephemeral__ sentinel so callers can route to a no-thesis fallback.
//
// The list read /tmp and /private/tmp and stopped there, which is every
// throwaway root except the one macOS actually uses: os.tmpdir() there is
// /var/folders/<…>/T. So the guard was inert on the platform that ships, and a
// scratch directory resolved to its own basename — 'T', or whatever the
// directory beneath it was called. _tempRoots() already knows all of them,
// and is what the store key uses, so both answers come from one list.
function _isEphemeralCwd(cwd) {
  if (!cwd) return true;
  if (_isScratch(cwd)) return true;
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

// Walk up from cwd looking for a.git directory. Returns the directory that
// holds it — the repository root — or null if there is none.
function _findGitRootDir(cwd) {
  let dir = cwd;
  for (let i = 0; i < 32 && dir && dir !== '/'; i++) {
    try {
      const stat = fs.statSync(path.join(dir, '.git'));
      // .git can be a dir (normal repo) or a file (worktree). Both count.
      if (stat) return dir;
    } catch (_) { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The repo root's name, which is what a human calls the project.
function _findGitRootBasename(cwd) {
  const root = _findGitRootDir(cwd);
  return root ? path.basename(root) : null;
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
  // CI is answered before anything else: a build machine is nobody's project,
  // whatever it has checked out.
  if (process.env.CI === 'true' || process.env.CI === '1') return '__ephemeral__';
  // A repository is a project wherever it happens to sit — a runner's
  // workspace, a worktree under a scratch root. Asked BEFORE the path-shape
  // guess for exactly the reason the declaration above is: the shape of a path
  // is the weakest signal here, and it was overruling the strongest one.
  // Widening the throwaway-root list without this would have taken the name
  // away from every checkout under a temp directory.
  const gitBasename = _findGitRootBasename(c);
  if (gitBasename) {
    _cache.set(c, { id: gitBasename, ts: Date.now() });
    return gitBasename;
  }
  if (_isEphemeralCwd(c)) return '__ephemeral__';
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

// Test / migration helper: clear the resolution caches so subsequent calls
// re-walk and re-ask git. Not for production hot path.
function _clearCache() { _cache.clear(); _rootCommitCache.clear(); }

// ── Store keys ─────────────────────────────────────────────────────────────
//
// Six files would carry their own copy of "sha256 of the directory, first 12
// chars" — the indexer that writes the code store, the tools that read it, the
// edit hook that updates it. Keying a project's
// store by its PATH means the project stops existing the moment it moves:
// troth-core moved once and its index started from
// empty at the new address, with nothing pointing at the old ones.
//
// The key now follows the project's IDENTITY — a declared id, else the
// repository's first commit — so the same project keeps one store wherever it
// sits and whatever its folder is called.
//
// Scratch directories are the deliberate exception. The whole test suite runs
// on a throwaway HOME under the system temp dir, and two of those would
// otherwise share a key through their identical basenames and read each
// other's rows. Under a temp root the PATH stays the key, which is exactly
// today's behaviour and keeps every suite isolated.
const _crypto = require('crypto');

function _tempRoots() {
  const roots = ['/tmp', '/private/tmp'];
  // os.tmpdir() is /var/folders/… on macOS. _isEphemeralCwd shares this list
  // through _isScratch, so "which roots are throwaway" has one answer.
  try { const t = os.tmpdir(); if (t) roots.push(t); } catch (_) {}
  return roots;
}

function _isScratch(dir) {
  const d = String(dir || '');
  return _tempRoots().some((r) => d === r || d.startsWith(r + path.sep));
}

function _key(s) {
  return _crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

// A repository's first commit is an identity no filesystem operation can
// touch. Keying on the git root's NAME fixed moving a folder and left renaming
// it: the same project under a new name became a new project with an empty
// store. The root commit survives moving, renaming, and being cloned to
// another machine — two checkouts of one repository are one project, which is
// what an operator means by the word.
//
// Deliberately NOT solved by writing a declaration file into the operator's
// repository. Putting a file in a directory that belongs to someone else is
// what broke the application bundle's signature once already, and it would
// turn up unannounced in every user's `git status`. The declaration is read
// when the operator writes one; troth never writes it.
// Asking git costs 11ms, and the edit hook is a FRESH PROCESS on every edit —
// an in-memory cache never survives to help it. Measured: 18ms to load this
// module, 32ms once the git call is added. So the answer is remembered on
// disk, where a short-lived process can still find it: ~1ms to read, and a
// repository's first commit does not change.
//
// Written atomically because several hooks run at once, and every failure
// — unreadable, unwritable, corrupt — is treated as a miss. A cache that can
// break the thing it speeds up is not worth having.
const _rootCommitCache = new Map();
const _DISK_TTL_MS = 24 * 60 * 60 * 1000;

function _diskCachePath() {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.troth', 'project-keys.json');
}
function _diskRead() {
  try { return JSON.parse(fs.readFileSync(_diskCachePath(), 'utf8')) || {}; }
  catch (_) { return {}; }
}
function _diskWrite(map) {
  const p = _diskCachePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (_) { /* a cache that cannot be written is simply not a cache */ }
}

function _gitRootCommit(dir) {
  const hit = _rootCommitCache.get(dir);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.sha;

  const disk = _diskRead();
  const dhit = disk[dir];
  if (dhit && typeof dhit.ts === 'number' && Date.now() - dhit.ts < _DISK_TTL_MS) {
    const sha = dhit.sha || null;
    _rootCommitCache.set(dir, { sha, ts: Date.now() });
    return sha;
  }

  let sha = null;
  try {
    const out = require('child_process').execFileSync(
      'git', ['rev-list', '--max-parents=0', 'HEAD'],
      { cwd: dir, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n').filter(Boolean);
    // A repository grafted from several histories has more than one root.
    // Sorting makes the choice deterministic instead of order-of-traversal.
    if (out.length) sha = out.slice().sort()[0];
  } catch (_) { /* not a repo, no commits yet, or no git on this machine */ }

  _rootCommitCache.set(dir, { sha, ts: Date.now() });
  // Bounded: a machine that visits thousands of directories must not grow an
  // unbounded file. Oldest entries go first.
  disk[dir] = { sha, ts: Date.now() };
  const keys = Object.keys(disk);
  if (keys.length > 200) {
    keys.sort((a, b) => (disk[a].ts || 0) - (disk[b].ts || 0));
    for (const k of keys.slice(0, keys.length - 200)) delete disk[k];
  }
  _diskWrite(disk);
  return sha;
}

/**
 * The 12-char key naming this project's per-project stores.
 *
 * Order: a declaration the operator wrote, then the repository's first commit,
 * then the path for scratch directories, then the resolved name.
 */
function projectKeyFor(dir) {
  const target = String(dir || process.cwd());
  const declared = _readProjectJson(target);
  if (declared) return _key('project:' + declared);
  const root = _gitRootCommit(target);
  if (root) return _key('git:' + root);
  // No repository to identify it by: a scratch directory keeps its own store
  // so throwaway test homes never read one another's rows.
  if (_isScratch(target)) return _key(target);
  const id = resolveProjectId(target);
  if (!id || id === '__ephemeral__') return _key(target);
  return _key('project:' + id);
}

// ── Carrying an existing store across a change of key ──────────────────────
//
// Changing what names a store is half a fix. Every per-project store already
// on disk sits under the name the previous rule produced, and a reader that
// looks only under the new name finds nothing: the code index, the recorded
// lessons and the decisions are all still there and all unreachable. The
// symptom is not an error — it is a partner that has forgotten the project.
//
// The same project could even hold TWO stores, because the key was the PATH:
// a proxy started at the repository root and one started in a subdirectory of
// it disagreed about where they were, and each indexed into its own file.
//
// So the first open under the new key adopts what the older rules would have
// named FROM THE SAME LOCATION, in a fixed order: this directory, then the
// repository root, then the resolved project name. The file is RENAMED rather
// than copied — atomic, no second copy of a large index — and nothing is ever
// deleted. A store that already exists under the new key is never touched.
//
// Every failure is a miss. The caller gets the new path and a clean store,
// which is precisely the behaviour without any of this. A migration is allowed
// to fail to carry a history; it is not allowed to break the thing it carries.
function legacyKeysFor(dir) {
  const target = path.resolve(String(dir || process.cwd()));
  const keys = [_key(target)];
  const root = _findGitRootDir(target);
  if (root && path.resolve(root) !== target) keys.push(_key(path.resolve(root)));
  const id = resolveProjectId(target);
  if (id && id !== '__ephemeral__') keys.push(_key('project:' + id));
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

// What was adopted, if anything, for whoever wants to say so out loud.
let _adoption = null;
function lastAdoption() { return _adoption; }

function _adopt(from, to) {
  try {
    if (!fs.existsSync(from)) return false;
    if (fs.existsSync(to)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // The main file moves first: if this throws, nothing has moved at all.
    fs.renameSync(from, to);
  } catch (_) { return false; }
  // The write-ahead log holds committed rows the main file has not absorbed
  // yet, so it travels with it or the newest work is exactly the part lost.
  for (const ext of ['-wal', '-shm']) {
    try { if (fs.existsSync(from + ext)) fs.renameSync(from + ext, to + ext); } catch (_) {}
  }
  _adoption = { from: from, to: to, at: Date.now() };
  return true;
}

/**
 * Absolute path of one of this project's stores under ~/.troth, adopting a
 * store left under an older key the first time it is asked for.
 *
 * `template` is the path below ~/.troth with {key} where the key belongs:
 * 'codelens/{key}.db'.
 */
function projectStorePath(dir, template) {
  const home = process.env.HOME || os.homedir();
  const at = (k) => path.join(home, '.troth', String(template).replace('{key}', k));
  const current = at(projectKeyFor(dir));
  try {
    if (fs.existsSync(current)) return current;
    for (const legacy of legacyKeysFor(dir)) {
      const older = at(legacy);
      if (older === current) continue;
      if (_adopt(older, current)) return current;
    }
  } catch (_) { /* a migration that throws is worse than one that does nothing */ }
  return current;
}

// ── What may be walked ─────────────────────────────────────────────────────
//
// A proxy started from inside a .app bundle substitutes the operator's home
// directory for the project directory. That is the right answer to "where do I
// keep state" and the wrong answer to "which codebase is this", and the
// indexer took it literally: on a machine running the app it walked the whole
// home — Downloads, Library, Desktop, browser profiles and a 12 GB backup —
// into a 201 MB index, and the code tools then answered questions from it.
//
// Containers are refused by name rather than by heuristic: a directory that
// holds projects is not itself one. Scratch roots stay indexable, because the
// suites index throwaway trees and a guard that disables the feature under
// test is worse than no guard.
const _CONTAINERS = new Set([
  'Documents', 'Desktop', 'Downloads', 'Library', 'Movies', 'Music',
  'Pictures', 'Public', 'Applications', 'Sites'
]);

/** May this directory be walked and indexed as a codebase? */
function isIndexableRoot(dir) {
  const d = String(dir || '');
  if (!d) return false;
  // A path is judged in every form the filesystem gives it: as written and
  // as resolved through symlinks (macOS keeps /var under /private), so a home
  // folder reached either way is still the home, and a container under it
  // that does not exist yet is still a container.
  const forms = (p) => { const r = path.resolve(p); let q = r; try { q = fs.realpathSync(r); } catch (_) { /* not there yet: the written form stands */ } return q === r ? [r] : [r, q]; };
  for (const resolved of forms(d)) {
    const sep = resolved.replace(/\\/g, '/');
    // Anything inside an application bundle is somebody's build output.
    if (sep.indexOf('.app/Contents/') !== -1 || sep.endsWith('.app')) return false;
    if (resolved === path.parse(resolved).root) return false;
    for (const home of forms(os.homedir())) {
      if (resolved === home || resolved === path.dirname(home)) return false;
      // A container directly under home holds projects; it is not one.
      if (path.dirname(resolved) === home && _CONTAINERS.has(path.basename(resolved))) return false;
    }
  }
  return true;
}

// Which directory IS the project, given one somewhere inside it.
//
// A proxy indexes the directory it was started in. Started from a
// subdirectory, it would build a second store for the same project — waste,
// but harmless. Once the store is named after the project's identity there is
// only one, and the indexer prunes whatever is not under its root: a proxy
// started in a subdirectory quietly cut a project's index down to that
// subdirectory's files. Measured here: 8,303 entries to 1,040 on one restart.
//
// The repository root is the project. Anything that is not inside one, or
// whose root is not a place worth walking, stays exactly where it was.
function projectRootFor(dir) {
  const target = path.resolve(String(dir || process.cwd()));
  const root = _findGitRootDir(target);
  if (!root) return target;
  const resolved = path.resolve(root);
  if (!isIndexableRoot(resolved)) return target;
  return resolved;
}

// Which project a piece of work belongs to, given the FILE being worked on.
//
// A hook runs wherever the session was started, and a fresh terminal starts in
// the operator's home — which is not a project at all. Deriving the project
// from that position sent the reader somewhere the writer never wrote:
// measured here, the edit hook was reading a home-wide index that did not
// contain a symbol added to the project that same morning, and cannot ever
// contain one, because home is no longer walked.
//
// The file being edited answers the question with no guessing at all, and
// every file-shaped hook is already holding it. A file outside any repository
// falls back rather than minting a store of its own for one loose directory.
function projectDirForFile(filePath, fallbackDir) {
  const fallback = fallbackDir || process.cwd();
  const f = String(filePath || '');
  if (!f) return fallback;
  const root = _findGitRootDir(path.dirname(path.resolve(f)));
  if (!root) return fallback;
  const resolved = path.resolve(root);
  return isIndexableRoot(resolved) ? resolved : fallback;
}

module.exports = {
  resolveProjectId,
  projectKeyFor,
  projectStorePath,
  legacyKeysFor,
  lastAdoption,
  isIndexableRoot,
  projectRootFor,
  projectDirForFile,
  _isEphemeralCwd,
  _clearCache
};
