#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One brain, many threads: what a scoped recall serves. Identity always; a
// fact that names no context or a bound one; the conversation's own turns;
// another conversation's turns only once cooled and only from a bound
// context; a turn without a home never unasked. A caller with a conversation
// but no context keeps the whole cooled history and no other live thread.
// TROTH_CONTEXT_BINDING=0 turns the scope off; the legacy context_id option
// is one bound context. A single candidate still gets the reranker's verdict.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');

process.env.TROTH_EMBED_PORT = '9';
process.env.TROTH_EMBEDDING_HOST = 'http://127.0.0.1:9';
process.env.TROTH_RECALL_CONCERNS = '0';
process.env.TROTH_LIVE_THREAD_HOURS = '6';

const CORE = path.join(__dirname, '..', 'shared-core');
// A reranker that answers for any number of documents, so the verdict on a
// single candidate is testable without a server.
const rerankerPath = path.join(CORE, 'local-reranker.js');
require.cache[rerankerPath] = { id: rerankerPath, filename: rerankerPath, loaded: true, exports: { rerank: async (q, docs) => docs.map(() => 0.42) } };

const engram = require(path.join(CORE, 'engram.js'));
const dialogue = require(path.join(CORE, 'dialogue-memory.js'));
const recall = require(path.join(CORE, 'recall.js'));

const AGENT = 'local-agent';
const CWD = '/w/scope-test';
const H = 3600000;
const now = Date.now();

function fact(statement, context_id) {
  engram.recordEngram({ agent_id: AGENT, cwd: CWD, statement, source: 'scope-test', context_id: context_id || null, auto_verify: false });
}
function turn(conversation_id, context_id, ageHours, user_text, assistant_text) {
  const ok = dialogue.recordTurn({ agent_id: AGENT, cwd: CWD, conversation_id, context_id, timestamp: now - ageHours * H, user_text, assistant_text, faculty: 'seed' });
  assert.ok(ok, 'turn refused: ' + user_text);
}

fact('The deadline for alpha moved to Friday.', 'ctx:alpha');
fact('The deadline for beta moved to Monday.', 'ctx:beta');
fact('The deadline for taxes is in June every year.');
turn('conv-a', 'ctx:alpha', 0.1, 'the alpha deadline is friday now', 'noted the alpha deadline');
turn('conv-a2', 'ctx:alpha', 0.5, 'alpha deadline talk in another live pane', 'noted');
turn('conv-a3', 'ctx:alpha', 30, 'alpha deadline talk from last week', 'noted then');
turn('conv-b', 'ctx:beta', 0.2, 'the beta deadline is monday now', 'noted the beta deadline');
turn('conv-b2', 'ctx:beta', 30, 'beta deadline talk from last week', 'noted then');
turn(null, null, 30, 'a deadline note from an unstamped surface last week', 'noted loosely');
turn(null, null, 0.1, 'a deadline note from an unstamped surface right now', 'noted loosely');

const has = (hits, re) => hits.some((h) => re.test(String(h.statement || '')));
const list = (hits) => hits.map((h) => String(h.statement || '').slice(0, 50)).join(' | ');
const ask = (opts) => recall.recall(Object.assign({ query: 'deadline', class: 'all', audience: 'model_visible', limit: 20 }, opts));

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch((e) => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

(async () => {
  console.log('\n=== thread scope ===\n');

  await t('a bound conversation reads its context, the shared facts and its own turns', async () => {
    const hits = await ask({ conversation_id: 'conv-a', contexts: ['ctx:alpha'] });
    assert.ok(has(hits, /alpha moved to Friday/), 'own-context fact: ' + list(hits));
    assert.ok(has(hits, /taxes/), 'a fact with no home is shared: ' + list(hits));
    assert.ok(has(hits, /alpha deadline is friday now/), 'own turn: ' + list(hits));
    assert.ok(has(hits, /alpha deadline talk from last week/), 'cooled turn of a bound context: ' + list(hits));
    assert.ok(!has(hits, /beta/), 'nothing of the other context: ' + list(hits));
    assert.ok(!has(hits, /another live pane/), 'another live thread never mounts: ' + list(hits));
    assert.ok(!has(hits, /unstamped surface/), 'a turn without a home never mounts unasked: ' + list(hits));
  });

  await t('a conversation without a context keeps the cooled history and no other live thread', async () => {
    const hits = await ask({ conversation_id: 'conv-x' });
    assert.ok(has(hits, /alpha moved to Friday/) && has(hits, /beta moved to Monday/) && has(hits, /taxes/), 'every fact: ' + list(hits));
    assert.ok(has(hits, /alpha deadline talk from last week/) && has(hits, /unstamped surface last week/), 'cooled history of any thread: ' + list(hits));
    assert.ok(!has(hits, /alpha deadline is friday now/) && !has(hits, /beta deadline is monday now/) && !has(hits, /right now/), 'no live thread of anyone else: ' + list(hits));
  });

  await t('the legacy context_id option is one bound context', async () => {
    const hits = await ask({ context_id: 'ctx:beta' });
    assert.ok(has(hits, /beta moved to Monday/) && has(hits, /beta deadline talk from last week/), list(hits));
    assert.ok(!has(hits, /alpha/), list(hits));
  });

  await t('TROTH_CONTEXT_BINDING=0 turns the scope off', async () => {
    process.env.TROTH_CONTEXT_BINDING = '0';
    try {
      const hits = await ask({ conversation_id: 'conv-a', contexts: ['ctx:alpha'] });
      assert.ok(has(hits, /beta/), 'everything comes back: ' + list(hits));
    } finally { delete process.env.TROTH_CONTEXT_BINDING; }
  });

  await t('a single candidate still gets the reranker verdict', async () => {
    const hits = await recall.recall({ query: 'taxes June', class: 'all', audience: 'model_visible', limit: 5, rerank: true });
    assert.ok(hits.length >= 1, 'a hit');
    assert.ok(hits.every((h) => typeof h._rerank === 'number'), 'each hit scored: ' + JSON.stringify(hits.map((h) => h._rerank)));
  });

  console.log('\nthread-scope: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
