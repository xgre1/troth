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

console.log('\nGround walls (SBG-1..8):');

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
    const body = sb._groundProfile(kind, 4, 5);
    assert.ok(!/[/](Users|home|tmp|private)/.test(body), kind + ' profile embeds a path: ' + body);
    assert.ok(/\(param "WORKSPACE"\)/.test(body), kind + ' profile does not deny partner ground');
  }
  const confined = sb._groundProfile('confine', 1, 1);
  const denyAll = confined.indexOf('(deny file-write*)');
  const allowWork = confined.indexOf('(param "WORK")');
  const policyLast = confined.lastIndexOf('(deny file-write* (subpath (param "POLICY0")))');
  assert.ok(denyAll > -1 && allowWork > denyAll, 'the work allowance must come after the blanket deny');
  assert.ok(policyLast > allowWork, 'policy denies must come last or a writable tree reopens them');
  assert.ok(sb._groundProfile('home', 1, 1).indexOf('(param "WORK")') === -1,
    'home ground must have no writable work directory');
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
};
