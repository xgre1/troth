// SPDX-License-Identifier: AGPL-3.0-only
// What a lesson is allowed to outlive.
//
// recordLesson dual-writes: a delivery queue (session_lessons, served once by
// pullLessons inside a 24-hour window) and a permanent mirror (action_records
// type='lesson', which recall reads). Two things were wrong with that, both
// measured on a working substrate:
//
//   Every lesson was permanent. A working-style warning about the PREVIOUS
//   turn is coaching for the next one, not a fact about the world — yet 886
//   fidelity warnings sat in the permanent store as semantic, model-visible
//   memories, each a sentence about a turn nobody can see any more.
//
//   Nothing ever swept the queue. 1,178 rows, 1,175 of them past every window
//   that could still deliver them, four months of residue.
//
// The rule now: what deserves to outlive the session says so (durable is the
// default); what does not is delivered once and swept with the queue. The
// permanent store is never touched by the sweep — anything worth keeping was
// mirrored there at write time.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'shared-core', 'state.js'));

console.log('\nLesson hygiene (LSN):');

const db = () => state._dbForQuery();
const NONCE = 'lsn' + Date.now().toString(36);
const durableCount = () => db().prepare(
  "SELECT COUNT(*) n FROM action_records WHERE type='lesson' AND instr(output, ?) > 0").get(NONCE).n;
const queueCount = () => db().prepare(
  'SELECT COUNT(*) n FROM session_lessons WHERE lesson LIKE ?').all('%' + NONCE + '%')[0].n;

test('LSN-1: a lesson is durable by default — the mirror contract holds', () => {
  state.recordLesson('lsn-s1', '/x', 'errortax', NONCE + '-fp1', 'lesson ' + NONCE + ' durable');
  assert.strictEqual(queueCount(), 1, 'delivered through the queue');
  assert.strictEqual(durableCount(), 1, 'and mirrored to the permanent store');
});

test('LSN-2: durable:false is delivered once and mirrored nowhere', () => {
  state.recordLesson('lsn-s1', '/x', 'fidelity_warn', NONCE + '-fp2',
    'warning ' + NONCE + ' transient', { durable: false });
  assert.strictEqual(queueCount(), 2, 'it reaches the queue like any other');
  assert.strictEqual(durableCount(), 1, 'and the permanent store never hears of it');
});

test('LSN-3: the sweep takes what no window can still deliver, and nothing else', () => {
  const now = Date.now();
  // consumed yesterday-ish: stays (under the 2-day consumed cutoff)
  // consumed three days ago: goes
  // unconsumed, eight days old: goes (no pullLessons window reaches it)
  // unconsumed, fresh: stays — it may still be delivered
  const ins = db().prepare(
    'INSERT INTO session_lessons (session_id, cwd, ts, source, fingerprint, lesson, consumed) VALUES (?,?,?,?,?,?,?)');
  ins.run('lsn-s2', '/x', now - 1 * 86400000, 't', NONCE + 'a', 'sw ' + NONCE + ' consumed-fresh', 1);
  ins.run('lsn-s2', '/x', now - 3 * 86400000, 't', NONCE + 'b', 'sw ' + NONCE + ' consumed-old', 1);
  ins.run('lsn-s2', '/x', now - 8 * 86400000, 't', NONCE + 'c', 'sw ' + NONCE + ' stale-unconsumed', 0);
  ins.run('lsn-s2', '/x', now - 1 * 3600000, 't', NONCE + 'd', 'sw ' + NONCE + ' fresh-unconsumed', 0);

  const removed = state.pruneSessionLessons();
  assert.ok(removed >= 2, 'the two dead rows go: ' + removed);
  const left = db().prepare('SELECT fingerprint FROM session_lessons WHERE lesson LIKE ?')
    .all('%sw ' + NONCE + '%').map(r => r.fingerprint).sort();
  assert.deepStrictEqual(left, [NONCE + 'a', NONCE + 'd'],
    'what a window can still serve, or a debugger still wants, survives: ' + JSON.stringify(left));
});

test('LSN-4: the sweep never reaches the permanent store', () => {
  assert.strictEqual(durableCount(), 1,
    'exactly the one durable lesson from LSN-1, untouched by every sweep above');
});

test('LSN-5: the transient writers say so, and the sweep is scheduled (source pins)', () => {
  const fs = require('fs');
  const fid = fs.readFileSync(path.join(ROOT, 'shared-core', 'fidelity-run.js'), 'utf8');
  assert.ok(/fidelity_warn[\s\S]{0,220}durable: false/.test(fid),
    'the fidelity warning is queue-only');
  const cr = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'critic.mjs'), 'utf8');
  assert.ok(/how_rails_warn[\s\S]{0,320}durable: false/.test(cr),
    'the HOW-rails warning is queue-only');
  const bw = fs.readFileSync(path.join(ROOT, 'shared-core', 'background-worker.js'), 'utf8');
  assert.ok(/pruneSessionLessons/.test(bw),
    'the sweep runs inside ledger_prune — a task the proxy already schedules');
});

// ── Which failures earn the shelf ────────────────────────────────────
//
// errortax used to write every classified failure THREE times — a direct
// durable lesson, recordLesson's durable mirror, and the queue — so one
// timeout minted two permanent rows. Measured on a working substrate: 283
// durable errortax lessons, 238 of them infrastructure weather, 76 about a
// router retired months earlier. A timeout is not a lesson: nobody can
// choose differently next week because a server was slow in July. What
// persists is what reflects a CHOICE — an Edit sent unread, a Write over
// something that existed, a command this machine does not have.

test('LSN-6: weather is not a lesson, choices are (the policy itself)', () => {
  const et = require(path.join(ROOT, 'shared-core', 'errortax-hook.js'));
  assert.strictEqual(typeof et.durable, 'function', 'the policy is one exported decision');
  for (const cls of ['string_not_found', 'file_already_exists', 'command_not_found']) {
    assert.strictEqual(et.durable(cls), true, cls + ' reflects a choice — it keeps the shelf');
  }
  for (const cls of ['timeout', 'mcp_error', 'network', 'file_not_found', 'permission_denied', 'nonzero_exit', 'unknown']) {
    assert.strictEqual(et.durable(cls), false, cls + ' is weather — delivered and swept');
  }
});

test('LSN-7: the hook has one lesson writer, and it asks the policy (source pin)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'errortax.mjs'), 'utf8');
  assert.ok(!/type: 'lesson'/.test(src),
    'the direct durable write is gone — recordLesson is the only lesson road');
  assert.ok(/durable: errortax\.durable\(diag\.class\)/.test(src),
    'and its durability comes from the taxonomy, not from the call site');
  assert.ok(/session_lessons[\s\S]{0,120}fingerprint = \?/.test(src),
    'precedent reads the delivery queue, which the sweep keeps for a week');
});

// ── A lesson must be true ────────────────────────────────────────────
//
// Live find: a SUCCEEDED troth_recall returned a paragraph containing the
// words "destination" and "exists". The hook read the success content for
// error markers, the taxonomy's unbounded "destination.*exists" matched
// across the one-line JSON, and the model was told "the recall call failed
// (file_already_exists)" — a durable class, so the lie came back as
// precedent in later prompts. Prose is not a failure report.

test('LSN-8: prose that merely mentions errors is not classified as a failure', () => {
  const et = require(path.join(ROOT, 'shared-core', 'errortax-hook.js'));
  const prose = [
    'presented as an organ toward that destination ... the repo exists and is private',
    'This destination is operator-only by policy; the file exists.',
    'the search found nothing and no file was written',
    // "timeout" is a word in ordinary output, not a verdict
    'spawnSync(cmd, { timeout: 1500 })',
    'timeout 90 ssh build-host ls',
    '// proxies do not time out idle connections'
  ];
  for (const p of prose) {
    assert.strictEqual(et.diagnose(p), null, 'prose must not classify: ' + JSON.stringify(p.slice(0, 48)));
  }
  // and the real messages still do
  assert.strictEqual(et.diagnose("fatal: destination path 'x' already exists").class, 'file_already_exists');
  assert.strictEqual(et.diagnose('EEXIST: file already exists, mkdir').class, 'file_already_exists');
  assert.strictEqual(et.diagnose('ENOENT: no such file or directory').class, 'file_not_found');
  assert.strictEqual(et.diagnose('Command timed out after 120s').class, 'timeout');
  assert.strictEqual(et.diagnose('killed by SIGTERM').class, 'timeout');
});

test('LSN-9: a succeeded call is read only on its error channel (source pin)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'errortax.mjs'), 'utf8');
  const marker = 'A call that SUCCEEDED';
  const i = src.indexOf(marker);
  assert.ok(i > 0, 'the success path is marked in the source');
  assert.ok(!/r\.content/.test(src.slice(i)),
    'past that marker the hook never reads a successful result’s content');
  assert.ok(/const err = typeof r\.stderr === 'string'/.test(src),
    'the success path reads stderr, the one channel that carries failures');
});
};
