// SPDX-License-Identifier: AGPL-3.0-only
// Documents are read, not memorised.
//
// `troth knowledge import` would chunk documents itself and write every
// piece as a type='lesson' ActionRecord — semantic, model-visible. On the
// substrate this was measured on, 3,785 of those "lessons" were whole
// research documents, and recall served them back as memories the partner
// had supposedly formed. The proper road existed the whole time: spool a
// pointer, let the reader drain it through the same gate, redaction,
// chunking and scoping that every other document passes.
//
// These drive the REAL command in a child process on a throwaway HOME, the
// way an operator's shell would.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nKnowledge import road (KNI):');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kni-home-'));
fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'kni-docs-'));
fs.writeFileSync(path.join(docs, 'research.md'), '# Findings\n\n' + 'A durable note about caching. '.repeat(40));
// credential-shaped fixture, assembled so nothing reads it as a live key
fs.writeFileSync(path.join(docs, 'creds.pem'), ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') + '\nnope\n');

const env = Object.assign({}, process.env, {
  HOME, _TROTH_TEST_HOME: HOME,
  STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
});
const runCmd = (args) => cp.spawnSync('node', ['-e',
  'require(' + JSON.stringify(path.join(ROOT, 'bin', 'cmd-knowledge.js')) +
  ')({command:"knowledge",passthrough:' + JSON.stringify(args) + '})'],
  { env, encoding: 'utf8' });

let db = null;
const openDb = () => {
  if (db) return db;
  const Database = require('better-sqlite3');
  db = new Database(env.STATE_DB_PATH, { readonly: true, fileMustExist: true });
  return db;
};

test('KNI-1: an import queues pointers for the reader and writes no lessons at all', () => {
  const r = runCmd(['import', docs]);
  assert.ok(/queued for reading/.test(r.stdout), 'the command says what it did: ' + r.stdout.slice(0, 120));
  const d = openDb();
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM knowledge_spool').get().n, 1,
    'one document, one pointer — and the credential file never entered');
  const row = d.prepare('SELECT kind, ref, sha, why FROM knowledge_spool').get();
  assert.strictEqual(row.kind, 'file');
  assert.ok(/research\.md$/.test(row.ref), 'the pointer names the document');
  assert.ok(row.sha && row.sha.length >= 32, 'and carries its content sha for change detection');
  assert.ok(/operator import/.test(row.why), 'and WHY it was queued, for the queue viewer');
  assert.strictEqual(d.prepare("SELECT COUNT(*) n FROM action_records WHERE type='lesson'").get().n, 0,
    'the old road is closed: zero document-lessons');
});

test('KNI-2: re-importing an unchanged file is a no-op, an edited file queues again', () => {
  const again = runCmd(['import', docs]);
  assert.ok(/already known:\s+1/.test(again.stdout), 'unchanged: ' + again.stdout.match(/already known.*$/m));
  assert.strictEqual(openDb().prepare('SELECT COUNT(*) n FROM knowledge_spool').get().n, 1, 'still one pointer');
  fs.appendFileSync(path.join(docs, 'research.md'), '\nA new paragraph.\n');
  const edited = runCmd(['import', docs]);
  assert.ok(/documents queued:\s+1/.test(edited.stdout), 'a new sha is new work');
  assert.strictEqual(openDb().prepare('SELECT COUNT(*) n FROM knowledge_spool').get().n, 2,
    'the edited version queues beside the read history, keyed by sha');
});

test('KNI-3: a dry run discovers and writes nothing', () => {
  const before = openDb().prepare('SELECT COUNT(*) n FROM knowledge_spool').get().n;
  const r = runCmd(['import', docs, '--dry-run']);
  assert.ok(/Dry run/.test(r.stdout), 'says so');
  assert.strictEqual(openDb().prepare('SELECT COUNT(*) n FROM knowledge_spool').get().n, before, 'and did nothing');
});

test('KNI-4: stats answers from the reservoir, and the lesson road is gone (source pin)', () => {
  const r = runCmd(['stats']);
  assert.ok(/waiting to be read/.test(r.stdout), 'stats reads the spool: ' + r.stdout.slice(0, 100));
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'cmd-knowledge.js'), 'utf8');
  assert.ok(/spoolKnowledge/.test(src), 'the import calls the reservoir');
  assert.ok(!/type: 'lesson'/.test(src.split('── import ─')[1] || src),
    'and the import section writes no lesson records');
});
};
