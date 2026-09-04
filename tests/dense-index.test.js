#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The dense arm's in-memory index: builds from the embedding stream, ranks by
// cosine within quantization error, filters by audience, takes new rows in
// through the created_at cursor, and never scans SQLite per query.
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const DIM = 8;
function vec(seed) { const v = new Float32Array(DIM); for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 7 + i * 1.3) + (i === seed % DIM ? 2 : 0); return v; }
function row(id, seed, created, audience) { const v = vec(seed); return { id, dim: DIM, vector: Buffer.from(v.buffer), created_at: created, memory_class: 'semantic', audience: audience || 'model_visible' }; }
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb)); }

let rows = [];
let streamCalls = [];
state.streamRecallableEmbeddings = (opts) => {
  const since = (opts && opts.since_created_at) || 0;
  streamCalls.push(since);
  return rows.filter((r) => r.created_at > since)[Symbol.iterator]();
};
const index = require(path.join(__dirname, '..', 'shared-core', 'dense-index.js'));

console.log('\n=== dense index ===\n');

(async () => {
  await t('a build reads the stream once and ranks by cosine like the float scan', async () => {
    rows = []; for (let i = 0; i < 300; i++) rows.push(row('e' + i, i, 1000 + i));
    index._resetForTests(); streamCalls = [];
    const r = await index.build();
    assert.strictEqual(r.rows, 300);
    assert.deepStrictEqual(streamCalls, [0]);
    const q = vec(42);
    const hits = index.search(q, 5, null);
    const exact = rows.map((x) => ({ id: x.id, cos: cosine(q, new Float32Array(x.vector.buffer, x.vector.byteOffset, DIM)) })).sort((a, b) => b.cos - a.cos).slice(0, 5);
    const topExact = exact[0].cos;
    const topSeen = cosine(q, vec(parseInt(hits[0].id.slice(1), 10)));
    assert.ok(Math.abs(topSeen - topExact) < 0.02, 'the top hit is a top-cosine row: ' + topSeen + ' vs ' + topExact);
    for (const h of hits) { const e = exact.find((x) => x.id === h.id) || { cos: cosine(q, vec(parseInt(h.id.slice(1), 10))) }; assert.ok(Math.abs(h.cos - e.cos) < 0.02, 'cosine within quantization error: ' + h.cos + ' vs ' + e.cos); }
  });

  await t('the audience filter keeps rows out', async () => {
    rows = [row('a', 1, 10, 'model_visible'), row('b', 1, 11, 'substrate_internal')];
    index._resetForTests(); await index.build();
    const hits = index.search(vec(1), 5, (aud) => aud === 'model_visible');
    assert.deepStrictEqual(hits.map((h) => h.id), ['a']);
  });

  await t('new rows join through the cursor, without a full read', async () => {
    rows = [row('a', 1, 10), row('b', 2, 20)];
    index._resetForTests(); streamCalls = [];
    await index.build();
    rows.push(row('c', 3, 30));
    // the refresh window has not elapsed: nothing is read
    let r = await index.refresh();
    assert.strictEqual(r.rows, 0);
    assert.deepStrictEqual(streamCalls, [0]);
    // force the window by moving the clock
    const realNow = Date.now; Date.now = () => realNow() + 61 * 1000;
    try { r = await index.refresh(); } finally { Date.now = realNow; }
    assert.strictEqual(r.rows, 1);
    assert.deepStrictEqual(streamCalls, [0, 20], 'only rows after the last created_at are read');
    assert.strictEqual(index.search(vec(3), 1, null)[0].id, 'c');
    assert.strictEqual(index.stats().rows, 3);
  });

  await t('a mismatched dimension is skipped and an empty index answers nothing', async () => {
    rows = [row('a', 1, 10)];
    index._resetForTests(); await index.build();
    assert.deepStrictEqual(index.search(new Float32Array(DIM + 1), 3, null), []);
    index._resetForTests();
    assert.deepStrictEqual(index.search(vec(1), 3, null), []);
    assert.strictEqual(index.isReady(), false);
  });

  console.log('\ndense-index: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
