// SPDX-License-Identifier: AGPL-3.0-only
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const gp = require(path.join(__dirname, '..', 'shared-core', 'tools', 'ground-policy.js'));

console.log('\nGround policy (GP-1..13):');

function withHome(fn) {
  const savedHome = process.env.HOME;
  const savedDir  = process.env.TROTH_CONFIG_DIR;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-')));
  process.env.HOME = home;
  delete process.env.TROTH_CONFIG_DIR;
  try {
    return fn(home);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.TROTH_CONFIG_DIR; else process.env.TROTH_CONFIG_DIR = savedDir;
  }
}

function mk(...parts) {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

test('GP-1: every ground is named, and jail ground is scoped to the project', () => {
  withHome((home) => {
    const wsRoot  = mk(home, '.troth', 'workspace');
    const project = mk(wsRoot, 'app');
    const deep    = mk(project, 'src', 'lib');
    const mine    = mk(home, 'code', 'myrepo');
    const other   = mk(home, 'code', 'somewhere-else');

    assert.strictEqual(gp.classifyGround(wsRoot).ground, 'workspace');
    assert.strictEqual(gp.classifyGround(project).ground, 'project');

    const d = gp.classifyGround(deep);
    assert.strictEqual(d.ground, 'project');
    assert.strictEqual(d.jail, project, 'a subdirectory must not narrow the jail');

    assert.strictEqual(gp.classifyGround(home).ground, 'home');
    assert.strictEqual(gp.classifyGround(path.join(home, '.troth')).ground, 'home');

    assert.strictEqual(gp.classifyGround(other).ground, 'unopened');

    const opened = gp.classifyGround(mine, { opened: [mine] });
    assert.strictEqual(opened.ground, 'opened');
    assert.strictEqual(opened.root, mine);
  });
});

test('GP-2: a path that claims the workspace but lands outside is escape, never quietly bare', () => {
  withHome((home) => {
    const wsRoot  = mk(home, '.troth', 'workspace');
    const outside = mk(home, 'elsewhere');
    fs.symlinkSync(outside, path.join(wsRoot, 'sneaky'));

    const esc = gp.classifyGround(path.join(wsRoot, 'sneaky'));
    assert.strictEqual(esc.ground, 'escape');
    assert.ok(esc.reason, 'an escape must say why');

    assert.strictEqual(gp.classifyGround(path.join(wsRoot, 'nope', 'deeper')).ground, 'escape');
    assert.strictEqual(gp.classifyGround(path.join(home, 'not-there')).ground, 'escape');
    assert.strictEqual(gp.classifyGround('').ground, 'escape');
  });
});

test('GP-3: ground is decided on a path boundary, not a string prefix', () => {
  withHome((home) => {
    const wsRoot = mk(home, '.troth', 'workspace');
    const sibling = mk(home, '.troth', 'workspace-evil');
    assert.strictEqual(gp.classifyGround(sibling).ground, 'home',
      'a name sharing the workspace prefix must not be workspace ground');
    assert.strictEqual(gp.classifyGround(wsRoot).ground, 'workspace');

    const mine = mk(home, 'code', 'app');
    const near = mk(home, 'code', 'app-evil');
    assert.strictEqual(gp.classifyGround(near, { opened: [mine] }).ground, 'unopened',
      'a name sharing an opened prefix must not inherit the open');
  });
});

test('GP-4: the registry cannot grant the ground that holds the substrate', () => {
  withHome((home) => {
    mk(home, '.troth', 'workspace');
    const inside = mk(home, '.troth', 'chains');
    const parent = path.dirname(home);

    for (const claim of [home, path.join(home, '.troth'), inside, parent]) {
      const c = gp.classifyGround(claim, { opened: [home, path.join(home, '.troth'), inside, parent] });
      assert.strictEqual(c.ground, 'home',
        'registry entry overrode home-class ground for: ' + claim);
    }
  });
});

test('GP-5: workspace ground outranks an open, so foreign code never inherits operator walls', () => {
  withHome((home) => {
    const wsRoot  = mk(home, '.troth', 'workspace');
    const project = mk(wsRoot, 'downloaded');
    const c = gp.classifyGround(project, { opened: [wsRoot, project] });
    assert.strictEqual(c.ground, 'project', 'an open must not un-jail workspace ground');
    assert.strictEqual(c.jail, project);
  });
});

test('GP-6: an unreadable or corrupt registry reads as empty, which confines rather than opens', () => {
  withHome((home) => {
    const mine = mk(home, 'code', 'app');
    mk(home, '.troth');
    fs.writeFileSync(gp.registryPath(), '{ this is not json');
    assert.deepStrictEqual(gp.openedFolders(), [], 'a corrupt registry must read as empty');
    assert.strictEqual(gp.classifyGround(mine).ground, 'unopened',
      'a corrupt registry must fail toward confinement, not toward opening');

    fs.writeFileSync(gp.registryPath(), JSON.stringify({ folders: ['relative/path', 42, null] }));
    assert.deepStrictEqual(gp.openedFolders(), [], 'entries that are not absolute paths are dropped');
  });
});

test('GP-7: the write road refuses the grounds an open must never reach', () => {
  withHome((home) => {
    const wsRoot  = mk(home, '.troth', 'workspace');
    const project = mk(wsRoot, 'app');

    for (const target of [wsRoot, project, home, path.join(home, '.troth')]) {
      const r = gp.openFolder(target);
      assert.strictEqual(r.ok, false, 'open must refuse: ' + target);
      assert.ok(/refused/.test(r.error), 'the refusal must say so: ' + r.error);
    }
    assert.strictEqual(gp.openFolder(path.join(home, 'not-there')).ok, false);
    assert.strictEqual(fs.existsSync(gp.registryPath()), false,
      'a refused open must not create the registry');
  });
});

test('GP-8: an open is recorded once, atomically, and readable back as ground', () => {
  withHome((home) => {
    const mine = mk(home, 'code', 'app');
    const deep = mk(mine, 'src');

    const first = gp.openFolder(mine);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.added, true);

    const mode = fs.statSync(gp.registryPath()).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'the registry must not be world-readable, got ' + mode.toString(8));

    const again = gp.openFolder(mine);
    assert.strictEqual(again.added, false, 'opening twice must not duplicate the entry');
    assert.strictEqual(gp.openedFolders().length, 1);

    assert.strictEqual(gp.classifyGround(deep).ground, 'opened',
      'a subdirectory of an opened folder is opened ground');
    assert.strictEqual(gp.classifyGround(deep).root, mine,
      'the open is scoped to the folder that was opened');

    const closed = gp.closeFolder(mine);
    assert.strictEqual(closed.removed, true);
    assert.strictEqual(gp.classifyGround(deep).ground, 'unopened',
      'a closed folder returns to confinement');
    assert.strictEqual(gp.closeFolder(mine).removed, false, 'closing twice is not an error');
  });
});

test('GP-9: a corrupt registry refuses the write instead of erasing what it holds', () => {
  withHome((home) => {
    const mine = mk(home, 'code', 'app');
    mk(home, '.troth');
    const corrupt = '{ "folders": [ truncated';
    fs.writeFileSync(gp.registryPath(), corrupt);

    const r = gp.openFolder(mine);
    assert.strictEqual(r.ok, false, 'a write over a corrupt registry must refuse');
    assert.ok(/corrupt_refusing_write/.test(r.error || ''), 'wrong error: ' + r.error);
    assert.strictEqual(fs.readFileSync(gp.registryPath(), 'utf8'), corrupt,
      'the corrupt file must be left exactly as found');
  });
});

test('GP-10: the session directory grants ground without writing anything to disk', () => {
  withHome((home) => {
    mk(home, '.troth');
    const started = mk(home, 'code', 'app');
    const deep    = mk(started, 'src');
    const other   = mk(home, 'code', 'other');

    const c = gp.classifyGround(deep, { sessionRoot: started });
    assert.strictEqual(c.ground, 'opened');
    assert.strictEqual(c.via, 'session');
    assert.strictEqual(c.root, started);

    assert.strictEqual(gp.classifyGround(other, { sessionRoot: started }).ground, 'unopened',
      'the session grant covers only the directory it started in');
    assert.strictEqual(fs.existsSync(gp.registryPath()), false,
      'a session grant must never write to the operator registry');

    assert.strictEqual(gp.classifyGround(home, { sessionRoot: home }).ground, 'home',
      'starting in a home-class directory must not open it');
    assert.strictEqual(gp.classifyGround(path.join(home, '.troth'), { sessionRoot: home }).ground, 'home');
  });
});

test('GP-11: undeclared ground is scoped to the project, not to the directory you happen to stand in', () => {
  withHome((home) => {
    mk(home, '.troth');
    const repo = mk(home, 'code', 'app');
    const deep = mk(repo, 'src', 'lib');
    fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');

    const c = gp.classifyGround(deep);
    assert.strictEqual(c.ground, 'unopened');
    assert.strictEqual(c.root, repo, 'the scope must be the project, or navigating it breaks');
    assert.strictEqual(c.cwd, deep, 'the directory actually stood in is still reported');

    // Nothing marks a project: the directory itself is the scope, which is
    // the right answer for a folder that is not one.
    const loose = mk(home, 'loose', 'folder');
    assert.strictEqual(gp.classifyGround(loose).root, loose);

    // The walk stops before it can swallow the ground holding the substrate:
    // a marker dropped in a home directory must not make the whole home one
    // project.
    fs.writeFileSync(path.join(home, 'package.json'), '{}\n');
    const orphan = mk(home, 'elsewhere');
    assert.strictEqual(gp.classifyGround(orphan).root, orphan,
      'the project walk climbed into home-class ground');
  });
});

test('GP-12: the repository is the unit, so a manifest at every level does not narrow the scope', () => {
  // A package manifest sits at every level of a monorepo, and a build step
  // drops one wherever it is run. Taking the nearest marker scopes the work
  // to a subdirectory and then refuses the sibling package, the top-level
  // manifest, and staging — the ordinary shape of working in a repository.
  withHome((home) => {
    mk(home, '.troth');
    const mono = mk(home, 'mono');
    const pkg  = mk(mono, 'packages', 'a');
    const deep = mk(pkg, 'src');
    mk(mono, '.git');
    fs.writeFileSync(path.join(mono, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}\n');

    assert.strictEqual(gp.classifyGround(deep).root, mono,
      'the scope narrowed to a package instead of the repository');

    // A manifest decides the root only when no repository stands above it.
    const loose = mk(home, 'loose', 'tool');
    fs.writeFileSync(path.join(loose, 'package.json'), '{}\n');
    assert.strictEqual(gp.classifyGround(path.join(loose)).root, loose);

    // A repository inside a repository still answers with the outer one: a
    // change in a vendored tree is usually committed from the project above.
    const sup = mk(home, 'super'); mk(sup, '.git');
    const inner = mk(sup, 'vendor', 'lib'); mk(inner, '.git');
    assert.strictEqual(gp.classifyGround(inner).root, sup);
  });
});

test('GP-13: a working tree whose repository lives elsewhere names that repository too', () => {
  // In a linked working tree .git is a FILE pointing into the main
  // repository, and committing writes there. Scoping to the tree alone
  // refuses every commit, naming a path the operator never mentioned.
  withHome((home) => {
    mk(home, '.troth');
    const main = mk(home, 'main');
    const repoDir = mk(main, '.git');
    mk(repoDir, 'worktrees', 'side');
    const tree = mk(home, 'side');
    fs.writeFileSync(path.join(tree, '.git'),
      'gitdir: ' + path.join(repoDir, 'worktrees', 'side') + '\n');

    const c = gp.classifyGround(tree);
    assert.strictEqual(c.root, tree, 'the working tree is still the scope');
    assert.deepStrictEqual(c.alsoWritable, [repoDir],
      'the repository directory must be named, and as the directory rather than the leaf inside it');

    // An ordinary repository keeps its objects inside the root already and
    // needs nothing extra.
    const plain = mk(home, 'plain'); mk(plain, '.git');
    assert.deepStrictEqual(gp.classifyGround(plain).alsoWritable, []);
  });
});
};
