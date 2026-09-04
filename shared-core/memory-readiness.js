// SPDX-License-Identifier: AGPL-3.0-only
// memory-readiness.js — one owner for the memory pipeline's truth.
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
    // Counts without a heartbeat are the failure mode: a frozen "28
    // still indexing" LOOKS like slow progress when in truth
    // no process anywhere is draining (dashboard-only topology).
    drain: { alive: false, last_run_ts: null, last_notes: null },
    // Documents seen but not yet turned into passages. The reservoir is a
    // QUEUE, and a queue nobody can see is the same failure as an index
    // nobody can see: the operator watches the fans spin and has no way to
    // know whether anything is happening or how long it lasts.
    // reader_alive is the QUEUE's own heartbeat, separate from drain.alive.
    // One heartbeat covered both lanes and the indexer's was the one being
    // read, so a machine whose document reader was never scheduled still
    // rendered "a worker is running" — true of the indexer, false of the
    // thing the operator was waiting for.
    reservoir: { queued: 0, done: 0, recent: [], reader_alive: false },
    // Upkeep the operator stopped on purpose. Without this the same stalled
    // counts appear whether they paused it or it broke, and the surface has
    // no way to tell the difference — so it would either alarm them about
    // their own decision or stay silent about a real failure.
    paused: { paused: false, since: null },
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

  // The document reader's own proof-of-life. Its cadence is 15 minutes, so
  // the window is wider than the indexer's two: a reader that ran nine
  // minutes ago is working, not dead.
  try {
    const state = require('./state.js');
    const kr = state.lastBackgroundRun('knowledge_drain', 24 * 60 * 60 * 1000);
    if (kr) out.reservoir.reader_alive = (Date.now() - kr.timestamp) < 20 * 60 * 1000;
  } catch (_) {}

  try { out.paused = require('./maintenance-gate.js').isPaused(); } catch (_) {}

  if (out.embedder.unavailable) {
    out.stage = 'unavailable';
    out.reasons.push('the embedding engine cannot run here: recall is word-matching only');
  } else if (!out.embedder.ready) {
    out.stage = 'engine_downloading';
    out.reasons.push('memory engine downloading (' + Math.round(out.embedder.progress * 100) + '%)');
  } else if (out.indexing.recall_missing > 0) {
    out.stage = 'indexing';
    // "N memories still indexing" would be both a duplicate of the detail
    // line below it and the wrong noun: the pending items are
    // passages of ingested DOCUMENTS, not memories, and the sentence sits
    // directly under "Import your chat history" — so it reads as if the
    // operator's Claude Code sessions were being processed. The count belongs
    // to the progress bar; this line says only what state we are in.
    out.reasons.push('Still indexing — answers get sharper as this drains');
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
  //
  // Silent while PAUSED: a stall the operator caused is not a fault, and
  // telling someone their machine is broken right after they pressed the
  // button that stopped it is how a surface loses its credibility for the
  // warnings that matter.
  if (out.paused && out.paused.paused) {
    out.reasons.push('paused by you — nothing is being read or indexed until you resume; what arrives meanwhile is kept and waits');
  } else if (!out.drain.alive && out.stage !== 'unavailable'
      && (out.indexing.recall_missing > 0
          || out.indexing.archive_chunks > out.indexing.archive_embedded)) {
    out.reasons.push('no background worker has drained memory recently — it runs on idle while the proxy (troth start), the app, or the daemon is up; `troth service` keeps one up from login');
  }
  // Reservoir depth. Cheap counts; a fresh install has no such table.
  try {
    const d = require('./state.js')._dbForQuery();
    out.reservoir.queued = d.prepare('SELECT COUNT(*) AS n FROM knowledge_spool WHERE done_at IS NULL').get().n;
    out.reservoir.done   = d.prepare('SELECT COUNT(*) AS n FROM knowledge_spool WHERE done_at IS NOT NULL').get().n;
    // The last few that actually went through, with what happened to each.
    // A percentage tells you something is moving; it never tells you WHAT is
    // moving, and the operator could not tell whether their documents or their
    // chat history was being processed.
    out.reservoir.recent = d.prepare(`
      SELECT kind, ref, result, done_at FROM knowledge_spool
      WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 6
    `).all().map((r) => ({
      kind: r.kind,
      name: r.kind === 'web' ? String(r.ref) : String(r.ref).split('/').slice(-1)[0],
      result: r.result || '',
      at: r.done_at
    }));
    // MEASURED throughput, not a constant copied from the worker.
    //
    // The card first estimated the queue by hardcoding "8 documents every 15
    // minutes" in the renderer — the worker's budget and cadence, duplicated
    // by hand into a second file. Any change to the worker leaves
    // the screen confidently wrong: "6 hours" beside "100% indexed".
    //
    // So: count what actually completed in the last hour. If nothing has yet,
    // the rate is null and the surface says it does not know instead of
    // inventing a number.
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const doneLastHour = d.prepare(
      'SELECT COUNT(*) AS n FROM knowledge_spool WHERE done_at IS NOT NULL AND done_at > ?'
    ).get(hourAgo).n;
    out.reservoir.docs_per_hour = doneLastHour > 0 ? doneLastHour : null;

    // Same question for the indexer, from the ledger it already writes.
    const embRow = d.prepare(
      "SELECT COUNT(*) AS n FROM engram_embeddings WHERE created_at > ?"
    ).get(hourAgo);
    out.indexing.passages_per_hour = (embRow && embRow.n > 0) ? embRow.n : null;
  } catch (_) { /* table not created yet */ }

  // WHAT is being indexed, not just how much. The progress line sits under
  // "Import your chat history", so a bare count reads as "your Claude Code
  // sessions are indexing" whatever the backlog actually is — a backlog can be
  // entirely ingested documents with no chat sessions in it. Naming the mix
  // costs one query and removes the guess. The breakdown MUST use the same
  // predicate as recall_missing above. Rows that carry no embeddable text, and
  // the chat archive that recall excludes, are not part of the backlog, so they
  // cannot appear in its breakdown either.
  try {
    const d = require('./state.js')._dbForQuery();
    const row = d.prepare(`
      SELECT
        SUM(CASE WHEN json_extract(ar.output,'$.scope') LIKE 'docs:%'
                  AND json_extract(ar.output,'$.scope') NOT LIKE 'docs:chats%' THEN 1 ELSE 0 END) AS documents,
        SUM(CASE WHEN json_extract(ar.output,'$.scope') IS NULL
                  OR json_extract(ar.output,'$.scope') NOT LIKE 'docs:%' THEN 1 ELSE 0 END) AS memories
      FROM action_records ar
      LEFT JOIN engram_embeddings ee ON ee.engram_id = ar.id
      WHERE ee.engram_id IS NULL
        AND ar.memory_class IN ('episodic','semantic','identity','procedural')
        AND (ar.audience IS NULL OR ar.audience = 'model_visible')
        AND (json_extract(ar.output,'$.scope') IS NULL
             OR json_extract(ar.output,'$.scope') NOT LIKE 'docs:chats%')
        AND (
          COALESCE(json_extract(ar.output,'$.statement'),'') <> ''
          OR COALESCE(json_extract(ar.output,'$.text'),'') <> ''
          OR COALESCE(json_extract(ar.output,'$.name'),'') <> ''
          OR (json_extract(ar.input,'$.tool_name') = 'dialogue.turn'
              AND (COALESCE(json_extract(ar.input,'$.args.user_text'),'') <> ''
                OR COALESCE(json_extract(ar.output,'$.assistant_text'),'') <> ''))
        )
    `).get() || {};
    out.indexing.pending_documents = row.documents || 0;
    out.indexing.pending_memories  = row.memories  || 0;
    // The archive has its own bar; it is never part of the recall backlog.
    out.indexing.pending_chats = 0;
  } catch (_) { /* fresh db */ }

  return out;
}

module.exports = { readiness };
