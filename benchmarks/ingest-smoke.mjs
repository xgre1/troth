#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// RESEARCH-INGEST SMOKE — document-QA benchmark for the Chameleon L3
// ingest->query path (shared-core/chameleon.js), NOT the LongMemEval
// conversational-memory path (shared-core/dialogue-memory.js +
// engram.retrieveRelevant's no-scope branch). This is the operator's real
// "ingest a research paper, ask it a question" use case.
//
// Dataset: QASPER (allenai/qasper, dev split, official S3 mirror —
// https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz
// — the HF repo `allenai/qasper` only ships the dataset-loader script, no
// data files or parquet mirror, so this harness downloads directly from
// Allen AI's S3 bucket, the same URL qasper.py's own _split_generators use).
// benchmarks/datasets/qasper/smoke-slice-20.json is a curated 20-item slice
// (15 extractive-span answers, 5 short free-form answers; unanswerable and
// yes/no questions excluded as noisy to grade against a single-sentence
// composed answer) — see benchmarks/datasets/qasper/README (selection
// script logic summarized in ingest-smoke results' "Honest caveats").
//
// Per item:
//   1. Spawn benchmarks/ingest-worker.cjs as a FRESH child process with an
//      isolated HOME (tests/hermetic-db.js pattern — shared-core/state.js
//      resolves its DB path off HOME/CLAUDE_PLUGIN_DATA into a require-time
//      singleton, so a fresh process per paper is required, not just a
//      fresh STATE_DB_PATH value; STATE_DB_PATH is set too, belt-and-
//      suspenders, matching longmemeval-smoke.mjs's own pattern). Never
//      touches the operator's real ~/.troth.
//   2. The worker ingests the paper's FULL TEXT (title + abstract + every
//      section's paragraphs, joined) via chameleon.ingestDocument() under
//      a per-paper scope ('docs:qasper-<paper_id>') — the SAME function an
//      MCP troth_chameleon_ingest call would use.
//   3. The worker queries via chameleon.queryScope() (scope SET -> the
//      "scope-locked legacy" commitment+embedding corpus path in
//      engram.retrieveRelevant, engram.js:992) — the SAME function the MCP
//      troth_chameleon_query tool calls (plugin/mcp-servers/troth-
//      substrate/server.mjs:439).
//   4. This harness composes an answer from ONLY the retrieved chunks (no
//      outside knowledge) via the configured ChatGPT-endpoint transport
//      (benchmarks/codex-oneshot.mjs, subscription lane — no paid API), then judges
//      CORRECT/INCORRECT against the QASPER gold answer via the same
//      codex-oneshot path.
//   5. Embeddings: the worker probes http://127.0.0.1:11437/health itself
//      and reports which path it actually took (semantic+lexical vs
//      lexical_fallback) — this harness never guesses; ingestDocument /
//      queryScope self-degrade to lexical scoring on embed failure
//      regardless (never blocked on the health probe).
//
// Usage:
//   node benchmarks/ingest-smoke.mjs                  # full 20-item slice
//   node benchmarks/ingest-smoke.mjs --n 5             # first 5 (fast check)
//   node benchmarks/ingest-smoke.mjs --n 20 --offset 0
//
// Style/report format matches benchmarks/longmemeval-smoke.mjs.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const DATASET_PATH = join(__dirname, 'datasets/qasper/smoke-slice-20.json');
const WORKER_PATH = join(__dirname, 'ingest-worker.cjs');
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
const TOP_K = parseInt(argVal('--k', '8'), 10);
const CODEX_ONESHOT = join(__dirname, 'codex-oneshot.mjs');

function loadSlice() {
  let raw;
  try {
    raw = readFileSync(DATASET_PATH, 'utf8');
  } catch (e) {
    console.error('QASPER slice not found at ' + DATASET_PATH);
    console.error(String(e.message || e));
    console.error('This slice ships with the repository, so a clean clone has it.');
    console.error('If it is missing, see benchmarks/datasets/README.md.');
    process.exit(1);
  }
  const all = JSON.parse(raw);
  return all.slice(OFFSET, OFFSET + N);
}

// Assemble a paper's full text for ingest: title + abstract + every
// section's paragraphs, in document order. This is genuinely the paper's
// full text (not a summary/excerpt) — QASPER's full_text is already
// section-segmented plain text extracted from the PDF.
function assembleFullText(paper) {
  const parts = [];
  if (paper.abstract) parts.push(paper.abstract.trim());
  for (const sec of paper.full_text || []) {
    if (sec.section_name) parts.push('## ' + sec.section_name);
    for (const p of sec.paragraphs || []) {
      if (p && p.trim()) parts.push(p.trim());
    }
  }
  return parts.join('\n\n');
}

// ── One paper, one isolated substrate, one fresh worker process ─────────
function runPaper(item) {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ingest-smoke-'));
  const dbPath = join(tmpHome, 'state.db');
  const fullText = assembleFullText(item);
  const job = {
    paper_id: item.paper_id,
    title: item.title,
    ingest_text: fullText,
    question: item.question,
    k: TOP_K,
    agent_id: 'ingest-' + item.paper_id.replace(/[^a-zA-Z0-9_-]/g, '_'),
    cwd: '/benchmarks/ingest/' + item.paper_id,
    embedding_host: EMBED_HOST,
    scope: 'docs:qasper-' + item.paper_id,
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
      HOME: tmpHome, // real isolation lever — matches tests/hermetic-db.js
      TROTH_NO_MODEL_FETCH: '1',
    },
  });
  const wallMs = Date.now() - t0;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}

  if (res.error) {
    return { paper_id: item.paper_id, error: 'spawn: ' + res.error.message, wall_ms: wallMs };
  }
  if (res.status !== 0) {
    return {
      paper_id: item.paper_id,
      error: 'worker exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 2000),
      wall_ms: wallMs,
    };
  }
  const lastLine = String(res.stdout || '').trim().split('\n').filter(Boolean).pop();
  let parsed;
  try { parsed = JSON.parse(lastLine); }
  catch (e) {
    return { paper_id: item.paper_id, error: 'bad worker JSON: ' + String(lastLine).slice(0, 500), wall_ms: wallMs };
  }
  parsed.wall_ms = wallMs;
  return parsed;
}

// ── Compose an answer from retrieved chunks ONLY ─────────────────────────
// Same honesty contract as longmemeval-smoke.mjs's composeAnswerPrompt:
// this is not a separate "benchmark answer path" — it hands the composer
// exactly what a real chameleon_query MCP caller would see (the retrieved
// chunk statements) and nothing else. No gold answer visible at compose
// time, so a bad retrieval can't be papered over by a clever judge.
function composeAnswerPrompt(question, retrieved) {
  if (!retrieved.length) {
    return null; // nothing retrieved — answer is definitionally "unknown"
  }
  const chunks = retrieved.map((it, i) => `${i + 1}. ${it.statement}`).join('\n\n');
  return (
    'You are answering a question using ONLY the document excerpts below, ' +
    'retrieved from a research paper ingested into a document-QA substrate. ' +
    'If the excerpts do not contain the answer, say "unknown" — do not guess ' +
    'or use outside knowledge, even if you recognize the paper.\n\n' +
    'Document excerpts:\n' + chunks + '\n\n' +
    'Question: ' + question + '\n\n' +
    'Answer as briefly as possible — a short phrase or one sentence, ' +
    'quoting the excerpt text where possible. No preamble.'
  );
}

function callCodex(prompt, timeoutMs) {
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

function judge(question, goldAnswer, ourAnswer) {
  const prompt =
    'You are grading a document-QA answer against a gold answer extracted ' +
    'from a research paper. Respond with ONLY a JSON object, no markdown ' +
    'fences, no prose: {"verdict":"CORRECT"|"INCORRECT","reason":"<one short sentence>"}\n\n' +
    'Grade CORRECT if the candidate answer conveys the same fact/entity as ' +
    'the gold answer, even with different wording, extra detail, or partial ' +
    'phrasing that still captures the key fact. Grade INCORRECT if it is ' +
    'missing, contradictory, "unknown", or a different fact.\n\n' +
    'Question: ' + question + '\n' +
    'Gold answer: ' + goldAnswer + '\n' +
    'Candidate answer: ' + (ourAnswer == null ? '(no answer — nothing retrieved)' : ourAnswer) + '\n\n' +
    'JSON verdict:';
  const raw = callCodex(prompt, JUDGE_TIMEOUT_MS);
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
  console.log('═ RESEARCH-INGEST SMOKE (Chameleon doc-QA) ═');
  console.log('  dataset:  ' + DATASET_PATH + ' (QASPER dev, 20-item curated slice)');
  console.log('  slice:    [' + OFFSET + ', ' + (OFFSET + slice.length) + ') of 20');
  console.log('  embed:    ' + EMBED_HOST);
  console.log('  compose+judge: codex-oneshot (subscription lane, no paid API)');
  console.log('');

  const rows = [];
  for (let i = 0; i < slice.length; i++) {
    const item = slice[i];
    process.stdout.write(
      '[' + (i + 1) + '/' + slice.length + '] ' + item.paper_id +
      ' (' + item.kind + ') "' + item.question.slice(0, 60) + '"... '
    );
    const t0 = Date.now();
    const w = runPaper(item);
    if (w.error) {
      console.log('WORKER-ERROR');
      rows.push({
        paper_id: item.paper_id, kind: item.kind, title: item.title,
        question: item.question, gold_answer: item.gold,
        error: w.error, verdict: 'ERROR', wall_ms: Date.now() - t0,
      });
      continue;
    }

    let ourAnswer = null, judgeResult = null, judgeError = null;
    const answerPrompt = composeAnswerPrompt(item.question, w.retrieved || []);
    try {
      ourAnswer = answerPrompt ? callCodex(answerPrompt, JUDGE_TIMEOUT_MS) : null;
      judgeResult = judge(item.question, item.gold, ourAnswer);
    } catch (e) {
      judgeError = String(e.message || e);
    }

    const verdict = judgeError ? 'ERROR' : judgeResult.verdict;
    console.log(
      verdict === 'CORRECT' ? '\x1b[32mCORRECT\x1b[0m' :
      verdict === 'INCORRECT' ? '\x1b[31mINCORRECT\x1b[0m' : '\x1b[33mERROR\x1b[0m'
    );

    rows.push({
      paper_id: item.paper_id,
      kind: item.kind,
      title: item.title,
      question: item.question,
      gold_answer: item.gold,
      ingest: w.ingest,
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

  console.log('\n═ RESEARCH-INGEST SMOKE results ═');
  console.log('  graded:    ' + graded + '/' + rows.length);
  console.log('  correct:   ' + correct);
  console.log('  incorrect: ' + incorrect);
  console.log('  errors:    ' + errors);
  console.log('  accuracy:  ' + (accuracy * 100).toFixed(1) + '%  (of graded)');
  console.log('  wall time: ' + (totalWallMs / 1000).toFixed(1) + 's total');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync(join(REPO, 'benchmarks/results'), { recursive: true });
  const jsonOutPath = join(REPO, 'benchmarks/results/ingest-smoke-' + ts + '.json');
  writeFileSync(jsonOutPath, JSON.stringify({
    timestamp: Date.now(),
    // Relative on purpose: an absolute dataset path records the build machine
    // into a published result file.
    dataset: DATASET_PATH.replace(REPO + '/', ''),
    dataset_source: 'allenai/qasper dev split, official S3 mirror (see file header)',
    offset: OFFSET, n: N, top_k: TOP_K,
    embed_host: EMBED_HOST,
    correct, incorrect, errors, graded, total: rows.length, accuracy,
    total_wall_ms: totalWallMs,
    retrieval_paths_seen: [...retrievalPaths],
    rows,
  }, null, 2));
  console.log('\nRaw results: ' + jsonOutPath);

  const mdPath = join(REPO, 'benchmarks/results/ingest-smoke-' + ts.slice(0, 10) + '.md');
  writeFileSync(mdPath, renderMarkdown({
    rows, correct, incorrect, errors, graded, accuracy, totalWallMs,
    offset: OFFSET, n: N, topK: TOP_K, retrievalPaths: [...retrievalPaths], embedHost: EMBED_HOST,
  }));
  console.log('Report:      ' + mdPath);
}

function renderMarkdown(s) {
  const lines = [];
  lines.push('# RESEARCH-INGEST SMOKE — troth substrate Chameleon doc-QA path');
  lines.push('');
  lines.push('Run: ' + new Date().toISOString());
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push('| Sample size | ' + s.n + ' paper+question items (offset ' + s.offset + ') |');
  lines.push('| Graded | ' + s.graded + '/' + s.rows.length + ' |');
  lines.push('| Correct | ' + s.correct + ' |');
  lines.push('| Incorrect | ' + s.incorrect + ' |');
  lines.push('| Errors | ' + s.errors + ' |');
  lines.push('| **Accuracy (of graded)** | **' + (s.accuracy * 100).toFixed(1) + '%** |');
  lines.push('| Wall time | ' + (s.totalWallMs / 1000).toFixed(1) + 's |');
  lines.push('| top_k retrieved per question | ' + s.topK + ' |');
  lines.push('| Retrieval path(s) observed | ' + (s.retrievalPaths.join(', ') || 'none') + ' |');
  lines.push('| Embed server probe target | ' + s.embedHost + ' |');
  lines.push('');
  lines.push('## What this measures (and how it differs from LongMemEval)');
  lines.push('');
  lines.push('LongMemEval (see `benchmarks/results/longmemeval-smoke-*.md`) tests ' +
    '**conversational memory**: dialogue turns written via `dialogueMemory.recordTurn()` ' +
    'and recalled via `engram.retrieveRelevant()`\'s no-scope cross-type branch ' +
    '(`recall.recall({class:\'all\'})`).');
  lines.push('');
  lines.push('This benchmark tests the **Chameleon L3 document-ingest path** ' +
    '(`shared-core/chameleon.js`) instead — a structurally different code path: ' +
    'a whole research paper\'s full text is chunked (paragraph/sentence-aware, ' +
    '~800 chars/100-char overlap) and embedded via `chameleon.ingestDocument()`, ' +
    'persisted as engrams tagged with a per-paper `scope` (`docs:qasper-<paper_id>`), ' +
    'then queried via `chameleon.queryScope()`, which routes `engram.retrieveRelevant()` ' +
    'into its **scope-locked legacy commitment+embedding path** (`engram.js` — the ' +
    '"caller wants a specific commitment corpus (chameleon docs:* etc)" branch), ' +
    'NOT the dialogue-turn cross-type branch LongMemEval exercises. This is the same ' +
    'function the MCP `troth_chameleon_query` tool calls.');
  lines.push('');
  lines.push('## Honest caveats');
  lines.push('');
  lines.push('- **20-item smoke slice**, not a full QASPER run (the dev split alone has 281 papers / ~1.3k answerable non-yes/no questions). Accuracy at n=20 has a wide confidence interval (~±20pp at 95% CI for a binomial proportion) — treat as a pipeline-works signal, not a publishable number.');
  lines.push('- **Dataset**: QASPER dev split (`allenai/qasper`), downloaded from the official Allen AI S3 mirror (`https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz`) because the HuggingFace `allenai/qasper` repo only ships the dataset-loader script (`qasper.py`), not data files or a parquet mirror.');
  lines.push('- **Slice construction**: filtered to papers with 8k-35k chars of full text (fast-enough ingest, still a real paper — not an abstract), excluded `unanswerable` and `yes_no` questions (noisy to grade against a single free-text composed answer per the task spec), then took 15 `extractive_spans` items (gold = spans joined by "; ") + 5 short `free_form_answer` items (gold < 200 chars), one question per distinct paper, seeded random shuffle (seed 42) for selection order. Selection script: not committed (one-off, see this file\'s header for the exact filter/seed logic to reproduce).');
  lines.push('- **Ingest is the paper\'s real full text**: title + abstract + every section\'s paragraphs from QASPER\'s already-PDF-segmented `full_text` field, joined in document order — not a summary or truncated excerpt.');
  lines.push('- Retrieval path: worker probes `' + s.embedHost + '`/health itself per paper and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise (see `retrieval_path` column). This is a side-channel label only — `chameleon.ingestDocument`/`queryScope` always run for real and self-degrade (null embedding per chunk, lexical-only rerank) on embed failure regardless of what the probe says.');
  lines.push('- Ingest and query both go through the REAL substrate path: `chameleon.ingestDocument()` (chunks+embeds+persists as scoped engrams) and `chameleon.queryScope()` -> `engram.retrieveRelevant()` with `scope` set (the scope-locked legacy corpus path). No benchmark-only shortcut, no raw SQL read.');
  lines.push('- Each paper runs in a fully isolated, throwaway HOME (fresh child process per paper, mirrors `tests/hermetic-db.js`\'s HOME-redirect mechanism — `STATE_DB_PATH` alone does NOT isolate `shared-core/state.js`, which resolves off HOME/CLAUDE_PLUGIN_DATA) — nothing was written to the operator\'s real `~/.troth`.');
  lines.push('- The compose+judge model is `codex-oneshot.mjs` (a GPT-5 class model through the ChatGPT Responses endpoint), NOT the original QASPER paper\'s F1/token-overlap evaluator, so numbers are not directly comparable to published QASPER leaderboard scores without re-running their exact metric.');
  lines.push('- "Our answer" is composed by handing the model ONLY the retrieved chunk excerpts (no gold answer visible at compose time) and asking it to answer from those alone, saying "unknown" if absent — isolates retrieval quality from judge leniency, same contract as the LongMemEval harness\'s `composeAnswerPrompt`.');
  lines.push('');
  lines.push('## Per-question verdicts');
  lines.push('');
  lines.push('| # | paper_id | kind | verdict | retrieved | path | question |');
  lines.push('|---|---|---|---|---|---|---|');
  s.rows.forEach((r, i) => {
    lines.push(
      '| ' + (i + 1) + ' | ' + r.paper_id + ' | ' + (r.kind || '-') +
      ' | ' + r.verdict + ' | ' + (r.retrieved_count != null ? r.retrieved_count : '-') +
      ' | ' + (r.retrieval_path || '-') + ' | ' + r.question.replace(/\|/g, '\\|').slice(0, 90) + ' |'
    );
  });
  lines.push('');
  lines.push('## Detail (gold vs our answer, judge reason)');
  lines.push('');
  s.rows.forEach((r, i) => {
    lines.push('### ' + (i + 1) + '. ' + r.paper_id + ' — ' + r.verdict);
    lines.push('');
    lines.push('- **Title:** ' + (r.title || '-'));
    lines.push('- **Question:** ' + r.question);
    lines.push('- **Gold answer:** ' + (r.gold_answer != null ? r.gold_answer : '-'));
    lines.push('- **Our answer:** ' + (r.our_answer != null ? r.our_answer : '(none — nothing retrieved or error)'));
    lines.push('- **Judge reason:** ' + (r.judge_reason || '-'));
    lines.push('- **Ingest:** ' + (r.ingest ? JSON.stringify(r.ingest) : '-') + ', **retrieved:** ' + (r.retrieved_count != null ? r.retrieved_count : '-') + ', **path:** ' + (r.retrieval_path || '-') + ', **wall:** ' + r.wall_ms + 'ms');
    if (r.error) lines.push('- **Error:** ' + r.error);
    lines.push('');
  });
  lines.push('## Rerun commands');
  lines.push('');
  lines.push('```bash');
  lines.push('# This smoke run (20 items, offset 0)');
  lines.push('node benchmarks/ingest-smoke.mjs --n 20 --offset 0');
  lines.push('');
  lines.push('# Fast check (first 5 only)');
  lines.push('node benchmarks/ingest-smoke.mjs --n 5');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
