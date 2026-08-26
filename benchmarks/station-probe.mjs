#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// station-probe — WHERE the pipe broke, not which question failed.
//
// A wrong answer is not a fact about a question; it is a fact about a station
// on the way from what the operator said to what the partner replies:
//
//   1 unwritten     the thing was never recorded
//   2 distorted     recorded, but the meaning did not survive the writing
//   3 unretrieved   recorded intact, never fetched for this question
//   4 late          fetched, but past the turn's budget, or cut on the way out
//   5 composed      present in front of the answerer, and the framing led it wrong
//   6 reasoned      everything present and clean, the model still answered wrong
//
// Fixing a question moves one number. Fixing a station moves every question
// that breaks the same way, including the ones nobody has asked yet. This
// probe attributes, it does not grade: it says where the mass sits.
//
// Method: the REAL worker runs (same ingest, same digest, same retrieval the
// bench and the product share), then attribution is computed from the dataset
// alone — LongMemEval names the sessions that hold each answer, so "was the
// right evidence in front of the answerer" is decidable without a model.
//
// Usage:
//   node benchmarks/station-probe.mjs [--only id,id] [--n 17]
//        [--verdicts benchmarks/results/longmemeval-smoke-<ts>.json]
//
// --verdicts joins a previous smoke run so stations 5 and 6 can be separated:
// without it a question whose evidence WAS retrieved is reported as
// "present — outcome unknown", which is honest rather than assumed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WORKER = join(HERE, 'longmemeval-worker.cjs');
const DATASET = join(HERE, 'datasets', 'longmemeval', 'longmemeval_s_cleaned.json');
const LIVE_BUDGET_MS = 3500;   // what the per-turn injector actually allows

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ONLY = argVal('--only', '');
const N = parseInt(argVal('--n', '17'), 10);
const VERDICTS = argVal('--verdicts', '');

const data = JSON.parse(readFileSync(DATASET, 'utf8'));
const pool = ONLY
  ? ONLY.split(',').map(s => s.trim()).filter(Boolean).map(id => data.find(q => q.question_id === id)).filter(Boolean)
  : data.filter(q => q.question_type === 'multi-session').slice(0, N);

let priorVerdicts = {};
if (VERDICTS && existsSync(VERDICTS)) {
  try {
    for (const r of (JSON.parse(readFileSync(VERDICTS, 'utf8')).rows || [])) {
      priorVerdicts[r.question_id] = { verdict: r.verdict, answer: String(r.our_answer || '') };
    }
  } catch (_) { /* a missing join is a missing column, not a failure */ }
}

// ── Ground truth: the words that hold the answer ──────────────────────────
// The dataset names the sessions; their user turns are the evidence. A
// retrieved row counts as carrying evidence when a whole sentence of it
// appears in one of those turns, which is strict enough that a coincidental
// word overlap does not pass.
function goldSentences(q) {
  const ids = new Set(q.answer_session_ids || []);
  const hIds = q.haystack_session_ids || [];
  const out = [];
  hIds.forEach((sid, si) => {
    if (ids.size && !ids.has(sid)) return;
    for (const turn of (q.haystack_sessions[si] || [])) {
      if (turn.role !== 'user') continue;
      for (const s of String(turn.content || '').split(/(?<=[.!?])\s+/)) {
        const t = s.replace(/\s+/g, ' ').trim();
        if (t.length >= 40) out.push(t.toLowerCase());
      }
    }
  });
  return out;
}

function carriesEvidence(retrieved, sentences) {
  const hay = retrieved.map(r => String(r.statement || '').replace(/\s+/g, ' ').toLowerCase());
  let hits = 0;
  for (const s of sentences) if (hay.some(h => h.indexOf(s) !== -1)) hits++;
  return hits;
}

// ── One question through the real worker ──────────────────────────────────
function runWorker(q) {
  const home = mkdtempSync(join(tmpdir(), 'station-'));
  mkdirSync(join(home, '.troth'), { recursive: true });
  const job = {
    question_id: q.question_id, question: q.question, question_date: q.question_date,
    haystack_sessions: q.haystack_sessions, haystack_dates: q.haystack_dates,
    agent_id: 'station-' + q.question_id, cwd: '/benchmarks/station/' + q.question_id,
    embedding_host: process.env.TROTH_EMBED_HOST || 'http://127.0.0.1:11437'
  };
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [WORKER], {
    input: JSON.stringify(job), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: 3600000,
    env: Object.assign({}, process.env, {
      STATE_DB_PATH: join(home, '.troth', 'q.db'), HOME: home, TROTH_NO_MODEL_FETCH: '1',
      TROTH_BENCH_FULL_SAUCE: process.env.TROTH_BENCH_FULL_SAUCE || '1'
    })
  });
  const wall = Date.now() - t0;
  let out = {};
  try {
    const last = String(res.stdout || '').trim().split('\n').filter(Boolean).pop();
    out = JSON.parse(last);
  } catch (_) { out = { error: String(res.stderr || 'no worker output').slice(0, 200) }; }
  try { rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { out, wall };
}

// ── Attribution ───────────────────────────────────────────────────────────
function attribute(q, out, prior) {
  if (out.error) return { station: '0 worker-error', detail: out.error.slice(0, 80) };
  const sentences = goldSentences(q);
  const retrieved = out.retrieved || [];
  const hits = carriesEvidence(retrieved, sentences);
  const ledger = retrieved.filter(r => /^\[instance\]/.test(String(r.statement || ''))).length;

  if (!sentences.length) return { station: 'n/a no-gold-sessions', hits: 0, ledger };
  if (hits === 0) return { station: '3 unretrieved', hits, ledger, of: sentences.length };

  // Evidence was in front of the answerer. What happened after is stations 4-6,
  // and only a graded answer can separate them.
  if (!prior) return { station: '≥4 present-outcome-unknown', hits, ledger, of: sentences.length };
  if (prior.verdict === 'CORRECT') return { station: 'ok', hits, ledger, of: sentences.length };
  const unfinished = prior.answer && !/^\s*Answer:/mi.test(prior.answer);
  if (unfinished) return { station: '4 late/cut', hits, ledger, of: sentences.length };
  return { station: '5 composed', hits, ledger, of: sentences.length };
}

// ── Run ───────────────────────────────────────────────────────────────────
console.log('═ station probe ═');
console.log('  questions: ' + pool.length + (VERDICTS ? '   joined with: ' + VERDICTS.split('/').pop() : '   (no verdict join)'));
console.log('  live budget: ' + LIVE_BUDGET_MS + 'ms\n');

const rows = [];
for (const q of pool) {
  const { out, wall } = runWorker(q);
  const prior = priorVerdicts[q.question_id] || null;
  const a = attribute(q, out, prior);
  const row = {
    question_id: q.question_id, retrieved: (out.retrieved || []).length,
    ingested_turns: out.ingested_turns || 0, wall_ms: wall,
    evidence_hits: a.hits || 0, evidence_of: a.of || 0, ledger_rows: a.ledger || 0,
    station: a.station, prior_verdict: prior ? prior.verdict : null
  };
  rows.push(row);
  console.log('  ' + q.question_id.padEnd(16) +
    ' retrieved:' + String(row.retrieved).padStart(3) +
    '  evidence:' + String(row.evidence_hits).padStart(2) + '/' + String(row.evidence_of).padEnd(3) +
    '  ledger:' + String(row.ledger_rows).padStart(3) +
    '  ' + Math.round(wall / 1000) + 's'.padEnd(4) +
    '  → ' + row.station);
}

const byStation = {};
for (const r of rows) byStation[r.station] = (byStation[r.station] || 0) + 1;
console.log('\n═ where the mass sits ═');
for (const [s, n] of Object.entries(byStation).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + String(n).padStart(3) + '  ' + s);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = join(REPO, 'benchmarks', 'results', 'station-probe-' + stamp + '.json');
writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(), live_budget_ms: LIVE_BUDGET_MS,
  joined_verdicts: VERDICTS || null, by_station: byStation, rows
}, null, 2));
console.log('\n  raw: ' + outPath);
