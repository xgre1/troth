#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// RESEARCH-INGEST worker — runs ONE paper (ingest + one question's recall)
// in an ISOLATED substrate state.
//
// Spawned as a fresh child process per paper by benchmarks/ingest-recall.mjs
// (same reason as benchmarks/longmemeval-worker.cjs: shared-core/state.js
// resolves its data dir off HOME/CLAUDE_PLUGIN_DATA into a require-time
// singleton — there is no in-process way to rebind it between papers, so
// hermeticity requires one process per paper, not just a fresh DB path).
//
// This exercises the Chameleon L3 ingest->query path (shared-core/
// chameleon.js), which is DIFFERENT from LongMemEval's dialogue-turn path
// (shared-core/dialogue-memory.js recordTurn + engram.retrieveRelevant's
// no-scope cross-type branch). Chameleon is the operator's "ingest a
// document corpus, ask it" path:
//   - chameleon.ingestDocument({agent_id, scope, text, title, source,
//     embedding_host}) — chunks (paragraph/sentence-aware, ~800 chars/100
//     overlap), embeds each chunk (best-effort, silently degrades to
//     null on embed failure), persists each chunk as one engram tagged
//     with `scope` (shared-core/chameleon.js:93).
//   - chameleon.queryScope({agent_id, query, scope, k, embedding_host}) —
//     thin wrapper around engram.retrieveRelevant with `scope` SET, which
//     routes to the "scope-locked legacy path" (shared-core/engram.js:992
//     comment: "caller wants a specific commitment corpus (chameleon
//     docs:* etc)") — NOT the no-scope cross-type recall.recall branch
//     LongMemEval's worker exercises. This is the real MCP
//     troth_chameleon_query tool's code path (plugin/mcp-servers/
//     troth-substrate/server.mjs calls chameleon.queryScope at line 439).
//
// Contract (stdin -> stdout, both JSON, one line each):
//   stdin:  { paper_id, title, ingest_text, question, k, agent_id, cwd,
//             embedding_host, scope }
//   stdout: single JSON line:
//     { paper_id, ingest: {chunks,recorded,embedded}, retrieved:
//       [{statement,score,...}], retrieval_path: 'semantic+lexical'|
//       'lexical_fallback', error? }

const { readFileSync } = require('node:fs');
const http = require('node:http');

// Mirrors benchmarks/longmemeval-worker.cjs probeEmbedHealth exactly —
// shared-core/local-embedder.js's own health check (_embServerHealth) is
// private/unexported, so this is a side-channel /health probe used ONLY
// to LABEL retrieval_path, not to gate the real ingest/query calls (those
// always run for real and self-degrade to null embeddings / lexical score
// on failure, per chameleon.js / engram.js).
function probeEmbedHealth(host, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL('/health', host || 'http://127.0.0.1:11437'); }
    catch (_) { return resolve(false); }
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname,
      method: 'GET', timeout: timeoutMs || 1200
    }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c);
      res.on('end', () => { try { resolve((JSON.parse(b) || {}).status === 'ok'); } catch (_) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.end();
  });
}

async function main() {
  const raw = readFileSync(0, 'utf8');
  const job = JSON.parse(raw);
  const {
    paper_id, title, ingest_text, question, k,
    agent_id, cwd, embedding_host, scope
  } = job;

  const out = { paper_id, ingest: null, retrieved: [], retrieval_path: 'unknown' };

  try {
    const chameleon = require('../shared-core/chameleon.js');
    const backgroundWorker = require('../shared-core/background-worker.js');

    // Real ingest path: chameleon.ingestDocument. Internally chunks + embeds
    // + persists (shared-core/chameleon.js:93-138). No benchmark-only
    // shortcut — this is the exact function the MCP troth_chameleon_ingest
    // tool (and any future doc-upload UI) would call.
    const ingestRes = await chameleon.ingestDocument({
      agent_id, user_id: 'default', cwd,
      scope, text: ingest_text, title,
      source: 'ingest:qasper:' + paper_id,
      embedding_host,
    });
    out.ingest = {
      ok: ingestRes.ok, chunks: ingestRes.chunks,
      recorded: ingestRes.recorded, embedded: ingestRes.embedded,
    };
    if (!ingestRes.ok) {
      out.error = 'ingest failed: ' + (ingestRes.error || 'unknown');
      process.stdout.write(JSON.stringify(out) + '\n');
      return;
    }

    // Force embedding backfill before query, same fidelity fix as
    // longmemeval-worker.cjs: ingestDocument embeds inline per-chunk
    // already (chameleon.js:113-118), so this is normally a no-op here,
    // but running it keeps this worker aligned with the same "real
    // background task, not a benchmark reimplementation" pattern and
    // catches any chunk whose inline embed attempt failed transiently.
    try {
      const tasks = (backgroundWorker && backgroundWorker.DEFAULT_TASKS) || [];
      const backfillTask = tasks.find(t => t && t.name === 'embedding_backfill');
      if (backfillTask && typeof backfillTask.run === 'function') {
        await backfillTask.run({});
      }
    } catch (_) { /* best-effort */ }

    // Real query path: chameleon.queryScope -> engram.retrieveRelevant with
    // scope SET (the "scope-locked legacy" corpus path, engram.js:992).
    const host = embedding_host || 'http://127.0.0.1:11437';
    const healthy = await probeEmbedHealth(host, 800);
    const q = await chameleon.queryScope({
      agent_id, cwd,
      query: question,
      k: k || 8,
      embedding_host: host,
      scope,
    });
    out.retrieved = (q.items || []).map(it => ({
      statement: it.statement, score: it.score,
      memory_class: it.memory_class, source: it.source,
    }));
    out.retrieval_path = healthy ? 'semantic+lexical' : 'lexical_fallback';
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

main();
