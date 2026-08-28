// SPDX-License-Identifier: AGPL-3.0-only
// ground-policy.js — which ground a working directory stands on.
//
// This answers the routing question that comes BEFORE any sandbox profile is
// built: given a cwd, is this the operator's own project, partner project
// ground, the directory tree that holds the substrate itself, or somewhere
// nobody declared? The answer decides which walls the caller applies.
//
// The rule is a directory convention rather than a command classifier,
// because a classifier fails open: a build target shells out to a package
// manager, a test run executes project code, and a config file is executable
// script. Ground is a property of WHERE work happens, which a command cannot
// talk its way out of.
//
// Six answers, four treatments:
//   escape             refuse — the path names one ground and resolves in
//                      another, so neither answer can be trusted
//   workspace/project  deny-default jail scoped to `jail`
//   home               the tree holding the substrate: writes belong in
//                      scratch, never here
//   opened             the operator declared this folder theirs; it runs with
//                      their own environment
//   unopened           confine writes to the folder itself; reads stay open
//
// Precedence is fixed and matters: workspace outranks an open so foreign code
// can never inherit the operator's walls by being registered, and home-class
// outranks an open so no registry entry can hand out the ground that holds
// the credential store and the substrate database.
//
// Two properties this module must never lose:
//   * Paths are compared on a SEPARATOR BOUNDARY, not as strings. A sibling
//     whose name merely starts with a governed path is not that ground.
//   * A path is judged twice — as written, and as the filesystem resolves it.
//     A link inside governed ground pointing elsewhere is the shape that
//     turns containment into no containment, so the mismatch is refused
//     rather than resolved in either direction's favour.
//
// HOME is read per call, never captured at load: an operator can move it, and
// a test that pins a throwaway home expects the next call to obey.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function homeDir() {
  return process.env.HOME || os.homedir();
}

function trothDir() {
  return process.env.TROTH_CONFIG_DIR || path.join(homeDir(), '.troth');
}

function workspaceRoot() {
  return path.join(trothDir(), 'workspace');
}

function registryPath() {
  return path.join(trothDir(), 'opened-folders.json');
}

// Boundary containment, not prefix matching: /a/bc is not under /a/b.
function under(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch (_) { return null; }
}

// What makes a directory the root of a piece of work. Confinement is scoped
// to this, never to the current directory: a repository is navigated, and a
// wall that moves with every cd refuses a test file written from the source
// directory, a manifest edited from a subdirectory, and staging from anywhere
// but the top. Those are the ordinary shape of working in a project, not the
// accident this layer exists to catch.
//
// Two kinds of marker, and the difference decides the answer. A repository is
// the unit of work and it is the OUTERMOST one that counts: a package
// manifest sits at every level of a monorepo, and a build step drops one
// wherever it is run, so taking the nearest marker narrows the scope to a
// subdirectory and refuses the sibling package, the top-level manifest and
// staging. A manifest only decides the root when there is no repository
// above it at all.
const VCS_MARKERS      = ['.git', '.hg', '.svn'];
const MANIFEST_MARKERS = ['package.json', 'Cargo.toml', 'go.mod',
                          'pyproject.toml', 'pom.xml', 'Gemfile'];

function hasAny(dir, markers) {
  for (const marker of markers) {
    try { if (fs.existsSync(path.join(dir, marker))) return true; } catch (_) {}
  }
  return false;
}

// Walks up, stopping before it can reach ground that holds the substrate — a
// marker dropped in a home directory must not turn the whole home into one
// project. Returns the NEAREST repository seen, else the nearest manifest,
// else null for a directory that is not part of anything.
//
// Nearest rather than outermost, and the difference is the whole scope. A
// monorepo has one repository at the top and manifests below it, so nearest
// already answers the top — that case never needed the wider rule. What the
// wider rule did need was one stray repository high in a tree of unrelated
// checkouts: a forgotten init in a directory of client projects made the
// scope that whole directory, and work in one client could then write into
// another. A repository inside a repository answers with the inner one for
// the same reason.
function projectRootOf(dir, troth) {
  let p = dir;
  let nearestManifest = null;
  for (let hops = 0; hops < 40; hops++) {
    if (under(p, troth) || under(troth, p)) break;
    if (hasAny(p, VCS_MARKERS)) return p;
    if (nearestManifest === null && hasAny(p, MANIFEST_MARKERS)) nearestManifest = p;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return nearestManifest;
}

// A linked working tree keeps its repository somewhere else: its .git is a
// FILE naming a directory under the main repository, and committing writes
// there — refs, index, objects. Scoping to the tree alone leaves every commit
// refused with a message about a path nobody asked for.
//
// That file lives INSIDE the tree being scoped, so on its own it is the
// scoped process describing its own scope: a file naming any directory at all
// would hand that directory over, and a project fetched from anywhere arrives
// carrying one. So the claim is only honoured when the repository AGREES:
// git records a pointer back to this tree inside the worktree entry, and
// writing that back-pointer already requires access to the repository. A
// one-way claim is refused, and so is a target that is not shaped like a
// repository, or that lies in the ground holding the substrate.
//
// An ordinary repository needs nothing from this: its .git is a directory
// inside the root already.
function linkedRepoDirOf(root, troth) {
  const dotgit = path.join(root, '.git');
  let text;
  try {
    if (!fs.lstatSync(dotgit).isFile()) return null;
    text = fs.readFileSync(dotgit, 'utf8');
  } catch (_) { return null; }
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!named) return null;
  const raw = named[1];
  const claimed = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  const entry = realOrNull(claimed);
  if (entry === null) return null;

  // Only a worktree entry can widen anything. A file naming a repository
  // directly, or naming an ordinary directory, names nothing here.
  const marker = path.sep + 'worktrees' + path.sep;
  const cut = entry.indexOf(marker);
  if (cut === -1) return null;
  const repoDir = realOrNull(entry.slice(0, cut));
  if (repoDir === null) return null;

  // The repository must point back at this tree. Forging this requires
  // already being able to write inside the repository, which is the access
  // the claim is asking for.
  let back;
  try { back = String(fs.readFileSync(path.join(entry, 'gitdir'), 'utf8')).trim(); }
  catch (_) { return null; }
  const backReal = realOrNull(back) || path.normalize(back);
  const hereReal = realOrNull(dotgit) || path.normalize(dotgit);
  if (backReal !== hereReal) return null;

  // Shaped like a repository, not merely a directory with the right name.
  for (const part of ['HEAD', 'objects']) {
    try { if (!fs.existsSync(path.join(repoDir, part))) return null; } catch (_) { return null; }
  }
  // And never the ground holding the substrate, whatever the file says.
  if (under(repoDir, troth) || under(troth, repoDir)) return null;
  return repoDir;
}

// Entries may be a bare path or an object carrying the path plus bookkeeping.
// A relative entry is dropped rather than resolved: resolving it would make
// the grant depend on whatever directory happened to be current.
function normalizeEntry(item) {
  const p = typeof item === 'string'
    ? item
    : (item && typeof item.path === 'string' ? item.path : null);
  if (!p || !path.isAbsolute(p)) return null;
  return path.normalize(p);
}

// Reader side: lenient by design. A registry that is missing, unreadable or
// unparseable yields NO opens, which lands every folder in confinement — the
// safe direction. Erring the other way would hand out bare ground on a torn
// write.
function openedFolders() {
  let raw;
  try { raw = fs.readFileSync(registryPath(), 'utf8'); }
  catch (_) { return []; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { return []; }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.folders) ? parsed.folders : null);
  if (!list) return [];
  const out = [];
  for (const item of list) {
    const p = normalizeEntry(item);
    if (p) out.push(p);
  }
  return out;
}

// classifyGround(cwd, opts) → { ground, root?, jail?, via?, reason? }
//
// opts.sessionRoot grants opened ground for the directory a session started
// in. It is passed in by the caller and never persisted: an in-memory grant
// has no expiry to get wrong, leaves nothing behind to go stale, and gives
// the partner no road that writes to the operator's registry.
// opts.opened and opts.workspaceRoot exist so the decision can be exercised
// against declared inputs instead of live machine state.
function classifyGround(cwd, opts) {
  opts = opts || {};
  if (typeof cwd !== 'string' || !cwd.length) {
    return { ground: 'escape', reason: 'no working directory given' };
  }
  const wsRoot   = opts.workspaceRoot || workspaceRoot();
  const claimed  = path.resolve(cwd);
  const realWs   = realOrNull(wsRoot);
  const claimsWs = under(claimed, wsRoot) || (realWs !== null && under(claimed, realWs));

  const real = realOrNull(cwd);
  if (real === null) {
    return { ground: 'escape',
             reason: 'working directory does not resolve: ' + claimed };
  }

  if (realWs !== null && under(real, realWs)) {
    // The workspace root is scaffolding ground: a new project has to be
    // created somewhere, so the jail is the whole root and every sibling is
    // in reach of a command run from it. Real work belongs one level deeper.
    if (real === realWs) return { ground: 'workspace', root: realWs, jail: realWs };
    // The FIRST segment under the root is the jail. Descending further never
    // re-scopes it, so a project's own build script cannot narrow its walls
    // to a subdirectory and then reach back out.
    const seg = real.slice(realWs.length + 1).split(path.sep)[0];
    const project = path.join(realWs, seg);
    return { ground: 'project', root: project, jail: project };
  }
  if (claimsWs) {
    return { ground: 'escape',
             reason: 'path is inside ' + wsRoot + ' but resolves to ' + real
                     + '; refusing rather than running unsandboxed' };
  }

  // Home-class is both directions: inside the substrate directory, and any
  // ancestor that CONTAINS it. An ancestor is governed because writes there
  // reach the credential store and the database by descent.
  const troth = realOrNull(trothDir()) || path.resolve(trothDir());
  if (under(real, troth) || under(troth, real)) {
    return { ground: 'home', root: real };
  }

  const sessionRoot = opts.sessionRoot ? realOrNull(opts.sessionRoot) : null;
  if (sessionRoot !== null && under(real, sessionRoot)
      && !under(sessionRoot, troth) && !under(troth, sessionRoot)) {
    return { ground: 'opened', root: sessionRoot, via: 'session' };
  }

  const registry = Array.isArray(opts.opened) ? opts.opened : openedFolders();
  for (const folder of registry) {
    const realFolder = realOrNull(folder);
    if (realFolder !== null && under(real, realFolder)) {
      return { ground: 'opened', root: realFolder, via: 'registry' };
    }
  }

  const root = projectRootOf(real, troth) || real;
  const linked = linkedRepoDirOf(root, troth);
  return { ground: 'unopened', root, cwd: real,
           alsoWritable: linked ? [linked] : [] };
}

// Writer side: strict, mirroring the config file's single-writer rules. A
// file that exists but does not parse REFUSES the write — overwriting it
// would erase every folder it holds, and "start from empty" is only correct
// when there is no file at all.
function readForWrite() {
  const p = registryPath();
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { folders: [] };
    throw new Error('opened_folders_read_failed: ' + p + ': ' + (e && e.message));
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    throw new Error(
      'opened_folders_corrupt_refusing_write: ' + p + ' is not valid JSON (' +
      (e && e.message) + '). Overwriting it would erase every folder in it; ' +
      'inspect and fix the file (or delete it to start fresh), then retry.');
  }
  if (Array.isArray(parsed)) return { folders: parsed };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.folders)) {
    throw new Error('opened_folders_corrupt_refusing_write: ' + p
                    + ' has no folders array');
  }
  return parsed;
}

// Same-directory temp plus rename, so a crash mid-write cannot leave a torn
// half-file for the strict reader above to trip on. The file can decide where
// work runs unconfined, so it is owner-only.
function writeRegistry(next) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  return next;
}

// The operator road. Every refusal is returned rather than thrown, because
// the caller is a command-line surface that has to print a reason.
//
// The folder is classified with NO opens in scope: the question is what this
// folder is on its own, not whether some earlier entry already covers it.
// Workspace ground and home-class ground are refused outright — the first
// would hand foreign code the operator's own environment, the second would
// grant the tree holding the credential store.
function openFolder(dir) {
  if (typeof dir !== 'string' || !dir.length) {
    return { ok: false, error: 'no directory given' };
  }
  const real = realOrNull(dir);
  if (real === null) {
    return { ok: false, error: 'no such directory: ' + dir };
  }
  try {
    if (!fs.statSync(real).isDirectory()) {
      return { ok: false, error: 'not a directory: ' + real };
    }
  } catch (e) {
    return { ok: false, error: 'unreadable: ' + real };
  }

  const c = classifyGround(real, { opened: [] });
  if (c.ground === 'workspace' || c.ground === 'project') {
    return { ok: false, error: 'refused: ' + real + ' is partner project ground '
             + '(under ' + workspaceRoot() + '); opening it would hand foreign '
             + 'code the operator\'s own walls' };
  }
  if (c.ground === 'home') {
    return { ok: false, error: 'refused: ' + real + ' holds or contains the '
             + 'substrate directory (' + trothDir() + '); it cannot be opened '
             + 'as a project' };
  }
  if (c.ground === 'escape') {
    return { ok: false, error: 'refused: ' + (c.reason || 'unresolvable path') };
  }

  try {
    const reg = readForWrite();
    // Stored resolved, and compared resolved, so the same folder reached by a
    // different spelling is one entry rather than two.
    const already = reg.folders.some((f) => normalizeEntry(f) === real);
    if (already) return { ok: true, path: real, added: false };
    reg.folders.push({ path: real, opened_at: new Date().toISOString() });
    writeRegistry(reg);
    return { ok: true, path: real, added: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Removal matches on both spellings: an entry written before a directory was
// moved behind a link is still the entry the operator means to withdraw, and
// a folder that no longer resolves must still be closable.
function closeFolder(dir) {
  if (typeof dir !== 'string' || !dir.length) {
    return { ok: false, error: 'no directory given' };
  }
  const asked = path.resolve(dir);
  const real  = realOrNull(dir);
  try {
    const reg = readForWrite();
    const before = reg.folders.length;
    reg.folders = reg.folders.filter((f) => {
      const p = normalizeEntry(f);
      return p !== asked && (real === null || p !== real);
    });
    if (reg.folders.length === before) {
      return { ok: true, path: real || asked, removed: false };
    }
    writeRegistry(reg);
    return { ok: true, path: real || asked, removed: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// The nearest project of a directory, by the same walk the classifier uses
// (nearest repository, else nearest manifest, bounded away from the
// substrate tree). Null when nothing above the directory marks a project.
function projectRoot(dir) {
  const real = realOrNull(dir);
  if (real === null) return null;
  const troth = realOrNull(trothDir()) || trothDir();
  return projectRootOf(real, troth);
}

module.exports = {
  classifyGround,
  openedFolders,
  openFolder,
  closeFolder,
  registryPath,
  workspaceRoot,
  trothDir,
  projectRoot,
  _readForWrite: readForWrite
};
