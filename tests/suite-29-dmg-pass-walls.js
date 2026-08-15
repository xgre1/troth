// SPDX-License-Identifier: AGPL-3.0-only
// The DMG-pass regressions (AUDIT-2026-08-09).
//
// The operator ran the shipped DMG as a new user and the audit reproduced,
// live, what the suite had never asked: raw stdout carrying a credential
// flowed to the model AND into tool_output_archive untouched; medium danger
// hits were classified and discarded; the STVC bypass rode the inherited
// env; a no-port browse could land in the operator's own 9222 session; the
// signed audit chain attested 40 rows of ~582,000; and the dashboard's
// headline count was 81% garbage-collector tombstones.
//
// These tests drive the REAL troth-bash MCP server over stdio — the exact
// process Claude Code spawns — plus the substrate write path and the
// shipped counts SQL, and pin each of those behaviours shut.
module.exports = function run({ test }) {
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs');
const state  = require(path.join(ROOT, 'shared-core', 'state.js'));

console.log('\nDMG-pass walls (TBS/CHAIN/COUNTS):');

// One server per call keeps the tests independent. The conversation is the
// MCP wire shape: initialize → tools/call(run) → parse the id:2 reply.
// The child inherits the harness's hermetic HOME, so its archive writes land
// in the same throwaway state.db this suite reads — PROVIDED the child
// resolves the db the same way this suite's state singleton did. Earlier
// suites override process.env.CLAUDE_PLUGIN_DATA around their own blocks
// (suite-02's daemon tests and friends), and an override still live when a
// TBS child spawns pointed that child at a different state.db than the one
// the assertions here read — TBS-2 then found neither the secret nor the
// marker, because it was looking in the wrong file. Blank the variable for
// the child: state.js:24 treats '' as unset and falls through to
// HOME/.troth, the hermetic home.
function callRun(args, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: '' }, extraEnv || {}),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    const done = (fn, v) => { clearTimeout(timer); try { proc.kill('SIGKILL'); } catch (_) {} fn(v); };
    const timer = setTimeout(() => done(reject, new Error('troth-bash never answered; stderr: ' + err.slice(0, 400))), 45000);
    proc.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 2) return done(resolve, msg);
      }
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => done(reject, e));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: args } }) + '\n');
  });
}
// All content blocks joined: the session's first result may lead with the
// one-shot [troth] greeting block, and every assertion here matches on
// substrings rather than positions.
const textOf = (msg) => ((msg.result && msg.result.content) || []).map((c) => c.text || '').join('\n');

test('TBS-1: a secret in command OUTPUT never reaches the model', async () => {
  // The command carries only the prefix (which TPW-21 pins as allowed —
  // otherwise nobody could grep for the problem); the OUTPUT assembles the
  // full credential shape. That output used to flow back verbatim.
  const msg = await callRun({ command: "printf 'sk-ant-'; printf 'A%.0s' {1..24}; echo" });
  const text = textOf(msg);
  assert.ok(text.indexOf('sk-ant-AAAAAAAA') === -1, 'credential literal reached the model: ' + text.slice(0, 200));
  assert.ok(/secret withheld/.test(text), 'the withheld marker names what happened: ' + text.slice(0, 200));
});

test('TBS-2: a secret in ARCHIVED output is redacted before the write', async () => {
  // Archive engages above the compression threshold, so pad past it. This is
  // the growth-stopper for the 550 credential literals already measured in
  // tool_output_archive: rows written from here on hold the marker, never
  // the value. (Existing rows are the operator's scrub decision, not code's.)
  const msg = await callRun({ command: "printf 'sk-ant-'; printf 'B%.0s' {1..24}; echo; i=0; while [ $i -lt 300 ]; do echo 'padding line to push the output over the archive threshold ...................'; i=$((i+1)); done" });
  const text = textOf(msg);
  assert.ok(/archive_id=/.test(text), 'output was large enough to archive: ' + text.slice(-200));
  // Read the file the CHILD deterministically wrote — $HOME/.troth/state.db
  // (callRun blanks CLAUDE_PLUGIN_DATA, so the child's state.js falls
  // through to the hermetic HOME) — with a FRESH readonly handle, not this
  // suite's `state` singleton. Several earlier suites reload state.js with
  // a CLAUDE_PLUGIN_DATA override live (delete require.cache + re-require),
  // so which data dir the singleton is bound to by the time suite-29
  // registers depends on suite ORDER — in the full run it pointed at a
  // leftover TMP dir whose archive table was empty, and this test's
  // leaked=0 passed vacuously while masked=0 failed. A direct handle on the
  // child's path makes the assertion self-consistent by construction, the
  // way CHAIN-1/COUNTS-1 already are (they write and read through one
  // handle).
  const Database = require('better-sqlite3');
  const db = new Database(path.join(process.env.HOME, '.troth', 'state.db'), { readonly: true });
  let leaked, masked;
  try {
    leaked = db.prepare("SELECT COUNT(*) AS n FROM tool_output_archive WHERE raw LIKE '%sk-ant-BBBBBBBB%' OR summary LIKE '%sk-ant-BBBBBBBB%'").get().n;
    masked = db.prepare("SELECT COUNT(*) AS n FROM tool_output_archive WHERE raw LIKE '%secret withheld%'").get().n;
  } finally { db.close(); }
  assert.strictEqual(leaked, 0, 'credential literal written into tool_output_archive');
  assert.ok(masked >= 1, 'the redaction marker is what got archived');
});

test('TBS-3: medium danger hits travel with the result instead of vanishing', async () => {
  // hit.severity !== 'medium' meant medium was classified and then thrown
  // away — the one severity that ran with no trace. It still runs (intent is
  // plausibly legitimate; high/critical still refuse without an ack), but
  // the classification now rides the meta header the model and the archive
  // both see.
  const msg = await callRun({ command: 'killall definitely-not-a-real-process-xyz-29' });
  const text = textOf(msg);
  assert.ok(/caution: kill_all_pattern \(medium\)/.test(text), 'medium classification travels: ' + text.slice(0, 200));
  // And the wall on non-medium is unchanged: refused, with the ack path named.
  const refused = textOf(await callRun({ command: 'git reset --hard HEAD~3' }));
  assert.ok(/REFUSED git_reset_hard/.test(refused), 'high severity still refuses without an ack');
});

test('TBS-4: TROTH_STVC_BYPASS is stripped from the partner shell env', async () => {
  // The unjailed spawn inherits the operator environment — that is the point
  // of operator ground — minus the switch that turns the substrate's write
  // gate off. Parent carries it; the command must not see it.
  const msg = await callRun({ command: 'printf "[%s]" "$TROTH_STVC_BYPASS"' }, { TROTH_STVC_BYPASS: '1' });
  const text = textOf(msg);
  assert.ok(text.indexOf('[]') !== -1, 'bypass leaked into the partner shell: ' + text.slice(0, 120));
  assert.ok(text.indexOf('[1]') === -1, 'bypass value visible to the command');
});

test('TBS-5: spelling the bypass INTO a command is refused at the wall', async () => {
  const msg = await callRun({ command: 'TROTH_STVC_BYPASS=1 echo hi' });
  const text = textOf(msg);
  assert.ok(/REFUSED/.test(text) && /stvc_bypass_env/.test(text), 'inline bypass not refused: ' + text.slice(0, 200));
  assert.ok(/acknowledge_danger does not override/.test(text), 'the wall is not ack-able');
});

test('TBS-6: a no-port browse never auto-attaches to 9222', () => {
  // The description always promised "private profile, never your own
  // session"; the candidate list said otherwise — 9222 was auto-attach
  // candidate #3, and with a debug Chrome open a bare browse landed inside
  // the operator's authenticated session with arbitrary eval. Functional CDP
  // needs a live browser, so this pins the SOURCE the way suite-24 pins
  // checkRemoteAuth: the two defect shapes — pushing 9222 onto the candidate
  // list, and falling back to port 9222 — must both be gone from the
  // no-port branch. 9222 may still be NAMED (comments, the explicit-port
  // error message); what it may not be is silently attached.
  const src = fs.readFileSync(SERVER, 'utf8');
  const start = src.indexOf('async function handleBrowse');
  const end   = src.indexOf('let page;', start);
  assert.ok(start > 0 && end > start, 'handleBrowse block located');
  const block = src.slice(start, end);
  assert.ok(!/candidates\.push\(\s*9222\s*\)/.test(block), '9222 is still an auto-attach candidate');
  // [^-] so the hyphenated flag spelling (--remote-debugging-port=9222) in
  // the error message is not mistaken for the fallback ASSIGNMENT.
  assert.ok(!/[^-]port\s*=\s*9222\b/.test(block), 'the no-port path still falls back to 9222');
  assert.ok(/attach-only|explicit/.test(block), 'the explicit-port opt-in is still the documented road');
});

test('CHAIN-1: every recordAction extends the signed audit chain, and it verifies', () => {
  // The chain attested 40 control-channel rows against ~582,000 engram
  // writes — "forge / suppress audit rows: yes, undetectably". Now the write
  // path itself appends one signed row per record, hashing the STORED
  // columns, and the whole chain still verifies.
  const actionRec = require(path.join(ROOT, 'shared-core', 'action-record.js'));
  const signedAudit = require(path.join(ROOT, 'shared-core', 'signed-audit.js'));
  const before = state.listSignedAuditChain({ limit: 5000 }).length;
  const id = actionRec.uuidv7();
  const wrote = state.recordAction({
    id, timestamp: Date.now(), type: 'commitment',
    agent_id: 'chain-test', cwd: null, user_id: 'operator',
    audience: 'model_visible', memory_class: 'episodic',
    input: { source: 'suite-29' },
    output: { statement: 'chain attestation probe', commitment_type: 'engram', salience: 1 }
  }, 'chain attestation probe');
  assert.ok(wrote, 'record persisted');
  const rows = state.listSignedAuditChain({ limit: 5000 });
  assert.ok(rows.length > before, 'the chain grew with the write');
  const last = rows[rows.length - 1];
  assert.strictEqual(last.kind, 'action_record');
  assert.strictEqual(last.action_id, id, 'the chain row names the record it attests');
  const v = signedAudit.verifyChain({});
  assert.strictEqual(v.ok, true, 'chain verifies after per-write attestation: ' + JSON.stringify(v.first_tamper || {}));
});

test('COUNTS-1: the shipped commitment count excludes GC tombstones and test seeds', () => {
  // 231,071 shown where the truth was ~43k real facts: engram-gc writes its
  // eviction markers as ordinary commitments, and bench/test seeds live in
  // the same table. Both consumer surfaces read by_type.commitment, so the
  // honest predicate lives in the counts handler — and this test executes
  // the EXACT WHERE string the handler ships, against seeded rows, so the
  // predicate cannot drift from what is asserted here.
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const m = src.match(/COMMITMENT_HONEST_WHERE =\s*((?:\s*"[^"]*"\s*\+?)+);/);
  assert.ok(m, 'COMMITMENT_HONEST_WHERE present in the counts handler');
  const where = m[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).join('');
  const db = state._dbForQuery();
  const actionRec = require(path.join(ROOT, 'shared-core', 'action-record.js'));
  const seed = (agent, outputExtra, inputExtra) => {
    const id = actionRec.uuidv7();
    state.recordAction({
      id, timestamp: Date.now(), type: 'commitment',
      agent_id: agent, cwd: null, user_id: 'operator',
      input: Object.assign({ source: 'suite-29-counts' }, inputExtra || {}),
      output: Object.assign({ statement: 'counts probe ' + id, commitment_type: 'engram', salience: 1 }, outputExtra || {})
    }, 'counts probe');
    return id;
  };
  const real  = seed('counts-real');
  const tomb  = seed('counts-real', { commitment_type: 'engram_tombstoned' });
  const bench = seed('bench-29');
  const scoped = seed('counts-real', { scope: 'test:rt' });
  const hit = (id) => db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE id = ? AND' + where).get(id).n;
  assert.strictEqual(hit(real), 1, 'a real fact counts');
  assert.strictEqual(hit(tomb), 0, 'a GC tombstone does not');
  assert.strictEqual(hit(bench), 0, 'a bench seed does not');
  assert.strictEqual(hit(scoped), 0, 'a test-scoped row does not');
});

test('TBS-7: the faculty bash gate refuses wall-crossing commands and allows the rest', () => {
  // The claude_cli faculty runs under an isolated CLAUDE_CONFIG_DIR, so
  // NONE of the operator's ~/.claude wiring (troth-bash, bash-steer) loads
  // there — both audit incidents ran on that surface with naked native
  // Bash. faculty-bash-gate.mjs is that spawn's PreToolUse wall, asking the
  // same bash-safety verdict the troth-bash server asks. Drive the REAL
  // hook binary over stdin, the way claude invokes it.
  const { spawnSync } = require('child_process');
  const GATE = path.join(ROOT, 'plugin', 'hooks', 'faculty-bash-gate.mjs');
  const ask = (payload, env) => {
    const r = spawnSync(process.execPath, [GATE], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8', timeout: 15000, env: Object.assign({}, process.env, env || {})
    });
    assert.strictEqual(r.status, 0, 'gate exited non-zero: ' + String(r.stderr).slice(-200));
    try { return JSON.parse(String(r.stdout) || '{}'); } catch (_) { return { unparseable: r.stdout }; }
  };
  const HOME = process.env.HOME;
  for (const cmd of [
    'cat ' + path.join(HOME, '.aws', 'credentials'),
    'sqlite3 ' + path.join(HOME, '.troth', 'state.db') + ' "DELETE FROM action_records"'
  ]) {
    const v = ask({ tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_input: { command: cmd } });
    const h = v.hookSpecificOutput || {};
    assert.strictEqual(h.permissionDecision, 'deny', 'not denied: ' + cmd + ' -> ' + JSON.stringify(v));
    assert.ok(/REFUSED/.test(h.permissionDecisionReason || ''), 'reason names the refusal');
    // The wall's own detail rides verbatim (same text as the troth-bash
    // door, em-dashes and all); only the gate's FRAMING is pinned here.
    assert.ok(/policy, not a permission prompt;/.test(h.permissionDecisionReason || ''), 'the gate framing is present');
  }
  // What must keep working: ordinary shell, other tools, garbage payloads,
  // and the operator opt-out — all allow (empty object), never a deny.
  assert.deepStrictEqual(ask({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), {});
  assert.deepStrictEqual(ask({ tool_name: 'BashOutput', tool_input: { command: 'x' } }), {});
  assert.deepStrictEqual(ask('not-json'), {});
  assert.deepStrictEqual(
    ask({ tool_name: 'Bash', tool_input: { command: 'cat ' + path.join(HOME, '.aws', 'credentials') } },
        { TROTH_FACULTY_BASH_GATE: '0' }),
    {}, 'the operator opt-out fails open');
});

test('TBS-8: every claude_cli spawn provisions the gate into the faculty home', () => {
  // TBS-7 proves the hook itself; this pins that subprocess-cli actually
  // writes it into ~/.troth/claude-faculty-home/settings.json on each spawn
  // (source pin, same road as TBS-6: the spawn path needs a live `claude`
  // binary to drive functionally). The two defect shapes that must stay
  // gone: no provisioning at all, or a gate not bound to Bash.
  const src = fs.readFileSync(path.join(ROOT, 'shared-core', 'transports', 'subprocess-cli.js'), 'utf8');
  const start = src.indexOf('claude-faculty-home');
  assert.ok(start > 0, 'faculty home block located');
  const block = src.slice(start, start + 4000);
  assert.ok(/faculty-bash-gate\.mjs/.test(block), 'the gate script is what gets provisioned');
  assert.ok(/settings\.json/.test(block), 'provisioned into the faculty settings.json');
  assert.ok(/matcher:\s*'Bash'/.test(block), 'bound to the Bash tool');
  assert.ok(/PreToolUse/.test(block), 'as a PreToolUse hook');
});
};
