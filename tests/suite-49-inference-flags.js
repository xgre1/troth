// SPDX-License-Identifier: AGPL-3.0-only
// What the local models are allowed to spend.
//
// Two servers run locally on every message: the embedder and the reranker.
// Both were started with -ngl 0 — no accelerator offload — and with no
// --threads at all, so llama.cpp took every core it could see. On a ten-core
// reference machine that is sixteen threads per server, two servers, thirty-two
// threads contending for ten cores.
//
// Measured on that machine, one injector-shaped rerank of fifty candidates:
//
//   default (16 threads, no offload)   1982 ms   6.72 CPU-seconds
//   four threads, no offload           1175 ms
//   accelerator offload                 441 ms
//   two concurrent, offloaded           379 ms   (still under one CPU call)
//   resident memory                      782 MB offloaded vs 1084 MB not
//
// Fewer threads is not a trade: it is faster AND cooler, because
// oversubscribing ten cores with thirty-two threads spends the difference on
// contention. Offload is not a memory cost either — unified memory replaces the
// host copy rather than adding to it.
//
// Offload had been refused for a written reason: "nothing stops an idle server,
// so a permanently-loaded embedder means a permanently busy GPU". An idle
// reaper was added later, covering the embedder, the reranker, the chat model
// and the browser on a thirty-minute leash, and the refusal was never
// revisited.
//
// The reranker earns its place: on six of six sample queries it returned a
// different top five than the hybrid blend alone. It is not decoration, it is
// not being removed, and it is not being made cheaper by returning less. It is
// being made to cost what the work actually costs.
//
// One behaviour here is NOT measured: what llama.cpp does when offload is
// requested and the backend cannot start. Simulating that means breaking an
// installation, so it is not trusted to a flag — the spawner checks that the
// server answered and starts it again without offload if it did not.
module.exports = function run({ test }) {
const assert = require('assert');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dc = require(path.join(ROOT, 'shared-core', 'device-capabilities.js'));

console.log('\nLocal inference budget (INF):');

test('INF-1: threads are bounded by the machine, never by a constant', () => {
  assert.strictEqual(typeof dc.inferenceFlags, 'function',
    'one place answers "how much may a local model spend here"');
  const f = dc.inferenceFlags();
  assert.ok(Number.isInteger(f.threads) && f.threads >= 1,
    'a thread count that is at least one: ' + JSON.stringify(f));
  assert.ok(f.threads <= os.cpus().length,
    'never more threads than the machine has cores (' + f.threads + ' vs ' + os.cpus().length + ')');
});

test('INF-2: offload is asked for only when a backend is actually present', () => {
  const f = dc.inferenceFlags();
  assert.ok(Number.isInteger(f.ngl) && f.ngl >= 0, 'ngl is a number: ' + JSON.stringify(f));
  // The claim is not "this is a Mac" — it is "a backend library is on disk".
  // A machine whose build has no accelerator must ask for none, or llama.cpp
  // is being handed a flag it cannot honour.
  const has = dc.hasAcceleratorBackend();
  assert.strictEqual(typeof has, 'boolean');
  if (!has) assert.strictEqual(f.ngl, 0, 'no backend on disk means no offload requested');
  else assert.ok(f.ngl > 0, 'a backend on disk means offload is used');
});

test('INF-3: the operator can force it either way', () => {
  const prev = process.env.TROTH_NGL;
  try {
    process.env.TROTH_NGL = '0';
    assert.strictEqual(dc.inferenceFlags().ngl, 0, 'forced off');
    process.env.TROTH_NGL = '999';
    assert.strictEqual(dc.inferenceFlags().ngl, 999, 'forced on');
  } finally {
    if (prev === undefined) delete process.env.TROTH_NGL; else process.env.TROTH_NGL = prev;
  }
});

test('INF-4: threads can be pinned too, for a machine that must stay quiet', () => {
  const prev = process.env.TROTH_INFER_THREADS;
  try {
    process.env.TROTH_INFER_THREADS = '2';
    assert.strictEqual(dc.inferenceFlags().threads, 2, 'honoured');
    process.env.TROTH_INFER_THREADS = '9999';
    assert.ok(dc.inferenceFlags().threads <= os.cpus().length,
      'but still clamped to the machine — an override may not oversubscribe it');
  } finally {
    if (prev === undefined) delete process.env.TROTH_INFER_THREADS; else process.env.TROTH_INFER_THREADS = prev;
  }
});

test('INF-5: both hot-path servers spend from the same budget (source pin)', () => {
  // Three servers, three different answers, was the state that produced this:
  // the chat model offloaded fully while the two that run on every single
  // message did not, and none of them bounded threads.
  const fs = require('fs');
  for (const rel of ['shared-core/local-reranker.js', 'shared-core/local-embedder.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/inferenceFlags/.test(src), rel + ' asks device-capabilities what it may spend');
    assert.ok(/'--threads'/.test(src), rel + ' bounds its thread count');
  }
});

test('INF-6: offload that fails to come up falls back instead of dying (source pin)', () => {
  // The one behaviour here that could not be measured without breaking a real
  // install. A flag is not a fallback: the server is started, checked, and
  // started again without offload if it never answered.
  const fs = require('fs');
  for (const rel of ['shared-core/local-reranker.js', 'shared-core/local-embedder.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/_offloadFailed|offload_failed/.test(src),
      rel + ' remembers that offload did not work, so it does not retry it every spawn');
  }
});
};
