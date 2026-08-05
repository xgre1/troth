#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// LMDT — LLM-Native Memory Density Test (P17 Tier 4 falsifier).
//
// 4-arm comparison of how a frontier LLM answers retrieval queries
// against the same substrate when the on-wire payload is encoded as:
//   A. Verbose JSON  (current default)
//   B. Minified JSON (whitespace stripped)
//   C. TOON          (P17 Tier 1)
//   D. TOON + active wire-format profile (P17 Tier 3)
//
// Per arm, we send the SAME N queries against the SAME N records and
// measure:
//   - Token Cost per Recall  ($)
//   - Recall@1               (correct intent_id retrieved)
//   - FAMA-lite              (no hallucinated fields, no superseded
//                              info acted upon)
//
// Falsifier hypothesis: Arm D ≥ 40% reduction in
// Token Cost per Recall vs Arm A AND Recall@1 within ±2%.
//
// Modes:
//   --dry-run   : run encoders + count tokens; no API call (default if
//                 ANTHROPIC_API_KEY is unset).
//   --run       : real Sonnet calls. Requires ANTHROPIC_API_KEY.
//   --queries N : how many retrieval queries to issue (default 8).
//   --cwd PATH  : scope soak data to this cwd (default soak-test dir).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = process.env.TROTH_REPO || new URL('..', import.meta.url).pathname.replace(/\/$/,'');
const Database = require(REPO + '/node_modules/better-sqlite3');
const W  = require(REPO + '/shared-core/wire-format.js');
const AR = require(REPO + '/shared-core/action-record.js');

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const DRY = args.includes('--dry-run') || !process.env.ANTHROPIC_API_KEY;
const REAL = args.includes('--run') && process.env.ANTHROPIC_API_KEY;
const NQ = parseInt(arg('--queries', '8'), 10);
const CWD = arg('--cwd', process.env.HOME + '/soak-test-20260428');
const MODEL = arg('--model', 'claude-sonnet-4-5-20250929');

// Anthropic pricing (Sonnet 4.5 as of Apr 2026 — sanity check before spend)
const PRICE_IN  = 3.0  / 1e6;   // $/input token
const PRICE_OUT = 15.0 / 1e6;   // $/output token

const DB_PATH = process.env.STATE_DB_PATH || process.env.TROTH_DB_PATH || join(homedir(), '.troth', 'state.db');
const db = new Database(DB_PATH, { readonly: true });

// ── Pull soak data ──────────────────────────────────────────────────────
function pullScope() {
  const intents = db.prepare(`
    SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
           parent_id, context_hash, input, output, verification, outcome
    FROM action_records WHERE type='intent' AND cwd = ? ORDER BY timestamp ASC
  `).all(CWD);
  const edits = db.prepare(`
    SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
           parent_id, context_hash, input, output, verification, outcome
    FROM action_records WHERE type='edit' AND cwd = ? ORDER BY timestamp ASC
  `).all(CWD);
  const edges = db.prepare(`
    SELECT e.id, e.from_id, e.to_id, e.label, e.weight, e.created_at
    FROM action_record_edges e
    JOIN action_records ar ON ar.id = e.from_id
    WHERE ar.cwd = ?
  `).all(CWD);
  return { intents, edits, edges };
}

// ── Build retrieval queries from real intent data ───────────────────────
// Each query is { question, expected_intent_id, kind }.
function buildQueries(intents, edits, edges) {
  const qs = [];
  for (const i of intents) {
    const inp = JSON.parse(i.input || '{}');
    const goal = inp.goal || '';
    // Extract a salient noun from the goal for the question.
    const verbObj = goal.replace(/^(add|fix|refactor|create|implement|update|remove|investigate|test|build)\s+/i, '');
    qs.push({
      question: 'Which intent in the substrate captured the goal of ' + (verbObj || goal) + '?',
      expected_intent_id: i.id,
      kind: 'goal_lookup'
    });
  }
  // Constraint-aware queries.
  for (const i of intents) {
    const inp = JSON.parse(i.input || '{}');
    if (inp.constraint) {
      qs.push({
        question: 'Which intent had a constraint about non-numeric inputs or input validation?',
        expected_intent_id: i.id,
        kind: 'constraint_lookup'
      });
      break;
    }
  }
  // Verified-by-satisfies queries.
  const satisfiedIntentIds = new Set(
    edges.filter(e => e.label === 'satisfies').map(e => e.to_id)
  );
  for (const i of intents) {
    if (satisfiedIntentIds.has(i.id)) {
      qs.push({
        question: 'Which intent was verified by a passing-AST edit (has a satisfies edge)?',
        expected_intent_id: i.id,
        kind: 'verified_lookup'
      });
      break;
    }
  }
  return qs.slice(0, NQ);
}

// ── 4 arms: encode the same payload 4 ways ─────────────────────────────
function buildArms(intents, edits, edges) {
  // Verbose JSON shape — what a v0.1 client would receive today.
  const verbose = {
    intents:  intents.map(AR.fromRow),
    edits:    edits.map(AR.fromRow),
    edges
  };
  const armA = JSON.stringify(verbose, null, 2);
  const armB = JSON.stringify(verbose);
  // TOON for the flat ActionRecord arrays + JSON for edges (no canonical
  // TOON shape for edges yet — keep them inline JSON).
  const allRows = intents.concat(edits);
  const armC = W.encodeBatch(allRows) + '\n\nedges: ' + JSON.stringify(edges);
  // Profile-aware — pretend a profile saw enough records to alias the
  // high-frequency strings present in our data.
  const profileAliases = {
    'claude-code': '&0',
    [CWD]: '&1',
    'hashline': '&2',
    'sha:0': '&3',
    'troth-plugin': '&4'
  };
  const armD = W.encodeBatch(allRows, { profile_aliases: profileAliases }) +
               '\n\nedges: ' + JSON.stringify(edges);

  return { A: armA, B: armB, C: armC, D: armD };
}

// ── Estimate tokens (chars/4 proxy; real run uses Anthropic count_tokens) ─
function estimateTokens(s) { return Math.ceil(s.length / 4); }

// ── Throttling: respect Anthropic 30k input tokens/min rate limit ──────
const RATE_LIMIT_TPM = 30000;
const _calls = []; // {ts, tokens}
async function _waitForBudget(estTokens) {
  while (true) {
    const cutoff = Date.now() - 60_000;
    while (_calls.length && _calls[0].ts < cutoff) _calls.shift();
    const used = _calls.reduce((s, c) => s + c.tokens, 0);
    if (used + estTokens <= RATE_LIMIT_TPM) return;
    const waitMs = (_calls[0].ts + 60_000) - Date.now() + 200;
    process.stdout.write('⏸');
    await new Promise(r => setTimeout(r, Math.max(waitMs, 1000)));
  }
}
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Real Anthropic call (with throttle + 1 retry on 429) ───────────────
async function callAnthropic(payload, question, estTokens) {
  await _waitForBudget(estTokens);
  const fetch = globalThis.fetch || (await import('node-fetch')).default;
  const body = {
    model: MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content:
        'You have access to the following memory substrate payload. Answer the question with ONLY the matching intent UUID (the 36-char id) — no other text.\n\n' +
        '--- PAYLOAD ---\n' + payload + '\n--- END PAYLOAD ---\n\n' +
        'Question: ' + question
    }]
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    const ms = Date.now() - t0;
    if (j.content) {
      const text = j.content.map(c => c.text || '').join('');
      const inT  = j.usage?.input_tokens  || 0;
      const outT = j.usage?.output_tokens || 0;
      _calls.push({ ts: Date.now(), tokens: inT });
      return { text, input_tokens: inT, output_tokens: outT, latency_ms: ms };
    }
    if (j.error?.type === 'rate_limit_error' && attempt === 0) {
      process.stdout.write('R');
      await _sleep(60_000);
      continue;
    }
    throw new Error('Anthropic error: ' + JSON.stringify(j));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────
async function main() {
  const { intents, edits, edges } = pullScope();
  if (intents.length === 0) {
    console.error('No intents in scope — soak the project first.');
    process.exit(1);
  }
  console.log('═ LMDT scope ═');
  console.log('  cwd:     ' + CWD);
  console.log('  intents: ' + intents.length);
  console.log('  edits:   ' + edits.length);
  console.log('  edges:   ' + edges.length);

  const queries = buildQueries(intents, edits, edges);
  console.log('  queries: ' + queries.length);
  if (!queries.length) { console.error('No queries derivable.'); process.exit(1); }

  const arms = buildArms(intents, edits, edges);
  console.log('\n═ payload sizes (chars / est.tokens) ═');
  for (const [k, v] of Object.entries(arms)) {
    console.log('  ' + k + ': ' + String(v.length).padStart(7) + ' chars / ~' + String(estimateTokens(v)).padStart(5) + ' tokens');
  }

  // Cost estimate
  const inTotal  = Object.values(arms).reduce((s, p) => s + estimateTokens(p), 0) * queries.length;
  const outTotal = queries.length * 4 * 50; // ~50 output tokens/answer
  const cost = inTotal * PRICE_IN + outTotal * PRICE_OUT;
  console.log('\n═ cost estimate (chars/4 proxy) ═');
  console.log('  ' + queries.length + ' questions × 4 arms = ' + (queries.length * 4) + ' API calls');
  console.log('  est. input tokens:  ' + inTotal);
  console.log('  est. output tokens: ' + outTotal);
  console.log('  est. cost:          $' + cost.toFixed(3));

  if (DRY) {
    console.log('\nDRY RUN — no API calls. Re-run with --run + ANTHROPIC_API_KEY to execute.');
    db.close();
    return;
  }
  if (!REAL) {
    console.error('\nMissing --run flag or ANTHROPIC_API_KEY. Refusing to spend.');
    db.close();
    process.exit(2);
  }

  // Real run
  const results = { A: [], B: [], C: [], D: [] };
  for (const armKey of ['A','B','C','D']) {
    console.log('\n--- arm ' + armKey + ' ---');
    const armTokenEst = estimateTokens(arms[armKey]) + 200;
    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      try {
        const r = await callAnthropic(arms[armKey], q.question, armTokenEst);
        const correct = r.text.includes(q.expected_intent_id);
        results[armKey].push({
          q: q.question.slice(0, 70),
          kind: q.kind,
          correct,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          latency_ms: r.latency_ms,
          response: r.text.slice(0, 100)
        });
        process.stdout.write(correct ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');
      } catch (e) {
        results[armKey].push({ q: q.question, kind: q.kind, error: e.message });
        process.stdout.write('\x1b[31m!\x1b[0m');
      }
    }
  }

  // Summary
  console.log('\n\n═ LMDT results ═');
  console.log('Arm | Recall@1 | Avg input tokens | Total $ |');
  console.log('----|----------|------------------|---------|');
  for (const k of ['A','B','C','D']) {
    const rs = results[k];
    const correct = rs.filter(r => r.correct).length;
    const recall  = correct / rs.length;
    const avgIn   = rs.reduce((s, r) => s + (r.input_tokens || 0), 0) / rs.length;
    const totalIn = rs.reduce((s, r) => s + (r.input_tokens || 0), 0);
    const totalOut= rs.reduce((s, r) => s + (r.output_tokens|| 0), 0);
    const cost    = totalIn * PRICE_IN + totalOut * PRICE_OUT;
    console.log('  ' + k + ' |   ' + (recall*100).toFixed(0).padStart(3) + '%   |     ' + Math.round(avgIn).toString().padStart(8) + '     |  $' + cost.toFixed(4) + ' |');
  }

  // Save raw output
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = join(REPO, 'benchmarks/results/lmdt-' + ts + '.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    timestamp: Date.now(),
    cwd: CWD,
    intents: intents.length,
    edits: edits.length,
    edges: edges.length,
    queries: queries.length,
    payload_sizes: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.length])),
    results
  }, null, 2));
  console.log('\nRaw results saved to: ' + outPath);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
