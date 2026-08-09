// SPDX-License-Identifier: AGPL-3.0-only
// memory-readiness.js — one owner for the memory pipeline's truth
// (PLAN-COHERENCE-2026-08-09, law 5).
//
// Memory has THREE readiness stages a new user lives through — the engine
// downloads, the imports land, the index catches up — and until now only the
// first had a voice (the wizard's real download bar). The verdict a stranger
// forms in their first session forms exactly inside the silent stages:
// recall is lexical-only while the backfill drains, reranking is absent
// until its 606MB model arrives on FIRST use, and none of that was stated
// anywhere. `troth doctor` already tells this truth in three states on the
// CLI; this module computes the same truth once so every OTHER surface (app
// Memory page, dashboard card, REPL greeting) renders one answer instead of
// four guesses.
//
// Read-only and side-effect-free BY CONTRACT: no download kicks, no server
// starts (the /api/embed/status poll owns the kick; rerank's first use owns
// its own download). Surfaces that want to trigger work call those paths;
// this one only ever LOOKS.
'use strict';

function readiness() {
  const out = {
    // engine_downloading | indexing | ready | unavailable
    stage: 'ready',
    embedder: { ready: false, downloading: false, progress: 0, unavailable: false },
    // Reranking is a QUALITY layer, not a gate: recall works without it, so
    // its absence never blocks 'ready' — it is stated, not hidden.
    reranker: { ready: false },
    imported: { chat_sessions: 0, distilled_sessions: 0 },
    indexing: { recall_total: 0, recall_embedded: 0, recall_missing: 0, archive_chunks: 0, archive_embedded: 0 },
    // The drain's proof-of-life, read from the background_task_run ledger.
    // Counts without a heartbeat were the field failure mode: a frozen "28
    // still indexing" for two days LOOKED like slow progress when in truth
    // no process anywhere was draining (dashboard-only topology, 2026-08-09).
    drain: { alive: false, last_run_ts: null, last_notes: null },
    reasons: []
  };

  let embStatus = null;
  try {
    const emb = require('./local-embedder.js');
    embStatus = emb.status();
    out.embedder.ready = !!embStatus.download_done && !embStatus.unavailable;
    out.embedder.downloading = !!embStatus.downloading;
    out.embedder.progress = Number(embStatus.download_progress || 0);
    out.embedder.unavailable = !!embStatus.unavailable;
  } catch (_) { out.embedder.unavailable = true; }

  try { out.reranker.ready = !!require('./local-reranker.js').isAvailable(); } catch (_) {}

  try {
    const ch = require('./chameleon.js');
    out.imported.chat_sessions = (ch.listIngestedSources('docs:chats') || []).length;
    out.imported.distilled_sessions = (ch.listIngestedSources('memory:chat-distilled') || []).length;
  } catch (_) {}

  try {
    const state = require('./state.js');
    let model = null;
    try { model = (embStatus && embStatus.model_id) || null; } catch (_) {}
    out.indexing = state.memoryIndexCounts(model);
  } catch (_) {}

  try {
    const state = require('./state.js');
    const lr = state.lastBackgroundRun('embedding_backfill', 24 * 60 * 60 * 1000);
    if (lr) {
      out.drain.last_run_ts = lr.timestamp;
      out.drain.last_notes = lr.notes || null;
      // 2 min > idle threshold (60s) + tick (30s): a living worker always
      // lands inside this window once the machine has had one quiet minute.
      out.drain.alive = (Date.now() - lr.timestamp) < 2 * 60 * 1000;
    }
  } catch (_) {}

  if (out.embedder.unavailable) {
    out.stage = 'unavailable';
    out.reasons.push('the embedding engine cannot run here: recall is word-matching only');
  } else if (!out.embedder.ready) {
    out.stage = 'engine_downloading';
    out.reasons.push('memory engine downloading (' + Math.round(out.embedder.progress * 100) + '%)');
  } else if (out.indexing.recall_missing > 0) {
    out.stage = 'indexing';
    out.reasons.push(out.indexing.recall_missing + ' memories still indexing ('
      + out.indexing.recall_embedded + '/' + out.indexing.recall_total
      + ' indexed) — answers get sharper as this drains');
  } else {
    out.stage = 'ready';
  }
  if (!out.reranker.ready && out.stage !== 'unavailable') {
    out.reasons.push('reranking not active yet (its model downloads on first use); recall works, precision improves once it lands');
  }
  if (out.indexing.archive_chunks > out.indexing.archive_embedded) {
    // The archive drains AFTER the recall pool, bounded per idle cycle
    // (background-worker ARCHIVE_CHUNK) — an import done before the embed
    // host was warm heals instead of staying keyword-only forever. Until it
    // drains, say so; do not imply full semantic search over the archive —
    // and only claim a background drain when one is PROVABLY alive.
    out.reasons.push((out.indexing.archive_chunks - out.indexing.archive_embedded)
      + ' imported archive chunks still embedding ('
      + out.indexing.archive_embedded + '/' + out.indexing.archive_chunks + ' done'
      + (out.drain.alive ? ', background drain running' : '') + ')');
  }
  // The heartbeat verdict itself: work is owed but nobody has drained in
  // the last 2 minutes → say it, instead of letting frozen counts imply
  // progress. (With the proxy's maintenance worker this should only appear
  // in the first idle minute after boot, or when maintenance is disabled.)
  if (!out.drain.alive && out.stage !== 'unavailable'
      && (out.indexing.recall_missing > 0
          || out.indexing.archive_chunks > out.indexing.archive_embedded)) {
    out.reasons.push('no background worker has drained memory recently — it runs on idle while the proxy (troth start), the app, or the daemon is up; `troth service` keeps one up from login');
  }
  return out;
}

module.exports = { readiness };
