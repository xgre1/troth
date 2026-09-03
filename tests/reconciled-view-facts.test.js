#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A fact question read from the live substrate: the ledger says nothing
// when no line is about the question, every statement carries its day, an
// older figure names the newer statement that replaces it, and the cast
// renders names only.
const assert = require('assert');
const path = require('path');
const { buildReconciledView } = require(path.join(__dirname, '..', 'shared-core', 'reconciled-view.js'));
const ic = require(path.join(__dirname, '..', 'shared-core', 'instance-consolidation.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== reconciled view, fact questions ===\n');

const MAY = Date.UTC(2026, 4, 4), SEP = Date.UTC(2026, 8, 2);
const Q = 'How much do I earn from Northwind and how many days a week do I work there?';
const items = [
  { source: 'instance-pool', id: 'i1', statement: '[instance] activity: run the suite — Running a 100-question check with a local model [completed] (attested ×1)', refs: ['dialogue.turn:r5'], _kind: 'activity', _entity: 'the suite', _cos: 0.21 },
  { source: 'instance-pool', id: 'i2', statement: '[instance] activity: worked orea — Working as a software engineer using methodology [completed] (attested ×1)', refs: [], _kind: 'activity', _entity: 'orea', _cos: 0.18 },
  { source: 'instance-pool', id: 'i3', statement: '[instance] activity: holding stamp collecting — Sorting a stamp collection on weekends [completed] (attested ×1)', refs: [], _kind: 'activity', _entity: 'stamp collecting', _cos: 0.24 },
  { source: 'identity-cast', id: 'c1', statement: '[cast] Contoso — vendor of the build tool (also: contosso, i mana poutanes gioi tis contoso)', link_names: ['contoso'] },
  { source: 'identity-cast', id: 'c2', statement: '[cast] orea — colleague (also: sinexise)', link_names: ['orea'] },
  { source: 'identity-cast', id: 'c3', statement: '[cast] Nikos — colleague', link_names: ['nikos'] },
  { source: 'commitment', id: 'r1', statement: 'User is currently employed by Northwind, earning €900/month for 2 days/week of work.', ts: MAY },
  { source: 'commitment', id: 'r2', statement: 'CORRECTED (supersedes the older figure): the Northwind part-time deal is €800/month for 2 days a week, Wednesday and Thursday.', ts: SEP },
  { source: 'dialogue-window', id: 'r5', statement: 'user: run the 100 with the local model', ts: SEP },
];

t('a fact question the ledger does not touch renders no ledger line', () => {
  const v = buildReconciledView(items, { question: Q, noun_head: 'earn', reference_ts: SEP });
  assert.strictEqual(v.ledger.length, 0, v.ledger.map((l) => l.statement).join(' | '));
  assert.strictEqual(v.aside.length, 3);
  assert.ok(v.aside.every((a) => /not about the asked subject/.test(a.reason)), v.aside.map((a) => a.reason).join(' | '));
});

t('a line with no cosine at all is left for the reader', () => {
  const noCos = items.map((it) => it.source === 'instance-pool' ? Object.assign({}, it, { _cos: undefined }) : it);
  const v = buildReconciledView(noCos, { question: Q, noun_head: 'earn', reference_ts: SEP });
  assert.strictEqual(v.ledger.length, 3);
});

t('every statement carries its day and the older figure names the newer statement that wins', () => {
  const out = buildReconciledView(items, { question: Q, noun_head: 'earn', reference_ts: SEP }).render();
  const s1 = out.split('\n').find((l) => /^S1\./.test(l));
  const s2 = out.split('\n').find((l) => /^S2\./.test(l));
  assert.ok(/\[2026-05-04\]/.test(s1), s1);
  assert.ok(/\[2026-09-02\]/.test(s2), s2);
  assert.ok(/S2 is newer on this subject and wins/.test(s1), s1);
  assert.ok(!/is newer on this subject/.test(s2), s2);
});

t('a fact question with no ledger line renders no cast at all', () => {
  const out = buildReconciledView(items, { question: Q, noun_head: 'earn', reference_ts: SEP }).render();
  assert.ok(!/^C\d+\./m.test(out), out.split('\n').filter((l) => /^C\d/.test(l)).join(' | '));
  assert.ok(!/Known people and entities/.test(out));
});

t('the cast renders names only: an insult leaves the aliases and a word that is nobody\'s name leaves the cast', () => {
  // Beside a ledger line about the subject the cast renders, cleaned.
  const withLedger = items.map((it) => it.id === 'i1' ? Object.assign({}, it, { statement: '[instance] activity: worked Northwind — Two days a week at the office [completed] (attested ×1)', _entity: 'Northwind', _cos: 0.6 }) : it);
  const out = buildReconciledView(withLedger, { question: Q, noun_head: 'earn', reference_ts: SEP }).render();
  assert.ok(/C\d+\. Contoso — vendor of the build tool \(also: contosso\)/.test(out), out.split('\n').filter((l) => /^C\d/.test(l)).join(' | '));
  assert.ok(!/poutanes/.test(out), 'no insult rendered');
  assert.ok(!/orea — colleague/.test(out), 'orea is not a person');
  assert.ok(/Nikos — colleague/.test(out), 'a real colleague stays');
});

t('for a question about what is owned, the turns that only attest a set-aside activity are marked, never judged', () => {
  const own = [
    { source: 'instance-pool', id: 'a1', statement: '[instance] activity: run the suite — Running a check [completed] (attested ×2)', refs: ['dialogue.turn:t1', 'dialogue.turn:t2'], _kind: 'activity', _qualifier: 'run', _entity: 'the suite', _cos: 0.31 },
    { source: 'commitment', id: 'f1', statement: 'User has a road bike', ts: MAY },
    { source: 'dialogue-window', id: 't1', statement: 'user: run the 100 check on the desk machine', ts: SEP },
    { source: 'dialogue-window', id: 't2', statement: 'user: run it again with the other reader', ts: SEP },
  ];
  const out = buildReconciledView(own, { question: 'How many road bikes do I have?', noun_head: 'bikes', head_phrase: 'road bikes', reference_ts: SEP }).render();
  const lines = out.split('\n');
  assert.ok(lines.some((l) => /^S2. \[-\] user: run the 100/.test(l)), lines.filter((l) => /^S\d/.test(l)).join(' | '));
  assert.ok(lines.some((l) => /^S1\. \[\+\] User has a road bike/.test(l)), lines.filter((l) => /^S\d/.test(l)).join(' | '));
});

t('the extractor never writes the user, the assistant or a word of the chat as an entity', () => {
  const turns = [{ user_text: 'orea sinexise, I finished the sandbox work today and Nikos reviewed it' }];
  const text = JSON.stringify({ identities: [], instances: [
    { kind: 'activity', entity: 'user', description: 'Working on the sandbox', date_iso: null, status: 'completed', qualifier: 'finished', quantity: null, turn_idxs: [0], quote: 'finished the sandbox work' },
    { kind: 'activity', entity: 'orea', description: 'Working as a software engineer', date_iso: null, status: 'completed', qualifier: 'worked', quantity: null, turn_idxs: [0], quote: 'orea sinexise' },
    { kind: 'activity', entity: 'Nikos', description: 'Reviewed the sandbox work', date_iso: null, status: 'completed', qualifier: 'reviewed', quantity: null, turn_idxs: [0], quote: 'Nikos reviewed it' }
  ]});
  const out = ic.parseCombinedExtractionV2(text, 1, turns);
  assert.deepStrictEqual(out.instances.map((i) => i.entity), ['Nikos'], JSON.stringify(out.instances.map((i) => i.entity)));
});

console.log('\nreconciled-view-facts: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
