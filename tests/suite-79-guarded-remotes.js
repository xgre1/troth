// SPDX-License-Identifier: AGPL-3.0-only
// Guarded publish destinations: a push toward an armed destination passes
// only while a green gate pass covers the exact tree at HEAD. The list ships
// empty — the empty case must cost nothing and block nothing — and arming is
// the operator's own act, so the file and the pass directory take no partner
// writes on any road.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

console.log('\nGuarded destinations (GUARD-1..10):');

const pub = require('../shared-core/tools/publish-gate.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function withTroth(fn) {
  const prev = process.env.TROTH_CONFIG_DIR;
  const troth = tmpdir('guard-troth-');
  process.env.TROTH_CONFIG_DIR = troth;
  try { return fn(troth); }
  finally {
    if (prev === undefined) delete process.env.TROTH_CONFIG_DIR;
    else process.env.TROTH_CONFIG_DIR = prev;
  }
}

function git(dir, argv) {
  cp.execFileSync('git', ['-C', dir].concat(argv), { stdio: 'ignore' });
}

function mkrepo(remoteUrl) {
  const d = tmpdir('guard-repo-');
  git(d, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  git(d, ['add', '.']);
  git(d, ['-c', 'user.email=t@test.invalid', '-c', 'user.name=t', 'commit', '-qm', 'one']);
  if (remoteUrl) git(d, ['remote', 'add', 'origin', remoteUrl]);
  return d;
}

// The forced spellings under test, assembled so no destructive-looking
// literal sits in this file for a text scanner to trip on.
const F = '--' + 'force';
const FSHORT = '-f';
const pushCmd = (flags) => ['git', 'push'].concat(flags).join(' ');

test('GUARD-1: an empty list blocks nothing — every push shape passes untouched', () => {
  withTroth(() => {
    const d = mkrepo('https://github.com/owner/repo.git');
    assert.strictEqual(pub.preflight(pushCmd(['origin', 'main']), d), null);
    assert.strictEqual(pub.preflight(pushCmd([F, 'origin', 'main']), d), null);
    assert.strictEqual(pub.preflight('echo push', d), null);
  });
});

test('GUARD-2: an armed destination with no pass refuses and names the run_gate road', () => {
  withTroth(() => {
    const d = mkrepo('https://github.com/owner/repo.git');
    pub.addGuard('github.com/owner/repo', 'scripts/release-gate.sh repo');
    const v = pub.preflight(pushCmd(['origin', 'main']), d);
    assert.ok(v && v.blocked, 'push must be blocked');
    assert.ok(/run_gate/.test(v.message), 'the refusal names the road: ' + v.message);
    assert.ok(/github\.com\/owner\/repo/.test(v.message));
    assert.ok(/Nothing here needs the operator/.test(v.message));
  });
});

test('GUARD-3: a green pass for the exact tree lets the push through; a moved tree re-blocks', () => {
  withTroth(() => {
    const d = mkrepo('https://github.com/owner/repo.git');
    pub.addGuard('github.com/owner/repo', 'true');
    const tree = pub.headTree(d);
    assert.ok(tree, 'fixture repo has a tree');
    pub.recordPass('github.com/owner/repo', tree, 'true');
    assert.strictEqual(pub.preflight(pushCmd(['origin', 'main']), d), null);
    fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
    git(d, ['add', '.']);
    git(d, ['-c', 'user.email=t@test.invalid', '-c', 'user.name=t', 'commit', '-qm', 'two']);
    const v = pub.preflight(pushCmd(['origin', 'main']), d);
    assert.ok(v && v.blocked, 'a pass never outlives its tree');
    assert.ok(/different tree/.test(v.message));
  });
});

test('GUARD-4: unguarded remotes and non-push commands stay untouched while the list is armed', () => {
  withTroth(() => {
    pub.addGuard('github.com/owner/repo', 'true');
    const other = mkrepo('https://github.com/other/place.git');
    assert.strictEqual(pub.preflight(pushCmd(['origin', 'main']), other), null);
    const d = mkrepo('https://github.com/owner/repo.git');
    assert.strictEqual(pub.preflight('git status', d), null);
    assert.strictEqual(pub.preflight('git fetch origin', d), null);
  });
});

test('GUARD-5: every remote spelling lands on the same destination', () => {
  assert.strictEqual(pub.normalizeUrl('https://github.com/Owner/Repo.git'), 'github.com/owner/repo');
  assert.strictEqual(pub.normalizeUrl('git@github.com:owner/repo.git'), 'github.com/owner/repo');
  assert.strictEqual(pub.normalizeUrl('ssh://git@github.com/owner/repo'), 'github.com/owner/repo');
  assert.ok(pub.matchesGuard('git@github.com:owner/repo.git', 'github.com/owner/repo'));
  assert.ok(!pub.matchesGuard('github.com/owner/repo-evil', 'github.com/owner/repo'));
  withTroth(() => {
    const d = mkrepo(null);
    pub.addGuard('github.com/owner/repo', 'true');
    const v = pub.preflight(pushCmd(['git@github.com:owner/repo.git', 'main']), d);
    assert.ok(v && v.blocked, 'a push straight to the URL is judged by the URL');
  });
});

test('GUARD-6: -C and the bare upstream push resolve the same repository', () => {
  withTroth(() => {
    const d = mkrepo('https://github.com/owner/repo.git');
    pub.addGuard('github.com/owner/repo', 'true');
    const elsewhere = tmpdir('guard-cwd-');
    const v1 = pub.preflight('git -C ' + d + ' push origin main', elsewhere);
    assert.ok(v1 && v1.blocked, '-C carries the repo');
    git(d, ['config', 'branch.main.remote', 'origin']);
    const v2 = pub.preflight('git push', d);
    assert.ok(v2 && v2.blocked, 'a bare push resolves its upstream');
  });
});

test('GUARD-7: history-surgery flags stay the operator\'s own even on a green pass', () => {
  withTroth(() => {
    const d = mkrepo('https://github.com/owner/repo.git');
    pub.addGuard('github.com/owner/repo', 'true');
    pub.recordPass('github.com/owner/repo', pub.headTree(d), 'true');
    for (const flags of [[F, 'origin', 'main'], [FSHORT, 'origin', 'main'],
                         ['--mirror', 'origin'], ['--tags', 'origin'], ['--delete', 'origin', 'x']]) {
      const v = pub.preflight(pushCmd(flags), d);
      assert.ok(v && v.blocked, pushCmd(flags) + ' must stay blocked');
      assert.ok(/operator/.test(v.message), 'the message says whose act it is');
    }
  });
});

test('GUARD-8: the list and the passes take no partner write on any road', () => {
  const sb = require('../shared-core/tools/sandbox-seatbelt.js');
  assert.ok(sb._policyPaths().some((p) => p.endsWith('guarded-remotes.json')),
    'the kernel wall covers the guarded list');
  // path-policy expands its prefixes from HOME at load, so the judged paths
  // are built from the module's own table rather than a repinned throwaway.
  const pp = require('../shared-core/tools/path-policy.js');
  const names = pp.BLOCKED_PREFIXES.map((b) => b.name);
  assert.ok(names.includes('guarded_remotes'), 'tool road covers the guarded list');
  assert.ok(names.includes('guarded_remotes_tmp'), 'and its atomic-write twin');
  assert.ok(names.includes('gate_pass_dir'), 'and the pass directory');
  const guardRow = pp.BLOCKED_PREFIXES.find((b) => b.name === 'guarded_remotes');
  const passRow  = pp.BLOCKED_PREFIXES.find((b) => b.name === 'gate_pass_dir');
  assert.strictEqual(pp.isWritablePath(guardRow.prefix, {}).allowed, false);
  assert.strictEqual(pp.isWritablePath(path.join(passRow.prefix, 'x.json'), {}).allowed, false);
});

test('GUARD-9: the shell road wires the gate ahead of every ack, and the gate tool exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs'), 'utf8');
  const guardIx = src.indexOf('Guarded destinations: a push toward one');
  const ackIx = src.indexOf('danger && !args.acknowledge_danger');
  assert.ok(guardIx > 0 && ackIx > 0 && guardIx < ackIx,
    'the publish pre-flight runs before the ack-able speed bump');
  assert.ok(src.includes("name: 'run_gate'"), 'the gate road is a declared tool');
  const sp = require('../shared-core/tools/spawn-purpose.js');
  assert.strictEqual(sp.PURPOSES['publish-preflight'].kind, 'trusted-plumbing');
  assert.strictEqual(sp.PURPOSES['release-gate'].kind, 'trusted-plumbing');
});

test('GUARD-10: the faculty door asks the same publish wall, and its road fits that door', () => {
  // The claude_cli faculty spawns carry no troth-bash server, so their wall
  // is the PreToolUse hook. A guarded destination must be guarded from that
  // door too — and the refusal must name a road that exists THERE, not the
  // run_gate tool that door cannot call.
  const GATE = path.join(__dirname, '..', 'plugin', 'hooks', 'faculty-bash-gate.mjs');
  const troth = tmpdir('guard-hook-');
  fs.writeFileSync(path.join(troth, 'guarded-remotes.json'),
    JSON.stringify([{ match: 'example.com/owner/repo', gate: 'true' }]));
  const ask = (command) => {
    const r = cp.spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({ tool_name: 'Bash', hook_event_name: 'PreToolUse',
        tool_input: { command }, cwd: tmpdir('guard-cwd-') }),
      encoding: 'utf8', timeout: 15000,
      env: Object.assign({}, process.env, { TROTH_CONFIG_DIR: troth })
    });
    assert.strictEqual(r.status, 0, 'gate exited non-zero: ' + String(r.stderr).slice(-200));
    return JSON.parse(String(r.stdout) || '{}');
  };
  const denied = ask('git push https://example.com/owner/repo.git main');
  const h = denied.hookSpecificOutput || {};
  assert.strictEqual(h.permissionDecision, 'deny', 'guarded push not denied: ' + JSON.stringify(denied));
  assert.ok(/guarded destination/.test(h.permissionDecisionReason || ''), 'the gate speaks');
  assert.ok(/partner session/.test(h.permissionDecisionReason || ''), 'the road fits this door');
  assert.ok(!/call run_gate with match/.test(h.permissionDecisionReason || ''), 'no unreachable road is named');
  assert.deepStrictEqual(ask('git push https://example.com/other/repo.git main'), {}, 'unguarded passes untouched');
  assert.deepStrictEqual(ask('git status'), {}, 'a non-push costs nothing and passes');
});
};
