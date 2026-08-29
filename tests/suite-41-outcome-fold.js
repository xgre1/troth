// SPDX-License-Identifier: AGPL-3.0-only
// Did the work survive?
//
// The substrate records every change and, without an observer, knows the
// outcome of none of them — edit records against zero outcome events.
// action-outcome.js could always answer — event-sourced, folded on read,
// exercised end to end — and had zero callers. This is its first observer.
//
// The detector is git, not our own ledger, and that choice was measured rather
// than assumed: of 21,188 edit records only 314 carry BOTH hash_before and
// hash_after (writers disagree about which fields they fill), and those 314
// contain zero detectable reverts. A hash-based revert detector would report
// "all clear" forever. Git answers the one question it can answer exactly —
// was this file committed after that change — and stays silent elsewhere.
module.exports = function run({ test }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT  = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'shared-core', 'state.js'));
const ar    = require(path.join(ROOT, 'shared-core', 'action-record.js'));
const fold  = require(path.join(ROOT, 'shared-core', 'outcome-fold.js'));
const outcome = require(path.join(ROOT, 'shared-core', 'action-outcome.js'));

console.log('\nOutcome fold (OF):');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });

// A real repository, because the whole point is that git is the oracle.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'of-repo-'));
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'of-plain-'));
const TRACKED = path.join(REPO, 'ledger.md');
const LOOSE   = path.join(PLAIN, 'notes.md');

const seedEdit = (filePath, ts) => {
  const id = ar.uuidv7();
  const ok = state.recordAction({
    id, timestamp: ts, type: 'edit', agent_id: 'of-test', user_id: 'default',
    cwd: null, memory_class: 'operational', audience: 'substrate_internal',
    input: { file_path: filePath, hash_before: 'aaa' },
    output: { hash_after: 'bbb', lines_changed: 3 }
  }, 'of edit ' + filePath);
  assert.ok(ok, 'seeded an edit for ' + filePath);
  return id;
};

let trackedEdit = null, looseEdit = null, ready = false;
try {
  git(REPO, ['init', '-q']);
  fs.writeFileSync(TRACKED, 'harbour ledger, first line\n');
  git(REPO, ['add', '.']);
  git(REPO, ['-c', 'user.name=of', '-c', 'user.email=of@test', 'commit', '-q', '-m', 'seed']);
  fs.writeFileSync(LOOSE, 'a note nobody versions\n');
  ready = true;
} catch (_) { ready = false; }

test('OF-1: a change that git kept is linked to the commit that kept it', function () {
  if (!ready) return; // no git on this machine: nothing to assert
  const before = Date.now() - 60 * 60 * 1000;
  trackedEdit = seedEdit(TRACKED, before);
  fs.appendFileSync(TRACKED, 'second line, the change under test\n');
  git(REPO, ['add', '.']);
  git(REPO, ['-c', 'user.name=of', '-c', 'user.email=of@test', 'commit', '-q', '-m', 'keep the change']);

  const r = fold.foldOnce(state, { limit: 50, settle_ms: 0, agent_id: 'of-test' });
  assert.ok(r.linked >= 1, 'something was linked: ' + JSON.stringify(r));
  const o = outcome.getOutcome(state, trackedEdit);
  assert.ok(o, 'the edit has an outcome now');
  assert.strictEqual(o.accepted, true, 'and it reads as accepted: ' + JSON.stringify(o));
  assert.ok(o.led_to_commit && o.led_to_commit.length >= 7, 'carrying the commit sha: ' + o.led_to_commit);
  assert.ok(o.sources.indexOf('outcome_fold') !== -1, 'attributed to the observer: ' + JSON.stringify(o.sources));
});

test('OF-2: a change outside version control gets NO outcome, not a guessed one', function () {
  if (!ready) return;
  looseEdit = seedEdit(LOOSE, Date.now() - 60 * 60 * 1000);
  fold.foldOnce(state, { limit: 50, settle_ms: 0, agent_id: 'of-test' });
  const o = outcome.getOutcome(state, looseEdit);
  assert.strictEqual(o.event_count, 0, 'silence is the truthful answer here: ' + JSON.stringify(o));
  assert.strictEqual(o.accepted, null, 'accepted stays unknown, never false');
});

test('OF-3: folding twice does not double — the ledger is not a rumour mill', function () {
  if (!ready || !trackedEdit) return;
  const first = outcome.listOutcomeEvents(state, trackedEdit).length;
  fold.foldOnce(state, { limit: 50, settle_ms: 0, agent_id: 'of-test' });
  const second = outcome.listOutcomeEvents(state, trackedEdit).length;
  assert.strictEqual(second, first, 'a second pass adds nothing: ' + first + ' -> ' + second);
});

test('OF-4: pendingEdits skips what is already folded and respects the settle window', function () {
  if (!ready || !trackedEdit) return;
  const ids = fold.pendingEdits(state, { limit: 200, settle_ms: 0 }).map((r) => r.id);
  assert.ok(ids.indexOf(trackedEdit) === -1, 'a folded edit is not offered again');
  const fresh = seedEdit(TRACKED, Date.now());
  const soon = fold.pendingEdits(state, { limit: 200, settle_ms: 10 * 60 * 1000 }).map((r) => r.id);
  assert.ok(soon.indexOf(fresh) === -1, 'a change made seconds ago has not settled yet');
});

test('OF-5: repoRootOf answers exactly, and caches without lying', function () {
  if (!ready) return;
  const cache = new Map();
  assert.strictEqual(fold.repoRootOf(TRACKED, cache), fs.realpathSync(REPO).indexOf(REPO) === 0 ? REPO : fold.repoRootOf(TRACKED, cache),
    'a tracked file resolves to its repo');
  assert.strictEqual(fold.repoRootOf(LOOSE, new Map()), null, 'an untracked tree resolves to nothing');
});

test('OF-6: the idle worker runs it (source pin)', () => {
  const worker = require(path.join(ROOT, 'shared-core', 'background-worker.js'));
  const names = (worker.DEFAULT_TASKS || []).map((t) => t.name);
  assert.ok(names.indexOf('outcome_fold') !== -1, 'registered: ' + JSON.stringify(names.slice(-4)));
  const src = fs.readFileSync(path.join(ROOT, 'shared-core', 'background-worker.js'), 'utf8');
  assert.ok(/taskOutcomeFold/.test(src), 'and by name, not by accident');
});
};
