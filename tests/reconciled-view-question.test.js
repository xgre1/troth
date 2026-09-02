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
  assert.ok(out.indexOf('said on') < 0);
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
  assert.ok(/L1\. .*peace lily.*\[said on 2023-06-05; the words say when it happened\]/.test(out), out.split('\n').slice(0, 4).join(' | '));
  assert.ok(/L2\. .*pothos.*\[completed, 2023-06-01\]/.test(out) && !/L2\. .*said on/.test(out), 'a pinned date is not doubled');
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

t('a request-shaped question lists what the user said about themselves first, newest first', () => {
  const items = [
    { source: 'dialogue-window', id: 'r1', statement: 'user: As an aspiring stand-up comedian, I\'m looking for advice on how to improve my craft. / asst: Sure.', ts: ASKED - 30 * DAY },
    { source: 'dialogue-window', id: 'r2', statement: 'user: I\'ve been trying to eat more plant-based meals lately. Any slow cooker ideas? / asst: Plenty.', ts: ASKED - 2 * DAY },
    { source: 'dialogue-window', id: 'r3', statement: 'asst: You are clearly a night owl.', ts: ASKED - 1 * DAY },
  ];
  const v = buildReconciledView(items, { question: 'Can you recommend a show or movie for me to watch tonight?', reference_ts: ASKED });
  assert.deepStrictEqual(v.about.map(a => a.kind), ['constraint', 'role'], 'newest first; the assistant\'s description of the user is not counted');
  const out = v.render();
  assert.ok(out.indexOf('About the user, in their own words') === 0, 'the block leads the view');
  assert.ok(/A2\. \[.*\] aspiring stand-up comedian \(who they are\) \(S1\)/.test(out), out.split('\n').slice(0, 3).join(' | '));
  const plain = buildReconciledView(items, { question: 'How many shows did I watch?', reference_ts: ASKED });
  assert.strictEqual(plain.about.length, 0, 'a count question carries no about block');
});

t('the model-read shape drives the view in any language; the patterns stand in without a model', async () => {
  const { shapeQuestion, shapeByPatterns } = require('../shared-core/question-shape.js');
  const fake = async () => JSON.stringify({ count: true, request: false, head: 'φυτό', verb_family: 'acquire', past: true, window_days: 30, window_kind: 'relative' });
  const shape = await shapeQuestion('Πόσα φυτά απέκτησα τον τελευταίο μήνα;', { llmCall: fake, reference_ts: ASKED });
  assert.strictEqual(shape.source, 'model');
  assert.deepStrictEqual(shape.families, ['acquire']);
  assert.ok(shape.window && shape.window.since === ASKED - 30 * DAY);
  const v = buildReconciledView(plants, { question: 'Πόσα φυτά απέκτησα τον τελευταίο μήνα;', reference_ts: ASKED, shape });
  const kept = v.ledger.map(l => l.statement);
  assert.ok(kept.some(s => /peace lily/.test(s)) && kept.some(s => /pothos/.test(s)), 'in-window acquisitions kept from a Greek question');
  assert.ok(!kept.some(s => /snake plant/.test(s)) && !kept.some(s => /misting fern/.test(s)), 'window and verb family set the rest aside');
  const fallback = await shapeQuestion('How many plants did I acquire in the last month?', { reference_ts: ASKED });
  assert.strictEqual(fallback.source, 'patterns');
  assert.deepStrictEqual(fallback.families, ['acquire']);
  assert.strictEqual(shapeByPatterns('Can you recommend a show?').request, true);
});

// What is still open: the clothing ledger as the probe measured it (2026-09-02),
// two obligations among three purchases. "Pick up" reads as acquiring to the
// verb families; the status ask has to win over the verb.
const clothing = [
  { source: 'instance-pool', id: 'c1', statement: '[instance] purchase: purchased H&M — Bought a white button-down shirt from H&M [completed] (attested ×1)', refs: ['dialogue.turn:s6'], _kind: 'purchase', _status: 'completed', _qualifier: 'purchased', _entity: 'H&M' },
  { source: 'instance-pool', id: 'c2', statement: '[instance] purchase: purchased Levi\'s — Bought new black jeans from Levi\'s [completed] (attested ×1)', refs: ['dialogue.turn:s6'], _kind: 'purchase', _status: 'completed', _qualifier: 'purchased', _entity: 'Levi\'s' },
  { source: 'instance-pool', id: 'c3', statement: '[instance] possession: owns navy blue blazer — Blazer at the dry cleaner, still to be picked up [owed] (attested ×2)', refs: ['dialogue.turn:s4'], _kind: 'possession', _status: 'owed', _qualifier: 'owns', _entity: 'navy blue blazer' },
  { source: 'instance-pool', id: 'c4', statement: '[instance] purchase: got boots — Exchanged boots at Zara, the larger pair still to be picked up [owed, 2023-02-05] (attested ×2)', refs: ['dialogue.turn:s9'], _kind: 'purchase', _status: 'owed', _qualifier: 'got', _entity: 'boots' },
  { source: 'dialogue-window', id: 's4', statement: 'user: I still need to pick up my dry cleaning for the navy blue blazer.', ts: inWin },
  { source: 'dialogue-window', id: 's6', statement: 'user: My recent purchases, the black jeans from Levi\'s and the white shirt from H&M.', ts: inWin },
  { source: 'dialogue-window', id: 's9', statement: 'user: I exchanged the boots at Zara and I still need to pick up the new pair.', ts: inWin },
];

t('a question about what is still pending keeps the owed lines and sets the done ones aside, whatever the verb', () => {
  const v = buildReconciledView(clothing, { noun_head: 'clothing', question: 'How many items of clothing do I need to pick up or return from a store?', reference_ts: ASKED });
  assert.strictEqual(v.status_ask, 'pending');
  const kept = v.ledger.map(l => l.statement);
  assert.ok(kept.some(s => /blazer/.test(s)) && kept.some(s => /boots/.test(s)), 'the two open obligations are the ledger: ' + kept.join(' | '));
  assert.ok(!kept.some(s => /H&M/.test(s)) && !kept.some(s => /Levi/.test(s)), 'finished purchases are set aside');
  assert.ok(v.aside.every(a => /open obligation/.test(a.reason)), v.aside.map(a => a.reason).join(' | '));
  const out = v.render();
  assert.ok(out.indexOf('asks what is still open') >= 0, 'the view says what it kept and why');
});

t('the shape says what kind of answer is wanted, by the model in any language, by the wh-word without one', async () => {
  const { shapeQuestion, shapeByPatterns } = require('../shared-core/question-shape.js');
  assert.strictEqual(shapeByPatterns('Where did I redeem a $5 coupon on coffee creamer?').asks, 'place');
  assert.strictEqual(shapeByPatterns('When did I last see my dentist?').asks, 'time');
  assert.strictEqual(shapeByPatterns('Who recommended the bakery to me?').asks, 'person');
  const pending = shapeByPatterns('How many items of clothing do I need to pick up or return from a store?');
  assert.strictEqual(pending.asks, 'count');
  assert.strictEqual(pending.status, 'pending');
  assert.strictEqual(shapeByPatterns('How many plants did I acquire in the last month?').status, 'any');
  const fake = async () => JSON.stringify({ count: false, request: false, head: 'κουπόνι', verb_family: 'none', past: true, window_days: null, window_kind: 'none', asks: 'place', status: 'any' });
  const shape = await shapeQuestion('Πού εξαργύρωσα το κουπόνι για την κρέμα καφέ;', { llmCall: fake, reference_ts: ASKED });
  assert.strictEqual(shape.source, 'model');
  assert.strictEqual(shape.asks, 'place');
  assert.strictEqual(shape.status, 'any');
  const v = buildReconciledView(clothing, { question: 'Πού εξαργύρωσα το κουπόνι;', reference_ts: ASKED, shape });
  assert.ok(v.render().indexOf('The question asks for a place; the answer names one.') === 0, 'the view opens with the kind of answer wanted');
  const fakePending = async () => JSON.stringify({ count: true, request: false, head: 'ρούχο', verb_family: 'acquire', past: true, window_days: null, window_kind: 'none', asks: 'count', status: 'pending' });
  const sp = await shapeQuestion('Πόσα ρούχα έχω ακόμα να παραλάβω ή να επιστρέψω;', { llmCall: fakePending, reference_ts: ASKED });
  const vp = buildReconciledView(clothing, { question: 'Πόσα ρούχα έχω ακόμα να παραλάβω ή να επιστρέψω;', reference_ts: ASKED, shape: sp });
  assert.deepStrictEqual(vp.ledger.map(l => /blazer/.test(l.statement) ? 'blazer' : (/boots/.test(l.statement) ? 'boots' : 'other')).sort(), ['blazer', 'boots'], 'a Greek pending question keeps the same two lines');
});

t('the shape can be read through the operator\'s proxy: the prompt rides the system text, raw, and the JSON comes back', async () => {
  const { makeProxyShapeCall, shapeQuestion } = require('../shared-core/question-shape.js');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Here you go: {"count":false,"request":false,"head":"coupon","verb_family":"none","past":true,"window_days":null,"window_kind":"none","asks":"place","status":"any"}' }] }) };
  };
  try {
    const call = makeProxyShapeCall({ host: 'http://127.0.0.1:8000/', model: 'gpt-5.4-mini' });
    const shape = await shapeQuestion('Where did I redeem the coupon?', { llmCall: call, reference_ts: ASKED });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, 'http://127.0.0.1:8000/v1/messages');
    assert.strictEqual(seen[0].headers['x-troth-raw'], '1', 'the prompt reaches the engine as written');
    assert.strictEqual(seen[0].body.model, 'gpt-5.4-mini');
    assert.ok(/^Read the question and describe its shape/.test(seen[0].body.system) && /Where did I redeem the coupon\?$/.test(seen[0].body.system), 'the shape prompt and the question ride the system text');
    assert.strictEqual(shape.source, 'model');
    assert.strictEqual(shape.asks, 'place');
  } finally { global.fetch = realFetch; }
});

t('the About block introduces itself as preferences to honour, never a whereabouts', () => {
  const liked = [
    { source: 'dialogue-window', id: 'p1', statement: 'user: I love exploring the nightlife scene in Belo Horizonte.', ts: inWin },
    { source: 'dialogue-window', id: 'p2', statement: 'user: I enjoy attending language exchange events.', ts: inWin + DAY },
  ];
  const v = buildReconciledView(liked, { question: 'Can you recommend some cultural events happening around me this weekend?', reference_ts: ASKED });
  const out = v.render();
  assert.ok(out.indexOf('never where the user is now') >= 0, out.split('\n')[0]);
});

t('a question naming two verbs keeps both families, from the model and from the patterns alike', async () => {
  const { shapeQuestion, shapeByPatterns } = require('../shared-core/question-shape.js');
  const fake = async () => JSON.stringify({ count: true, request: false, head: 'μοντέλο', verb_families: ['work', 'acquire'], past: true, window_days: null, window_kind: 'none', asks: 'count', status: 'any' });
  const shape = await shapeQuestion('Πόσα μοντέλα έχω φτιάξει ή αγοράσει;', { llmCall: fake, reference_ts: ASKED });
  assert.deepStrictEqual(shape.families, ['work', 'acquire']);
  const legacy = async () => JSON.stringify({ count: true, request: false, head: 'kit', verb_family: 'work', past: true, window_days: null, window_kind: 'none', asks: 'count', status: 'any' });
  const one = await shapeQuestion('How many kits did I build?', { llmCall: legacy, reference_ts: ASKED });
  assert.deepStrictEqual(one.families, ['work'], 'a single family still reads');
  assert.deepStrictEqual(shapeByPatterns('How many model kits have I worked on or bought?').families, ['acquire', 'work']);
});

t('a total is the user speaking of themselves: pasted text and third-party sentences state nothing', () => {
  const items = [
    { source: 'instance-pool', id: 'i1', statement: '[instance] visit: visited Dr. Lee — follow-up with dermatologist Dr. Lee [completed] (attested ×1)', refs: ['dialogue.turn:r1'], _kind: 'visit', _qualifier: 'visited', _status: 'completed', _entity: 'Dr. Lee', _cos: 0.5 },
    { source: 'dialogue-window', id: 'r1', statement: 'user: I just got back from a follow-up with my dermatologist, Dr. Lee.', ts: ASKED - 10 * DAY },
    { source: 'dialogue-window', id: 'r2', statement: 'user: Please correct my grammar below, the message below is from us ("As Clinic") to the provider: "Our clinic has 2 doctors and 1 doctor is on leave, so bookings for 1 doctor only."', ts: ASKED - 5 * DAY },
    { source: 'dialogue-window', id: 'r3', statement: 'user: The clinic next door has 4 doctors, by the way. So far I have seen 2 doctors about this.', ts: ASKED - 3 * DAY },
  ];
  const v = buildReconciledView(items, { noun_head: 'doctors', question: 'How many different doctors did I visit?', reference_ts: ASKED });
  assert.deepStrictEqual(v.totals.map(t => t.value), [2], 'only "I have seen 2 doctors" is a total: ' + JSON.stringify(v.totals));
});

console.log('\nreconciled-view-question: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
