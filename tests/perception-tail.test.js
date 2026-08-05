#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// perception-tail test. Proves the live-view tee that
// backs control:perception_tail + control:browser_state: the substrate's
// browser observer writes perception engrams through recordEngram, and a
// bounded in-memory ring mirrors them so the operator panel can poll
// cheaply. Feeds REAL observer schema shapes (engram-schemas.js) through
// the tee — if the schema shape drifts, this test catches it.
//
// Hermetic: pure module, no DB, no CDP, no network. __resetForTest gives
// each case a clean ring.
const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

const SHARED  = path.join(__dirname, '..', 'shared-core');
const tail    = require(path.join(SHARED, 'perception', 'perception-tail.js'));
const schemas = require(path.join(SHARED, 'perception', 'engram-schemas.js'));

console.log('\n=== perception-tail  ===\n');

t('empty ring → empty tail + null browser_state', () => {
  tail.__resetForTest();
  const r = tail.perceptionTail({});
  assert.deepStrictEqual(r.events, []);
  assert.strictEqual(r.buffered, 0);
  assert.strictEqual(tail.browserState().last_page, null);
});

t('page_visit engram mirrors into tail AND sets browser_state', () => {
  tail.__resetForTest();
  const eng = schemas.pageVisit({
    url: 'https://example.com/login', title: 'Login', ts: 1000,
    ax_node_count: 42, semantic_summary: 'button: Sign in', ax_graph_text: 'a|b',
  });
  tail.recordPerception(eng);
  const r = tail.perceptionTail({});
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].class, 'page_visit');
  const st = tail.browserState().last_page;
  assert.strictEqual(st.url, 'https://example.com/login');
  assert.strictEqual(st.title, 'Login');
  assert.strictEqual(st.ax_node_count, 42);
  assert.strictEqual(st.ts, 1000);
  assert.ok(st.ax_graph_hash, 'page_visit hash carried into browser_state');
});

t('perception_event does NOT clobber browser_state', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.pageVisit({ url: 'https://a.test', title: 'A', ts: 1, ax_graph_text: 'x' }));
  tail.recordPerception(schemas.perceptionEvent({ kind: 'network', payload: { url: 'https://a.test/api', status: 500 }, ts: 2 }));
  assert.strictEqual(tail.browserState().last_page.url, 'https://a.test', 'network event must not overwrite page state');
  assert.strictEqual(tail.perceptionTail({}).events.length, 2);
});

t('since_ts polls forward (only newer events)', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.perceptionEvent({ kind: 'console', payload: { level: 'error', message: 'old' }, ts: 100 }));
  tail.recordPerception(schemas.perceptionEvent({ kind: 'console', payload: { level: 'error', message: 'new' }, ts: 200 }));
  const r = tail.perceptionTail({ since_ts: 150 });
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].payload.payload.message, 'new');
});

t('kind filter matches class AND perception_event sub-kind', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.pageVisit({ url: 'https://p.test', title: 'P', ts: 1, ax_graph_text: 'x' }));
  tail.recordPerception(schemas.perceptionEvent({ kind: 'network', payload: { status: 404 }, ts: 2 }));
  tail.recordPerception(schemas.perceptionEvent({ kind: 'console', payload: { level: 'warning' }, ts: 3 }));
  assert.strictEqual(tail.perceptionTail({ kind: 'page_visit' }).events.length, 1, 'class match');
  assert.strictEqual(tail.perceptionTail({ kind: 'network' }).events.length, 1, 'sub-kind match');
  assert.strictEqual(tail.perceptionTail({ kind: 'console' }).events.length, 1, 'sub-kind match');
});

t('ring is bounded — oldest evicted past max', () => {
  tail.__resetForTest(3);
  for (let i = 1; i <= 5; i++) {
    tail.recordPerception(schemas.perceptionEvent({ kind: 'mutation', payload: { n: i }, ts: i }));
  }
  const r = tail.perceptionTail({ limit: 100 });
  assert.strictEqual(r.buffered, 3, 'ring capped at max');
  assert.strictEqual(r.max_buffered, 3);
  assert.strictEqual(r.events[0].payload.payload.n, 3, 'oldest two evicted');
  assert.strictEqual(r.events[2].payload.payload.n, 5);
});

t('limit clamps to ring max', () => {
  tail.__resetForTest(2);
  tail.recordPerception(schemas.perceptionEvent({ kind: 'mutation', payload: {}, ts: 1 }));
  tail.recordPerception(schemas.perceptionEvent({ kind: 'mutation', payload: {}, ts: 2 }));
  const r = tail.perceptionTail({ limit: 999 });
  assert.strictEqual(r.events.length, 2);
});

t('malformed input never throws', () => {
  tail.__resetForTest();
  tail.recordPerception(null);
  tail.recordPerception(undefined);
  tail.recordPerception('not an object');
  tail.recordPerception({});                 // no payload
  assert.strictEqual(tail.perceptionTail({}).events.length, 1, 'only the {} object recorded');
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
