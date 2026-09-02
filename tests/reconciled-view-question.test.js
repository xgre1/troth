#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// reconciled-view, question-shaped: the ledger holds the whole class, the
// question asks for a slice. Fixtures are the measured shapes from the
// LongMemEval probe (2026-09-02): "acquired in the last month" over a
// 28-line plant ledger, "items of clothing" over purchases of fishing hooks.
const assert = require('assert');
const { buildReconciledView } = require('../shared-core/reconciled-view.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== reconciled view, question-shaped ===\n');

const DAY = 86400000;
const ASKED = Date.UTC(2023, 5, 15);            // 2023-06-15
const inWin = ASKED - 10 * DAY;                 // 2023-06-05
const outWin = ASKED - 200 * DAY;               // 2022-11-27

const plants = [
  { source: 'instance-pool', id: 'i1', statement: '[instance] purchase: bought peace lily — Bought a peace lily from a nursery [completed] (attested ×1)', refs: ['dialogue.turn:r1'], _attested_ts: inWin, _cos: 0.62 },
  { source: 'instance-pool', id: 'i2', statement: '[instance] purchase: bought snake plant — Bought a snake plant [completed] (attested ×1)', refs: ['dialogue.turn:r2'], _attested_ts: outWin, _cos: 0.60 },
  { source: 'instance-pool', id: 'i3', statement: '[instance] activity: misting fern — Misting a fern every other day [recurring] (attested ×1)', refs: ['dialogue.turn:r3'], _attested_ts: inWin, _cos: 0.12 },
  { source: 'instance-pool', id: 'i4', statement: '[instance] purchase: got a pothos — Got a pothos cutting from a friend [completed, 2023-06-01] (attested ×1)', refs: [], _attested_ts: null, _cos: 0.58 },
  { source: 'dialogue-window', id: 'r1', statement: 'user: I bought a peace lily from the nursery today.', ts: inWin },
  { source: 'dialogue-window', id: 'r2', statement: 'user: Last autumn I bought a snake plant.', ts: outWin },
  { source: 'dialogue-window', id: 'r3', statement: 'user: I mist my fern every other day.', ts: inWin },
  { source: 'dialogue-window', id: 'r4', statement: 'user: Any tips for repotting?', ts: inWin },
];

t('without a question nothing is set aside and no dates are added (previous behaviour)', () => {
  const v = buildReconciledView(plants, { noun_head: 'plants' });
  assert.strictEqual(v.ledger.length, 4);
  assert.strictEqual(v.aside.length, 0);
  const out = v.render();
  assert.ok(out.indexOf('Set aside') < 0);
  assert.ok(out.indexOf('first mentioned') < 0);
  assert.ok(out.indexOf('[-]') < 0);
});

t('a time window keeps the dated lines inside it and sets the rest aside', () => {
  const v = buildReconciledView(plants, { noun_head: 'plants', question: 'How many plants did I acquire in the last month?', reference_ts: ASKED });
  assert.ok(v.window && v.window.since < inWin && v.window.until >= ASKED, 'window parsed from the question');
  const kept = v.ledger.map(l => l.statement);
  assert.ok(kept.some(s => /peace lily/.test(s)), 'in-window purchase kept');
  assert.ok(kept.some(s => /pothos/.test(s)), 'a line with a pinned in-window date kept');
  assert.ok(!kept.some(s => /snake plant/.test(s)), 'out-of-window purchase set aside');
  assert.ok(!kept.some(s => /misting fern/.test(s)), 'unrelated activity (low cosine, no noun head) set aside');
  assert.strictEqual(v.aside.length, 2);
  assert.deepStrictEqual(v.aside.map(a => a.reason).sort(), ['not about the asked subject', 'outside the time window']);
});

t('kept lines are numbered contiguously and carry the day they were first mentioned', () => {
  const v = buildReconciledView(plants, { noun_head: 'plants', question: 'How many plants did I acquire in the last month?', reference_ts: ASKED });
  assert.deepStrictEqual(v.ledger.map(l => l.n), [1, 2]);
  const out = v.render();
  assert.ok(/L1\. .*peace lily.*\[first mentioned 2023-06-05\]/.test(out), out.split('\n').slice(0, 4).join(' | '));
  assert.ok(/L2\. .*pothos.*\[completed, 2023-06-01\]/.test(out) && !/L2\. .*first mentioned/.test(out), 'a pinned date is not doubled');
  assert.ok(out.indexOf('The question spans 1 month') >= 0, 'the window is stated once');
  assert.ok(/Set aside, not listed: .*1 ledger line outside the time window.*1 ledger line not about the asked subject/.test(out) ||
            /Set aside, not listed: .*1 ledger line not about the asked subject.*1 ledger line outside the time window/.test(out), 'one summary line for what was set aside');
});

t('a statement behind a line set aside for a CERTAIN reason (window, status) is marked; a heuristic reason leaves it open', () => {
  const v = buildReconciledView(plants, { noun_head: 'plants', question: 'How many plants did I acquire in the last month?', reference_ts: ASKED });
  const out = v.render();
  assert.ok(/S2\. \[-\] user: Last autumn/.test(out), 'snake plant statement (outside the window) carries the - mark');
  assert.ok(/S3\. \[\+\] user: I mist/.test(out), 'fern statement (subject heuristic) stays open for judgment');
  assert.ok(/S4\. \[\+\] user: Any tips/.test(out), 'an uncovered statement still carries +');
  assert.ok(out.indexOf('"-" marks one that attests only a set-aside line') >= 0, 'legend explains the mark');
});

t('several verbs in one question: a line is kept when any named family accepts it', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] purchase: got B-29 kit — Purchased a B-29 model kit [completed] (attested ×1)', refs: [], _kind: 'purchase', _qualifier: 'got', _status: 'completed', _entity: 'B-29 kit', _facets: ['got'], _cos: 0.6 },
    { source: 'instance-pool', id: 'i2', statement: '[instance] activity: finished Spitfire — Finished painting a model kit [completed] (attested ×1)', refs: [], _kind: 'activity', _qualifier: 'finished', _status: 'completed', _entity: 'Spitfire', _facets: ['finished'], _cos: 0.5 },
    { source: 'instance-pool', id: 'i3', statement: '[instance] activity: using AK products — Using weathering products [recurring] (attested ×1)', refs: [], _kind: 'activity', _qualifier: 'using', _status: 'recurring', _entity: 'AK products', _facets: ['using'], _cos: 0.5 },
    { source: 'instance-pool', id: 'i4', statement: '[instance] activity: planning B-29 — Planning to work on the B-29 kit [planned] (attested ×1)', refs: [], _kind: 'activity', _qualifier: 'planning', _status: 'planned', _entity: 'B-29', _facets: ['planning'], _cos: 0.6 },
  ];
  const v = buildReconciledView(items, { noun_head: 'kits', head_phrase: 'model kits', question: 'How many model kits have I worked on or bought?' });
  assert.deepStrictEqual(v.families, ['acquire', 'work']);
  const kept = v.ledger.map(l => l.statement);
  assert.ok(kept.some(s => /B-29 kit/.test(s)) && kept.some(s => /Spitfire/.test(s)), 'purchase and work-verb activity both kept');
  assert.ok(!kept.some(s => /AK products/.test(s)), 'an activity with a non-work verb is set aside');
  assert.ok(!kept.some(s => /planning B-29/.test(s)), 'a planned line is set aside for a question about what happened');
});

t('an occurrence needs the head or a high cosine; an object keeps the low floor', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] event: attended Rachel — Attended cousin Rachel\'s wedding [completed] (attested ×1)', refs: [], _kind: 'event', _qualifier: 'attended', _status: 'completed', _entity: 'Rachel', _facets: ['attended'], _cos: 0.40 },
    { source: 'instance-pool', id: 'i2', statement: '[instance] event: attended barbecue — Ate ribs at a neighbour\'s barbecue [completed] (attested ×1)', refs: [], _kind: 'event', _qualifier: 'attended', _status: 'completed', _entity: 'barbecue', _facets: ['attended'], _cos: 0.40 },
    { source: 'instance-pool', id: 'i3', statement: '[instance] purchase: got boots — Bought boots from Zara [completed] (attested ×1)', refs: [], _kind: 'purchase', _qualifier: 'got', _status: 'completed', _entity: 'boots', _facets: ['got'], _cos: 0.35 },
    { source: 'instance-pool', id: 'i4', statement: '[instance] event: attended Jen — Attended a friend\'s wedding at a barn [completed] (attested ×1)', refs: [], _kind: 'event', _qualifier: 'attended', _status: 'completed', _entity: 'Jen', _facets: ['attended'], _cos: 0.43 },
    { source: 'instance-pool', id: 'i5', statement: '[instance] event: attended Emily — Attended Emily\'s wedding downtown [completed] (attested ×1)', refs: [], _kind: 'event', _qualifier: 'attended', _status: 'completed', _entity: 'Emily', _facets: ['attended'], _cos: 0.50 },
  ];
  const w = buildReconciledView([items[0], items[1], items[3], items[4]], { noun_head: 'weddings', question: 'How many weddings have I attended?' });
  assert.deepStrictEqual(w.ledger.map(l => /wedding/.test(l.statement)), [true, true, true], 'the barbecue is not a wedding; the three weddings stay');
  const c = buildReconciledView([items[2]], { noun_head: 'clothing', question: 'How many items of clothing did I buy?' });
  assert.strictEqual(c.ledger.length, 1, 'boots pass as clothing on the object floor');
});

t('when the strict floor would leave fewer than three lines, the object floor applies to every kind', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] visit: got back from Muir Woods — Day hike to Muir Woods [completed] (attested ×1)', refs: [], _kind: 'visit', _qualifier: 'got back', _status: 'completed', _entity: 'Muir Woods', _facets: ['got back'], _cos: 0.30 },
    { source: 'instance-pool', id: 'i2', statement: '[instance] activity: drove Highway 1 — Drove along Highway 1 [completed] (attested ×1)', refs: [], _kind: 'activity', _qualifier: 'drove', _status: 'completed', _entity: 'Highway 1', _facets: ['drove'], _cos: 0.34 },
    { source: 'instance-pool', id: 'i3', statement: '[instance] activity: practices yoga — Yoga on Mondays [recurring] (attested ×1)', refs: [], _kind: 'activity', _qualifier: 'practices', _status: 'recurring', _entity: 'yoga', _facets: ['practices'], _cos: 0.20 },
  ];
  const v = buildReconciledView(items, { noun_head: 'trips', question: 'What is the order of the three trips I took?' });
  assert.strictEqual(v.ledger.length, 2, 'the two plausible lines survive on the relaxed floor; yoga does not');
});

t('the noun head keeps a low-cosine line when the line names it', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] purchase: got jacket — Bought a denim jacket [completed] (attested ×1)', refs: [], _attested_ts: inWin, _cos: 0.10 },
    { source: 'instance-pool', id: 'i2', statement: '[instance] purchase: got hooks — Purchased new fishing hooks [completed] (attested ×1)', refs: [], _attested_ts: inWin, _cos: 0.10 },
    { source: 'instance-pool', id: 'i3', statement: '[instance] purchase: clothing haul — Clothing from the outlet [completed] (attested ×1)', refs: [], _attested_ts: inWin, _cos: 0.10 },
  ];
  const v = buildReconciledView(items, { noun_head: 'clothing', question: 'How many items of clothing did I buy?', reference_ts: ASKED });
  assert.deepStrictEqual(v.ledger.map(l => /clothing/.test(l.statement)), [true], 'only the line naming the head survives a low cosine');
  assert.strictEqual(v.aside.length, 2);
});

t('no window and no cosine information: a question alone sets nothing aside', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] visit: went to Tokyo [completed] (attested ×1)', refs: [] },
    { source: 'instance-pool', id: 'i2', statement: '[instance] visit: went to Osaka [completed] (attested ×1)', refs: [] },
  ];
  const v = buildReconciledView(items, { noun_head: 'trips', question: 'How many trips have I taken?' });
  assert.strictEqual(v.ledger.length, 2);
  assert.strictEqual(v.aside.length, 0);
  assert.ok(/\[undated\]/.test(v.render()), 'a line without any date says so when a question is asked');
});

t('stated totals are read from the user\'s own words, dated, newest first', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] activity: wrote story — Wrote a short story about a lighthouse [completed] (attested ×1)', refs: ['dialogue.turn:r1'], _kind: 'activity', _qualifier: 'wrote', _status: 'completed', _entity: 'lighthouse story', _facets: ['wrote'], _cos: 0.5, _attested_ts: ASKED - 40 * DAY },
    { source: 'dialogue-window', id: 'r1', statement: 'user: I wrote a short story about a lighthouse last week. / asst: Lovely, that makes it your fifth, I think.', ts: ASKED - 40 * DAY },
    { source: 'dialogue-window', id: 'r2', statement: 'user: I have written four short stories since I started writing regularly.', ts: ASKED - 60 * DAY },
    { source: 'dialogue-window', id: 'r3', statement: 'user: Just finished my seventh short story!', ts: ASKED - 5 * DAY },
  ];
  const v = buildReconciledView(items, { noun_head: 'stories', question: 'How many short stories have I written since I started writing regularly?', reference_ts: ASKED });
  assert.deepStrictEqual(v.totals.map(t => t.value), [7, 4], 'newest first: the running seventh, then the stated four; the assistant\'s fifth is not counted');
  const out = v.render();
  assert.ok(/T1\. \[.*\] 7 \(running count: "seventh short story"\) \(S3\)   <- newest/.test(out), out.split('\n').filter(l => /^T/.test(l)).join(' | '));
  assert.ok(out.indexOf('the newest stated total wins') >= 0, 'the rule is stated once');
});

t('a pronoun total counts when the head is named; designations and measures never do', () => {
  const items = [
    { source: 'dialogue-window', id: 'r1', statement: 'user: Have you tried any good Korean restaurants lately? I\'ve tried four different ones so far. / asst: Sure!', ts: ASKED - 5 * DAY },
    { source: 'dialogue-window', id: 'r2', statement: 'user: I\'ve tried three different ones recently, each Korean restaurant has its own style.', ts: ASKED - 50 * DAY },
    { source: 'dialogue-window', id: 'r3', statement: 'user: I picked up a Revell F-15 Eagle kit and a 1/72 scale B-29 bomber model kit; my first meal kit arrived too.', ts: ASKED - 3 * DAY },
  ];
  const k = buildReconciledView(items, { noun_head: 'restaurants', question: 'How many Korean restaurants have I tried?', reference_ts: ASKED });
  assert.deepStrictEqual(k.totals.map(t => t.value), [4, 3]);
  const m = buildReconciledView(items, { noun_head: 'kits', head_phrase: 'model kits', question: 'How many model kits have I bought?', reference_ts: ASKED });
  assert.deepStrictEqual(m.totals.map(t => t.value), [], 'F-15, 1/72, B-29 and a meal kit state no total of model kits: ' + JSON.stringify(m.totals));
  const w = buildReconciledView([{ source: 'dialogue-window', id: 'r9', statement: 'user: I have been to a few weddings recently and one of them was my cousin\'s wedding at a vineyard.', ts: ASKED }], { noun_head: 'weddings', question: 'How many weddings have I attended?', reference_ts: ASKED });
  assert.deepStrictEqual(w.totals, [], '"one of them was" is a partitive, never a total');
});

console.log('\nreconciled-view-question: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
