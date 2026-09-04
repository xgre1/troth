// SPDX-License-Identifier: AGPL-3.0-only
// Import atomicity (field question): "what if someone closes
// the laptop mid-import?" A session's ingest marker IS its chunk rows, so
// a half-written session would read as "already imported" and its
// missing tail could never be completed — silent, permanent, invisible.
// The cure is one synchronous transaction per document (chameleon.js):
// an interrupted import leaves NOTHING behind and the next run ingests
// the session whole; a completed one is complete; re-runs skip. These
// tests kill a real child process mid-write (a deterministic stand-in for
// the power cut) and assert all-or-nothing on disk.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

console.log('\nImport atomicity (ATOM):');

const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atomimp'));
fs.mkdirSync(path.join(HOME2, '.troth'), { recursive: true });
const SRC = 'import:claude-cli:atom-1';

// A document long enough to produce a healthy chunk count.
const BIGDOC = Array.from({ length: 260 }, (_, i) =>
  'Line ' + i + ': the atom test conversation keeps enough words per line that the chunker produces a real multi-chunk document for the interrupt to land inside.'
).join('\n');

// Runs ingestDocument in a CHILD with its own HOME. killAt > 0 patches
// engram.recordEngram (the require-cache singleton chameleon calls) to
// die mid-transaction on the Nth chunk write — the same machine state a
// power cut leaves: an uncommitted transaction, which must roll back.
const runChild = (killAt) => {
  const js =
    "process.env.HOME = " + JSON.stringify(HOME2) + ";" +
    "process.env.CLAUDE_PLUGIN_DATA = '';" +
    "const engram = require(process.argv[1]);" +
    "const killAt = " + killAt + ";" +
    "if (killAt > 0) { const orig = engram.recordEngram; let n = 0;" +
    "  engram.recordEngram = function (o) { n++; if (n >= killAt) process.exit(9); return orig(o); }; }" +
    "const ch = require(process.argv[2]);" +
    "ch.ingestDocument({ agent_id: 'atom-test', scope: 'docs:chats', cwd: null," +
    "  text: " + JSON.stringify(BIGDOC) + ", title: 'atomtest', source: " + JSON.stringify(SRC) + " })" +
    "  .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })" +
    "  .catch((e) => { console.error(e && e.stack || e); process.exit(1); });";
  return spawnSync(process.execPath, ['-e', js,
    path.join(ROOT, 'shared-core', 'engram.js'), path.join(ROOT, 'shared-core', 'chameleon.js')], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: HOME2, TROTH_NO_MODEL_FETCH: '1', CLAUDE_PLUGIN_DATA: '' })
  });
};

const childCount = () => {
  const js =
    "process.env.HOME = " + JSON.stringify(HOME2) + ";" +
    "process.env.CLAUDE_PLUGIN_DATA = '';" +
    "const s = require(process.argv[1]);" +
    "const ch = require(process.argv[2]);" +
    "const n = s._dbForQuery().prepare(\"SELECT COUNT(*) AS n FROM action_records WHERE json_extract(input,'$.source') = ?\").get(" + JSON.stringify(SRC) + ").n;" +
    "console.log(JSON.stringify({ n: n, ingested: (ch.listIngestedSourcesPrefix('docs:chats') || []) }));";
  const r = spawnSync(process.execPath, ['-e', js,
    path.join(ROOT, 'shared-core', 'state.js'), path.join(ROOT, 'shared-core', 'chameleon.js')], {
    encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { HOME: HOME2, CLAUDE_PLUGIN_DATA: '' })
  });
  assert.strictEqual(r.status, 0, 'count child clean: ' + String(r.stderr).slice(-200));
  return JSON.parse(String(r.stdout).trim().split('\n').pop());
};

test('ATOM-1: a mid-write death leaves NOTHING — no chunks, no false "already imported" marker', () => {
  const r = runChild(3);
  assert.strictEqual(r.status, 9, 'the child died mid-transaction as scripted: status=' + r.status);
  const c = childCount();
  assert.strictEqual(c.n, 0, 'zero rows survive an interrupted ingest (no half session): ' + JSON.stringify(c));
  assert.ok(!c.ingested.includes(SRC), 'so the session never reads as imported and WILL be retried whole');
});

test('ATOM-2: the retry ingests the session whole, and completeness is what marks it done', () => {
  const r = runChild(0);
  assert.strictEqual(r.status, 0, 'clean ingest: ' + String(r.stderr).slice(-200));
  const out = JSON.parse(String(r.stdout).trim().split('\n').pop());
  assert.ok(out.ok && out.chunks >= 5, 'a real multi-chunk document: ' + JSON.stringify({ ok: out.ok, chunks: out.chunks }));
  assert.strictEqual(out.recorded, out.chunks, 'every chunk landed (all-or-nothing, the ALL side)');
  const c = childCount();
  assert.strictEqual(c.n, out.chunks, 'the db holds exactly the full set — no duplicates from the interrupted attempt');
  assert.ok(c.ingested.includes(SRC), 'and only NOW does the session read as imported (re-runs skip it)');
});

test('ATOM-3: one importer at a time — a live lock is honored, a dead one is reclaimed', () => {
  // The auto-sync task and the dashboard button share the same importer;
  // without the lock both can read provenance before either writes and
  // land the same session twice. Live holder → the second run says so and
  // exits clean; a dead holder's stale lock never wedges import forever.
  const LOCK = path.join(HOME2, '.troth', 'import.lock');
  fs.writeFileSync(LOCK, String(process.pid));   // this test process IS a live holder
  const spawnImport = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'troth-import-chats.js'), '--source', 'claude-cli'], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: HOME2, TROTH_NO_MODEL_FETCH: '1', CLAUDE_PLUGIN_DATA: '' })
  });
  let r = spawnImport();
  assert.strictEqual(r.status, 0, 'locked-out import exits clean: ' + String(r.stderr).slice(-200));
  let res = JSON.parse(String(r.stdout).trim().split('\n').pop()).result;
  assert.ok(res.skipped_locked === true, 'a LIVE lock holder wins: ' + JSON.stringify(res));
  fs.writeFileSync(LOCK, '999999999');           // a pid that cannot exist → dead holder
  r = spawnImport();
  assert.strictEqual(r.status, 0, 'reclaim run exits clean: ' + String(r.stderr).slice(-200));
  res = JSON.parse(String(r.stdout).trim().split('\n').pop()).result;
  assert.ok(!res.skipped_locked, 'a dead holder is reclaimed and the import proceeds: ' + JSON.stringify(res));
  assert.ok(!fs.existsSync(LOCK), 'and the lock is released on exit');
});
};
