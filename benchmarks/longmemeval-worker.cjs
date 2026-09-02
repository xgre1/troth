#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// LongMemEval worker — runs ONE question in an ISOLATED substrate state.
//
// Spawned as a fresh child process per question by longmemeval.mjs.
// A fresh process is required (not just a fresh DB handle) because
// shared-core/state.js resolves STATE_DB_PATH into a module-scope constant
// at require() time and caches a singleton db handle — there is no
// in-process way to rebind it mid-run. One process per question keeps each
// haystack's ingest completely hermetic (mirrors tests/hermetic-db.js /
// tests/suite-11-production-e2e.js child-process isolation pattern).
//
// Contract (stdin -> stdout, both JSON, one line each):
//   stdin:  { question_id, question, haystack_sessions, haystack_dates,
//             agent_id, cwd, embedding_host }
//     haystack_sessions: array of sessions, each session an array of
//       { role: 'user'|'assistant', content: string } turns (native
//       LongMemEval shape).
//   stdout: single JSON line:
//     { question_id, ingested_turns, retrieved: [{statement,score,...}],
//       retrieval_path: 'semantic+lexical'|'lexical_fallback', error? }
//
// Real write path: shared-core/dialogue-memory.js recordTurn() — the SAME
// function bin/troth-entity.js calls after every real assistant turn
// (grepped: bin/troth-entity.js:1359). Real recall path:
// shared-core/engram.js retrieveRelevant() — the SAME function
// shared-core/benchmark-runner.js composeSubstratePrefix() uses to build
// the entity's prefix (episodic dialogue.turn rows included, since
// retrieveRelevant's no-scope branch rides recall.recall's cross-type
// 'all' class, which routes episodic through entity-axis.multiAxisQuery).
// No benchmark-only shortcuts, no raw SQL.

const { readFileSync } = require('node:fs');
const http = require('node:http');

// Direct /health probe against the local embed server (127.0.0.1:11437 by
// default) — spec step (e). shared-core/local-embedder.js's own health
// check (_embServerHealth) is private/unexported, so we mirror it exactly
// (same host/port/path/timeout convention) rather than reaching into
// module internals.
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
  const raw = readFileSync(0, 'utf8'); // read all of stdin
  const job = JSON.parse(raw);
  const {
    question_id, question, haystack_sessions, haystack_dates, question_date,
    agent_id, cwd, embedding_host
  } = job;

  const out = { question_id, ingested_turns: 0, retrieved: [], retrieval_path: 'unknown' };

  try {
    const dialogueMemory = require('../shared-core/dialogue-memory.js');
    const engram = require('../shared-core/engram.js');

    // Ingest every haystack session as dialogue turns, through the REAL
    // write path (dialogueMemory.recordTurn — same fn bin/troth-entity.js
    // uses after every real assistant turn). Each user/assistant pair in a
    // session becomes one turn. Sessions are timestamped in order using
    // haystack_dates so recency-weighted recall sees a plausible history
    // instead of everything landing at Date.now().
    let tsCursor = Date.now() - (haystack_sessions.length * 3600 * 1000);
    for (let si = 0; si < haystack_sessions.length; si++) {
      const session = haystack_sessions[si] || [];
      const sessDateStr = (haystack_dates && haystack_dates[si]) || null;
      let sessTs = tsCursor;
      if (sessDateStr) {
        const _cleanDate = sessDateStr.replace(/\s*\([^)]*\)\s*/, ' ').trim();
        const parsed = Date.parse(_cleanDate + ' UTC') || Date.parse(_cleanDate);
        if (!Number.isNaN(parsed)) sessTs = parsed;
      }
      // Pair consecutive user/assistant turns. LongMemEval sessions are
      // role-alternating; we walk pairs, tolerating stray unmatched roles.
      let userText = null;
      let pairIdx = 0;
      for (const turn of session) {
        if (turn.role === 'user') {
          userText = turn.content;
        } else if (turn.role === 'assistant') {
          const ok = dialogueMemory.recordTurn({
            timestamp: sessTs + pairIdx * 1000,
            agent_id,
            user_id: 'default',
            cwd,
            user_text: userText || '',
            assistant_text: turn.content || '',
            faculty: 'longmemeval-ingest',
            conversation_id: 'sess-' + si,
          });
          if (ok) { out.ingested_turns++; pairIdx++; }
          userText = null;
        }
      }
      tsCursor = sessTs + 60_000;
    }

    // Full digestion (TROTH_BENCH_FULL_SAUCE=1): the same understanding a
    // long-running entity accrues over time - identity registry, typed
    // instances, chunked docs:chats archive - built here, question-blind,
    // before the question is seen. Off by default so the raw-turn lane
    // stays runnable as the before/after baseline.
    if (process.env.TROTH_BENCH_FULL_SAUCE === '1') {
      const digest = require('./digest.cjs');
      const ic = require('../shared-core/instance-consolidation.js');
      // TROTH_BENCH_EXTRACTOR=proxy: extraction rides the operator's own proxy
      // (credentials and engine stay there); otherwise the llama.cpp host.
      const llmCall = process.env.TROTH_BENCH_EXTRACTOR === 'proxy'
        ? require('./proxy-extractor.cjs').makeProxyExtractor({
          timeout_ms: parseInt(process.env.TROTH_BENCH_EXTRACTOR_TIMEOUT_MS || '120000', 10)
        })
        : ic.makeLlamacppExtractor({
          host: process.env.TROTH_BENCH_EXTRACTOR_HOST || undefined,
          timeout_ms: parseInt(process.env.TROTH_BENCH_EXTRACTOR_TIMEOUT_MS || '120000', 10)
        });
      out.digest = await digest.digestHaystack({
        agent_id,
        user_id: 'default',
        llmCall,
        cacheDir: process.env.TROTH_BENCH_EXTRACT_CACHE || null
      });
    }

    // Backfill embeddings BEFORE recall.
    //
    // In a real long-running troth-entity process, shared-core/
    // background-worker.js's taskEmbeddingBackfill runs on a 30s cadence
    // during idle windows, so by the time the operator asks a question
    // about a conversation from days/weeks ago, that old dialogue turn
    // already has a stored embedding and semantic recall can find it.
    // This worker is a one-shot child process — ingest and recall happen
    // seconds apart with nothing else running, so without this step every
    // freshly-ingested turn has NO stored vector and recall.recall's dense
    // arm (recall.js denseArm / cosine rerank) has nothing to rerank,
    // silently degrading every question to lexical-only (min-one-token-
    // overlap) scoring — not a fair test of the substrate's real semantic
    // recall. Calling the SAME background task function directly (not a
    // benchmark-only reimplementation) keeps this on the real code path;
    // it is time-budgeted (10s) and self-terminates once the backlog for
    // this haystack (at most ~a few hundred turns) is drained.
    try {
      const backgroundWorker = require('../shared-core/background-worker.js');
      // taskEmbeddingBackfill isn't individually named in module.exports
      // (only DEFAULT_TASKS as a whole + a curated `tasks` map that omits
      // it) — locate it by name inside the exported DEFAULT_TASKS array so
      // this stays wired to the real task object (and its real 10s
      // RUN_BUDGET_MS) rather than a benchmark-only reimplementation.
      // Called directly (not via runDueTasks) to force an unconditional
      // backfill — runDueTasks' cadence/decision-record gating is
      // irrelevant here (this is a one-shot child process, not a
      // long-running worker loop).
      const tasks = (backgroundWorker && backgroundWorker.DEFAULT_TASKS) || [];
      const backfillTask = tasks.find(t => t && t.name === 'embedding_backfill');
      if (backfillTask && typeof backfillTask.run === 'function') {
        // Drain to the end, never one pass: the task is budgeted (10 s) and a
        // busy GPU (the 27B composing beside it) leaves turns without vectors,
        // which the harness then measures as lexical recall without saying so.
        // The row records what share of this haystack's turns carry a vector.
        let passes = 0, note = '';
        for (let i = 0; i < 60; i++) {
          const r = await backfillTask.run({}); passes++;
          note = ((r && r.notes) || []).join(' ');
          if (!/more remaining/.test(note)) break;
        }
        try {
          const state = require('../shared-core/state.js');
          const d = state._dbForQuery();
          const turns = d.prepare("SELECT COUNT(*) n FROM action_records WHERE type='tool_call' AND json_extract(input,'$.tool_name')='dialogue.turn'").get().n;
          const withVec = d.prepare("SELECT COUNT(*) n FROM engram_embeddings ee JOIN action_records ar ON ar.id=ee.engram_id WHERE ar.type='tool_call' AND json_extract(ar.input,'$.tool_name')='dialogue.turn'").get().n;
          out.embed_coverage = { turns, with_vector: withVec, passes, ratio: turns ? +(withVec / turns).toFixed(3) : null };
        } catch (_) { out.embed_coverage = null; }
      }
    } catch (_) { /* best-effort — recall gracefully degrades to lexical if this fails */ }

    // Real recall path — engram.retrieveRelevant, no-scope branch, which
    // is the same cross-type (identity+procedural+semantic+episodic) pull
    // the entity's prefix provider uses. Ask for a generous k so the
    // composed-answer step downstream has enough evidence.
    //
    // agent_id is intentionally OMITTED here (fixed  — a prior
    // draft of this worker passed agent_id, which silently steers
    // retrieveRelevant into its "explicit sub-brain silo" branch at
    // engram.js:927 (`opts.scope === undefined && !opts.agent_id`). That
    // branch calls listEngrams(), which only ever reads type='commitment'
    // rows — dialogue turns are written as type='tool_call'
    // (dialogue-memory.js recordTurn), so they are STRUCTURALLY INVISIBLE
    // on that path (retrieved:0 on every question, confirmed by a 2-question
    // dry run). The real production callers never pass agent_id here:
    // shared-core/substrate-tools.js:219 (the engram_search MCP tool) has
    // the comment "agent_id intentionally omitted — reads across the whole
    // partner brain", and bin/troth-entity.js's live per-turn prefix
    // provider calls recall.recall({class:'all', audience:'model_visible'})
    // directly with no agent_id either. Cross-question isolation is fully
    // guaranteed by the isolated STATE_DB_PATH (fresh child process + fresh
    // SQLite file per question) — agent_id silo isolation is redundant here
    // and was actively wrong.
    const host = embedding_host || 'http://127.0.0.1:11437';
    const healthy = await probeEmbedHealth(host, 800);
    const items = await engram.retrieveRelevant({
      cwd,
      query: question,
      k: 10,
      audience: 'model_visible', // matches the real prefix provider's filter
      embedding_host: host,
      reference_ts: (() => {
        if (!question_date) return undefined;
        const _cleanQd = String(question_date).replace(/\s*\([^)]*\)\s*/, ' ').trim();
        const p = Date.parse(_cleanQd + ' UTC') || Date.parse(_cleanQd);
        return Number.isNaN(p) ? undefined : p;
      })(),
    });
    out.retrieved = items.map(it => ({
      id: it.id, statement: it.statement, score: it.score,
      memory_class: it.memory_class, ts: it.ts,
      source: it.source || null, refs: it.refs || undefined
    }));
    out.retrieval_path = healthy ? 'semantic+lexical' : 'lexical_fallback';
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

main();
