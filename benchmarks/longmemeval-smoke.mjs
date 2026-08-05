#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// LongMemEval SMOKE — 20-question slice of LongMemEval-S against the REAL
// troth substrate write/recall path.
//
// Per question:
//   1. Spawn benchmarks/longmemeval-worker.cjs as a FRESH child process with
//      an isolated STATE_DB_PATH (tests/hermetic-db.js pattern — a throwaway
//      SQLite file per haystack, never ~/.troth). A fresh process is
//      required, not just a fresh path: shared-core/state.js resolves its
//      DB path into a module-scope singleton at require()-time, so there is
//      no in-process way to rebind it between questions.
//   2. The worker ingests every haystack session as dialogue turns through
//      dialogueMemory.recordTurn() — the SAME function bin/troth-entity.js
//      calls after every real assistant turn (bin/troth-entity.js:1359).
//   3. The worker recalls via engram.retrieveRelevant() with NO agent_id
//      ( fix — passing agent_id silently steers retrieveRelevant
//      into its commitment-only sub-brain-silo branch, which structurally
//      cannot see dialogue.turn rows; confirmed via a 2-question dry run
//      that returned 0 retrieved items on both before this fix). Omitting
//      agent_id matches the REAL production call sites: shared-core/
//      substrate-tools.js:219 (the troth_engram_search MCP tool — comment
//      there reads "agent_id intentionally omitted") and bin/troth-entity.js's
//      live per-turn prefix provider, which calls recall.recall({class:'all',
//      audience:'model_visible'}) directly with no agent_id. Cross-question
//      isolation is guaranteed by the isolated STATE_DB_PATH instead (see
//      step 1), not by an agent_id silo. The worker also forces a real
//      taskEmbeddingBackfill pass (shared-core/background-worker.js) between
//      ingest and recall — in a long-running entity this runs on a 30s idle
//      cadence, but this one-shot process needs it forced or every freshly-
//      ingested turn has no stored vector and recall silently degrades to
//      lexical-only scoring.
//   4. This harness composes an answer from the top retrieved statements
//      (a thin, honest paraphraser — see composeAnswer() below) and judges
//      it against the gold answer via `claude -p` (a Claude model through the
//      Claude Code CLI) — CORRECT/INCORRECT JSON verdict.
//   5. Embeddings: the worker probes http://127.0.0.1:11437/health itself
//      and reports which path (semantic+lexical vs lexical_fallback) it
//      actually took — this harness never guesses.
//
// Usage:
//   node benchmarks/longmemeval-smoke.mjs                 # first 20 (smoke)
//   node benchmarks/longmemeval-smoke.mjs --n 500          # full run
//   node benchmarks/longmemeval-smoke.mjs --n 20 --offset 20
//
// Style/report format matches benchmarks/lmdt-runner.mjs.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync,
         openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
// The upstream filename first, so a reader who downloads LongMemEval-S and
// drops it in place can run the command printed in the result document without
// renaming anything. The `_cleaned` name is the locally re-serialised copy the
// published run used; see benchmarks/datasets/README.md.
const DATASET_CANDIDATES = [
  join(__dirname, 'datasets/longmemeval/longmemeval_s.json'),
  join(__dirname, 'datasets/longmemeval/longmemeval_s_cleaned.json')
];
const DATASET_PATH = DATASET_CANDIDATES.find((p) => existsSync(p)) || DATASET_CANDIDATES[0];

// Hashed by streaming, not by reading 277 MB into memory to hash it.
function datasetSha256() {
  try {
    const h = createHash('sha256');
    const fd = openSync(DATASET_PATH, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
      }
    } finally { closeSync(fd); }
    return h.digest('hex');
  } catch (_) { return null; }
}
const WORKER_PATH = join(__dirname, 'longmemeval-worker.cjs');
const EMBED_HOST = process.env.TROTH_EMBED_HOST || 'http://127.0.0.1:11437';

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const N = parseInt(argVal('--n', '20'), 10);
const OFFSET = parseInt(argVal('--offset', '0'), 10);
const WORKER_TIMEOUT_MS = parseInt(argVal('--worker-timeout-ms', '120000'), 10);
const JUDGE_TIMEOUT_MS = parseInt(argVal('--judge-timeout-ms', '60000'), 10);
// Judge/compose provider: 'codex' = the ChatGPT Responses endpoint via the
// codex-oauth transport;
// 'claude' = the original `claude -p` path. Default codex.
const PROVIDER = argVal('--provider', 'codex');
const CODEX_ONESHOT = join(__dirname, 'codex-oneshot.mjs');
// Answer transport (the SECOND arm): 'codex'/'claude' = cloud model reads the
// retrieved memory from the prompt (the MCP/hosted experience); 'llamacpp' =
// the LOCAL model answers WITH substrate decode-time bias toward the retrieved
// facts (the mechanism the hosted path can't use). The JUDGE stays on PROVIDER
// (codex) either way, so the two arms are graded identically.
const ANSWER = argVal('--answer', 'codex');
const LLAMA_ONESHOT = join(__dirname, 'llamacpp-oneshot.mjs');

function loadSlice() {
  let raw;
  try {
    raw = readFileSync(DATASET_PATH, 'utf8');
  } catch (e) {
    console.error('LongMemEval-S not found. Looked for:');
    for (const p of DATASET_CANDIDATES) console.error('  ' + p);
    console.error('');
    console.error('It is ~277 MB, so it is downloaded rather than committed.');
    console.error('benchmarks/datasets/README.md says where to get it and where to put it.');
    process.exit(1);
  }
  const all = JSON.parse(raw);
  return all.slice(OFFSET, OFFSET + N);
}

// ── One question, one isolated substrate, one fresh worker process ──────
function runQuestion(q) {
  const tmpHome = mkdtempSync(join(tmpdir(), 'lme-smoke-'));
  const dbPath = join(tmpHome, 'state.db');
  const job = {
    question_id: q.question_id,
    question: q.question,
    haystack_sessions: q.haystack_sessions,
    haystack_dates: q.haystack_dates,
    agent_id: 'lme-' + q.question_id,
    cwd: '/benchmarks/longmemeval/' + q.question_id,
    embedding_host: EMBED_HOST,
  };
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [WORKER_PATH], {
    input: JSON.stringify(job),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: WORKER_TIMEOUT_MS,
    env: {
      ...process.env,
      STATE_DB_PATH: dbPath,
      HOME: tmpHome, // belt-and-suspenders: matches tests/hermetic-db.js redirect
      TROTH_NO_MODEL_FETCH: '1',
    },
  });
  const wallMs = Date.now() - t0;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}

  if (res.error) {
    return { question_id: q.question_id, error: 'spawn: ' + res.error.message, wall_ms: wallMs };
  }
  if (res.status !== 0) {
    return {
      question_id: q.question_id,
      error: 'worker exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 2000),
      wall_ms: wallMs,
    };
  }
  const lastLine = String(res.stdout || '').trim().split('\n').filter(Boolean).pop();
  let parsed;
  try { parsed = JSON.parse(lastLine); }
  catch (e) {
    return { question_id: q.question_id, error: 'bad worker JSON: ' + String(lastLine).slice(0, 500), wall_ms: wallMs };
  }
  parsed.wall_ms = wallMs;
  return parsed;
}

// ── Compose an answer from retrieved statements ──────────────────────────
// Honest and thin: this is NOT a separate "benchmark answer path" — it is
// the same downstream step composeSubstratePrefix() leaves to the LLM
// (handing it "Relevant memories: - stmt1 - stmt2 ..." and letting the
// model answer from them). Since this harness doesn't spin up a full
// entity turn, we hand the SAME retrieved-statement list to the judge step
// and let Claude (the judge) both compose AND grade in one call — but to
// keep the "answer" and "grade" honest and separable (so a bad retrieval
// can't be papered over by a clever judge), we first ask a plain
// composition question with ONLY the retrieved statements as context, no
// gold answer visible.
function composeAnswerPrompt(question, retrieved) {
  if (!retrieved.length) {
    return null; // nothing retrieved — answer is definitionally "unknown"
  }
  const mem = retrieved.map((it, i) => `${i + 1}. ${it.statement}`).join('\n');
  return (
    'You are answering a question using ONLY the memory statements below, ' +
    'retrieved from a conversation history substrate. If the statements do ' +
    'not contain the answer, say "unknown" — do not guess or use outside ' +
    'knowledge.\n\n' +
    'Memory statements:\n' + mem + '\n\n' +
    'Question: ' + question + '\n\n' +
    'Answer in one short sentence or phrase. No preamble.'
  );
}

function callClaudeP(prompt, timeoutMs) {
  if (PROVIDER === 'codex') {
    // Prompt rides stdin (can be large: memory statements), same one-process-
    // per-call shape as claude -p so the sync harness loop is unchanged.
    const res = spawnSync(process.execPath, [CODEX_ONESHOT], {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      cwd: REPO,
    });
    if (res.error) throw new Error('codex spawn error: ' + res.error.message);
    if (res.status !== 0) throw new Error('codex exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 1000));
    return String(res.stdout || '');
  }
  const res = spawnSync('claude', ['-p', '--output-format=json', prompt], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    cwd: REPO,
  });
  if (res.error) throw new Error('claude -p spawn error: ' + res.error.message);
  if (res.status !== 0) throw new Error('claude -p exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 1000));
  const j = JSON.parse(res.stdout);
  return j.result != null ? String(j.result) : '';
}

function composeAnswer(prompt, retrieved, timeoutMs) {
  if (ANSWER === 'llamacpp') {
    const boost = retrieved.map((it) => it.statement).filter(Boolean);
    const res = spawnSync(process.execPath, [LLAMA_ONESHOT], {
      input: JSON.stringify({ prompt, boost }),
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, cwd: REPO,
    });
    if (res.error) throw new Error('llamacpp spawn error: ' + res.error.message);
    if (res.status !== 0) throw new Error('llamacpp exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 500));
    return String(res.stdout || '');
  }
  return callClaudeP(prompt, timeoutMs);
}

function judge(question, goldAnswer, ourAnswer) {
  const prompt =
    'You are grading a memory-recall answer against a gold answer. ' +
    'Respond with ONLY a JSON object, no markdown fences, no prose: ' +
    '{"verdict":"CORRECT"|"INCORRECT","reason":"<one short sentence>"}\n\n' +
    'Grade CORRECT if the candidate answer conveys the same fact as the ' +
    'gold answer, even with different wording, extra detail, or partial ' +
    'phrasing that still captures the key fact. Grade INCORRECT if it is ' +
    'missing, contradictory, "unknown", or a different fact.\n\n' +
    'Question: ' + question + '\n' +
    'Gold answer: ' + goldAnswer + '\n' +
    'Candidate answer: ' + (ourAnswer == null ? '(no answer — nothing retrieved)' : ourAnswer) + '\n\n' +
    'JSON verdict:';
  const raw = callClaudeP(prompt, JUDGE_TIMEOUT_MS);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('judge returned non-JSON: ' + raw.slice(0, 300));
  const j = JSON.parse(m[0]);
  if (j.verdict !== 'CORRECT' && j.verdict !== 'INCORRECT') {
    throw new Error('judge returned unexpected verdict: ' + JSON.stringify(j));
  }
  return j;
}

// ── Run ────────────────────────────────────────────────────────────────
async function main() {
  const slice = loadSlice();
  console.log('═ LongMemEval SMOKE ═');
  console.log('  dataset:  ' + DATASET_PATH);
  console.log('  slice:    [' + OFFSET + ', ' + (OFFSET + slice.length) + ') of full set');
  console.log('  embed:    ' + EMBED_HOST);
  console.log('  answer:   ' + ANSWER + '   judge: ' + PROVIDER);
  console.log('');

  const rows = [];
  for (let i = 0; i < slice.length; i++) {
    const q = slice[i];
    process.stdout.write(
      '[' + (i + 1) + '/' + slice.length + '] ' + q.question_id +
      ' (' + q.question_type + ') "' + q.question.slice(0, 60) + '"... '
    );
    const t0 = Date.now();
    const w = runQuestion(q);
    if (w.error) {
      console.log('WORKER-ERROR');
      rows.push({
        question_id: q.question_id, question_type: q.question_type,
        question: q.question, gold_answer: q.answer,
        error: w.error, verdict: 'ERROR', wall_ms: Date.now() - t0,
      });
      continue;
    }

    let ourAnswer = null, judgeResult = null, judgeError = null;
    const answerPrompt = composeAnswerPrompt(q.question, w.retrieved || []);
    try {
      ourAnswer = answerPrompt ? composeAnswer(answerPrompt, w.retrieved || [], JUDGE_TIMEOUT_MS) : null;
      judgeResult = judge(q.question, q.answer, ourAnswer);
    } catch (e) {
      judgeError = String(e.message || e);
    }

    const verdict = judgeError ? 'ERROR' : judgeResult.verdict;
    console.log(
      verdict === 'CORRECT' ? '\x1b[32mCORRECT\x1b[0m' :
      verdict === 'INCORRECT' ? '\x1b[31mINCORRECT\x1b[0m' : '\x1b[33mERROR\x1b[0m'
    );

    rows.push({
      question_id: q.question_id,
      question_type: q.question_type,
      question: q.question,
      gold_answer: q.answer,
      ingested_turns: w.ingested_turns,
      retrieval_path: w.retrieval_path,
      retrieved_count: (w.retrieved || []).length,
      our_answer: ourAnswer,
      verdict,
      judge_reason: judgeResult ? judgeResult.reason : judgeError,
      wall_ms: Date.now() - t0,
    });
  }

  // ── Report ──────────────────────────────────────────────────────────
  const correct = rows.filter(r => r.verdict === 'CORRECT').length;
  const incorrect = rows.filter(r => r.verdict === 'INCORRECT').length;
  const errors = rows.filter(r => r.verdict === 'ERROR').length;
  const graded = correct + incorrect;
  const accuracy = graded ? (correct / graded) : 0;
  const totalWallMs = rows.reduce((s, r) => s + (r.wall_ms || 0), 0);
  const retrievalPaths = new Set(rows.map(r => r.retrieval_path).filter(Boolean));

  console.log('\n═ LongMemEval SMOKE results ═');
  console.log('  graded:    ' + graded + '/' + rows.length);
  console.log('  correct:   ' + correct);
  console.log('  incorrect: ' + incorrect);
  console.log('  errors:    ' + errors);
  console.log('  accuracy:  ' + (accuracy * 100).toFixed(1) + '%  (of graded)');
  console.log('  wall time: ' + (totalWallMs / 1000).toFixed(1) + 's total');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonOutPath = join(REPO, 'benchmarks/results/longmemeval-smoke-' + ts + '.json');
  mkdirSync(dirname(jsonOutPath), { recursive: true });
  writeFileSync(jsonOutPath, JSON.stringify({
    timestamp: Date.now(),
    // Relative on purpose: an absolute dataset path records the build machine
    // into a published result file.
    dataset: DATASET_PATH.replace(REPO + '/', ''),
    // The hash is what makes two runs comparable. Without it, "we both ran
    // LongMemEval" is an assumption about bytes neither side checked.
    datasetSha256: datasetSha256(),
    offset: OFFSET, n: N,
    embed_host: EMBED_HOST,
    correct, incorrect, errors, graded, total: rows.length, accuracy,
    total_wall_ms: totalWallMs,
    retrieval_paths_seen: [...retrievalPaths],
    rows,
  }, null, 2));
  console.log('\nRaw results: ' + jsonOutPath);

  // Dated by RUN, like the json next to it. A fixed name silently overwrote
  // the previous run's report.
  const mdPath = join(REPO, 'benchmarks/results/longmemeval-smoke-' + ts + '.md');
  writeFileSync(mdPath, renderMarkdown({
    rows, correct, incorrect, errors, graded, accuracy, totalWallMs,
    offset: OFFSET, n: N, retrievalPaths: [...retrievalPaths], embedHost: EMBED_HOST,
  }));
  console.log('Report:      ' + mdPath);
}

function renderMarkdown(s) {
  const lines = [];
  lines.push('# LongMemEval SMOKE — troth substrate');
  lines.push('');
  lines.push('Run: ' + new Date().toISOString());
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push('| Sample size | ' + s.n + ' questions (offset ' + s.offset + ') |');
  lines.push('| Graded | ' + s.graded + '/' + s.rows.length + ' |');
  lines.push('| Correct | ' + s.correct + ' |');
  lines.push('| Incorrect | ' + s.incorrect + ' |');
  lines.push('| Errors | ' + s.errors + ' |');
  lines.push('| **Accuracy (of graded)** | **' + (s.accuracy * 100).toFixed(1) + '%** |');
  lines.push('| Wall time | ' + (s.totalWallMs / 1000).toFixed(1) + 's |');
  lines.push('| Retrieval path(s) observed | ' + (s.retrievalPaths.join(', ') || 'none') + ' |');
  lines.push('| Embed server probe target | ' + s.embedHost + ' |');
  if (s.datasetSha256) {
    lines.push('| Dataset | `' + s.dataset + '` |');
    lines.push('| Dataset sha256 | `' + s.datasetSha256 + '` |');
  }
  lines.push('');
  lines.push('## Honest caveats');
  lines.push('');
  lines.push('- **20-sample smoke test**, not the full 500-question LongMemEval-S set. Accuracy at this sample size has a wide confidence interval (roughly ±20pp at 95% CI for a binomial proportion) — treat as a smoke signal that the pipeline works end-to-end, not a publishable recall number.');
  lines.push('- Sample is a **fixed offset slice** (first 20 by dataset order), not a random or stratified sample. The dataset\'s question_type distribution for this slice may not match the full set\'s distribution — check the `question_type` column below.');
  lines.push('- Retrieval path: worker probes `' + s.embedHost + '`/health itself per question and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise. See the `retrieval_path` column per row.');
  lines.push('- Ingest and recall both go through the REAL substrate write path (`dialogueMemory.recordTurn`, same function `bin/troth-entity.js` calls after every real turn) and REAL recall path (`engram.retrieveRelevant` with no `agent_id`, matching `shared-core/substrate-tools.js`\'s `troth_engram_search` MCP tool and `bin/troth-entity.js`\'s live per-turn prefix provider, both of which omit `agent_id` so cross-type episodic/semantic/procedural recall is reachable). No benchmark-only shortcut or raw SQL read. A real `taskEmbeddingBackfill` pass (`shared-core/background-worker.js`) runs between ingest and recall so semantic rerank has stored vectors to work with, mirroring what a long-running entity\'s idle-cadence backfill would have by the time an old conversation is queried.');
  lines.push('- Each question runs in a fully isolated, throwaway `STATE_DB_PATH` (fresh child process per question, mirrors `tests/hermetic-db.js`) — haystacks never leak between questions, and nothing was written to the operator\'s real `~/.troth`.');
  lines.push('- The judge is `claude -p` (a Claude model via the Claude Code CLI) grading CORRECT/INCORRECT against the gold answer with a single lenient-match prompt — not the original LongMemEval paper\'s GPT-4o judge, so numbers are not directly comparable to published Mem0/Zep LongMemEval results without re-running their judge methodology.');
  lines.push('- "Our answer" is composed by handing the judge model ONLY the retrieved statement list (no gold answer visible at compose time) and asking it to answer from those statements alone, saying "unknown" if absent — this isolates retrieval quality from judge leniency, but is a thinner answer-composition step than a full entity turn (no full identity envelope, no multi-turn context beyond the retrieved set).');
  lines.push('');
  lines.push('## Per-question verdicts');
  lines.push('');
  lines.push('| # | question_id | type | verdict | retrieved | path | question |');
  lines.push('|---|---|---|---|---|---|---|');
  s.rows.forEach((r, i) => {
    lines.push(
      '| ' + (i + 1) + ' | ' + r.question_id + ' | ' + (r.question_type || '-') +
      ' | ' + r.verdict + ' | ' + (r.retrieved_count != null ? r.retrieved_count : '-') +
      ' | ' + (r.retrieval_path || '-') + ' | ' + r.question.replace(/\|/g, '\\|').slice(0, 90) + ' |'
    );
  });
  lines.push('');
  lines.push('## Detail (gold vs our answer, judge reason)');
  lines.push('');
  s.rows.forEach((r, i) => {
    lines.push('### ' + (i + 1) + '. ' + r.question_id + ' — ' + r.verdict);
    lines.push('');
    lines.push('- **Question:** ' + r.question);
    lines.push('- **Gold answer:** ' + (r.gold_answer != null ? r.gold_answer : '-'));
    lines.push('- **Our answer:** ' + (r.our_answer != null ? r.our_answer : '(none — nothing retrieved or error)'));
    lines.push('- **Judge reason:** ' + (r.judge_reason || '-'));
    lines.push('- **Ingested turns:** ' + (r.ingested_turns != null ? r.ingested_turns : '-') + ', **retrieved:** ' + (r.retrieved_count != null ? r.retrieved_count : '-') + ', **path:** ' + (r.retrieval_path || '-') + ', **wall:** ' + r.wall_ms + 'ms');
    if (r.error) lines.push('- **Error:** ' + r.error);
    lines.push('');
  });
  lines.push('## Rerun commands');
  lines.push('');
  lines.push('```bash');
  lines.push('# Dataset placement (once): benchmarks/datasets/README.md');
  lines.push('');
  lines.push('# This smoke run (20 questions, offset 0)');
  lines.push('node benchmarks/longmemeval-smoke.mjs --n 20 --offset 0');
  lines.push('');
  lines.push('# Full LongMemEval-S (500 questions) — budget wall time accordingly,');
  lines.push('# see wall-time-per-question in this report to extrapolate.');
  lines.push('node benchmarks/longmemeval-smoke.mjs --n 500 --offset 0');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
