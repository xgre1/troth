#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// extract-probe.mjs - extraction quality, measured before it costs anything.
// Runs ONLY the extractor over selected haystacks (no ingest, no answerer,
// no judge): every session goes prompt -> model -> parse, results land in a
// readable report, and the shared content-addressed cache fills as a side
// effect so later full runs reuse every call. Question-blind: the extractor
// sees haystack sessions, never questions.
//
//   node benchmarks/extract-probe.mjs --type multi-session --per-type 17 \
//     --host http://127.0.0.1:1234 --cache ~/bench-extract-cache
//   --mock 1 replaces the model with a canned response (plumbing dry-run).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}

const TYPE = argVal('--type', 'multi-session');
const PER_TYPE = parseInt(argVal('--per-type', '17'), 10);
const HOST = argVal('--host', process.env.TROTH_BENCH_EXTRACTOR_HOST || 'http://127.0.0.1:1234');
const CACHE = argVal('--cache', process.env.TROTH_BENCH_EXTRACT_CACHE || null);
const MOCK = argVal('--mock', '0') === '1';
const IDS = argVal('--ids', '');
const GREP = argVal('--grep', '');
const DATASET_PATH = join(REPO, 'benchmarks/datasets/longmemeval/longmemeval_s_cleaned.json');

function sessionTurns(q, si) {
  const session = q.haystack_sessions[si] || [];
  const dateStr = (q.haystack_dates && q.haystack_dates[si]) || null;
  let ts = Date.parse(String(dateStr || '').replace(/\s*\([^)]*\)\s*/, ' ').trim() + ' UTC');
  if (Number.isNaN(ts)) ts = Date.parse('2023-01-01');
  const turns = [];
  for (const t of session) {
    if (t.role === 'user' && t.content) turns.push({ timestamp: ts, user_text: String(t.content) });
  }
  return turns;
}

async function main() {
  const digest = require('./digest.cjs');
  const ic = require('../shared-core/instance-consolidation.js');
  const all = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
  let qs = all.filter(q => q.question_type === TYPE).slice(0, PER_TYPE);
  if (IDS) {
    const want = new Set(IDS.split(','));
    qs = all.filter(q => want.has(q.question_id));
  }
  const grepRe = GREP ? new RegExp(GREP, 'i') : null;
  const llmCall = MOCK
    ? () => Promise.resolve(JSON.stringify({ identities: [], instances: [] }))
    : ic.makeLlamacppExtractor({ host: HOST, timeout_ms: 180000, max_tokens: 2048 });

  const report = [];
  const agg = { questions: 0, sessions: 0, calls: 0, cache_hits: 0, parse_empty: 0,
                identities: 0, instances: 0, byKind: {} };
  for (const q of qs) {
    agg.questions++;
    const row = { question_id: q.question_id, question: q.question, sessions: 0,
                  identities: 0, instances: 0, parse_empty: 0, samples: [] };
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const turns = sessionTurns(q, si);
      if (!turns.length) continue;
      if (grepRe && !turns.some(t => grepRe.test(t.user_text))) continue;
      row.sessions++; agg.sessions++;
      const ex = await digest.extractSession({ turns, llmCall, cacheDir: CACHE });
      if (ex.stats.extractor_call) agg.calls++;
      if (ex.stats.cache_hit) agg.cache_hits++;
      const p = ex.parsed;
      row.identities += p.identities.length;
      row.instances += p.instances.length;
      agg.identities += p.identities.length;
      agg.instances += p.instances.length;
      for (const inst of p.instances) {
        agg.byKind[inst.kind] = (agg.byKind[inst.kind] || 0) + 1;
        if (row.samples.length < 12) {
          row.samples.push(inst.kind + ': ' + (inst.qualifier || inst.status) + ' ' + inst.entity +
            ' - ' + inst.description + ' [' + inst.status + (inst.date_iso ? ', ' + inst.date_iso : '') + ']');
        }
      }
      for (const ident of p.identities) {
        if (row.samples.length < 12) {
          row.samples.push('identity: ' + ident.name + (ident.relation ? ' (' + ident.relation + ')' : ''));
        }
      }
      if (!p.identities.length && !p.instances.length && String(ex.raw || '').trim()) {
        row.parse_empty++; agg.parse_empty++;
      }
      process.stdout.write('.');
    }
    report.push(row);
    console.log(' q=' + q.question_id + ' sessions=' + row.sessions +
      ' ident=' + row.identities + ' inst=' + row.instances + ' empty=' + row.parse_empty);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outBase = join(REPO, 'benchmarks/results/extract-probe-' + ts);
  mkdirSync(dirname(outBase), { recursive: true });
  writeFileSync(outBase + '.json', JSON.stringify({ type: TYPE, per_type: PER_TYPE,
    host: MOCK ? 'mock' : HOST, prompt_version: digest.PROMPT_VERSION, agg, report }, null, 2));
  const lines = ['# Extraction probe - ' + TYPE + ' x' + agg.questions, '',
    'Sessions: ' + agg.sessions + ' | calls: ' + agg.calls + ' | cache hits: ' + agg.cache_hits +
    ' | parse-empty: ' + agg.parse_empty, 'Identities: ' + agg.identities +
    ' | instances: ' + agg.instances + ' | by kind: ' + JSON.stringify(agg.byKind), ''];
  for (const r of report) {
    lines.push('## ' + r.question_id + ' - ' + r.question);
    lines.push('sessions ' + r.sessions + ', identities ' + r.identities +
      ', instances ' + r.instances + ', parse-empty ' + r.parse_empty);
    for (const s of r.samples) lines.push('- ' + s);
    lines.push('');
  }
  writeFileSync(outBase + '.md', lines.join('\n'));
  console.log('\nreport: ' + outBase + '.md');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
