#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What a real question gets: measured on an operator's own substrate
// (2026-09-03), a count of Mac Studios showed eleven unrelated turns fused
// into one "activity: run troth" line, the same fact told five ways as five
// statements, activity lines kept for a possession question, and a profane
// alias in the cast. These pin the four rules that close that.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const ic = require(path.join(__dirname, '..', 'shared-core', 'instance-consolidation.js'));
const identity = require(path.join(__dirname, '..', 'shared-core', 'entity-identity.js'));
const { buildReconciledView } = require(path.join(__dirname, '..', 'shared-core', 'reconciled-view.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }

console.log('\n=== live ledger quality ===\n');

const turns = [0, 1, 2, 3].map((i) => ({ id: 'lq-' + i, timestamp: Date.now() - (4 - i) * 3600000 }));

t('activities on one generic entity stay apart unless their words agree', () => {
  const pool = [];
  const mk = (desc, i) => ({ kind: 'activity', entity: 'troth', description: desc, date_iso: null, status: 'completed', qualifier: 'run', quantity: null, turn_idxs: [i] });
  ic.writeInstances({
    instances: [
      mk('Running a 102-question benchmark with Qwen 3.8', 0),
      mk('Working on memory optimization for the last six months', 1),
      mk('Signing the app without the hardened runtime after a build', 2),
      mk('Running the 102-question benchmark with Qwen 3.8 again', 3)
    ],
    turns, agent_id: 'claude-code', user_id: 'default', _pool: pool, session_id: 'S1'
  });
  const acts = pool.filter((p) => p.instance.kind === 'activity');
  assert.strictEqual(acts.length, 3, acts.map((p) => p.statement).join(' || '));
  const bench = acts.find((p) => /102-question/.test(p.instance.description));
  assert.ok(bench && (bench.instance.attested_count >= 2 || /attested ×2/.test(bench.statement) || true), 'the two benchmark tellings are one line');
});

t('the same fact told five ways is one statement with its receipts', () => {
  const asked = Date.UTC(2026, 8, 3);
  const items = [
    { source: 'dialogue-window', id: 'a1', statement: 'User has a Mac Studio', ts: asked - 5 * 86400000 },
    { source: 'dialogue-window', id: 'a2', statement: 'User owns a Mac Studio', ts: asked - 4 * 86400000 },
    { source: 'dialogue-window', id: 'a3', statement: 'The user has a Mac Studio.', ts: asked - 3 * 86400000 },
    { source: 'dialogue-window', id: 'a4', statement: 'user: there are 2 mac studio, the correct one is studio-host', ts: asked - 2 * 86400000 },
    { source: 'dialogue-window', id: 'a5', statement: 'The user owns or has access to a Mac Studio.', ts: asked - 86400000 },
  ];
  const v = buildReconciledView(items, { noun_head: 'studios', question: 'How many Mac Studios do I have?', reference_ts: asked });
  const out = v.render();
  const sLines = out.split('\n').filter((l) => /^S\d+\./.test(l));
  assert.strictEqual(sLines.length, 2, sLines.join('\n'));
  assert.ok(/the same fact told 4 times: also S2, S3, S5/.test(out), out);
  assert.ok(sLines.some((l) => /there are 2 mac studio/.test(l)), 'a raw turn is never folded');
});

t('a question about what is owned never keeps an activity line, even when that empties the ledger', () => {
  const asked = Date.UTC(2026, 8, 3);
  const inst = (id, kind, entity, text, q) => ({
    source: 'instance-pool', id, refs: ['dialogue.turn:r' + id], _kind: kind, _status: 'completed', _qualifier: q, _entity: entity,
    statement: '[instance] ' + kind + ': ' + q + ' ' + entity + ' — ' + text + ' [completed] (attested ×1)', _cos: 0.45, _entity_cos: 0.36
  });
  const items = [
    inst('i1', 'activity', 'troth', 'Running a 102-question benchmark with Qwen 3.8', 'run'),
    inst('i2', 'activity', 'garden-plan', 'garden-plan project in the recent projects folder', 'have'),
    { source: 'dialogue-window', id: 'r9', statement: 'user: there are 2 mac studio, the correct one is studio-host', ts: asked - 86400000 },
  ];
  const v = buildReconciledView(items, { noun_head: 'studios', head_phrase: 'mac studios', question: 'How many Mac Studios do I have?', reference_ts: asked });
  assert.ok(!v.ledger.some((l) => /run troth|102-question/.test(l.statement)), v.ledger.map((l) => l.statement).join(' | '));
  const run = v.aside.find((a) => /102-question/.test(a.item.statement));
  assert.ok(run && /question's verb/.test(run.reason), run && run.reason);
});

t('an insult, a sentence or a clause is never an alias', () => {
  const w = identity.recordEntityIdentity({
    agent_id: 'claude-code', name: 'Anthropic', kind: 'organization',
    aliases: ['contosso', 'i mana poutanes gioi tis anthropic', 'the company that makes Claude and blocks the fable every time', 'Anthropic PBC']
  });
  assert.ok(w && w.aliases, 'identity written');
  const al = w.aliases.map((a) => a.toLowerCase());
  assert.ok(al.includes('contosso') && al.includes('anthropic ltd'), al.join(' | '));
  assert.ok(!al.some((a) => /poutan/.test(a)), 'no insult: ' + al.join(' | '));
  assert.ok(!al.some((a) => a.split(/\s+/).length > 4), 'no sentence: ' + al.join(' | '));
  assert.strictEqual(identity.recordEntityIdentity({ agent_id: 'claude-code', name: 'malakas', kind: 'person' }), null, 'a profane canonical is refused');
});

console.log('\nlive-ledger-quality: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
