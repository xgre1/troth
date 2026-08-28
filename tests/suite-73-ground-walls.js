// SPDX-License-Identifier: AGPL-3.0-only
// The walls for ground that is not a deny-default jail.
//
// A jail answers "nothing until it is named". These answer the opposite
// question — everything the operator already does, minus a short list — and
// the list is what these tests pin. They run against a throwaway substrate
// directory, so the credential stores under test are decoys and the real
// ones are never opened.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));

console.log('\nGround walls (SBG-1..13):');

function withTrothDir(fn) {
  const saved = process.env.TROTH_CONFIG_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sbg-')));
  const troth = path.join(root, '.troth');
  fs.mkdirSync(path.join(troth, 'workspace', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(troth, 'workspace', 'proj', 'staged.js'), 'console.log(1)\n');
  process.env.TROTH_CONFIG_DIR = troth;
  try {
    for (const p of sb._jewelPaths()) {
      if (path.basename(p) === 'audit-keys') fs.mkdirSync(p, { recursive: true });
      else fs.writeFileSync(p, 'decoy\n');
    }
    for (const p of sb._policyPaths()) fs.writeFileSync(p, '{}\n');
    return fn({ root, troth });
  } finally {
    if (saved === undefined) delete process.env.TROTH_CONFIG_DIR;
    else process.env.TROTH_CONFIG_DIR = saved;
  }
}

function runUnder(spec, cmd, cwd) {
  const r = spawnSync(spec.exec, spec.args.concat(['/bin/bash', '-lc', cmd]),
                      { cwd, env: spec.env, encoding: 'utf8', timeout: 60000 });
  return r.status;
}

test('SBG-1: the availability probe measures whether a RESTRICTION can be applied', () => {
  // A profile that restricts nothing applies even inside an existing sandbox,
  // where every real profile is refused by the kernel. Probing with one
  // reports a usable sandbox in the one environment that has none.
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'), 'utf8');
  const probe = src.match(/spawnSync\(SANDBOX_EXEC, \['-p',\s*\n\s*'([^']+)'/);
  assert.ok(probe, 'the availability probe is no longer a -p profile literal');
  assert.ok(/\(deny /.test(probe[1]), 'the probe profile carries no restriction: ' + probe[1]);
});

test('SBG-2: a restricting profile cannot be applied inside an existing sandbox, and an empty one can', () => {
  if (process.platform !== 'darwin') return skip('macOS-only');
  const plain = '(version 1)(allow default)';
  const restricting = '(version 1)(allow default)(deny file-read* (literal "/.troth-suite-probe"))';
  const nest = (inner) => spawnSync('/usr/bin/sandbox-exec',
    ['-p', plain, '/usr/bin/sandbox-exec', '-p', inner, '/usr/bin/true'],
    { encoding: 'utf8', timeout: 20000 }).status;
  assert.strictEqual(nest(plain), 0, 'an unrestricted profile should still nest');
  assert.notStrictEqual(nest(restricting), 0,
    'a restricting profile nested successfully — the probe above would then be measuring nothing');
});

test('SBG-3: paths reach the profile as parameters, never as text', () => {
  // A directory whose name carries a quote must not be able to rewrite the
  // policy, so the profile body names parameters only.
  for (const kind of ['thin', 'confine', 'home']) {
    const body = sb._groundProfile(kind, 4, 5, 6, 7, 2);
    assert.ok(!/[/](Users|home|tmp|private)/.test(body), kind + ' profile embeds a path: ' + body);
    assert.ok(/\(param "WORKSPACE"\)/.test(body), kind + ' profile does not deny partner ground');
  }

  // Every count is passed, because the rules that matter most are the ones
  // emitted LAST and an assertion that never asks for them cannot see their
  // order. Later rules win here, so each of these must come after every
  // allowance that could otherwise reopen it.
  const confined = sb._groundProfile('confine', 2, 2, 2, 2, 2);
  const at = (needle) => confined.indexOf(needle);
  const denyAll    = at('(deny file-write*)');
  const allowScr   = at('(allow file-write* (subpath (param "SCRATCH")))');
  const allowWork  = at('(allow file-write* (subpath (param "WORK")))');
  const allowExtra = at('(allow file-write* (subpath (param "EXTRA0")))');
  const allowCache = at('(allow file-write* (subpath (param "CACHE0")))');
  const denyPolicy = at('(deny file-write* (subpath (param "POLICY0")))');
  const denyPersist= at('(deny file-write* (subpath (param "PERSIST0")))');
  const denyJewelW = at('(deny file-write* (subpath (param "JEWEL0")))');
  const denyJewelR = at('(deny file-read* (subpath (param "JEWEL0")))');
  const hooks      = at('(deny file-write* (regex');

  for (const [name, idx] of [['blanket write deny', denyAll], ['scratch allow', allowScr],
                            ['work allow', allowWork], ['extra allow', allowExtra],
                            ['cache allow', allowCache], ['policy deny', denyPolicy],
                            ['persist deny', denyPersist], ['jewel write deny', denyJewelW],
                            ['jewel read deny', denyJewelR], ['hook rule', hooks]]) {
    assert.ok(idx > -1, 'the profile does not emit the ' + name + ' at all');
  }
  const lastAllow = Math.max(allowScr, allowWork, allowExtra, allowCache);
  assert.ok(lastAllow > denyAll, 'an allowance came before the blanket deny and does nothing');
  for (const [name, idx] of [['policy deny', denyPolicy], ['persist deny', denyPersist],
                            ['jewel write deny', denyJewelW], ['hook rule', hooks]]) {
    assert.ok(idx > lastAllow, name + ' is reopened by a later allowance');
  }
  // The read deny may sit early: only write allowances follow it, and they
  // are a different operation class.
  assert.ok(denyJewelR < denyAll, 'the read deny moved into the write section');

  assert.ok(sb._groundProfile('home', 1, 1, 1, 1, 0).indexOf('(param "WORK")') === -1,
    'home ground must have no writable work directory');
  assert.ok(sb._groundProfile('thin', 1, 1, 1, 1, 1).indexOf('(param "EXTRA0")') === -1,
    'ground that is not confined has nothing to reopen and must name no extra tree');
});

test('SBG-4: thin ground leaves the operator their own machine', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  withTrothDir(({ root }) => {
    const spec = sb.groundSpawnSpec({ kind: 'thin' });
    assert.ok(spec.ok, 'thin spec failed: ' + spec.error);
    assert.strictEqual(runUnder(spec, 'node -e "1"', root), 0, 'the toolchain must still run');
    assert.strictEqual(runUnder(spec, 'echo x > ordinary.txt', root), 0, 'ordinary writes must still land');
    assert.strictEqual(runUnder(spec, 'ls / >/dev/null', root), 0, 'reads must stay open');
  });
});

test('SBG-5: thin ground denies partner project ground, the credential stores, and the policy files', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  withTrothDir(({ root, troth }) => {
    const spec = sb.groundSpawnSpec({ kind: 'thin' });
    const staged = path.join(troth, 'workspace', 'proj', 'staged.js');

    // Reading is what is denied, not only executing: an interpreter defeats
    // an exec-only rule, since the interpreter is what runs and the staged
    // file is merely read.
    assert.notStrictEqual(runUnder(spec, 'cat ' + JSON.stringify(staged), root), 0,
      'partner ground was readable from operator ground');
    assert.notStrictEqual(runUnder(spec, 'node ' + JSON.stringify(staged), root), 0,
      'the interpreter road into partner ground is open');
    assert.notStrictEqual(runUnder(spec, 'cp ' + JSON.stringify(staged) + ' ' + JSON.stringify(path.join(root, 'out.js')), root), 0,
      'partner ground could be copied out without review');

    for (const jewel of sb._jewelPaths()) {
      if (!fs.existsSync(jewel) || fs.statSync(jewel).isDirectory()) continue;
      assert.notStrictEqual(runUnder(spec, 'head -c1 ' + JSON.stringify(jewel) + ' >/dev/null', root), 0,
        'a credential store was readable: ' + path.basename(jewel));
    }
    for (const policy of sb._policyPaths()) {
      assert.notStrictEqual(runUnder(spec, 'echo x >> ' + JSON.stringify(policy), root), 0,
        'a policy file was writable: ' + path.basename(policy));
    }
  });
});

test('SBG-6: confined ground scopes writes to the folder while reads stay open', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  withTrothDir(({ root }) => {
    const folder = path.join(root, 'unfamiliar');
    fs.mkdirSync(folder, { recursive: true });
    const spec = sb.groundSpawnSpec({ kind: 'confine', cwd: folder });
    assert.ok(spec.ok, 'confine spec failed: ' + spec.error);

    assert.strictEqual(runUnder(spec, 'echo x > inside.txt', folder), 0, 'writes inside the folder must work');
    assert.notStrictEqual(runUnder(spec, 'echo x > ' + JSON.stringify(path.join(root, 'outside.txt')), folder), 0,
      'a write escaped the folder');
    assert.strictEqual(runUnder(spec, 'ls ' + JSON.stringify(root) + ' >/dev/null', folder), 0,
      'reads must stay open, or exploring an unfamiliar tree breaks');
  });
});

test('SBG-7: the tree holding the substrate has no writable work directory', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  withTrothDir(({ root, troth }) => {
    const spec = sb.groundSpawnSpec({ kind: 'home', cwd: troth });
    assert.ok(spec.ok, 'home spec failed: ' + spec.error);
    assert.notStrictEqual(runUnder(spec, 'echo x > landed.txt', troth), 0,
      'a write landed in the substrate directory');
    assert.strictEqual(runUnder(spec, 'ls ' + JSON.stringify(troth) + ' >/dev/null', troth), 0,
      'reads must stay open here too');
    assert.ok(spec.scratch && spec.scratch.length, 'scratch is the only writable ground and must be named');
  });
});

test('SBG-8: the environment crossing into a partner shell carries no lowering switch', () => {
  withTrothDir(({ root }) => {
    const strip = sb.PARTNER_ENV_STRIP;
    assert.ok(Array.isArray(strip) && strip.length > 0, 'nothing is stripped from the partner environment');
    const saved = {};
    for (const k of strip) { saved[k] = process.env[k]; process.env[k] = '1'; }
    try {
      const env = sb.operatorEnv();
      for (const k of strip) {
        assert.ok(!Object.prototype.hasOwnProperty.call(env, k), k + ' crossed into the partner environment');
      }
      assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0,
        'operator ground keeps the operator environment — that is what makes it ordinary to work in');
    } finally {
      for (const k of strip) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
    const folder = path.join(root, 'confined');
    fs.mkdirSync(folder, { recursive: true });
    const spec = sb.groundSpawnSpec({ kind: 'confine', cwd: folder });
    if (spec.ok) {
      assert.strictEqual(String(spec.env.TMPDIR).indexOf(spec.scratch), 0,
        'confined ground must point the caches every toolchain writes at scratch');
    }
  });
});

test('SBG-9: the substrate database is walled on the tool and shell roads, not by a kernel rule here', () => {
  // Its contents are already refused twice over, each refusal naming the
  // sanctioned way in, and partner project ground cannot reach this directory
  // at all. A kernel rule here would instead break the operator running the
  // substrate's own tooling from their own checkout.
  const policy = require(path.join(__dirname, '..', 'shared-core', 'tools', 'path-policy.js'));
  const dbName = 'state' + '.db';
  assert.ok(!sb._jewelPaths().some((p) => path.basename(p) === dbName),
    'the database joined the kernel deny list without the sweep that decision needs');
  // Read off the policy's own list rather than rebuilt from HOME: that module
  // captures HOME at load and this harness repoints it partway through a run,
  // so a hand-built path would be measuring a different machine.
  const entry = policy.SECRET_READ_PREFIXES.find((e) => e.name === 'substrate_db');
  assert.ok(entry, 'the tool road no longer names the database at all');
  assert.strictEqual(policy.isReadablePath(entry.prefix, {}).allowed, false,
    'the tool road must still refuse it');
});

test('SBG-10: what the shell and the agent host execute at startup is not writable, however the write is spelled', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  const savedHome = process.env.HOME;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sbgp-')));
  process.env.HOME = home;
  try {
    withTrothDir(() => {
      fs.writeFileSync(path.join(home, '.zshrc'), 'original\n');
      fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
      const proj = path.join(home, 'work', 'repo');
      fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });

      for (const kind of ['thin', 'confine']) {
        const spec = sb.groundSpawnSpec({ kind, cwd: proj });
        assert.ok(spec.ok, kind + ' spec failed: ' + spec.error);
        const rc = path.join(home, '.zshrc');

        assert.notStrictEqual(runUnder(spec, 'echo evil >> ' + JSON.stringify(rc), proj), 0,
          kind + ': a shell startup file was writable');
        // The roads that judge command text cannot parse a filesystem call
        // carried inside an interpreter argument. A kernel rule does not read
        // the command at all.
        assert.notStrictEqual(runUnder(spec,
          'node -e ' + JSON.stringify('require("fs").appendFileSync(' + JSON.stringify(rc) + ', "x")'), proj), 0,
          kind + ': the interpreter road to a startup file is open');
        assert.notStrictEqual(runUnder(spec, 'echo x > ' + JSON.stringify(path.join(home, '.claude', 'hooks', 'h.sh')), proj), 0,
          kind + ': an agent-host hook was writable');
        assert.notStrictEqual(runUnder(spec, 'echo x > .git/hooks/pre-commit', proj), 0,
          kind + ': a repository hook was writable inside the writable project');

        // Zero tax: the deny is narrow enough that ordinary work in the same
        // directory is untouched, including the rest of the repository.
        assert.strictEqual(runUnder(spec, 'mkdir -p src && echo x > src/a.js', proj), 0,
          kind + ': ordinary work was refused');
        assert.strictEqual(runUnder(spec, 'echo x >> .git/config', proj), 0,
          kind + ': the deny is too wide, it caught ordinary repository files');
      }

      const jail = sb.jailSpawnSpec({ cwd: proj, network: 'none' });
      assert.ok(jail.ok, 'jail spec failed: ' + jail.error);
      const jspec = { exec: jail.exec, args: jail.args, env: jail.env };
      assert.notStrictEqual(runUnder(jspec, 'echo x > .git/hooks/pre-commit', proj), 0,
        'jail: a repository hook was writable inside the project');
      assert.strictEqual(runUnder(jspec, 'mkdir -p src && echo x > src/b.js', proj), 0,
        'jail: ordinary work was refused');

      assert.strictEqual(fs.readFileSync(path.join(home, '.zshrc'), 'utf8').trim(), 'original',
        'a startup file was modified');
      assert.strictEqual(fs.readdirSync(path.join(proj, '.git', 'hooks')).length, 0,
        'a repository hook landed');
      assert.strictEqual(fs.readdirSync(path.join(home, '.claude', 'hooks')).length, 0,
        'an agent-host hook landed');
    });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
});

test('SBG-11: every startup file walled here is also walled on the tool road', () => {
  // Two lists exist because this one must resolve HOME per call while the
  // policy freezes it at load. They may differ in shape; they must not differ
  // in what they cover, or one road quietly stops agreeing with the other.
  const policy = require(path.join(__dirname, '..', 'shared-core', 'tools', 'path-policy.js'));
  // Compared on the part below HOME, not on absolute paths: the two modules
  // resolve HOME at different moments by design, so an absolute comparison
  // measures when a module was required rather than what it covers.
  const blocked = policy.BLOCKED_PREFIXES.map((e) => e.prefix.replace(/\/$/, ''));
  for (const rel of sb.PERSISTENCE_RELATIVE) {
    assert.ok(blocked.some((p) => p.endsWith(path.sep + rel)),
      'the tool road does not refuse a startup file the kernel rule covers: ' + rel);
  }
  assert.ok(/\.git\/hooks/.test(sb.HOOK_DIR_RULE), 'the repository hook rule lost its target');
});

test('SBG-12: creating a repository still works on every ground, and a hook that would run still does not', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  // Creating a repository copies fourteen template files into the hook
  // directory and fails hard when refused, so the rule that protects the
  // directory has to let the templates through. Their .sample suffix is
  // exactly what stops them running: a hook is executed by exact name.
  withTrothDir(({ root }) => {
    const work = path.join(root, 'repowork');
    fs.mkdirSync(work, { recursive: true });
    for (const kind of ['thin', 'confine']) {
      const spec = sb.groundSpawnSpec({ kind, cwd: work });
      assert.ok(spec.ok, kind + ' spec failed: ' + spec.error);
      const name = 'r-' + kind;
      assert.strictEqual(runUnder(spec, 'git init -q ' + name, work), 0,
        kind + ': creating a repository was refused');
      assert.strictEqual(runUnder(spec,
        'cd ' + name + ' && echo x > z.txt && git add z.txt && '
        + 'git -c user.email=a@b -c user.name=n commit -qm t', work), 0,
        kind + ': committing was refused');
      assert.notStrictEqual(runUnder(spec, 'echo evil > ' + name + '/.git/hooks/pre-commit', work), 0,
        kind + ': a hook that the next command would run was writable');
      const hooks = fs.readdirSync(path.join(work, name, '.git', 'hooks'));
      assert.ok(hooks.length > 0, kind + ': the templates did not land');
      assert.ok(hooks.every((f) => f.endsWith('.sample')),
        kind + ': something other than a template landed in the hook directory: ' + hooks.join(', '));
    }
  });
});

test('SBG-13: confined ground can still write the caches a toolchain writes without being asked', () => {
  if (!sb.isAvailable().available) return skip('sandbox-exec unavailable');
  // Redirecting these one environment variable at a time means enumerating
  // every build system that will ever exist. A cache is derived data, so the
  // roots are allowed instead — but the trees that are not caches stay shut.
  const savedHome = process.env.HOME;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sbgc-')));
  process.env.HOME = home;
  try {
    withTrothDir(() => {
      const proj = path.join(home, 'proj');
      fs.mkdirSync(proj, { recursive: true });
      const spec = sb.groundSpawnSpec({ kind: 'confine', cwd: proj });
      assert.ok(spec.ok, 'confine spec failed: ' + spec.error);
      // The cache roots themselves exist on any machine that has run the
      // toolchain once, and only the roots are allowed — not the trees above
      // them, which is why a nested cache root is created here rather than
      // from inside the walls.
      for (const rel of sb.CACHE_RELATIVE) {
        fs.mkdirSync(path.join(home, rel), { recursive: true });
        const target = path.join(home, rel, 'nested', 'probe');
        assert.strictEqual(runUnder(spec,
          'mkdir -p ' + JSON.stringify(path.dirname(target)) + ' && echo x > ' + JSON.stringify(target), proj), 0,
          'a toolchain cache was refused: ~/' + rel);
      }
      // Neither of these is a cache: one holds executables that sit on PATH,
      // the other holds several tools' credentials.
      for (const rel of ['.local/bin', '.config/gh']) {
        const target = path.join(home, rel, 'probe');
        assert.notStrictEqual(runUnder(spec,
          'mkdir -p ' + JSON.stringify(path.dirname(target)) + ' && echo x > ' + JSON.stringify(target), proj), 0,
          'the cache allowance reached a tree that is not a cache: ~/' + rel);
      }
    });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
});
};
