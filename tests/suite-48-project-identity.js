// SPDX-License-Identifier: AGPL-3.0-only
// A project is not a folder.
//
// Six places in this tree name a per-project store by sha256 of the DIRECTORY
// PATH. That convention has three consequences, all measured on a real
// machine on 2026-08-12:
//
//   MOVED. troth-core lived at ~/Documents/troth-core-bootstrap and now lives
//   at ~/Documents/troth-files/current/troth-core-bootstrap. Two paths, two
//   store keys, so the index and every learning store started again from
//   empty. Nothing pointed at the old ones afterwards.
//
//   SPLIT. The same code shipped inside troth.app is a third and fourth
//   "project" (…/Resources/core and …/core/proxy each got their own store).
//
//   HOME. A proxy started from inside a .app bundle substitutes the operator's
//   home directory for the project directory — correct for "where do I keep
//   state", wrong for "which codebase is this" — and the indexer took it
//   literally: 201 MB of index over Downloads, Library, Desktop, browser
//   profiles and a 12 GB backup, on the machine of anyone running the app.
//
// The resolver for this already exists and is already correct:
// shared-core/project-id.js resolves a declared id, then a git root, and
// refuses home outright. Nothing in the store-keying path asks it.
//
// These tests pin the two properties that must hold, and the one that must
// NOT change: a scratch directory under /tmp still gets its own isolated
// store, because the whole test suite runs on a hermetic HOME there and a
// shared key would have every suite writing into one another's stores.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const pid = require(path.join(ROOT, 'shared-core', 'project-id.js'));

console.log('\nProject identity (PROJ):');

test('PROJ-1: one project keeps one store key when its folder moves', () => {
  // Both paths are the same repository — same git root basename, and the
  // declared-id rule would give the same answer too. A store key derived from
  // identity is stable across the move; one derived from the path is not.
  const before = '/somewhere/Documents/troth-core-bootstrap';
  const after  = '/somewhere/Documents/troth-files/current/troth-core-bootstrap';
  assert.strictEqual(typeof pid.projectKeyFor, 'function',
    'project-id owns the store key — six files currently each hash the path themselves');
  assert.strictEqual(pid.projectKeyFor(before), pid.projectKeyFor(after),
    'moving the folder must not orphan the index');
});

test('PROJ-2: two different projects never collide', () => {
  const a = '/somewhere/Documents/troth-core-bootstrap';
  const b = '/somewhere/Documents/some-other-repo';
  assert.notStrictEqual(pid.projectKeyFor(a), pid.projectKeyFor(b),
    'distinct projects keep distinct stores');
});

test('PROJ-3: a scratch directory still gets its own store (test isolation)', () => {
  // Two throwaway HOMEs are both called "repo" at the end. Keyed by identity
  // alone they would share one store and every suite would read the next
  // one's rows, so the key falls back to the path under a temp root.
  //
  // It cannot lean on resolveProjectId's __ephemeral__ answer to detect that.
  // _isEphemeralCwd tests for /tmp and /private/tmp, and os.tmpdir() on macOS
  // is /var/folders/<...>/T — which it does not match, so every hermetic test
  // HOME resolves to a basename instead. That gap is real and separate; this
  // key does its own scratch check so it holds on both platforms.
  const t1 = path.join(os.tmpdir(), 'troth-test-home-aaa', 'repo');
  const t2 = path.join(os.tmpdir(), 'troth-test-home-bbb', 'repo');
  assert.notStrictEqual(pid.projectKeyFor(t1), pid.projectKeyFor(t2),
    'two scratch dirs under os.tmpdir() must not share a store');
  assert.notStrictEqual(pid.projectKeyFor('/tmp/a/repo'), pid.projectKeyFor('/tmp/b/repo'),
    'and the same under a literal /tmp, which is what Linux uses');
});

test('PROJ-4: home, its containers and app bundles are not indexable roots', () => {
  assert.strictEqual(typeof pid.isIndexableRoot, 'function',
    'the indexer needs one predicate to ask before walking a tree');
  const home = os.homedir();
  const refuse = [
    home,
    path.dirname(home),
    '/',
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    '/Applications/troth.app/Contents/Resources/core',
    '/Applications/troth.app/Contents/Resources/core/proxy'
  ];
  for (const d of refuse) {
    assert.strictEqual(pid.isIndexableRoot(d), false, 'must refuse to index: ' + d);
  }
});

test('PROJ-5: a real project directory is still indexable', () => {
  // The guard must not be so broad that it disables the feature. This
  // checkout, and an ordinary scratch repo, both remain indexable — the
  // second because the suite indexes throwaway trees under /tmp.
  assert.strictEqual(pid.isIndexableRoot(ROOT), true, 'this repository indexes');
  assert.strictEqual(pid.isIndexableRoot(path.join(os.tmpdir(), 'proj-xyz')), true,
    'a scratch project under /tmp indexes, or the codelens suites test nothing');
});

test('PROJ-6: every store-keying site uses the one function (source pin)', () => {
  // Six files carried their own copy of "sha256 of the directory, first 12
  // chars". A change to the convention in five of six silently divorces the
  // reader from the writer: the index is written under one name and looked up
  // under another, and the only symptom is an empty answer. They now ask for a
  // PATH rather than a key, so the adoption of an older key happens once, in
  // one place, for all of them.
  const fs = require('fs');
  //
  // The edit hook reaches the store one step removed — it asks code-graph for
  // the entities behind a file, and code-graph names the store. That
  // indirection exists because troth's own hashline tool records edits too and
  // needs the identical answer; the pin follows the call rather than loosening.
  const sites = [
    ['proxy/modules/codelens/index.js', 'the indexer that writes the store'],
    ['shared-core/code-graph.js',       'the tools that read it']
  ];
  for (const [rel, why] of sites) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/projectStorePath/.test(src), rel + ' asks project-id for the path (' + why + ')');
    assert.ok(!/createHash\('sha256'\)[\s\S]{0,80}(update\((dir|watchDir|target)\)|GF_WATCH_DIR)/.test(src),
      rel + ' no longer hashes the raw directory itself');
  }
  for (const rel of ['plugin/hooks/mark-edit.mjs', 'plugin/mcp-servers/troth-hashline/server.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/entitiesForFile/.test(src), rel + ' reaches the store through code-graph');
    assert.ok(!/createHash\('sha256'\)[\s\S]{0,80}(update\((dir|watchDir|target)\)|GF_WATCH_DIR)/.test(src),
      rel + ' does not hash a directory itself');
  }
});

// ── Identity that survives a rename ──────────────────────────────────────────
//
// Keying on the git root's NAME fixed the move and left the rename: call the
// folder something else and the project became a different project again.
//
// A repository already carries an identity that no filesystem operation can
// touch — the hash of its first commit. It survives moving, renaming, and
// being cloned somewhere else entirely, and it costs one git call that is
// cached like every other answer here.
//
// The alternative was writing a declaration file into the operator's own
// repository the first time troth saw it. That is the same class of act that
// broke the application bundle's signature once already — putting a file in a
// directory that belongs to somebody else — and it would appear unannounced in
// every user's `git status`. troth reads `.troth/project.json` when the
// operator writes one, and never writes it.
const cp = require('child_process');
const fs2 = require('fs');

let _gitOk = true;
const gitEnv = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'suite', GIT_AUTHOR_EMAIL: 'suite@invalid',
  GIT_COMMITTER_NAME: 'suite', GIT_COMMITTER_EMAIL: 'suite@invalid'
});
function mkRepo(name, opts) {
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'proj-' + name + '-'));
  try {
    cp.execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    if (!(opts && opts.empty)) {
      fs2.writeFileSync(path.join(dir, 'a.txt'), name + '\n');
      cp.execFileSync('git', ['add', 'a.txt'], { cwd: dir, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
      cp.execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: dir, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    }
  } catch (_) { _gitOk = false; }
  return dir;
}

test('PROJ-7: renaming the folder keeps the same store key', () => {
  const dir = mkRepo('rename');
  if (!_gitOk) return;   // no git on this machine — nothing to assert
  const before = pid.projectKeyFor(dir);
  const renamed = path.join(path.dirname(dir), path.basename(dir) + '-called-something-else');
  fs2.renameSync(dir, renamed);
  pid._clearCache();
  assert.strictEqual(pid.projectKeyFor(renamed), before,
    'the same repository under a new name is the same project');
});

test('PROJ-8: two different repositories never share a key', () => {
  const a = mkRepo('alpha');
  const b = mkRepo('beta');
  if (!_gitOk) return;
  assert.notStrictEqual(pid.projectKeyFor(a), pid.projectKeyFor(b),
    'distinct repositories, distinct stores');
});

test('PROJ-9: a repository with no commits yet still gets an isolated key', () => {
  // git init and nothing else: there is no first commit to hash. It must not
  // throw, and two such directories must not collide.
  const a = mkRepo('unborn-a', { empty: true });
  const b = mkRepo('unborn-b', { empty: true });
  if (!_gitOk) return;
  assert.strictEqual(typeof pid.projectKeyFor(a), 'string');
  assert.notStrictEqual(pid.projectKeyFor(a), pid.projectKeyFor(b),
    'an unborn repository falls back without colliding');
});

test('PROJ-10: a declaration the operator writes wins, and joins two folders into one project', () => {
  // The only way two DIFFERENT repositories become one project: the operator
  // says so. Same declared id in both, one store.
  const a = mkRepo('joined-a');
  const b = mkRepo('joined-b');
  if (!_gitOk) return;
  assert.notStrictEqual(pid.projectKeyFor(a), pid.projectKeyFor(b), 'precondition: separate by default');
  for (const d of [a, b]) {
    fs2.mkdirSync(path.join(d, '.troth'), { recursive: true });
    fs2.writeFileSync(path.join(d, '.troth', 'project.json'), JSON.stringify({ id: 'one-product-x9' }));
  }
  pid._clearCache();
  assert.strictEqual(pid.projectKeyFor(a), pid.projectKeyFor(b),
    'a declared id makes two locations one project');
});

test('PROJ-11: troth never writes the declaration itself (source pin)', () => {
  // Reading it is the operator's choice; writing it would put an unrequested
  // file in their repository and in their git status.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
      const src = fs2.readFileSync(p, 'utf8');
      if (/(writeFile|writeFileSync|appendFile)[^\n]{0,120}project\.json/.test(src)) offenders.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(offenders, [], 'nothing writes .troth/project.json');
});

test('PROJ-12: memory scoping is untouched by all of this', () => {
  // resolveProjectId answers a different question — which project a MEMORY
  // belongs to — and hundreds of thousands of records are already scoped by
  // its answer. Changing it would orphan them. The store key moved; this did
  // not.
  const dir = mkRepo('scoping');
  if (!_gitOk) return;
  assert.strictEqual(pid.resolveProjectId(dir), path.basename(dir),
    'still the human-readable name, exactly as the engrams were written with');
});

// ── Carrying the existing store across the change ────────────────────────
//
// Renaming what a store is called, with nothing that carries the old one over,
// is not a fix — it is the same loss the fix was written to prevent, arriving
// on the operator's first run of the new version instead of when they moved a
// folder. Measured on one machine before this existed: the key the new rule
// produced named no file at all, while a 16.9 MB index of 1,042 files sat
// under the old one and a second index sat under a third, because the proxy
// had once been started from a subdirectory.
//
// Nothing is copied and nothing is deleted: the file is renamed once, on the
// first open, and only when the new name is free.
const crypto2 = require('crypto');
const oldKeyOf = (p) => crypto2.createHash('sha256').update(p).digest('hex').slice(0, 12);

function seedStore(relPath, rows) {
  const full = path.join(process.env.HOME, '.troth', relPath);
  fs2.mkdirSync(path.dirname(full), { recursive: true });
  fs2.writeFileSync(full, rows);
  return full;
}

test('PROJ-13: a store under the old key is adopted, not abandoned', () => {
  const dir = mkRepo('adopt');
  if (!_gitOk) return;
  const legacy = seedStore('codelens/' + oldKeyOf(path.resolve(dir)) + '.db', 'INDEX-OF-1042-FILES');
  pid._clearCache();

  const resolved = pid.projectStorePath(dir, 'codelens/{key}.db');

  assert.strictEqual(path.basename(resolved), pid.projectKeyFor(dir) + '.db',
    'the answer is the NEW name — identity, not path');
  assert.strictEqual(fs2.readFileSync(resolved, 'utf8'), 'INDEX-OF-1042-FILES',
    'and the existing index is what is behind it');
  assert.strictEqual(fs2.existsSync(legacy), false, 'moved, not copied — no second index on disk');
});

test('PROJ-14: a store already under the new key is never overwritten', () => {
  const dir = mkRepo('nooverwrite');
  if (!_gitOk) return;
  const current = seedStore('codelens/' + pid.projectKeyFor(dir) + '.db', 'THE-LIVE-INDEX');
  const legacy  = seedStore('codelens/' + oldKeyOf(path.resolve(dir)) + '.db', 'AN-OLDER-INDEX');
  pid._clearCache();

  const resolved = pid.projectStorePath(dir, 'codelens/{key}.db');

  assert.strictEqual(resolved, current, 'the live store is the answer');
  assert.strictEqual(fs2.readFileSync(current, 'utf8'), 'THE-LIVE-INDEX', 'and it is untouched');
  assert.strictEqual(fs2.existsSync(legacy), true, 'the older one is left alone rather than deleted');
});

test('PROJ-15: the write-ahead log travels with the store', () => {
  // A SQLite database in WAL mode keeps committed rows in the -wal file until
  // a checkpoint folds them in. Move the .db alone and the newest work is
  // precisely what is lost — the worst possible half of the data to drop.
  const dir = mkRepo('wal');
  if (!_gitOk) return;
  const base = 'codelens/' + oldKeyOf(path.resolve(dir)) + '.db';
  seedStore(base, 'MAIN');
  seedStore(base + '-wal', 'RECENT-COMMITS');
  seedStore(base + '-shm', 'SHM');
  pid._clearCache();

  const resolved = pid.projectStorePath(dir, 'codelens/{key}.db');

  assert.strictEqual(fs2.readFileSync(resolved + '-wal', 'utf8'), 'RECENT-COMMITS',
    'the recent commits came too');
  assert.strictEqual(fs2.existsSync(resolved + '-shm'), true, 'and the shared-memory index with them');
});

test('PROJ-16: a store keyed to the repository ROOT is found from a subdirectory', () => {
  // The case that produced two indexes for one project: a proxy started at the
  // repository root and a proxy started in proxy/ hashed different paths. From
  // inside the subdirectory, the root's store must still be the one adopted.
  const dir = mkRepo('subdir');
  if (!_gitOk) return;
  const sub = path.join(dir, 'proxy');
  fs2.mkdirSync(sub, { recursive: true });
  seedStore('codelens/' + oldKeyOf(path.resolve(dir)) + '.db', 'ROOT-INDEX');
  pid._clearCache();

  const resolved = pid.projectStorePath(sub, 'codelens/{key}.db');

  assert.strictEqual(fs2.readFileSync(resolved, 'utf8'), 'ROOT-INDEX',
    'one project, one index, whichever directory the process was started in');
});

test('PROJ-17: a project with no store yet simply gets its path', () => {
  const dir = mkRepo('fresh');
  if (!_gitOk) return;
  pid._clearCache();
  const resolved = pid.projectStorePath(dir, 'trajectories-{key}.db');
  assert.ok(resolved.endsWith('trajectories-' + pid.projectKeyFor(dir) + '.db'),
    'the new name: ' + resolved);
  assert.strictEqual(fs2.existsSync(resolved), false,
    'resolving a path must not create a file — the store opens itself');
});

test('PROJ-18: home keeps the name it already had', () => {
  // Home is not a project, and its key comes out the same under both rules, so
  // there is nothing to adopt and nothing must move. A migration that starts
  // shuffling the largest store on the machine has misunderstood its job.
  const home = process.env.HOME;
  pid._clearCache();
  assert.strictEqual(pid.projectKeyFor(home), oldKeyOf(path.resolve(home)),
    'same key before and after');
  const legacies = pid.legacyKeysFor(home);
  assert.ok(legacies.every((k) => k === pid.projectKeyFor(home)),
    'so no other key is even considered: ' + JSON.stringify(legacies));
});

// ── Which directory the indexer is actually pointed at ─────────────────────
//
// The store carries over, and then the next start throws it away: the indexer
// walks the directory the process was launched from and removes every row
// outside it. Launched from a subdirectory, one project's index went from
// 8,303 entries to 1,040 in a single restart — with a path-shaped key that
// only ever built a second store, so the loss arrived with the identity key
// rather than being caused by it.

test('PROJ-19: from inside a repository, the project is the repository', () => {
  const dir = mkRepo('rootfor');
  if (!_gitOk) return;
  const deep = path.join(dir, 'proxy', 'modules');
  fs2.mkdirSync(deep, { recursive: true });
  assert.strictEqual(pid.projectRootFor(deep), path.resolve(dir),
    'a proxy started three levels down still indexes the whole project');
  assert.strictEqual(pid.projectRootFor(dir), path.resolve(dir),
    'and started at the root, nothing changes');
});

test('PROJ-20: a directory outside any repository is left exactly where it is', () => {
  const plain = fs2.mkdtempSync(path.join(os.tmpdir(), 'proj-norepo-'));
  assert.strictEqual(pid.projectRootFor(plain), path.resolve(plain),
    'no repository, no correction');
});

test('PROJ-21: it never climbs out into somewhere that must not be walked', () => {
  // A repository whose root is an application bundle is the case that already
  // wrote into a signed bundle once. Correcting upward into it would undo the
  // guard rather than use it.
  const bundle = path.join(fs2.mkdtempSync(path.join(os.tmpdir(), 'proj-bundle-')), 'Some.app');
  const inner = path.join(bundle, 'Contents', 'Resources', 'core');
  fs2.mkdirSync(inner, { recursive: true });
  fs2.mkdirSync(path.join(bundle, '.git'), { recursive: true });
  assert.strictEqual(pid.projectRootFor(inner), path.resolve(inner),
    'the guard wins over the correction');
});

test('PROJ-22: the proxy applies it before anything reads the watch dir (source pin)', () => {
  // Eight modules read GF_WATCH_DIR || cwd at load. The correction is only
  // worth anything if it lands before the first of them, and it must not
  // overrule an operator who named the directory themselves.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const head = src.slice(0, src.indexOf('const WATCH_DIR'));
  assert.ok(head.indexOf('projectRootFor') !== -1,
    'the correction happens above the line that reads the watch dir');
  assert.ok(/if \(!process\.env\.GF_WATCH_DIR\)/.test(head),
    'and only when the operator has not answered the question already');
});

// ── The reader stands somewhere else than the writer ──────────────────────
//
// The proxy is not the only process asking which project this is. Hooks run in
// their own process, started wherever the operator's session was, and a fresh
// terminal starts in home. Measured: with a session rooted at home, the edit
// hook resolved a home-wide index while the indexer wrote the project's own,
// and that home index did not contain a symbol added to the project the same
// morning — nor can it ever, since home is no longer walked.
//
// A hook editing a file does not have to guess. The file says which project
// this is.

test('PROJ-23: the project comes from the file being edited, not from where the session started', () => {
  const dir = mkRepo('reader');
  if (!_gitOk) return;
  const deep = path.join(dir, 'shared-core');
  fs2.mkdirSync(deep, { recursive: true });
  const file = path.join(deep, 'thing.js');
  fs2.writeFileSync(file, '// x\n');
  pid._clearCache();

  const fromElsewhere = pid.projectDirForFile(file, process.env.HOME);

  assert.strictEqual(fromElsewhere, path.resolve(dir),
    'the edited file names its own project');
  assert.strictEqual(pid.projectKeyFor(fromElsewhere), pid.projectKeyFor(dir),
    'so the hook reads exactly the store the indexer writes');
});

test('PROJ-24: a file outside any repository falls back instead of minting a store', () => {
  const loose = path.join(fs2.mkdtempSync(path.join(os.tmpdir(), 'proj-loose-')), 'a.js');
  fs2.writeFileSync(loose, '// x\n');
  const fallback = path.join(os.tmpdir(), 'somewhere-else');
  assert.strictEqual(pid.projectDirForFile(loose, fallback), fallback,
    'one loose file is not a project');
  assert.strictEqual(pid.projectDirForFile('', fallback), fallback,
    'and no file at all is not one either');
});

test('PROJ-25: an edit is attributed by its file, not by the caller\'s cwd (source pin)', () => {
  const fs = require('fs');
  // Both writers of an edit record hand over the file and nothing else; the
  // decision itself is made once, in code-graph.
  for (const rel of ['plugin/hooks/mark-edit.mjs', 'plugin/mcp-servers/troth-hashline/server.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/entitiesForFile\(\s*abs/.test(src),
      rel + ' passes the absolute path of the edited file');
  }
  const cg = fs.readFileSync(path.join(ROOT, 'shared-core', 'code-graph.js'), 'utf8');
  assert.ok(/projectDirForFile/.test(cg),
    'and code-graph derives the project from that file');
  assert.ok(/projectStorePath/.test(cg),
    'then names the store with the same call the indexer uses');
});

// ── Throwaway directories, on the platform that ships ────────────────────
//
// The "never anchor a project to a scratch directory" guard listed /tmp and
// /private/tmp, which is every throwaway root except the one macOS uses:
// os.tmpdir() there is /var/folders/<…>/T. The guard was inert on the shipping
// platform, and a scratch directory resolved to its own basename — 'T', or
// whatever sat beneath it.
//
// Widening the list alone would have taken the name away from every checkout
// under a temp root: a runner's workspace, a worktree parked in scratch. So
// the repository is asked about first, for the same reason a written
// declaration already was — the shape of a path is the weakest signal here and
// it was overruling the strongest.
//
// Measured before changing it: zero records in the live substrate carried a
// temp-shaped project id, so no existing scoping moves.

test('PROJ-26: a throwaway directory anchors nothing, on this platform too', () => {
  const scratch = fs2.mkdtempSync(path.join(os.tmpdir(), 'proj-scratch-'));
  pid._clearCache();
  assert.strictEqual(pid.resolveProjectId(scratch), '__ephemeral__',
    'os.tmpdir() is a throwaway root wherever the platform puts it');
  assert.strictEqual(pid.resolveProjectId('/tmp/nothing-here'), '__ephemeral__',
    'and the roots it already knew still count');
});

test('PROJ-27: a repository under a throwaway root keeps its name', () => {
  // The regression the widening would have caused. A checkout is a project
  // wherever somebody put it.
  const repo = mkRepo('under-temp');
  if (!_gitOk) return;
  pid._clearCache();
  assert.strictEqual(pid.resolveProjectId(repo), path.basename(repo),
    'the repository is named, not erased');
});

test('PROJ-28: a build machine is nobody\'s project, whatever it checked out', () => {
  const repo = mkRepo('on-ci');
  if (!_gitOk) return;
  const prev = process.env.CI;
  try {
    process.env.CI = 'true';
    pid._clearCache();
    assert.strictEqual(pid.resolveProjectId(repo), '__ephemeral__',
      'CI is answered before the repository, deliberately');
  } finally {
    if (prev === undefined) delete process.env.CI; else process.env.CI = prev;
    pid._clearCache();
  }
});
};
