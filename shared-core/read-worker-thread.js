// SPDX-License-Identifier: AGPL-3.0-only
// The read worker's side: heavy read-only questions answered on their own
// thread with their own database handle, so the proxy's event loop never
// waits on a count over the whole substrate.
'use strict';

const { parentPort } = require('worker_threads');

const JOBS = {
  memory_readiness: () => require('./memory-readiness.js').readiness(),
  substrate_counts: () => require('./substrate-counts.js').counts(),
  recallable_missing_embeddings: (a) => require('./state.js').listRecallableMissingEmbeddings(a.limit, a.model),
  archive_missing_embeddings: (a) => require('./state.js').listArchiveMissingEmbeddings(a.limit),
  concern_tokens: () => Array.from(require('./recall.js')._gatherConcernTokens()),
  // One recall class arm (the FTS pull and the scoring over its pool) for
  // the proxy's recall, so a hook's question never holds the event loop.
  recall_class: (a) => require('./recall.js')._recallClass(String(a.cls), a.opts || {}),
  // The analytics overview for a window (the all-time one walks every
  // ledger), for the stats answer the dashboard polls.
  analytics_overview: (a) => (require('./analytics.js').getAnalytics({ window: (a && a.window) || 'all' }) || {}).overview || {},
  sql_rows: (a) => require('./state.js')._dbForQuery().prepare(String(a.sql)).all(...(Array.isArray(a.params) ? a.params : [])),
  sql_get: (a) => require('./state.js')._dbForQuery().prepare(String(a.sql)).get(...(Array.isArray(a.params) ? a.params : []))
};

parentPort.on('message', (m) => {
  let result = null, error = null;
  try {
    const fn = JOBS[m && m.job];
    if (!fn) throw new Error('unknown job: ' + (m && m.job));
    result = fn((m && m.args) || {});
  } catch (e) {
    error = String((e && e.message) || e);
  }
  parentPort.postMessage({ id: m && m.id, result: result === undefined ? null : result, error });
});
