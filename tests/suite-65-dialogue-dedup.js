// SPDX-License-Identifier: AGPL-3.0-only
// One exchange, one row — whatever surface echoes it.
//
// The desktop per-role mirror landed the SAME exchange as half rows around
// the daemon's paired row: (U,'') and ('',A) beside (U,A). Whole-tuple
// dedup never caught them, so identical assistant text was stored twice and
// RE-MOUNTED into the prompt window on every following turn — measured
// ~4.1K tokens of pure duplication across one 14h window, paid again on
// every call while the rows stayed fresh. The wall: a HALF whose non-empty
// side matches the corresponding side of a recent turn is an echo of an
// exchange the substrate already holds. Genuinely new halves (voice notes
// with no daemon scribe) still write — the mirror exists for them.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nDialogue mirror dedup (DDM):');

test('DDM-1: echo halves are refused, fresh content still writes', function () {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ddm-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const inner = [
    "const dm = require(" + JSON.stringify(path.join(ROOT, 'shared-core', 'dialogue-memory.js')) + ");",
    "const base = { agent_id: 'probe-agent', user_id: 'default' };",
    "const out = [",
    "  dm.recordTurn({ ...base, user_text: 'the question', assistant_text: 'the full answer', faculty: 'engine' }),",
    "  dm.recordTurn({ ...base, user_text: '', assistant_text: 'the full answer', faculty: 'mirror' }),",
    "  dm.recordTurn({ ...base, user_text: 'the question', assistant_text: '', faculty: 'mirror' }),",
    "  dm.recordTurn({ ...base, user_text: 'a brand new voice note', assistant_text: '', faculty: 'voice' })",
    "];",
    "console.log(JSON.stringify(out));"
  ].join('\n');
  const r = cp.spawnSync('node', ['-e', inner], {
    env: Object.assign({}, process.env, {
      HOME, _TROTH_TEST_HOME: HOME,
      STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
    }),
    encoding: 'utf8', timeout: 30000
  });
  assert.strictEqual(r.status, 0, r.stderr.slice(0, 200));
  const [paired, asstEcho, userEcho, freshHalf] = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(paired, true, 'the paired daemon record writes');
  assert.strictEqual(asstEcho, false, 'the assistant-side echo is refused — it was already stored');
  assert.strictEqual(userEcho, false, 'the user-side echo is refused too');
  assert.strictEqual(freshHalf, true, 'a genuinely new half (voice note, no daemon scribe) still writes');
});

test('DDM-2: the wall is the half-echo check, stated where the next writer will read it (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared-core', 'dialogue-memory.js'), 'utf8');
  assert.ok(/_incomingHalf/.test(src), 'the half detection exists');
  assert.ok(/Mirror-echo halves/.test(src), 'and carries the why — the measured duplication that justified it');
});

test('DDM-3: the scribe records the operator\'s words even on a failed turn (source pin)', () => {
  // Retiring the per-role mirror removed its one accidental virtue: an
  // errored-then-abandoned question would leave a user half behind.
  // The daemon must carry that duty itself — an else-branch beside the
  // ok-path record, writing the prompt with an empty assistant side.
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'troth-entity.js'), 'utf8');
  assert.ok(/\} else if \(action\.prompt\) \{/.test(src), 'the failed-turn branch exists');
  assert.ok(/even when the faculty/.test(src), 'and states why the half is written');
});
};
