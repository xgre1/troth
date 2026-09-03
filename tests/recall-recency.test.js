#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// "When did we last …" is answered by the newest relevant item: the ranked
// set comes back newest first for a recency-shaped question, in English or
// Greek, and in relevance order for any other.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-recency-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const dm = require(path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== recall: the last time ===\n');
const A = 'recency-test';
const NOW = Date.now();
const DAY = 86400000;
(async () => {
  dm.recordTurn({ agent_id: A, conversation_id: 'r1', timestamp: NOW - 30 * DAY, user_text: 'we restart the proxy after the routing change, the first restart of the month', assistant_text: 'restarted the proxy.' });
  dm.recordTurn({ agent_id: A, conversation_id: 'r2', timestamp: NOW - 10 * DAY, user_text: 'restart the proxy again, the second restart, the watcher change', assistant_text: 'restarted the proxy.' });
  dm.recordTurn({ agent_id: A, conversation_id: 'r3', timestamp: NOW - 3600000, user_text: 'restart the proxy for the maintenance worker fix, the third restart', assistant_text: 'restarted the proxy.' });

  await t('a recency-shaped question comes back newest first', async () => {
    const items = await engram.retrieveRelevant({ query: 'When did we last restart the proxy and why?', audience: 'model_visible', k: 5, rerank: false });
    assert.ok(items.length >= 3, 'found ' + items.length);
    assert.ok(/third restart/.test(items[0].statement), items[0].statement.slice(0, 100));
    assert.ok((items[0].ts || 0) >= (items[1].ts || 0) && (items[1].ts || 0) >= (items[2].ts || 0), 'newest first');
  });

  await t('the same in Greek', async () => {
    const items = await engram.retrieveRelevant({ query: 'πότε κάναμε τελευταία restart τον proxy;', audience: 'model_visible', k: 5, rerank: false });
    assert.ok(items.length >= 2, 'found ' + items.length);
    assert.ok(/third restart/.test(items[0].statement), items[0].statement.slice(0, 100));
  });

  await t('a question without a recency shape keeps its relevance order', async () => {
    const items = await engram.retrieveRelevant({ query: 'the first restart of the month after the routing change', audience: 'model_visible', k: 5, rerank: false });
    assert.ok(items.length >= 1);
    assert.ok(/first restart/.test(items[0].statement), items[0].statement.slice(0, 100));
  });

  console.log('\nrecall-recency: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
