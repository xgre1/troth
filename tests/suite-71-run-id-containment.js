// SPDX-License-Identifier: AGPL-3.0-only
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MCP = path.join(ROOT, 'bin', 'mcp-server.js');
// Fixture commits carry their own identity and signing stance, so a bare
// runner with no git configuration is enough ground for this suite.
const GITC = ['-c', 'user.email=t@t.local', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

console.log('\nRun-id containment (RID):');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rid-'));
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  return root;
}

function callTool(root, name, args) {
  const script = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }
  ].map(m => JSON.stringify(m)).join('\n') + '\n';
  const r = cp.spawnSync('node', [MCP], {
    input: script,
    env: Object.assign({}, process.env, {
      HOME: path.join(root, 'home'),
      TROTH_RUNS_DIR: path.join(root, 'runs')
    }),
    encoding: 'utf8', timeout: 20000
  });
  const line = String(r.stdout || '').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean).find(m => m.id === 2);
  return line || {};
}

function plantRealRun(root) {
  const id = '2026-01-02T03-04-05-a-task-zzzz';
  const dir = path.join(root, 'runs', id);
  const wt = path.join(dir, 'workspace');
  fs.mkdirSync(wt, { recursive: true });
  cp.spawnSync('git', ['init', '-q', '.'], { cwd: wt });
  cp.spawnSync('git', GITC.concat(['commit', '-q', '--allow-empty', '-m', 'base']), { cwd: wt });
  cp.spawnSync('git', ['branch', '-M', 'main'], { cwd: wt });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, task: 'a task', branch: 'troth/a-task', parent_branch: 'main',
    worktree: wt, repo_root: wt, started_at: '2026-01-02T03:04:05Z'
  }));
  fs.writeFileSync(path.join(dir, 'log.txt'), 'worker said something\n');
  return { id, dir, wt };
}

function plantDecoy(root) {
  const evil = path.join(root, 'evil');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(evil, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'witness.txt'), 'operator data\n');
  fs.writeFileSync(path.join(evil, 'log.txt'), 'contents of a file outside the runs directory\n');
  fs.writeFileSync(path.join(evil, 'meta.json'), JSON.stringify({
    worktree: victim, repo_root: victim, branch: 'x',
    parent_branch: '--output=' + path.join(root, 'written-by-git')
  }));
  return { evil, victim };
}

test('RID-1: a traversing run id reaches no tool, and the directory it names survives', () => {
  const root = sandbox();
  const { victim } = plantDecoy(root);
  for (const tool of ['troth_status', 'troth_logs', 'troth_diff', 'troth_kill', 'troth_clean']) {
    const msg = callTool(root, tool, { run_id: '../evil' });
    const blob = JSON.stringify(msg);
    assert.ok(/run not found|invalid|no readable/i.test(blob),
      tool + ' must refuse a traversing id; got ' + blob.slice(0, 160));
    assert.ok(!/contents of a file outside/.test(blob),
      tool + ' must not serve a file outside the runs directory');
  }
  assert.ok(fs.existsSync(path.join(victim, 'witness.txt')),
    'nothing outside the runs directory may be deleted');
  fs.rmSync(root, { recursive: true, force: true });
});

test('RID-2: a meta file cannot name a delete target outside its own run', () => {
  const root = sandbox();
  const { victim } = plantDecoy(root);
  const id = '2026-01-02T03-04-05-liar-yyyy';
  const dir = path.join(root, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, task: 't', branch: 'troth/t', parent_branch: 'main',
    worktree: victim, repo_root: victim
  }));
  const msg = callTool(root, 'troth_clean', { run_id: id });
  assert.ok(JSON.stringify(msg).length > 0, 'the call returns something');
  assert.ok(fs.existsSync(path.join(victim, 'witness.txt')),
    'a worktree path outside the run is left alone');
  assert.ok(!fs.existsSync(dir), "the run's own directory is still removed");
  fs.rmSync(root, { recursive: true, force: true });
});

test('RID-3: a meta value never reaches git as an option', () => {
  const root = sandbox();
  const id = '2026-01-02T03-04-05-optish-xxxx';
  const dir = path.join(root, 'runs', id);
  const wt = path.join(dir, 'workspace');
  fs.mkdirSync(wt, { recursive: true });
  cp.spawnSync('git', ['init', '-q', '.'], { cwd: wt });
  cp.spawnSync('git', GITC.concat(['commit', '-q', '--allow-empty', '-m', 'base']), { cwd: wt });
  const written = path.join(root, 'written-by-git');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, task: 't', branch: 'troth/t', worktree: wt, repo_root: wt,
    parent_branch: '--output=' + written
  }));
  callTool(root, 'troth_diff', { run_id: id });
  const leaked = fs.readdirSync(root).filter(f => f.indexOf('written-by-git') === 0);
  assert.deepStrictEqual(leaked, [], 'git must not be steered into writing a file');
  fs.rmSync(root, { recursive: true, force: true });
});

test('RID-4: a real run still reports, and still cleans itself', () => {
  const root = sandbox();
  const { id, dir } = plantRealRun(root);
  const status = JSON.stringify(callTool(root, 'troth_status', { run_id: id }));
  assert.ok(/a task/.test(status), 'status reads the run: ' + status.slice(0, 160));
  const logs = JSON.stringify(callTool(root, 'troth_logs', { run_id: id }));
  assert.ok(/worker said something/.test(logs), 'logs come back: ' + logs.slice(0, 160));
  callTool(root, 'troth_clean', { run_id: id });
  assert.ok(!fs.existsSync(dir), 'clean removes the run it was given');
  fs.rmSync(root, { recursive: true, force: true });
});

test('RID-5: a meta file cannot name the repository git acts in', () => {
  const root = sandbox();

  // The repository that really owns the run, and a stranger's repository
  // holding work the operator cares about.
  const owner = path.join(root, 'owner-repo');
  fs.mkdirSync(owner, { recursive: true });
  cp.spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: owner });
  cp.spawnSync('git', GITC.concat(['commit', '-q', '--allow-empty', '-m', 'base']), { cwd: owner });

  const foreign = path.join(root, 'someone-elses-repo');
  fs.mkdirSync(foreign, { recursive: true });
  cp.spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: foreign });
  cp.spawnSync('git', GITC.concat(['commit', '-q', '--allow-empty', '-m', 'base']), { cwd: foreign });
  cp.spawnSync('git', ['branch', 'precious-work'], { cwd: foreign });

  // A valid id and a workspace genuinely inside the run: every earlier gate
  // is satisfied. Only repo_root points at the stranger.
  const id = '2026-01-02T03-04-05-owned-wwww';
  const dir = path.join(root, 'runs', id);
  const wt = path.join(dir, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  cp.spawnSync('git', ['worktree', 'add', '-q', '-b', 'troth/' + id, wt], { cwd: owner });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, task: 't', branch: 'precious-work', parent_branch: 'main',
    worktree: wt, repo_root: foreign
  }));

  callTool(root, 'troth_clean', { run_id: id });

  const branches = cp.execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: foreign })
    .toString().trim().split('\n');
  assert.ok(branches.indexOf('precious-work') !== -1,
    'a branch in a repository the run does not own must survive: ' + JSON.stringify(branches));
  assert.ok(!fs.existsSync(dir), "the run's own directory is still removed");
  fs.rmSync(root, { recursive: true, force: true });
});

// The proxy hands this path to macOS `open`, which launches whatever it
// names, so the workspace must come from the gate and not from the meta file
// the caller reads alongside it.
test('RID-6: the workspace a run hands out is its own, or none', () => {
  const root = sandbox();
  const runner = path.join(ROOT, 'bin', 'runner.js');

  const honest = plantRealRun(root);

  const id = '2026-01-02T03-04-05-pointer-vvvv';
  const dir = path.join(root, 'runs', id);
  const elsewhere = path.join(root, 'Somewhere.app');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, task: 't', branch: 'troth/t', parent_branch: 'main',
    worktree: elsewhere, repo_root: elsewhere
  }));

  const probe = 'const r = require(' + JSON.stringify(runner) + ');' +
    'console.log(JSON.stringify({' +
    'honest: r.apiRunWorkspace(' + JSON.stringify(honest.id) + '),' +
    'pointer: r.apiRunWorkspace(' + JSON.stringify(id) + '),' +
    'traversing: r.apiRunWorkspace("../evil")' +
    '}));';
  const out = cp.spawnSync('node', ['-e', probe], {
    env: Object.assign({}, process.env, {
      HOME: path.join(root, 'home'),
      TROTH_RUNS_DIR: path.join(root, 'runs')
    }),
    encoding: 'utf8', timeout: 20000
  });
  const got = JSON.parse(String(out.stdout || '{}').trim());

  assert.strictEqual(got.honest.ok, true, 'a real run still yields its workspace');
  assert.strictEqual(got.honest.worktree, honest.wt, 'and it is the run\'s own');
  assert.strictEqual(got.pointer.ok, false,
    'a meta file pointing outside the run yields nothing: ' + JSON.stringify(got.pointer));
  assert.strictEqual(got.traversing.ok, false, 'a traversing id yields nothing');
  fs.rmSync(root, { recursive: true, force: true });
});

};
