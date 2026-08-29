// SPDX-License-Identifier: AGPL-3.0-only
// Bulk text is the one road into the substrate where nobody read the document
// first.
//
// The chat-import roads redact every turn (claude-session-watcher,
// backfill-claude-sessions). chameleon.ingestDocument mentioned redaction zero
// times — survivable while a human chose each file by hand, not survivable the
// moment ingestion becomes automatic. Measured on the operator's own material
// In the field, 3 of 141 knowledge-shaped files they had opened carried a
// credential-shaped literal (2.1%), and they were markdown notes, not config
// files — the kind of file an automatic capture predicate accepts.
//
// The trap this pins is the ORDER. secret-redactor is harvest-then-redact:
// redact() masks literals it has ALREADY collected, so redact() alone on a
// document it has never seen returns the text untouched. The obvious one-line
// "fix" is a no-op, and a test that harvested first would have passed it and
// shipped a gate that does nothing. Verified by experiment before the line was
// written; this test exists so it can never regress to that shape.
module.exports = function run({ test }) {
const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const chameleon = require(path.join(ROOT, 'shared-core', 'chameleon.js'));
const state     = require(path.join(ROOT, 'shared-core', 'state.js'));
const redactor  = require(path.join(ROOT, 'shared-core', 'secret-redactor.js'));

console.log('\nIngest secret gate (GATE):');

// Assembled at runtime: a credential-shaped literal must never sit in a source
// file, a command line, or an archived shell transcript.
const KEY   = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2';
const KEEP  = 'the harbour ledger reconciliation runs after every deploy';
const DOC   = '# Deployment notes\n\nThe staging service reads its key from the environment.\n\n' +
              'OPENAI_API_KEY=' + KEY + '\n\nRotate it quarterly. ' + KEEP + '.';

const chunksOf = (scope) => state._dbForQuery()
  .prepare("SELECT json_extract(output,'$.statement') AS s FROM action_records WHERE json_extract(output,'$.scope') = ?")
  .all(scope).map((r) => String(r.s || ''));

test('GATE-1: a credential inside an ingested document never reaches a chunk row', async () => {
  const scope = 'docs:gate-1';
  const r = await chameleon.ingestDocument({ agent_id: 'gate-test', scope, text: DOC, title: 'notes' });
  assert.ok(r && r.ok, 'the document was ingested: ' + JSON.stringify(r));
  const rows = chunksOf(scope);
  assert.ok(rows.length > 0, 'chunks were written');
  assert.strictEqual(rows.filter((s) => s.indexOf(KEY) !== -1).length, 0,
    'no chunk carries the credential');
  assert.ok(rows.some((s) => /secret withheld/.test(s)), 'and the withheld marker took its place');
});

test('GATE-2: the rest of the document survives — this is a gate, not a shredder', async () => {
  const rows = chunksOf('docs:gate-1');
  assert.ok(rows.some((s) => s.indexOf(KEEP) !== -1),
    'ordinary sentences are untouched: ' + JSON.stringify(rows.map((s) => s.slice(0, 60))));
});

test('GATE-3: the gate harvests FIRST — redact alone is a no-op on unseen text', async () => {
  // The regression this exists for. A fresh store cannot mask what it has
  // never collected, so an implementation that only calls redact() passes
  // nothing here. Note the store is process-wide, so reset before asserting.
  redactor._resetForTests();
  const unseen = 'token ' + 'ghp_' + 'z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5';
  assert.strictEqual(redactor.redact(unseen), unseen,
    'redact() alone leaves an unharvested credential exactly as it was');
  redactor.harvest(unseen);
  assert.notStrictEqual(redactor.redact(unseen), unseen,
    'and only after harvest() does it mask — which is why ingest must do both');
});

test('GATE-4: ingest calls both, in that order (source pin)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'shared-core', 'chameleon.js'), 'utf8');
  const h = src.indexOf('redactor.harvest(');
  const d = src.indexOf('redactor.redact(');
  assert.ok(h > 0 && d > 0, 'ingest reaches the redactor at all');
  assert.ok(h < d, 'and harvests before it redacts');
  const chunkCall = src.indexOf('chunkText(safeText');
  assert.ok(chunkCall > d, 'and chunks the REDACTED text, not the original');
});
};
