#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// instance-consolidation — typed distillation with mandatory provenance.
// Proves the four covenants: (1) no provenance ⇒ no write, (2) extractor
// down ⇒ window retained (queue, not drop), (3) identity-resolved entities
// carry the canonical slug (counting merges by identity), (4) instances are
// substrate_internal — invisible to conversational recall by construction.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-instance-consolidation-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';

const assert = require('assert');
const ic = require('../shared-core/instance-consolidation.js');
const identity = require('../shared-core/entity-identity.js');
const engram = require('../shared-core/engram.js');
const dialogueMemory = require('../shared-core/dialogue-memory.js');

let pass = 0, fail = 0;
function t(name, fn) {
  const p = fn && fn.constructor && fn.constructor.name === 'AsyncFunction'
    ? fn() : Promise.resolve().then(fn);
  return p.then(() => { console.log('  ✓ ' + name); pass++; })
          .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const BRAIN = 'test-brain';

(async function main() {
console.log('\n=== instance-consolidation (typed distillation) ===\n');

// One charter, one parser: the product and the bench read the extractor
// through the same door, so the schema discipline below is the discipline the
// operator's own memory is written under.
await t('extraction: fenced JSON accepted, schema violations dropped', () => {
  const turns = [
    { user_text: 'I saw Dr. Lee for a mole check on May 12.' },
    { user_text: 'Nothing else to report today.' }
  ];
  const raw = 'Sure, here you go:\n```json\n' + JSON.stringify({
    identities: [],
    instances: [
      { kind: 'visit', entity: 'Dr. Lee', description: 'dermatologist, mole check', date_iso: '2023-05-12', status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0], quote: 'I saw Dr. Lee for a mole check' },
      { kind: 'teleport', entity: 'x', description: 'bad kind', turn_idxs: [0], quote: 'I saw Dr. Lee' },
      { kind: 'visit', entity: 'Dr. Ghost', description: 'NO provenance', turn_idxs: [], quote: 'I saw Dr. Lee' },
      { kind: 'visit', entity: 'Dr. Range', description: 'idx out of range', turn_idxs: [99], quote: 'I saw Dr. Lee' }
    ]
  }) + '\n```';
  const out = ic.parseCombinedExtractionV2(raw, 2, turns);
  assert.strictEqual(out.instances.length, 1, 'only the valid row survives');
  assert.strictEqual(out.dropped, 3);
  assert.strictEqual(out.instances[0].entity, 'Dr. Lee');
});

await t('extraction: a row whose quote is not in the turns does not survive', () => {
  const turns = [{ user_text: 'I saw Dr. Lee for a mole check on May 12.' }];
  const raw = JSON.stringify({
    identities: [],
    instances: [
      { kind: 'visit', entity: 'Dr. Nobody', description: 'never said', date_iso: null, status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0], quote: 'I saw Dr. Nobody last Tuesday' }
    ]
  });
  const out = ic.parseCombinedExtractionV2(raw, 1, turns);
  assert.strictEqual(out.instances.length, 0, 'an unattested quote is not provenance');
  assert.strictEqual(out.quote_fail, 1);
});

await t('extraction: garbage in, empty out', () => {
  assert.strictEqual(ic.parseCombinedExtractionV2('no json here', 5, []).instances.length, 0);
  assert.strictEqual(ic.parseCombinedExtractionV2('{"not":"array"}', 5, []).instances.length, 0);
});

// Seed real turns through the real write path.
const T0 = Date.now() - 60 * 1000;
assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-A', timestamp: T0,
  user_text: 'I visited Dr. Lee the dermatologist for the mole biopsy follow-up — results were benign.',
  assistant_text: 'Great news about the results.'
}));
assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-A', timestamp: T0 + 1000,
  user_text: "My sister's wedding was last June — I was maid of honor at the rooftop garden.",
  assistant_text: 'That sounds lovely.'
}));

// Identity from item 1: the mind knows who "my sister" is.
identity.recordEntityIdentity({ agent_id: BRAIN, name: 'Jen', kind: 'person', aliases: ['my sister'] });

// Deterministic extractor fixture: the combined charter the product asks for
// — identities and instances in one answer, every row quoting the turn that
// attests it.
function fixtureExtractor(prompt) {
  const identities = [];
  const instances = [
    { kind: 'visit', entity: 'Dr. Lee', description: 'dermatologist biopsy follow-up (benign)', date_iso: null, status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0], quote: 'I visited Dr. Lee the dermatologist' }
  ];
  if (prompt.indexOf('wedding') >= 0) {
    identities.push({ name: 'Jen', kind: 'person', relation: 'sister', aliases: ['my sister'], quote: "My sister's wedding was last June" });
    instances.push({ kind: 'event', entity: 'my sister', description: 'wedding at the rooftop garden, maid of honor', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [1], quote: "My sister's wedding was last June" });
  }
  return Promise.resolve(JSON.stringify({ identities: identities, instances: instances }));
}

let firstStats = null;
await t('runPass writes typed instances with provenance to the REAL turn ids', async () => {
  firstStats = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: fixtureExtractor });
  assert.strictEqual(firstStats.written, 2, 'two instances written: ' + JSON.stringify(firstStats));
  assert.ok(firstStats.advanced, 'watermark must advance on success');
  const visits = engram.listEngrams({ scope: 'instance:visit', audience: 'all', agent_id: BRAIN, limit: 10 });
  assert.strictEqual(visits.length, 1);
  const inst = visits[0].payload && visits[0].payload.instance;
  assert.ok(inst && inst.kind === 'visit' && inst.entity === 'Dr. Lee', 'payload.instance intact');
});

await t('provenance covenant: refs point at dialogue.turn rows', () => {
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: BRAIN, limit: 10 });
  for (const r of rows) {
    // provenance_ref is written top-level in output; hydration exposes
    // grounded_in/payload — read through the raw action row instead.
    const state = require('../shared-core/state.js');
    const raw = state.getAction(r.id);
    const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
    assert.ok(Array.isArray(out.provenance_ref) && out.provenance_ref.length,
      'every instance must carry provenance_ref');
    assert.ok(out.provenance_ref.every(x => /^dialogue\.turn:/.test(x)), out.provenance_ref.join('|'));
  }
});

await t('identity resolution: "my sister" instance carries entity_slug jen', () => {
  const events = engram.listEngrams({ scope: 'instance:event', audience: 'all', agent_id: BRAIN, limit: 10 });
  assert.strictEqual(events.length, 1);
  const inst = events[0].payload.instance;
  assert.strictEqual(inst.entity_slug, 'jen', 'counting must merge by identity, not surface string');
  assert.strictEqual(inst.canonical, 'Jen');
});

await t('idempotence: second pass writes nothing new', async () => {
  const again = await ic.runPass({ agent_id: BRAIN, user_id: 'default', llmCall: fixtureExtractor });
  assert.strictEqual(again.written, 0, 'no re-distillation: ' + JSON.stringify(again));
  assert.strictEqual(again.processed, 0, 'watermark must have excluded the processed turns');
});

await t('queue-on-unavailable: extractor down ⇒ watermark NOT advanced, retry succeeds', async () => {
  assert.ok(dialogueMemory.recordTurn({
    agent_id: BRAIN, conversation_id: 'sess-B', timestamp: Date.now(),
    user_text: 'I bought a new tennis racket from the sports store downtown yesterday.',
    assistant_text: 'Nice choice.'
  }));
  const down = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.reject(new Error('ECONNREFUSED'))
  });
  assert.strictEqual(down.advanced, false, 'window must be retained');
  assert.strictEqual(down.written, 0);
  const retry = await ic.runPass({
    agent_id: BRAIN, user_id: 'default',
    llmCall: () => Promise.resolve(JSON.stringify({
      identities: [],
      instances: [
        { kind: 'purchase', entity: 'tennis racket', description: 'from the sports store downtown', date_iso: null, status: 'completed', qualifier: 'bought', quantity: null, turn_idxs: [0], quote: 'I bought a new tennis racket from the sports store downtown' }
      ]
    }))
  });
  assert.strictEqual(retry.written, 1, 'retained window must distill on retry: ' + JSON.stringify(retry));
});

await t('poisoning-safe by construction: instances invisible to model_visible reads', () => {
  const visible = engram.listEngrams({ audience: 'model_visible', agent_id: BRAIN, limit: 100 }) || [];
  const leaked = visible.filter(e => e && String(e.scope || '').indexOf('instance:') === 0);
  assert.strictEqual(leaked.length, 0, 'conversational recall must never mount the typed pool');
  const lifted = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: BRAIN, limit: 100 }) || [];
  assert.ok(lifted.length >= 3, 'the count reader lifts them explicitly (audience:all): got ' + lifted.length);
});

await t('the pass runs by default and the operator can turn it off', () => {
  delete process.env.TROTH_INSTANCE_CONSOLIDATION;
  assert.strictEqual(ic.enabled(), true, 'distillation is part of the substrate');
  process.env.TROTH_INSTANCE_CONSOLIDATION = '0';
  assert.strictEqual(ic.enabled(), false, 'and one variable turns it off');
  process.env.TROTH_INSTANCE_CONSOLIDATION = '1';
  assert.strictEqual(ic.enabled(), true);
  delete process.env.TROTH_INSTANCE_CONSOLIDATION;
});

// ── Self-entity guard + scoped identity census ────────────────────────
// Unguarded, the entity 'user' becomes the target of two merges in five — a
// self-reference names the speaker, not a thing, so it can never say two
// rows are the same occurrence. Near-self strings name real things and
// keep merging. The census a merge consults must be the caller's brain,
// not the whole database — a second brain's identities must not flip
// another brain's merge verdicts.

await t('self-entity guard: distinct user-entity activities never merge', () => {
  const AG = 'self-guard-brain';
  const turns = [{ id: 'sg-1', user_text: 'context turn' }];
  const mk = (desc, qual) => ({ kind: 'activity', entity: 'user', description: desc, date_iso: null, status: 'completed', qualifier: qual, quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mk('Woke up at 7 AM every day, including weekends', 'woke')], turns, agent_id: AG, user_id: 'default', session_id: 'sg-s1', source: 'test' });
  ic.writeInstances({ instances: [mk('Hired a wedding planner in the city', 'hired')], turns, agent_id: AG, user_id: 'default', session_id: 'sg-s2', source: 'test' });
  ic.writeInstances({ instances: [{ kind: 'activity', entity: 'User', description: 'Slept in until 10 AM on last Sunday', date_iso: null, status: 'completed', qualifier: 'slept', quantity: null, turn_idxs: [0] }], turns, agent_id: AG, user_id: 'default', session_id: 'sg-s3', source: 'test' });
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 20 });
  assert.strictEqual(rows.length, 3, 'each self-entity fact stays its own occurrence: ' + rows.length);
});

await t('near-self entity is a real thing and still merges', () => {
  const AG = 'near-self-brain';
  const turns = [{ id: 'ns-1', user_text: 'context turn' }];
  const mk = (qual) => ({ kind: 'activity', entity: "user's website", description: 'Redesigning the landing page hero section', date_iso: null, status: 'completed', qualifier: qual, quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mk('redesigning')], turns, agent_id: AG, user_id: 'default', session_id: 'ns-s1', source: 'test' });
  ic.writeInstances({ instances: [mk('updating')], turns, agent_id: AG, user_id: 'default', session_id: 'ns-s2', source: 'test' });
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 20 });
  assert.strictEqual(rows.length, 1, 'same real-entity occurrence retold merges: ' + rows.length);
});

await t('identity census scopes to the asking brain', () => {
  identity.recordEntityIdentity({ agent_id: 'census-A', name: 'Emma', kind: 'person', aliases: ['the bride'] });
  identity.recordEntityIdentity({ agent_id: 'census-B', name: 'Emma', kind: 'person', aliases: ['the bride'] });
  identity._resetCacheForTests();
  const scoped = identity.uniqueNameOwners({ agent_id: 'census-A' });
  const global_ = identity.uniqueNameOwners({});
  assert.strictEqual(scoped.get('emma'), 1, 'within one brain Emma is unique: ' + scoped.get('emma'));
  assert.ok((global_.get('emma') || 0) >= 2, 'the cross-brain census still sees every brain: ' + global_.get('emma'));
});

await t('a second brain\'s identities cannot flip a merge verdict', () => {
  // The Emma/mom mechanism, distilled: with an UNSCOPED census, census-B\'s
  // Emma above makes \'Emma\' non-unique, the participant rung loses its
  // discriminator, and two different parties join. Scoped, they stay apart.
  const AG = 'census-A';
  const turns = [{ id: 'cf-1', user_text: 'context turn' }];
  const mkE = (entity, desc) => ({ kind: 'event', entity, description: desc, date_iso: null, status: 'planned', qualifier: 'planning', quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mkE('Emma', 'Surprise birthday party for the bride with a movie night theme')], turns, agent_id: AG, user_id: 'default', session_id: 'cf-s1', source: 'test' });
  ic.writeInstances({ instances: [mkE('my mom', "Family birthday party for mom's 60th with a formal dinner")], turns, agent_id: AG, user_id: 'default', session_id: 'cf-s2', source: 'test' });
  const events = engram.listEngrams({ scope: 'instance:event', audience: 'all', agent_id: AG, limit: 20 });
  const parties = events.filter(r => /birthday party/i.test(r.statement));
  assert.strictEqual(parties.length, 2, 'two different parties stay two occurrences: ' + parties.length);
});

// ── Quote grounding: ellipsis-spliced quotes ───────────────────────────
// A model that quotes across turns with an ellipsis did the right thing;
// requiring one contiguous span destroyed perfectly-grounded rows (measured:
// 15/15 quote-gate deaths in the corpus carried an ellipsis). Every elided
// span long enough to verify must be present — inside the turns the row
// itself cites, so true spans from unrelated turns cannot be stitched into
// a false claim. Single-span quotes take exactly the original path.

await t('quote gate: single-span behavior unchanged', () => {
  const turns2 = [{ user_text: 'I visited the little bakery on Elm Street this morning and bought sourdough.' }];
  const mkText = (quote) => JSON.stringify({ identities: [], instances: [
    { kind: 'visit', entity: 'bakery', description: 'Morning sourdough run', date_iso: null, status: 'completed', qualifier: 'visited', quantity: null, turn_idxs: [0], quote }
  ]});
  const ok = ic.parseCombinedExtractionV2(mkText('visited the little bakery on Elm Street'), 1, turns2);
  assert.strictEqual(ok.instances.length, 1, 'verbatim quote survives');
  const bad = ic.parseCombinedExtractionV2(mkText('completely absent words here'), 1, turns2);
  assert.strictEqual(bad.instances.length, 0, 'absent quote still dies');
  assert.strictEqual(bad.quote_fail, 1);
});

await t('quote gate: an ellipsis-spliced quote passes when every span lives in its cited turns', () => {
  const turns2 = [
    { user_text: 'I just got back from a friend\'s wedding last weekend, it was lovely.' },
    { user_text: 'It was at a rustic barn in the countryside with fairy lights.' }
  ];
  const text = JSON.stringify({ identities: [], instances: [
    { kind: 'event', entity: "Jen's wedding", description: 'Wedding at a rustic barn', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0, 1],
      quote: "I just got back from a friend's wedding last weekend... It was at a rustic barn in the countryside" }
  ]});
  const out = ic.parseCombinedExtractionV2(text, 2, turns2);
  assert.strictEqual(out.instances.length, 1, 'spliced-but-grounded survives: fails=' + out.quote_fail);
});

await t('quote gate: spans stitched from turns the row does not cite are rejected', () => {
  const turns2 = [
    { user_text: 'The weather was stormy all through October here.' },
    { user_text: 'My brother finally paid off his car loan in full.' },
    { user_text: 'Nothing else happened today, quiet afternoon overall.' }
  ];
  const text = JSON.stringify({ identities: [], instances: [
    { kind: 'activity', entity: 'brother', description: 'Storm-driven loan payoff', date_iso: null, status: 'completed', qualifier: 'did', quantity: null, turn_idxs: [2],
      quote: 'The weather was stormy... paid off his car loan' }
  ]});
  const out = ic.parseCombinedExtractionV2(text, 3, turns2);
  assert.strictEqual(out.instances.length, 0, 'stitched spans outside cited turns must fail');
  assert.strictEqual(out.quote_fail, 1);
});

await t('quote gate: a quote of only unverifiable short spans is rejected', () => {
  const turns2 = [{ user_text: 'I went to the gym.' }];
  const text = JSON.stringify({ identities: [], instances: [
    { kind: 'activity', entity: 'gym', description: 'Gym visit', date_iso: null, status: 'completed', qualifier: 'went', quantity: null, turn_idxs: [0], quote: 'gym... to' }
  ]});
  const out = ic.parseCombinedExtractionV2(text, 1, turns2);
  assert.strictEqual(out.instances.length, 0, 'nothing verifiable, nothing kept');
});

// ── Truncated extractions keep their complete rows ────────────────────
// A model that hits its token ceiling mid-array leaves valid rows behind a
// broken tail. Roughly one extraction in thirteen ends that way, and without
// salvage each one costs an entire session of what the user said.

await t('a truncated extraction keeps the rows that closed before the cut', () => {
  const turns2 = [{ user_text: 'I finished the game on normal difficulty and it took me 25 hours to complete.' }];
  const row = '{"kind":"activity","entity":"the game","description":"Completed on normal difficulty in 25 hours","date_iso":null,"status":"completed","qualifier":"finished","quantity":null,"turn_idxs":[0],"quote":"it took me 25 hours to complete"}';
  const cut = '{"identities":[],"instances":[' + row + ',{"kind":"activity","entity":"half a row';
  const out = ic.parseCombinedExtractionV2(cut, 1, turns2);
  assert.strictEqual(out.instances.length, 1, 'the complete row survives the broken tail');
  assert.ok(/25 hours/.test(out.instances[0].description), out.instances[0].description);
});

await t('salvage never invents: unparseable text still yields nothing', () => {
  const turns2 = [{ user_text: 'I finished the game.' }];
  assert.strictEqual(ic.parseCombinedExtractionV2('not json at all', 1, turns2).instances.length, 0);
  assert.strictEqual(ic.parseCombinedExtractionV2('{"instances":[{"kind":"acti', 1, turns2).instances.length, 0);
});

await t('a whole valid response takes exactly the same path as before', () => {
  const turns2 = [{ user_text: 'I finished the game on normal difficulty and it took me 25 hours to complete.' }];
  const whole = '{"identities":[],"instances":[{"kind":"activity","entity":"the game","description":"Completed on normal difficulty in 25 hours","date_iso":null,"status":"completed","qualifier":"finished","quantity":null,"turn_idxs":[0],"quote":"it took me 25 hours to complete"}]}';
  const out = ic.parseCombinedExtractionV2(whole, 1, turns2);
  assert.strictEqual(out.instances.length, 1);
  assert.strictEqual(out.quote_fail, 0);
});

// ── Description composition: a merge never silently discards content ─────
// The measured damage class: two true retellings share an entity, the
// newer overwrites the older, and a stated fact (30 hours on hard; the
// sangria's orange and lemon) is silently gone. Composition keeps the
// losing description as a ' · ' clause whenever it carries any content
// token the primary lacks — bounded, and degrading to exactly today's
// behaviour, never to a truncated clause.

await t('composition: both playthroughs survive on one row (the games case)', () => {
  const AG = 'compose-games';
  const T = (x) => [{ id: x, user_text: 'context turn' }];
  const mk = (desc, qual) => ({ kind: 'activity', entity: 'The Last of Us Part II', description: desc, date_iso: null, status: 'completed', qualifier: qual, quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mk('Completed the game on hard difficulty, taking 30 hours to finish', 'completed')], turns: T('cg-1'), agent_id: AG, user_id: 'default', session_id: 'cg-s1', source: 'test' });
  ic.writeInstances({ instances: [mk('Completed the game on normal difficulty in 25 hours', 'finished')], turns: T('cg-2'), agent_id: AG, user_id: 'default', session_id: 'cg-s2', source: 'test' });
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 10 });
  assert.strictEqual(rows.length, 1, 'still ONE occurrence: ' + rows.length);
  assert.ok(/30 hours/.test(rows[0].statement), '30 hours preserved: ' + rows[0].statement);
  assert.ok(/25 hours/.test(rows[0].statement), '25 hours present: ' + rows[0].statement);
});

await t('composition: a retelling with nothing new adds nothing', () => {
  const AG = 'compose-para';
  const T = (x) => [{ id: x, user_text: 'context turn' }];
  const mk = (desc, qual) => ({ kind: 'activity', entity: 'park walk', description: desc, date_iso: null, status: 'completed', qualifier: qual, quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mk('Walked around the central park fountain', 'walked')], turns: T('cp-1'), agent_id: AG, user_id: 'default', session_id: 'cp-s1', source: 'test' });
  ic.writeInstances({ instances: [mk('Around the central park fountain, walked', 'strolled')], turns: T('cp-2'), agent_id: AG, user_id: 'default', session_id: 'cp-s2', source: 'test' });
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 10 });
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].statement.indexOf(' · ') === -1, 'no clause for a paraphrase: ' + rows[0].statement);
});

await t('composition: the digit-bearing primary leads, detail follows (the kits shape)', () => {
  const AG = 'compose-kits';
  const T = (x) => [{ id: x, user_text: 'context turn' }];
  const mk = (desc, qual) => ({ kind: 'activity', entity: 'diorama', description: desc, date_iso: null, status: 'planned', qualifier: qual, quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mk('Working on a diorama featuring a 1/16 scale German Tiger I tank with realistic terrain', 'started')], turns: T('ck-1'), agent_id: AG, user_id: 'default', session_id: 'ck-s1', source: 'test' });
  ic.writeInstances({ instances: [mk('Adding vegetation to the riverbank including water plants', 'adding')], turns: T('ck-2'), agent_id: AG, user_id: 'default', session_id: 'ck-s2', source: 'test' });
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 10 });
  assert.strictEqual(rows.length, 1);
  const s = rows[0].statement;
  assert.ok(s.indexOf('Tiger I tank') !== -1 && s.indexOf('vegetation') !== -1, 'both present: ' + s);
  assert.ok(s.indexOf('Tiger I tank') < s.indexOf('vegetation'), 'digit-bearing primary stays first: ' + s);
});

await t('composition: the clause cap holds and degradation is the primary unchanged', () => {
  const AG = 'compose-cap';
  const T = (x) => [{ id: x, user_text: 'context turn' }];
  const mk = (desc, qual) => ({ kind: 'activity', entity: 'novel readthrough', description: desc, date_iso: null, status: 'recurring', qualifier: qual, quantity: null, turn_idxs: [0] });
  const descs = ['Reading the opening chapters slowly', 'Highlighting favourite passages throughout', 'Discussing themes with the book club', 'Drafting margin annotations everywhere'];
  descs.forEach((d, i) => ic.writeInstances({ instances: [mk(d, 'reading-' + i)], turns: T('cc-' + i), agent_id: AG, user_id: 'default', session_id: 'cc-s' + i, source: 'test' }));
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 10 });
  assert.strictEqual(rows.length, 1);
  const seps = rows[0].statement.split(' · ').length - 1;
  assert.ok(seps <= 2, 'at most three clauses: ' + rows[0].statement);
});

await t('composition: three weddings told in different words are three occurrences, each recoverable', () => {
  // The S1 lesson, kept from the other side: three finished doings on one
  // generic entity with nothing in common but the word "wedding" are three
  // lines, and every ingredient survives on its own line. (Fusing them and
  // keeping the ingredients inside one row was the earlier, weaker guard.)
  const AG = 'compose-chimera';
  const T = (x) => [{ id: x, user_text: 'context turn' }];
  const mk = (desc, qual) => ({ kind: 'activity', entity: 'wedding season', description: desc, date_iso: null, status: 'completed', qualifier: qual, quantity: null, turn_idxs: [0] });
  ic.writeInstances({ instances: [mk("Attended college roommate's wedding in the city with a rooftop garden ceremony", 'attended')], turns: T('cw-1'), agent_id: AG, user_id: 'default', session_id: 'cw-s1', source: 'test' });
  ic.writeInstances({ instances: [mk('Attended wedding of friend Emily and her partner Sarah', 'went')], turns: T('cw-2'), agent_id: AG, user_id: 'default', session_id: 'cw-s2', source: 'test' });
  ic.writeInstances({ instances: [mk("Attended friend Jen's wedding at a rustic barn in the countryside", 'joined')], turns: T('cw-3'), agent_id: AG, user_id: 'default', session_id: 'cw-s3', source: 'test' });
  const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: AG, limit: 10 });
  assert.strictEqual(rows.length, 3, rows.map((r) => r.statement).join(' || '));
  const all = rows.map((r) => r.statement).join('\n');
  assert.ok(/roommate/.test(all) && /Emily and her partner Sarah/.test(all) && /rustic barn/.test(all), 'all three weddings recoverable: ' + all);
});

console.log('');
console.log('instance-consolidation: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
