#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// While the dense index warms over a corpus larger than one chunk, every
// other caller of the same database connection keeps getting answers: the
// index reads in finished chunks and yields between them, never across an
// open statement.
const assert = require('assert');
const path = require('path');
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
const index = require(path.join(__dirname, '..', 'shared-core', 'dense-index.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const DIM = 16;
const ROWS = 4500;
// One distinct direction per row: sixteen residues of a spread seed modulo
// distinct primes, centred on zero, so neighbouring seeds point far apart
// and a query built from a row's seed finds that row.
const PRIMES = [97, 89, 83, 79, 73, 71, 67, 61, 59, 53, 47, 43, 41, 37, 31, 29];
function vec(seed) { const v = []; for (let i = 0; i < DIM; i++) v.push(((seed * 7919) % PRIMES[i]) / PRIMES[i] - 0.5); return v; }

console.log('\n=== the dense index shares its connection while it warms ===\n');

(async () => {
  await t('every tick during a build the connection still answers, and the build reads every row', async () => {
    for (let i = 0; i < ROWS; i++) {
      const id = 'di' + String(i).padStart(6, '0');
      const ok = state.recordAction({
        id, timestamp: Date.now(), type: 'commitment', agent_id: 'di-test', user_id: 'default', cwd: null,
        principal_id: 'partner', memory_class: 'semantic', audience: 'model_visible',
        input: { source: 'dense-index-busy' }, output: { statement: 'row ' + i }
      }, 'row ' + i);
      assert.ok(ok, 'row written ' + i);
      assert.ok(state.setEmbedding(id, vec(i), { model: 'di-model' }), 'vector written ' + i);
    }
    let ticks = 0, errors = [];
    let building = true;
    const tick = () => {
      if (!building) return;
      try { state.db().pragma('user_version', { simple: true }); ticks++; } catch (e) { errors.push(String(e && e.message || e)); }
      setImmediate(tick);
    };
    setImmediate(tick);
    index._resetForTests();
    const r = await index.build();
    building = false;
    assert.strictEqual(r.rows, ROWS, 'every row reached the index: ' + r.rows);
    assert.ok(ticks > 0, 'the ticker ran during the build: ' + ticks);
    assert.deepStrictEqual(errors, [], 'no caller found the connection busy');
    const hits = index.search(new Float32Array(vec(7)), 3, null);
    assert.strictEqual(hits[0].id, 'di000007', 'the index answers: ' + JSON.stringify(hits));
  });

  await t('the keyset read walks ties on created_at by id and stops at the end', async () => {
    let seen = 0, calls = 0, last = null;
    let ca = 0, id = '￿';
    while (true) {
      const rows = state.listRecallableEmbeddings({ after_created_at: ca, after_id: id, limit: 1000 });
      calls++;
      for (const row of rows) {
        if (last) assert.ok(row.created_at > last.created_at || (row.created_at === last.created_at && row.id > last.id), 'rows arrive in keyset order');
        last = row; seen++;
      }
      if (!rows.length || rows.length < 1000) break;
      ca = last.created_at; id = last.id;
    }
    assert.strictEqual(seen, ROWS, 'the pages cover the corpus once: ' + seen);
    assert.ok(calls >= 5, 'in pages: ' + calls);
  });

  console.log('\ndense-index-busy: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
