// SPDX-License-Identifier: AGPL-3.0-only
// Archive provenance + reachability (field report): imported
// chunks used to be titled by session uuid with cwd null in ONE flat scope,
// so "remember what we did in <project>" had nothing to hold on to, and the
// auto-recall exclusion (correct: raw fragments out-match curated facts)
// made the archive unreachable in practice. These drive the REAL import
// script on a per-suite HOME and pin: per-project scopes + cwd stamping,
// the one-time healing of legacy flat rows, prefix idempotency across scope
// families, and the recall archive arm that serves depth on request while
// the flood-protection stands.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

console.log('\nArchive provenance (ARCH):');

// The import script resolves everything from HOME, so these tests get their
// own home INSIDE the hermetic one — the suite's state singleton stays
// unpolluted, and a child process with HOME set is exactly how the app and
// the dashboard actually run the importer.
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-prov-'));
fs.mkdirSync(path.join(HOME2, '.troth'), { recursive: true });

// A real-shaped project dir: the encoded name IS a real temp path, so the
// cwd decode verifies on disk and the test is deterministic on any machine.
// HYPHEN-FREE prefix on purpose — a hyphen in the dir name makes the naive
// decode ambiguous (the documented case where cwd stays null and only the
// scope + human tail carry the project); this test pins the HAPPY road.
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapx'));
const encoded = projDir.replace(/\//g, '-');
const uuid = 'e2e0aaaa-1111-2222-3333-444455556666';
const sessionsDir = path.join(HOME2, '.claude', 'projects', encoded);
fs.mkdirSync(sessionsDir, { recursive: true });
const mkline = (role, text) => JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } });
fs.writeFileSync(path.join(sessionsDir, uuid + '.jsonl'), [
  mkline('user', 'We are building the snapx tracker today, remember the deploy key lives in the vault.'),
  mkline('assistant', 'Noted: the snapx tracker deploy flow goes through the vault, never plaintext. '.repeat(3)),
].join('\n') + '\n');

const runImport = () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'troth-import-chats.js'), '--source', 'claude-cli'], {
    encoding: 'utf8', timeout: 120000,
    // CLAUDE_PLUGIN_DATA blanked for the same reason suite-29 blanks it:
    // an earlier suite's live override would point this child at a
    // DIFFERENT state.db than the assertions read (state.js treats '' as
    // unset and falls through to HOME — the hermetic home above).
    env: Object.assign({}, process.env, { HOME: HOME2, TROTH_NO_MODEL_FETCH: '1', CLAUDE_PLUGIN_DATA: '' }),
  });
  assert.strictEqual(r.status, 0, 'import exited clean: ' + String(r.stderr).slice(-300));
  const lines = String(r.stdout).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).result;
};

const childState = (js) => {
  const r = spawnSync(process.execPath, ['-e', js, path.join(ROOT, 'shared-core', 'state.js')], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: HOME2, CLAUDE_PLUGIN_DATA: '' }),
  });
  assert.strictEqual(r.status, 0, 'state child: ' + String(r.stderr).slice(-300));
  return JSON.parse(String(r.stdout).trim().split('\n').pop());
};

test('ARCH-1: a fresh import stamps the project scope, the verified cwd and a human title', () => {
  const res = runImport();
  assert.ok(res.sessions >= 1, 'the session imported: ' + JSON.stringify(res));
  const row = childState(
    'const s = require(process.argv[1]);' +
    'const d = s._dbForQuery();' +
    'const r = d.prepare("SELECT cwd, json_extract(output,\'$.scope\') AS scope, json_extract(output,\'$.statement\') AS stmt FROM action_records WHERE json_extract(output,\'$.scope\') LIKE \'docs:chats:%\' LIMIT 1").get();' +
    'console.log(JSON.stringify(r || null));');
  assert.ok(row, 'a project-scoped archive row exists');
  assert.strictEqual(row.scope, 'docs:chats:' + encoded, 'the scope carries the full encoded project dir');
  assert.strictEqual(row.cwd, projDir, 'the cwd decode verified on disk and was stored');
  assert.ok(String(row.stmt).includes(path.basename(projDir)), 'the title carries the human project tail: ' + String(row.stmt).slice(0, 80));
});

test('ARCH-2: re-running skips via PREFIX idempotency (scope families, not exact match)', () => {
  const res = runImport();
  assert.ok(res.skipped >= 1 && res.sessions === 0,
    'second run must skip the project-scoped session: ' + JSON.stringify(res));
});

test('ARCH-3: legacy flat-scope rows heal in place when their session file still exists', () => {
  childState(
    'const s = require(process.argv[1]);' +
    'const path = require("path");' +
    'const ar = require(path.join(path.dirname(process.argv[1]), "action-record.js"));' +
    'const id = ar.uuidv7();' +
    'const ok = s.recordAction({ id, timestamp: Date.now(), type: "commitment", agent_id: "local-agent", cwd: null,' +
    '  user_id: "default", memory_class: "semantic", audience: "model_visible",' +
    '  input: { source: "import:claude-cli:' + uuid + '" },' +
    '  output: { statement: "legacy flat chunk", commitment_type: "engram", salience: 1, scope: "docs:chats" } }, "legacy flat chunk");' +
    'console.log(JSON.stringify({ ok: !!ok }));');
  const res = runImport();
  assert.ok(res.repaired >= 1, 'the healing pass stamped the legacy row: ' + JSON.stringify(res));
  const row = childState(
    'const s = require(process.argv[1]);' +
    'const d = s._dbForQuery();' +
    'const r = d.prepare("SELECT cwd, json_extract(output,\'$.scope\') AS scope FROM action_records WHERE json_extract(output,\'$.statement\') = \'legacy flat chunk\'").get();' +
    'console.log(JSON.stringify(r || null));');
  assert.ok(row && String(row.scope).startsWith('docs:chats:'), 'flat scope became a project scope: ' + JSON.stringify(row));
  assert.strictEqual(row.cwd, projDir, 'and the healed row carries the verified cwd');
});

test('ARCH-4: the recall archive arm serves the project on request; the flood-protection stands', () => {
  const out = childState(
    'const path = require("path");' +
    'const dir = path.dirname(process.argv[1]);' +
    '(async () => {' +
    '  const recall = require(path.join(dir, "recall.js"));' +
    '  const named = await recall.recall({ query: "what did we build in ' + path.basename(projDir) + '", class: "all", limit: 5 });' +
    '  const generic = await recall.recall({ query: "what deploy key goes through the vault", class: "all", limit: 5 });' +
    '  console.log(JSON.stringify({' +
    '    named_archive: named.filter((r) => r.source === "chat-archive").length,' +
    '    generic_archive: generic.filter((r) => r.source === "chat-archive").length,' +
    '  }));' +
    '})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });');
  assert.ok(out.named_archive >= 1, 'naming the project reaches the archive: ' + JSON.stringify(out));
  assert.strictEqual(out.generic_archive, 0, 'an unnamed query never floods from the archive: ' + JSON.stringify(out));
});

test('ARCH-5: every surface imports with the SAME contract (source pin)', () => {
  // The app's Rust import sends --full; the dashboard endpoint used to
  // spawn bare (raw-only), so "import" MEANT different things on the two
  // surfaces — the two-truths disease again. Pin the proxy spawn.
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  // Anchor on the IMPORT spawn (the one that passes --source), not the
  // first mention of the script — the --detect endpoint spawns it too and
  // detect legitimately carries no mode flag.
  const at = src.indexOf("'--source', src");
  assert.ok(at > 0, 'the dashboard import spawn exists');
  const call = src.slice(at, at + 120);
  assert.ok(/--full/.test(call), 'the dashboard import carries --full like the app: ' + call.slice(0, 120));
});
};
