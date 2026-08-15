// SPDX-License-Identifier: AGPL-3.0-only
// The contract that reaches agents troth cannot hook.
//
// AGENTS.md is the cross-tool instruction file read at session start by
// essentially every coding agent. On agents without troth's hooks the tool
// listing is otherwise the whole introduction, so `troth agents` (and a
// consented init-wizard step) writes one fixed block there. The disciplines
// under test are the ones the measured research demands: the text is a
// hand-written template with a hard size ceiling (curated-short helps
// agents; generated bulk measurably hurts), the operator's own content is
// never disturbed, and the block updates in place instead of piling up.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const contract = require(path.join(ROOT, 'shared-core', 'agents-contract.js'));

console.log('\nAGENTS.md contract (AGC):');

test('AGC-1: a project without AGENTS.md gets exactly the block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-'));
  const r = contract.applyToDir(dir);
  assert.strictEqual(r.action, 'created');
  const src = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(src.startsWith(contract.BEGIN), 'markers frame it');
  assert.ok(/troth_recall/.test(src), 'and it leads with the recall-first contract');
});

test('AGC-2: operator content stays byte-identical; the block appends after it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-'));
  const theirs = '# Their project\n\nTheir own agent notes.\n';
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), theirs);
  const r = contract.applyToDir(dir);
  assert.strictEqual(r.action, 'appended');
  const src = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(src.startsWith(theirs.replace(/\n*$/, '\n')), 'their text is untouched, byte for byte');
  assert.strictEqual((src.match(/BEGIN troth contract/g) || []).length, 1);
});

test('AGC-3: reruns update in place — one block, forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-'));
  contract.applyToDir(dir);
  const again = contract.applyToDir(dir);
  assert.strictEqual(again.action, 'unchanged', 'same template, no rewrite');
  const src = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.strictEqual((src.match(/BEGIN troth contract/g) || []).length, 1);
  assert.strictEqual((src.match(/END troth contract/g) || []).length, 1);
});

test('AGC-4: the block honors the no-bloat ceiling', () => {
  const block = contract.contractBlock();
  assert.ok(block.split('\n').length <= 18, 'a contract, not a manual: ' + block.split('\n').length + ' lines');
  assert.ok(block.length <= 1200, 'and under the character ceiling: ' + block.length);
});

test('AGC-5: the CLI road works end to end and resolves to the repository root', () => {
  const cp = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-repo-'));
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@i', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@i'
  });
  cp.execFileSync('git', ['init', '-q'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const sub = path.join(repo, 'deep', 'inside');
  fs.mkdirSync(sub, { recursive: true });
  const r = cp.spawnSync('node', [path.join(ROOT, 'bin', 'troth.js'), 'agents'],
    { cwd: sub, env: Object.assign({}, process.env), encoding: 'utf8', timeout: 30000 });
  assert.ok(/AGENTS\.md/.test(r.stdout), 'the command speaks: ' + (r.stdout || r.stderr).slice(0, 120));
  assert.ok(fs.existsSync(path.join(repo, 'AGENTS.md')),
    'the block lands at the repository root, not in the subdirectory the shell stood in');
});
};
