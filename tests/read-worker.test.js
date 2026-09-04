#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Heavy read-only questions answer from a worker thread: a query runs there
// with its own handle, memo serves the last answer while a fresh one is
// computed, and peek never waits.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const rw = require(path.join(__dirname, '..', 'shared-core', 'read-worker.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== read worker ===\n');

(async () => {
  state.db();
  await t('a query runs on the worker with its own handle', async () => {
    const row = await rw.run('sql_get', { sql: 'SELECT COUNT(*) AS n FROM action_records' }, { timeout_ms: 20000 });
    assert.ok(row && typeof row.n === 'number', JSON.stringify(row));
  });

  await t('substrate counts and memory readiness answer as objects', async () => {
    const c = await rw.run('substrate_counts', {}, { timeout_ms: 30000 });
    assert.ok(c && typeof c.total === 'number' && c.by_type, JSON.stringify(c).slice(0, 120));
    const r = await rw.run('memory_readiness', {}, { timeout_ms: 30000 });
    assert.ok(r && typeof r.stage === 'string', JSON.stringify(r).slice(0, 120));
  });

  await t('memo waits once, then serves the held answer while refreshing', async () => {
    rw._resetForTests();
    const a = await rw.memo('k', 50, 'sql_get', { sql: 'SELECT 1 AS one' });
    assert.strictEqual(a.one, 1);
    const t0 = Date.now();
    const b = await rw.memo('k', 50, 'sql_get', { sql: 'SELECT 2 AS one' });
    assert.strictEqual(b.one, 1, 'the held answer is served at once');
    assert.ok(Date.now() - t0 < 30, 'no wait');
    await new Promise((r) => setTimeout(r, 120));
    await rw.memo('k', 50, 'sql_get', { sql: 'SELECT 3 AS one' });
    await new Promise((r) => setTimeout(r, 120));
    const c = await rw.memo('k', 50, 'sql_get', { sql: 'SELECT 4 AS one' });
    assert.ok(c.one === 2 || c.one === 3, 'a refreshed answer arrived: ' + c.one);
  });

  await t('peek never waits: null first, a value once the worker answered', async () => {
    rw._resetForTests();
    assert.strictEqual(rw.peek('p', 1000, 'sql_get', { sql: 'SELECT 7 AS n' }), null);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(rw.peek('p', 1000, 'sql_get', { sql: 'SELECT 8 AS n' }).n, 7);
  });

  await t('an unknown job is an error, never a hang', async () => {
    await assert.rejects(rw.run('nope', {}, { timeout_ms: 5000 }), /unknown job/);
  });

  console.log('\nread-worker: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
