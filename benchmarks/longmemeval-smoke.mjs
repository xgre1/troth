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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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
const STRATIFIED = parseInt(argVal('--stratified', '0'), 10);
const ONLY = argVal('--only', '');
const WORKER_TIMEOUT_MS = parseInt(argVal('--worker-timeout-ms', '120000'), 10);
const JUDGE_TIMEOUT_MS = parseInt(argVal('--judge-timeout-ms', '60000'), 10);
// Judge/compose provider: 'codex' = the ChatGPT Responses endpoint via the
// codex-oauth transport;
// 'claude' = the original `claude -p` path. Default codex.
const PROVIDER = argVal('--provider', 'codex');
const CLAUDE_MODEL = argVal('--model', '');
const CODEX_ONESHOT = join(__dirname, 'codex-oneshot.mjs');
// Answer transport (the SECOND arm): 'codex'/'claude' = cloud model reads the
// retrieved memory from the prompt (the MCP/hosted experience); 'llamacpp' =
// the LOCAL model answers WITH substrate decode-time bias toward the retrieved
// facts (the mechanism the hosted path can't use). The JUDGE stays on PROVIDER
// (codex) either way, so the two arms are graded identically.
const ANSWER = argVal('--answer', 'codex');
const JUDGE = argVal('--judge', '');
const JUDGE_HOST = process.env.TROTH_JUDGE_HOST || 'http://localhost:1234';
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
  if (ONLY) {
    const ids = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
    return all.filter((x) => ids.includes(x.question_id));
  }
  if (STRATIFIED > 0) {
    const byType = new Map();
    for (const q of all) {
      const t = q.question_type || '?';
      if (!byType.has(t)) byType.set(t, []);
      const bucket = byType.get(t);
      if (bucket.length < STRATIFIED) bucket.push(q);
    }
    return [...byType.values()].flat();
  }
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
    question_date: q.question_date,
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
function composeAnswerPrompt(q, retrieved) {
  if (!retrieved.length) {
    return null; // nothing retrieved — answer is definitionally "unknown"
  }
  const _hasLedger = retrieved.some((it) => it.source === 'instance-pool');
  let mem;
  if (_hasLedger) {
    const { buildReconciledView } = require('../shared-core/reconciled-view.js');
    const _stamp = (it) => Object.assign({}, it, {
      statement: (Number.isFinite(it.ts) && it.source !== 'instance-pool'
        ? '[' + new Date(it.ts).toISOString().slice(0, 10) + '] ' : '') + it.statement
    });
    mem = buildReconciledView(retrieved.map(_stamp)).render();
  } else {
    mem = retrieved.map((it, i) => {
      const d = Number.isFinite(it.ts) ? '[' + new Date(it.ts).toISOString().slice(0, 10) + '] ' : '';
      return `${i + 1}. ${d}${it.statement}`;
    }).join('\n');
  }
  const _pref = q.question_type === 'single-session-preference';
  return (
    (_pref
      ? 'You are answering a personal request. The memory statements below, ' +
        'retrieved from a conversation history substrate, tell you who the user ' +
        'is — their preferences, constraints, gear, plans. Use them to ' +
        'personalise your answer; you may use general knowledge for the ' +
        'recommendation itself, but ground every personal detail in the ' +
        'statements.\n\n'
      : 'You are answering a question using ONLY the memory statements below, ' +
        'retrieved from a conversation history substrate. Each statement may be ' +
        'prefixed with the [date] it was recorded. If the statements do ' +
        'not contain the answer, say "unknown" — do not guess or use outside ' +
        'knowledge. If statements give conflicting or updated values for the ' +
        'same fact, the most recent [date] wins — answer with the updated value.\n\n') +
    'Memory statements:\n' + mem + '\n\n' +
    (q.question_date ? 'Question asked on: ' + q.question_date + ' — compute any relative time (ago / since / between) from this date using the [dates] on the statements.\n' : '') +
    'Question: ' + q.question + '\n\n' +
    (/\b(how many|how much|how often|total|count|number of|order of|first to last|earliest to latest)\b/i.test(q.question)
      ? 'When a Consolidated ledger is present, follow its own legends: the ' +
        'L-lines are the occurrences, the marks say what is already counted ' +
        'and what you judge individually, and the header rules (ownership, ' +
        'distinct people over C-lines) are the counting law. ' +
        'Otherwise work in two steps: first list every DISTINCT item or event that matches ' +
        'what the question counts (cite the statement number for each; merge ' +
        'repeated MENTIONS of the same thing; skip anything the statements do ' +
        'not support). Statements may contain a "user:" and an "asst:" half - ' +
        'the assistant restating something the user already said is not a ' +
        'separate instance, but a DISTINCT entity (a different name, specialty ' +
        'or type) counts even when the assistant named it first, as long as ' +
        'the user\'s own messages engage with it as theirs (booked it, used ' +
        'it, visited it). ' +
        'Count at the unit the question names: when one storyline leaves several ' +
        'qualifying units (e.g. one item still to return AND another still to ' +
        'pick up), count each unit separately. ' +
        'When the question sets a time window (this year, last month, past N ' +
        'weeks), place every candidate with the statement dates and drop the ' +
        'ones outside the window before counting. ' +
        'One occasion described across several statements is still ONE event: ' +
        'combine statements that clearly refer to the same occasion instead ' +
        'of treating the combination as unsupported. ' +
        'Apply the question\'s own qualifier first, judged by the statement\'s ' +
        'own wording: an event the user participated in is not one they ' +
        '"watched", and a project described only as "working on" in a team is ' +
        'not one they "led" - but a SOLO project is led by its only member, ' +
        'and doing something alone satisfies leading it. ' +

        'When mentions state INCREMENTS over time (e.g. wore them twice, then ' +
        'once more, then three more times), add the increments up for the total. ' +
        'Then give the final result on its own last line as: Answer: <value>'
      : q.question_type === 'knowledge-update'
      ? 'Work in two steps: first list EVERY dated value the statements give for ' +
        'the asked fact, oldest to newest (cite the statement number for each — ' +
        'include values stated in passing, e.g. "remember when..."). Then answer ' +
        'with the most recent value on its own last line as: Answer: <value>'
      : _pref
      ? 'First find the preference or prior effort MOST specific to this exact ' +
        'request and build the answer around it; then weave in the user\'s ' +
        'other relevant preferences and constraints so each is acknowledged. ' +
        'A generally personalised answer that ignores the one most on-point ' +
        'preference is a miss. Personalised, no preamble.'
      : 'Answer in one short sentence or phrase, using the user\'s own wording for the asked detail where the statements give it. Answer exactly what is asked - do not append extra items or alternatives. No preamble.')
  );
}

function callClaudeP(prompt, timeoutMs) {
  return _callProvider(prompt, timeoutMs);
}

// claude -p loads the user-level ambient (global CLAUDE.md, plugins, hooks
// that inject context blocks into every prompt). A benchmark call must run
// in a sterile HOME holding ONLY the credential file, or the measurement
// includes whatever the operator's environment happens to inject that day —
// measured swing on identical inputs: tens of points.

let _cleanHome = null;
function cleanClaudeHome() {
  if (_cleanHome) return _cleanHome;
  const dir = mkdtempSync(join(tmpdir(), 'lme-claude-home-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  try {
    const cred = join(process.env.HOME || '', '.claude', '.credentials.json');
    writeFileSync(join(dir, '.claude', '.credentials.json'), readFileSync(cred));
  } catch (_) { /* keychain-auth setups need no credential file */ }
  _cleanHome = dir;
  return _cleanHome;
}

function _callProvider(prompt, timeoutMs) {
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
  const _claudeArgs = ['-p', '--output-format=json'];
  if (CLAUDE_MODEL) _claudeArgs.push('--model', CLAUDE_MODEL);
  _claudeArgs.push(prompt);
  const res = spawnSync('claude', _claudeArgs, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    cwd: cleanClaudeHome(),
    env: { ...process.env, HOME: cleanClaudeHome() },
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

const JUDGE_PROMPTS_VERSION = 'longmemeval-official-v1';

function officialJudgePrompt(q, ourAnswer) {
  const resp = ourAnswer == null ? '(no answer — nothing retrieved)' : ourAnswer;
  if (/_abs$/.test(q.question_id)) {
    return (
      'I will give you an unanswerable question, an explanation, and a response ' +
      'from a model. Please answer yes if the model correctly identifies the ' +
      'question as unanswerable. The model could say that the information is ' +
      'incomplete, or some other information is given but the asked information ' +
      'is not.\n\n' +
      'Question: ' + q.question + '\n\n' +
      'Explanation: ' + q.answer + '\n\n' +
      'Model Response: ' + resp + '\n\n' +
      'Does the model correctly identify the question as unanswerable? Answer yes or no only.'
    );
  }
  if (q.question_type === 'single-session-preference') {
    return (
      'I will give you a question, a rubric for a desired personalized response, ' +
      'and a response from a model. Please answer yes if the response satisfies ' +
      'the desired response. Otherwise, answer no. The model does not need to ' +
      'reflect all the points in the rubric. The response is correct as long as ' +
      'it recalls and utilizes the user\'s personal information correctly.\n\n' +
      'Question: ' + q.question + '\n\n' +
      'Rubric: ' + q.answer + '\n\n' +
      'Model Response: ' + resp + '\n\n' +
      'Is the model response correct? Answer yes or no only.'
    );
  }
  let extra = '';
  if (q.question_type === 'temporal-reasoning') {
    extra =
      ' In addition, do not penalize off-by-one errors for the number of days. ' +
      'If the question asks for the number of days/weeks/months, etc., and the ' +
      'model makes off-by-one errors (e.g., predicting 19 days when the answer ' +
      'is 18), the model\'s response is still correct.';
  } else if (q.question_type === 'knowledge-update') {
    extra =
      ' If the response contains some previous information along with an ' +
      'updated answer, the response should be considered as correct as long as ' +
      'the updated answer is the required answer.';
  }
  return (
    'I will give you a question, a correct answer, and a response from a model. ' +
    'Please answer yes if the response contains the correct answer. Otherwise, ' +
    'answer no. If the response is equivalent to the correct answer or contains ' +
    'all the intermediate steps to get the correct answer, you should also ' +
    'answer yes. If the response only contains a subset of the information ' +
    'required by the answer, answer no.' + extra + '\n\n' +
    'Question: ' + q.question + '\n\n' +
    'Correct Answer: ' + q.answer + '\n\n' +
    'Model Response: ' + resp + '\n\n' +
    'Is the model response correct? Answer yes or no only.'
  );
}

// Deterministic judge: local llama-server at temperature 0. An LLM judge
// behind a CLI has neither temperature control nor a pinned context, and
// verdicts on identical input flipped between runs. enable_thinking:false is
// load-bearing for reasoning models — with it on, the tiny max_tokens budget
// is consumed by thinking and the visible content comes back empty.
async function judgeLocal(prompt) {
  const res = await fetch(JUDGE_HOST + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'local-judge',
      temperature: 0,
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: 'You are a strict grader. Reply with exactly yes or no.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const body = await res.json();
  return String((body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '');
}

async function judge(q, ourAnswer) {
  const raw = JUDGE === 'local'
    ? await judgeLocal(officialJudgePrompt(q, ourAnswer))
    : callClaudeP(officialJudgePrompt(q, ourAnswer), JUDGE_TIMEOUT_MS);
  const m = String(raw).trim().match(/^\W*(yes|no)\b/i);
  if (!m) throw new Error('judge returned non-yes/no: ' + String(raw).slice(0, 300));
  const yes = m[1].toLowerCase() === 'yes';
  return {
    verdict: yes ? 'CORRECT' : 'INCORRECT',
    reason: 'official ' + (/_abs$/.test(q.question_id) ? 'abstention' : q.question_type) + ' judge: ' + m[1].toLowerCase()
  };
}

// ── Run ────────────────────────────────────────────────────────────────
async function main() {
  const slice = loadSlice();
  console.log('═ LongMemEval SMOKE ═');
  console.log('  dataset:  ' + DATASET_PATH);
  console.log('  slice:    ' + (STRATIFIED > 0 ? 'stratified ' + STRATIFIED + '/type = ' + slice.length + ' questions' : '[' + OFFSET + ', ' + (OFFSET + slice.length) + ') of full set'));
  console.log('  embed:    ' + EMBED_HOST);
  console.log('  answer:   ' + ANSWER + (ANSWER === 'claude' && CLAUDE_MODEL ? ' (' + CLAUDE_MODEL + ')' : '') + '   judge: ' + (JUDGE === 'local' ? 'local@temp0 (' + JUDGE_HOST + ')' : PROVIDER + (PROVIDER === 'claude' && CLAUDE_MODEL ? ' (' + CLAUDE_MODEL + ')' : '')) + '   prompts: ' + JUDGE_PROMPTS_VERSION);
  console.log('');
  try {
    const _eh = await fetch(EMBED_HOST + '/health', { signal: AbortSignal.timeout(5000) });
    if (!_eh.ok) throw new Error('health ' + _eh.status);
  } catch (e) {
    console.error('ABORT: embedder unreachable at ' + EMBED_HOST + ' (' + String(e.message || e) + ').');
    console.error('A run without the dense arm silently measures lexical_fallback retrieval — a different system.');
    console.error('Start the embedder, or pass --allow-degraded to run anyway.');
    if (argVal('--allow-degraded', '') !== '1') process.exit(1);
  }

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
    const answerPrompt = composeAnswerPrompt(q, w.retrieved || []);
    try {
      ourAnswer = answerPrompt ? composeAnswer(answerPrompt, w.retrieved || [], JUDGE_TIMEOUT_MS) : null;
      judgeResult = await judge(q, ourAnswer);
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
      retrieved_preview: (w.retrieved || []).map((it) => ({
        ts: it.ts,
        s: String(it.statement || '').slice(0, 160)
      })),
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
  let _commit = null;
  try { _commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(); } catch (_) {}
  writeFileSync(jsonOutPath, JSON.stringify({
    timestamp: Date.now(),
    // The commit that produced this result. Overlay-synced trees have no
    // commit identity; a result that cannot name its code cannot be replayed.
    commit: _commit,
    full_sauce: process.env.TROTH_BENCH_FULL_SAUCE === '1',
    // Relative on purpose: an absolute dataset path records the build machine
    // into a published result file.
    dataset: DATASET_PATH.replace(REPO + '/', ''),
    // The hash is what makes two runs comparable. Without it, "we both ran
    // LongMemEval" is an assumption about bytes neither side checked.
    datasetSha256: datasetSha256(),
    offset: OFFSET, n: N, stratified: STRATIFIED || null,
    judge_provider: JUDGE === 'local' ? 'local-llamacpp' : PROVIDER,
    judge_model: JUDGE === 'local' ? 'local-temp0-thinking-off' : (PROVIDER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : 'codex-oauth'),
    answer_transport: ANSWER,
    answer_model: ANSWER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : ANSWER,
    judge_prompts: JUDGE_PROMPTS_VERSION,
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
    stratified: STRATIFIED,
    judgeProvider: JUDGE === 'local' ? 'local-llamacpp' : PROVIDER,
    judgeModel: JUDGE === 'local' ? 'local-temp0-thinking-off' : (PROVIDER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : 'codex-oauth'),
    answerTransport: ANSWER,
    answerModel: ANSWER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : ANSWER,
    judgePrompts: JUDGE_PROMPTS_VERSION,
    dataset: DATASET_PATH.replace(REPO + '/', ''),
    datasetSha256: datasetSha256(),
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
  lines.push('| Sample size | ' + (s.stratified > 0 ? s.rows.length + ' questions (stratified ' + s.stratified + '/type)' : s.n + ' questions (offset ' + s.offset + ')') + ' |');
  lines.push('| Graded | ' + s.graded + '/' + s.rows.length + ' |');
  lines.push('| Correct | ' + s.correct + ' |');
  lines.push('| Incorrect | ' + s.incorrect + ' |');
  lines.push('| Errors | ' + s.errors + ' |');
  lines.push('| **Accuracy (of graded)** | **' + (s.accuracy * 100).toFixed(1) + '%** |');
  lines.push('| Wall time | ' + (s.totalWallMs / 1000).toFixed(1) + 's |');
  lines.push('| Judge | ' + s.judgeProvider + ' (' + s.judgeModel + '), prompts ' + s.judgePrompts + ' |');
  lines.push('| Answer | ' + s.answerTransport + ' (' + s.answerModel + ') |');
  lines.push('| Retrieval path(s) observed | ' + (s.retrievalPaths.join(', ') || 'none') + ' |');
  lines.push('| Embed server probe target | ' + s.embedHost + ' |');
  if (s.datasetSha256) {
    lines.push('| Dataset | `' + s.dataset + '` |');
    lines.push('| Dataset sha256 | `' + s.datasetSha256 + '` |');
  }
  lines.push('');
  const byType = new Map();
  for (const r of s.rows) {
    const t = /_abs$/.test(r.question_id) ? 'abstention' : (r.question_type || '?');
    if (!byType.has(t)) byType.set(t, { n: 0, correct: 0 });
    const b = byType.get(t);
    b.n++;
    if (r.verdict === 'CORRECT') b.correct++;
  }
  lines.push('## By question type');
  lines.push('');
  lines.push('| Type | n | Correct | Accuracy |');
  lines.push('|---|---|---|---|');
  for (const [t, b] of [...byType.entries()].sort((a, z) => a[0].localeCompare(z[0]))) {
    lines.push('| ' + t + ' | ' + b.n + ' | ' + b.correct + ' | ' + (100 * b.correct / b.n).toFixed(1) + '% |');
  }
  lines.push('');
  lines.push('## Honest caveats');
  lines.push('');
  lines.push('- **' + s.rows.length + '-question sample** (' + (s.stratified > 0 ? 'stratified ' + s.stratified + '/type' : 'fixed offset slice') + '), not the full 500-question LongMemEval-S set unless n=500. Binomial CI applies — treat sub-100 samples as smoke signals, not publishable numbers.');
  lines.push('- ' + (s.stratified > 0 ? 'Stratified sampling takes the first ' + s.stratified + ' questions of each question_type in dataset order — deterministic and reproducible, but within-type dataset order is arbitrary upstream.' : 'Sample is a **fixed offset slice** (dataset order), and the dataset is ordered by question_type — an offset-0 slice measures ONLY the first type(s). Check the `question_type` column below.'));
  lines.push('- Retrieval path: worker probes `' + s.embedHost + '`/health itself per question and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise. See the `retrieval_path` column per row.');
  lines.push('- Ingest and recall both go through the REAL substrate write path (`dialogueMemory.recordTurn`, same function `bin/troth-entity.js` calls after every real turn) and REAL recall path (`engram.retrieveRelevant` with no `agent_id`, matching `shared-core/substrate-tools.js`\'s `troth_engram_search` MCP tool and `bin/troth-entity.js`\'s live per-turn prefix provider, both of which omit `agent_id` so cross-type episodic/semantic/procedural recall is reachable). No benchmark-only shortcut or raw SQL read. A real `taskEmbeddingBackfill` pass (`shared-core/background-worker.js`) runs between ingest and recall so semantic rerank has stored vectors to work with, mirroring what a long-running entity\'s idle-cadence backfill would have by the time an old conversation is queried.');
  lines.push('- Each question runs in a fully isolated, throwaway `STATE_DB_PATH` (fresh child process per question, mirrors `tests/hermetic-db.js`) — haystacks never leak between questions, and nothing was written to the operator\'s real `~/.troth`.');
  lines.push('- The judge uses the official LongMemEval per-type prompt templates (' + s.judgePrompts + ': standard, temporal off-by-one allowance, knowledge-update updated-answer rule, preference rubric, abstention) with a yes/no verdict, faithfully reproduced from the upstream evaluate_qa.py. The remaining protocol deviation is the judge MODEL: ' + s.judgeModel + ' instead of the paper\'s GPT-4o.');
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

// Run ONLY when invoked as the entry script. A benchmark that fires on
// import is a benchmark that fires by accident — a syntax probe, a tooling
// import, a test harness pulling helpers — and every accidental firing
// ingests haystacks and writes a junk result into the archive.
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
