// SPDX-License-Identifier: AGPL-3.0-only
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MCP = path.join(ROOT, 'bin', 'mcp-server.js');

console.log('\nRun-id containment (RID):');

// A run id names a directory troth created. It is not a path, and the files a
// run's own meta.json points at are the only ones a run-keyed tool may read,
// kill or delete. These tests drive the real MCP server over its real stdio
// transport, so what they prove is what a calling agent can actually do.

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

// A run the way troth writes one: the workspace lives inside the run dir.
function plantRealRun(root) {
  const id = '2026-01-02T03-04-05-a-task-zzzz';
  const dir = path.join(root, 'runs', id);
  const wt = path.join(dir, 'workspace');
  fs.mkdirSync(wt, { recursive: true });
  cp.spawnSync('git', ['init', '-q', '.'], { cwd: wt });
  cp.spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: wt });
  cp.spawnSync('git', ['branch', '-M', 'main'], { cwd: wt });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, task: 'a task', branch: 'troth/a-task', parent_branch: 'main',
    worktree: wt, repo_root: wt, started_at: '2026-01-02T03:04:05Z'
  }));
  fs.writeFileSync(path.join(dir, 'log.txt'), 'worker said something\n');
  return { id, dir, wt };
}

// A directory outside RUNS_DIR carrying a meta.json that names someone else's
// files — the shape a traversal needs to become a delete.
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
  // Same decoy, but reachable under a VALID id: the id is fine, the meta lies.
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
  cp.spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: wt });
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

};
