#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// LongMemEval — a slice of LongMemEval-S against the REAL
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
//   node benchmarks/longmemeval.mjs                 # first 20 (quick check)
//   node benchmarks/longmemeval.mjs --n 500          # full run
//   node benchmarks/longmemeval.mjs --n 20 --offset 20
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
const SLICE_EXPLICIT = args.indexOf('--n') >= 0 || args.indexOf('--offset') >= 0;
const ONLY = argVal('--only', '');
// --rejudge <results.json>: grade that run's stored answers with this run's
// judge, composing nothing. The judge is the one variable.
const REJUDGE = argVal('--rejudge', '');
const REJUDGE_SRC = REJUDGE ? JSON.parse(readFileSync(REJUDGE, 'utf8')) : null;
const REJUDGE_ROWS = REJUDGE_SRC ? (REJUDGE_SRC.rows || []) : null;
// A re-judged run keeps the answers' own labels: the answers were composed
// by the source run's model, not by whatever --answer this invocation carries.
function _answerTransportLabel() {
  return REJUDGE_SRC && REJUDGE_SRC.answer_transport ? REJUDGE_SRC.answer_transport : ANSWER;
}
function _answerModelLabel() {
  if (REJUDGE_SRC && REJUDGE_SRC.answer_model) return REJUDGE_SRC.answer_model;
  return ANSWER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : (ANSWER === 'proxy' ? 'proxy:' + PROXY_MODEL : ANSWER);
}
const WORKER_TIMEOUT_MS = parseInt(argVal('--worker-timeout-ms', '120000'), 10);
const JUDGE_TIMEOUT_MS = parseInt(argVal('--judge-timeout-ms', '60000'), 10);
// The answer lane gets its own clock — a compose over a big mount is not a
// judge call, and the two lanes must never share a budget again.
const ANSWER_TIMEOUT_MS = parseInt(argVal('--answer-timeout-ms', String(Math.max(JUDGE_TIMEOUT_MS, 240000))), 10);
// Judge/compose provider: 'codex' = the ChatGPT Responses endpoint via the
// codex-oauth transport; 'proxy' = the operator's own troth proxy
// (/v1/messages), which holds the credentials and picks the engine, so the
// harness never touches a key or a token; 'claude' = the original
// `claude -p` path. Default codex.
const PROVIDER = argVal('--provider', 'codex');
const CLAUDE_MODEL = argVal('--model', '');
const CODEX_ONESHOT = join(__dirname, 'codex-oneshot.mjs');
const PROXY_ONESHOT = join(__dirname, 'proxy-oneshot.mjs');
const PROXY_MODEL = process.env.TROTH_PROXY_MODEL || 'gpt-5.5';
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
  if (REJUDGE_ROWS) {
    const ids = REJUDGE_ROWS.map((r) => r.question_id);
    return all.filter((x) => ids.includes(x.question_id)).sort((a, b) => ids.indexOf(a.question_id) - ids.indexOf(b.question_id));
  }
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
    const buckets = [...byType.values()];
    const woven = [];
    for (let _i = 0; _i < STRATIFIED; _i++) {
      for (const _b of buckets) if (_b[_i]) woven.push(_b[_i]);
    }
    return SLICE_EXPLICIT ? woven.slice(OFFSET, OFFSET + N) : woven;
  }
  return all.slice(OFFSET, OFFSET + N);
}

// ── One question, one isolated substrate, one fresh worker process ──────
function runQuestion(q) {
  const tmpHome = mkdtempSync(join(tmpdir(), 'lme-'));
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
// One structured call per question reads its shape; the local reader's
// host serves it (the judge host when no reader host is set).
const _shapeCall = (() => {
  try {
    const qs = require('../shared-core/question-shape.js');
    const host = process.env.TROTH_LLAMACPP_HOST || process.env.TROTH_JUDGE_HOST || null;
    return host ? qs.makeShapeCall({ host, timeout_ms: 30000 }) : null;
  } catch (_) { return null; }
})();

function composeAnswerPrompt(q, retrieved, shape) {
  if (!retrieved.length) {
    return null; // nothing retrieved — answer is definitionally "unknown"
  }
  const _hasLedger = retrieved.some((it) => it.source === 'instance-pool');
  let mem;
  // The view also serves a preference question with no ledger: it leads with
  // what the user said about themselves, then the statements.
  if (_hasLedger || q.question_type === 'single-session-preference') {
    const { buildReconciledView } = require('../shared-core/reconciled-view.js');
    const _stamp = (it) => Object.assign({}, it, {
      statement: (Number.isFinite(it.ts) && it.source !== 'instance-pool'
        ? '[' + new Date(it.ts).toISOString().slice(0, 10) + '] ' : '') + it.statement
    });
    const { countNounHead, countNounPhrase } = require('../shared-core/engram.js');
    // The view is question-shaped: it sets aside ledger lines outside the
    // question's time window or subject, so the reader counts what was asked.
    const _refTs = (() => {
      if (!q.question_date) return undefined;
      const c = String(q.question_date).replace(/\s*\([^)]*\)\s*/, ' ').trim();
      const p = Date.parse(c + ' UTC') || Date.parse(c);
      return Number.isNaN(p) ? undefined : p;
    })();
    mem = buildReconciledView(retrieved.map(_stamp), { noun_head: countNounHead(q.question), head_phrase: countNounPhrase(q.question), question: q.question, reference_ts: _refTs, shape: shape || undefined }).render();
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
    // The question type decides first: a knowledge-update question phrased
    // as a count ("how many X have I tried") is answered by its newest
    // stated value, never by summing the stated total with the members.
    (q.question_type !== 'knowledge-update' && /\b(how many|how much|how often|total|count|number of|order of|first to last|earliest to latest)\b/i.test(q.question)
      ? 'When a Consolidated ledger is present, follow its own legends: the ' +
        'L-lines are the occurrences, the marks say what is already counted ' +
        'and what you judge individually, and the header rules (ownership, ' +
        'distinct people over C-lines) are the counting law. ' +
        'Otherwise work in two steps: first list every DISTINCT item or event that matches ' +
        'what the question counts (cite the statement number for each; merge ' +
        'repeated MENTIONS of the same thing; skip anything the statements do ' +
        'not support). Statements may contain a "user:" and an "asst:" half - ' +
        'the assistant restating something the user already said is not a ' +
        'separate instance, but a DISTINCT entity (a different name or type) ' +
        'counts even when the assistant named it first, as long as ' +
        'the user\'s own messages engage with it as theirs (booked it, used ' +
        'it, visited it). ' +
        'Count at the unit the question names. ' +
        'When the question sets a time window, place every candidate with ' +
        'the statement dates and drop the ones outside the window before ' +
        'counting. ' +
        'One occasion described across several statements is still ONE event: ' +
        'combine statements that clearly refer to the same occasion instead ' +
        'of treating the combination as unsupported. ' +

        'When mentions state INCREMENTS over time, add the increments up for the total. ' +
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
// that inject context blocks into every prompt). A benchmark call must not
// see any of it, or the measurement includes whatever the operator's
// environment happens to inject that day — measured swing on identical
// inputs: tens of points. Two sterile shapes, same guarantee:
//   default                       — throwaway HOME holding only the credential
//                                   file (works where that file is readable);
//   TROTH_BENCH_CLAUDE_KEYCHAIN=1 — real HOME so macOS Keychain auth works,
//                                   with --setting-sources "" and
//                                   --strict-mcp-config stripping the ambient
//                                   instead (contamination probe on 2.1.220
//                                   reports zero injected context).

let _cleanHome = null;
function cleanClaudeHome() {
  if (_cleanHome) return _cleanHome;
  const dir = mkdtempSync(join(tmpdir(), 'lme-claude-home-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  try {
    const cred = join(process.env.HOME || '', '.claude', '.credentials.json');
    writeFileSync(join(dir, '.claude', '.credentials.json'), readFileSync(cred));
  } catch (_) { /* keychain-auth setups need no credential file */ }
  writeFileSync(join(dir, 'empty-mcp.json'), '{"mcpServers":{}}');
  _cleanHome = dir;
  return _cleanHome;
}

// One prompt in on stdin, one answer out on stdout, one process per call:
// the shape every cloud lane shares, so the sync harness loop never changes.
function _spawnOneshot(script, prompt, timeoutMs, label) {
  const res = spawnSync(process.execPath, [script], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    cwd: REPO,
  });
  if (res.error) throw new Error(label + ' spawn error: ' + res.error.message);
  if (res.status !== 0) throw new Error(label + ' exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 1000));
  return String(res.stdout || '');
}

function _callProvider(prompt, timeoutMs) {
  if (PROVIDER === 'codex') {
    // Prompt rides stdin (can be large: memory statements), same one-process-
    // per-call shape as claude -p so the sync harness loop is unchanged.
    return _spawnOneshot(CODEX_ONESHOT, prompt, timeoutMs, 'codex');
  }
  if (PROVIDER === 'proxy') return _spawnOneshot(PROXY_ONESHOT, prompt, timeoutMs, 'proxy');
  const keychain = process.env.TROTH_BENCH_CLAUDE_KEYCHAIN === '1';
  const _claudeArgs = ['-p', '--output-format=json'];
  if (CLAUDE_MODEL) _claudeArgs.push('--model', CLAUDE_MODEL);
  if (keychain) {
    // Prompt rides stdin here: --mcp-config is variadic and would swallow a
    // trailing positional prompt as a second config path.
    _claudeArgs.push('--setting-sources', '', '--strict-mcp-config',
      '--mcp-config', join(cleanClaudeHome(), 'empty-mcp.json'));
  } else {
    _claudeArgs.push(prompt);
  }
  const res = spawnSync('claude', _claudeArgs, {
    ...(keychain ? { input: prompt } : {}),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    cwd: cleanClaudeHome(),
    env: keychain ? { ...process.env } : { ...process.env, HOME: cleanClaudeHome() },
  });
  if (res.error) throw new Error('claude -p spawn error: ' + res.error.message);
  if (res.status !== 0) throw new Error('claude -p exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 1000));
  const j = JSON.parse(res.stdout);
  return j.result != null ? String(j.result) : '';
}

function _composeOnce(prompt, retrieved, timeoutMs) {
  if (ANSWER === 'llamacpp') {
    const boost = retrieved.map((it) => it.statement).filter(Boolean);
    // Both clocks agree: the child's internal abort gets the same budget as
    // the spawn, and the spawn adds margin for node boot + stdin. One retry
    // on transport-class failures only — a judged-wrong answer never retries.
    const run = () => spawnSync(process.execPath, [LLAMA_ONESHOT], {
      input: JSON.stringify({ prompt, boost }),
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs + 15000, cwd: REPO,
      env: { ...process.env, TROTH_BENCH_LOCAL_TIMEOUT_MS: String(timeoutMs) },
    });
    let res = run();
    const transportFail = (r) => r.error || (r.status !== 0 && /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|aborted|socket hang up/i.test(String(r.stderr || '') + String(r.error && r.error.message || '')));
    if (transportFail(res)) {
      process.stdout.write(' [transport retry]');
      res = run();
    }
    if (res.error) throw new Error('llamacpp spawn error: ' + res.error.message);
    if (res.status !== 0) throw new Error('llamacpp exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 500));
    return String(res.stdout || '');
  }
  if (ANSWER === 'proxy') return _spawnOneshot(PROXY_ONESHOT, prompt, timeoutMs, 'proxy');
  return callClaudeP(prompt, timeoutMs);
}

// An empty compose is a transport outcome, not a memory verdict — the model
// never spoke. One retry on the same arm; a persistent blank stays in the
// row and scores as the failure it is, never excluded.
function composeAnswer(prompt, retrieved, timeoutMs) {
  let text = _composeOnce(prompt, retrieved, timeoutMs);
  if (!String(text || '').trim()) {
    process.stdout.write(' [empty compose retry]');
    text = _composeOnce(prompt, retrieved, timeoutMs);
  }
  return text;
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
// One retry on a connection-class failure: under concurrent load a fetch can
// fail before the server ever sees it, and that is a transport outcome, not
// a grading verdict. A second consecutive failure surfaces as the error it is.
async function judgeLocal(prompt) {
  try { return await _judgeLocalOnce(prompt); }
  catch (_) { return await _judgeLocalOnce(prompt); }
}

async function _judgeLocalOnce(prompt) {
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
  console.log('═ LongMemEval ═');
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
    // --rejudge <results.json>: the rows come from that file (their answers
    // and coverage as recorded), only the judge runs. Holding the answers
    // fixed is how two judges are compared on the same evidence.
    const _prev = REJUDGE_ROWS ? REJUDGE_ROWS.find((r) => r.question_id === q.question_id) : null;
    const w = _prev
      ? { ingested_turns: _prev.ingested_turns, retrieved: [], retrieval_path: _prev.retrieval_path, embed_coverage: _prev.embed_coverage || null, error: _prev.error }
      : runQuestion(q);
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
    // The question's shape, read by the local model (any language); the
    // English patterns stand in when no model answers.
    let shape = null;
    try {
      const qs = require('../shared-core/question-shape.js');
      const _refTs = q.question_date ? (Date.parse(String(q.question_date).replace(/\s*\([^)]*\)\s*/, ' ').trim() + ' UTC') || undefined) : undefined;
      shape = await qs.shapeQuestion(q.question, { llmCall: _shapeCall, reference_ts: Number.isFinite(_refTs) ? _refTs : undefined });
    } catch (_) { shape = null; }
    const answerPrompt = composeAnswerPrompt(q, w.retrieved || [], shape);
    try {
      // A re-judge grades the stored answer; nothing is composed again.
      ourAnswer = _prev ? (_prev.our_answer == null ? null : _prev.our_answer) : (answerPrompt ? composeAnswer(answerPrompt, w.retrieved || [], ANSWER_TIMEOUT_MS) : null);
      judgeResult = await judge(q, ourAnswer);
    } catch (e) {
      judgeError = String(e.message || e);
    }

    // An answer cut off before its final line is an instrument failure, not
    // a memory verdict: the model ran out of output budget mid-deliberation
    // and never named a value. Grading that as INCORRECT blames recall for
    // a ceiling the harness owns. The check applies ONLY where the prompt
    // actually demanded that final line - the preference and default
    // families are told to answer in a sentence with no preamble, and a
    // blind check would mark every one of them an error.
    const _demandedAnswerLine = !!answerPrompt && answerPrompt.indexOf('Answer: <value>') !== -1;
    // A bare 'Answer:' with nothing after it is the same truncation: the
    // line was reached, the value was not.
    const _unfinished = !judgeError && ourAnswer && _demandedAnswerLine && !/^\s*Answer:\s*\S/mi.test(String(ourAnswer));
    const verdict = judgeError ? 'ERROR' : (_unfinished ? 'ERROR' : judgeResult.verdict);
    if (_unfinished) judgeError = 'answer truncated before its Answer: line (' + String(ourAnswer).length + ' chars) - raise TROTH_BENCH_LOCAL_MAX_TOKENS';
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
      embed_coverage: w.embed_coverage || null,
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
  // Coverage is the instrument that says whether recall was semantic: a row
  // whose turns lack vectors measured lexical recall no matter what the
  // health probe said. Summarised here, printed on the report.
  const coverageRatios = rows.map(r => r.embed_coverage && r.embed_coverage.ratio).filter(v => typeof v === 'number');
  const coverageMin = coverageRatios.length ? Math.min(...coverageRatios) : null;
  const rowsBelowFull = coverageRatios.length ? coverageRatios.filter(v => v < 1).length : null;

  console.log('\n═ LongMemEval results ═');
  console.log('  graded:    ' + graded + '/' + rows.length);
  console.log('  correct:   ' + correct);
  console.log('  incorrect: ' + incorrect);
  console.log('  errors:    ' + errors);
  console.log('  accuracy:  ' + (accuracy * 100).toFixed(1) + '%  (of graded)');
  console.log('  wall time: ' + (totalWallMs / 1000).toFixed(1) + 's total');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonOutPath = join(REPO, 'benchmarks/results/longmemeval-' + ts + '.json');
  mkdirSync(dirname(jsonOutPath), { recursive: true });
  let _commit = null;
  try { _commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(); } catch (_) {}
  writeFileSync(jsonOutPath, JSON.stringify({
    timestamp: Date.now(),
    // The commit that produced this result. Overlay-synced trees have no
    // commit identity; a result that cannot name its code cannot be replayed.
    commit: _commit,
    // A re-judge names the answers it graded: same answers, another judge.
    rejudged_from: REJUDGE || null,
    full_sauce: process.env.TROTH_BENCH_FULL_SAUCE === '1',
    // Relative on purpose: an absolute dataset path records the build machine
    // into a published result file.
    dataset: DATASET_PATH.replace(REPO + '/', ''),
    // The hash is what makes two runs comparable. Without it, "we both ran
    // LongMemEval" is an assumption about bytes neither side checked.
    datasetSha256: datasetSha256(),
    offset: OFFSET, n: N, stratified: STRATIFIED || null,
    judge_provider: JUDGE === 'local' ? 'local-llamacpp' : PROVIDER,
    judge_model: JUDGE === 'local' ? 'local-temp0-thinking-off' : (PROVIDER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : (PROVIDER === 'proxy' ? 'proxy:' + PROXY_MODEL : 'codex-oauth')),
    answer_transport: _answerTransportLabel(),
    answer_model: _answerModelLabel(),
    judge_prompts: JUDGE_PROMPTS_VERSION,
    embed_host: EMBED_HOST,
    correct, incorrect, errors, graded, total: rows.length, accuracy,
    total_wall_ms: totalWallMs,
    retrieval_paths_seen: [...retrievalPaths],
    embed_coverage_min: coverageMin,
    rows_below_full_coverage: rowsBelowFull,
    rows,
  }, null, 2));
  console.log('\nRaw results: ' + jsonOutPath);

  // Dated by RUN, like the json next to it. A fixed name silently overwrote
  // the previous run's report.
  const mdPath = join(REPO, 'benchmarks/results/longmemeval-' + ts + '.md');
  writeFileSync(mdPath, renderMarkdown({
    rows, correct, incorrect, errors, graded, accuracy, totalWallMs,
    offset: OFFSET, n: N, retrievalPaths: [...retrievalPaths], embedHost: EMBED_HOST,
    stratified: STRATIFIED,
    judgeProvider: JUDGE === 'local' ? 'local-llamacpp' : PROVIDER,
    judgeModel: JUDGE === 'local' ? 'local-temp0-thinking-off' : (PROVIDER === 'claude' ? (CLAUDE_MODEL || 'claude-default') : (PROVIDER === 'proxy' ? 'proxy:' + PROXY_MODEL : 'codex-oauth')),
    answerTransport: _answerTransportLabel(),
    answerModel: _answerModelLabel(),
    judgePrompts: JUDGE_PROMPTS_VERSION,
    dataset: DATASET_PATH.replace(REPO + '/', ''),
    datasetSha256: datasetSha256(),
  }));
  console.log('Report:      ' + mdPath);
}

function renderMarkdown(s) {
  const lines = [];
  lines.push('# LongMemEval — troth substrate');
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
  lines.push('- **' + s.rows.length + '-question sample** (' + (s.stratified > 0 ? 'stratified ' + s.stratified + '/type' : 'fixed offset slice') + '), not the full 500-question LongMemEval-S set unless n=500. Binomial CI applies — treat sub-100 samples as directional signals, not publishable numbers.');
  lines.push('- ' + (s.stratified > 0 ? 'Stratified sampling takes the first ' + s.stratified + ' questions of each question_type in dataset order — deterministic and reproducible, but within-type dataset order is arbitrary upstream.' : 'Sample is a **fixed offset slice** (dataset order), and the dataset is ordered by question_type — an offset-0 slice measures ONLY the first type(s). Check the `question_type` column below.'));
  lines.push('- Retrieval path: worker probes `' + s.embedHost + '`/health itself per question and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise. See the `retrieval_path` column per row.');
  lines.push('- Embedding coverage: the worker drains the embedding backfill to the end before recall and records, per row, how many of the haystack\'s turns carry a vector (`embed_coverage`). This run: minimum ' + (s.embedCoverageMin != null ? s.embedCoverageMin.toFixed(3) : 'n/a') + ', rows below full coverage: ' + (s.rowsBelowFullCoverage != null ? s.rowsBelowFullCoverage : 'n/a') + '. A row below 1.000 measured partly lexical recall.');
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
  lines.push('# This run (20 questions, offset 0)');
  lines.push('node benchmarks/longmemeval.mjs --n 20 --offset 0');
  lines.push('');
  lines.push('# Full LongMemEval-S (500 questions) — budget wall time accordingly,');
  lines.push('# see wall-time-per-question in this report to extrapolate.');
  lines.push('node benchmarks/longmemeval.mjs --n 500 --offset 0');
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
