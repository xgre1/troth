#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Aggregate 4-arm results from arms.sh into one matrix-<task>-<date>.{json,md}
//
// Reads /tmp/gc-arms-{A,B,C,D}.json + their .wall + .pass companion files,
// joins them into a single per-task matrix with the killer derived metric:
// $/passing-test (cost per test that actually passes, the one number that
// makes "OSS+troth vs vanilla Sonnet" land hard).
//
// Usage:
//   node benchmarks/tiers/aggregate.mjs --task=seeds/01-bugfix

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const RESULTS = resolve(REPO, 'benchmarks', 'results');

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));

const task = args.task;
if (!task) { console.error('Need --task=<dir>'); process.exit(2); }

const ARM_LABELS = {
  A: 'vanilla Claude Code (Anthropic direct)',
  B: 'Claude Code + troth (Anthropic upstream)',
  C: 'OSS LLM + troth (OpenRouter upstream)',
  D: 'OSS LLM vanilla (OpenRouter, no troth)'
};

function parseRunJson(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  // Extract the trailing result JSON line from --output-format=json.
  const m = text.match(/\{"type":"result"[\s\S]*\}\s*$/);
  if (!m) return { raw: text.slice(0, 500) };
  try { return JSON.parse(m[0]); } catch (e) { return { raw: text.slice(0, 500) }; }
}

function readSidecar(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

const matrix = {};
for (const arm of ['A', 'B', 'C', 'D']) {
  const base = `/tmp/gc-arms-${arm}.json`;
  const raw = parseRunJson(base);
  const wall = parseInt(readSidecar(base + '.wall') || '0', 10);
  const passLabel = readSidecar(base + '.pass');
  const usage = (raw && raw.usage) || {};
  matrix[arm] = {
    label: ARM_LABELS[arm],
    wall_seconds: wall,
    tests_passed: passLabel === 'yes',
    duration_ms: raw && raw.duration_ms,
    num_turns: raw && raw.num_turns,
    cost_usd: raw && raw.total_cost_usd,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation: usage.cache_creation_input_tokens,
    cache_read: usage.cache_read_input_tokens,
    raw_present: !!raw
  };
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const taskKey = task.replace(/\//g, '-');
mkdirSync(RESULTS, { recursive: true });
const jsonOut = `${RESULTS}/matrix-${taskKey}-${stamp}.json`;
const mdOut   = `${RESULTS}/matrix-${taskKey}-${stamp}.md`;

writeFileSync(jsonOut, JSON.stringify({ task, generated_at: new Date().toISOString(), matrix }, null, 2));

// Markdown report
const fmt = (v, d = '—') => (v === undefined || v === null ? d : v);
const cost = (v) => v == null ? '—' : '$' + Number(v).toFixed(4);
const dollarsPerPass = (arm) => {
  if (!arm.tests_passed || !arm.cost_usd) return '—';
  return cost(arm.cost_usd) + ' (1 task)';
};

const md = [
  `# Benchmark matrix — ${task}`,
  `Generated: ${new Date().toISOString()}`,
  ``,
  `| Arm | Tests pass | Wall (s) | Turns | Cost | Input toks | Cache create |`,
  `|---|---|---|---|---|---|---|`,
  ...['A', 'B', 'C', 'D'].map(arm => {
    const r = matrix[arm];
    return `| **${arm}** ${r.label} | ${r.tests_passed ? '✓' : '✗'} | ${fmt(r.wall_seconds)} | ${fmt(r.num_turns)} | ${cost(r.cost_usd)} | ${fmt(r.input_tokens)} | ${fmt(r.cache_creation)} |`;
  }),
  ``,
  `## Headline derived metric — $/passing-task`,
  ``,
  `| Arm | $/pass |`,
  `|---|---|`,
  ...['A', 'B', 'C', 'D'].map(arm => `| ${arm} | ${dollarsPerPass(matrix[arm])} |`),
  ``,
  `## Notes`,
  ``,
  `- N=1 per arm. For public quoting, re-run 5–10× per arm and report median ± IQR.`,
  `- Loopguard ran with \`TROTH_BENCH_MODE=1\` (raised thresholds). Confirmed via proxy log on each arm.`,
  `- Arms C/D require \`OPENROUTER_API_KEY\` (or local llama.cpp on the proxy upstream).`,
  ``,
  `Raw blobs preserved at \`/tmp/gc-arms-{A,B,C,D}.json\`. Reproduce: \`bash benchmarks/tiers/arms.sh --task=${task} --all-arms\` then re-run this aggregator.`,
].join('\n');

writeFileSync(mdOut, md);
console.log('Wrote:', jsonOut);
console.log('Wrote:', mdOut);
