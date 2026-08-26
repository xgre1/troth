#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Usage:
//   node benchmarks/surface-probe.mjs --db /tmp/copy-of-a-backup.db [--n 30]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PLUGIN = join(REPO, 'plugin');
const HOOK = join(PLUGIN, 'hooks', 'injector.mjs');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = argVal('--db', '');
const N = parseInt(argVal('--n', '30'), 10);
const CWD = argVal('--cwd', REPO);
const PROMPTS_FILE = argVal('--prompts', '');
const BUDGET_MS = 3500; // the injector's own race timeout

if (!DB || !existsSync(DB)) {
  console.error('surface-probe: --db <path> is required and must exist.');
  console.error('  Make one from a backup bundle, never from the live file:');
  console.error('    cp ~/.troth/backups/substrate-<newest>/state.db /tmp/probe-state.db');
  process.exit(2);
}

const HOME = mkdtempSync(join(tmpdir(), 'surface-probe-'));
mkdirSync(join(HOME, '.troth'), { recursive: true });
writeFileSync(join(HOME, '.troth', 'recall-trace.enabled'), '');
const DATA = join(HOME, 'plugin-data');
mkdirSync(DATA, { recursive: true });
const TRACE = join(HOME, '.troth', 'recall-trace.jsonl');

const childEnv = {
  ...process.env,
  HOME,
  STATE_DB_PATH: DB,
  CLAUDE_PLUGIN_ROOT: PLUGIN,
  CLAUDE_PLUGIN_DATA: DATA,
  TROTH_NO_MODEL_FETCH: '1'
};

function loadPrompts() {
  if (PROMPTS_FILE) {
    return readFileSync(PROMPTS_FILE, 'utf8').split('\n').map(s => s.trim()).filter(s => s.length >= 30).slice(0, N);
  }
  const src = [
    'process.env.STATE_DB_PATH = ' + JSON.stringify(DB) + ';',
    'const d = require(' + JSON.stringify(join(REPO, 'shared-core', 'dialogue-memory.js')) + ');',
    'const out = [];',
    'for (const t of (d.recentTurns({ limit: 100, principal: null }) || [])) {',
    '  const s = String(t.user_text || "").replace(/\\s+/g, " ").trim();',
    '  if (s.length >= 30 && !s.startsWith("/")) out.push(s);',
    '}',
    'process.stdout.write(JSON.stringify(out));'
  ].join('\n');
  const f = join(HOME, 'load-prompts.cjs');
  writeFileSync(f, src);
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', env: childEnv, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error('surface-probe: could not read the dialogue archive:', String(r.stderr || '').slice(0, 300));
    process.exit(3);
  }
  let all = [];
  try { all = JSON.parse(r.stdout || '[]'); } catch (_) { all = []; }
  const seen = new Set();
  const uniq = [];
  for (const p of all.reverse()) { const k = p.slice(0, 120); if (seen.has(k)) continue; seen.add(k); uniq.push(p); }
  return uniq.slice(0, N);
}

const BLOCK_RE = /\[troth\/([a-z_-]+)\]/g;

function runTurn(prompt, i) {
  const payload = { session_id: 'surface-probe-' + i, cwd: CWD, user_prompt: prompt };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', env: childEnv,
    maxBuffer: 32 * 1024 * 1024, timeout: 60000
  });
  const ms = Date.now() - t0;
  let ctx = '';
  try {
    const parsed = JSON.parse(String(r.stdout || '').trim() || '{}');
    ctx = (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
  } catch (_) { /* a hook that prints nothing injected nothing */ }
  const kinds = [];
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(ctx)) !== null) kinds.push(m[1]);
  const recallLines = (ctx.match(/^ {2}• /gm) || []).length;
  const fp = createHash('sha1').update(prompt).digest('hex').slice(0, 8);
  return { i, prompt_sha: fp, prompt_len: prompt.length, ms, chars: ctx.length, kinds, recallLines,
           stderr_len: String(r.stderr || '').length,
           _prompt_local: prompt.slice(0, 90) };
}

const prompts = loadPrompts();
if (!prompts.length) { console.error('surface-probe: no prompts found.'); process.exit(4); }

console.log('═ surface probe ═');
console.log('  db:      ' + DB);
console.log('  prompts: ' + prompts.length + ' (real operator messages, newest first)');
console.log('  cwd:     ' + CWD);
console.log('');

const rows = [];
for (let i = 0; i < prompts.length; i++) {
  const row = runTurn(prompts[i], i);
  rows.push(row);
  process.stdout.write('  [' + (i + 1) + '/' + prompts.length + '] ' +
    String(row.kinds.length).padStart(2) + ' blocks  ' +
    String(row.chars).padStart(5) + ' chars  ' +
    String(row.ms).padStart(5) + 'ms  ' +
    (row.ms > BUDGET_MS ? 'OVER  ' : '      ') +
    '"' + row._prompt_local.slice(0, 46) + '"\n');
}

let considered = 0, kept = 0, dropped = 0, tracedTurns = 0, timeouts = 0;
const recallMs = [];
if (existsSync(TRACE)) {
  for (const line of readFileSync(TRACE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
    tracedTurns++;
    if (rec.timeout_hit) timeouts++;
    considered += rec.n || 0;
    if (Number.isFinite(rec.latency_ms)) recallMs.push(rec.latency_ms);
    for (const t of rec.top || []) {
      if (t.rr === null || t.rr === undefined) continue;
      if (t.rr > 0) kept++; else dropped++;
    }
  }
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const nums = (arr) => arr.slice().sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? nums(arr)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
const blocks = rows.map(r => r.kinds.length);
const chars = rows.map(r => r.chars);
const msArr = rows.map(r => r.ms);
const byKind = {};
for (const r of rows) for (const k of r.kinds) byKind[k] = (byKind[k] || 0) + 1;
const silent = rows.filter(r => r.kinds.length === 0).length;
const over = rows.filter(r => r.ms > BUDGET_MS).length;

console.log('\n═ results ═');
console.log('  blocks/turn      p50 ' + q(blocks, 0.5) + '   p95 ' + q(blocks, 0.95) + '   max ' + Math.max(...blocks));
console.log('  chars/turn       p50 ' + q(chars, 0.5) + '   p95 ' + q(chars, 0.95) + '   max ' + Math.max(...chars));
console.log('  hook ms          p50 ' + q(msArr, 0.5) + '   p95 ' + q(msArr, 0.95) + '   over ' + BUDGET_MS + 'ms: ' + over + '/' + rows.length);
console.log('  recall ms        p50 ' + q(recallMs, 0.5) + '   p95 ' + q(recallMs, 0.95) +
            '   over budget: ' + recallMs.filter(v => v > BUDGET_MS).length + '/' + recallMs.length +
            '   (this is the clock the ' + BUDGET_MS + 'ms race runs against)');
console.log('  silent turns     ' + silent + '/' + rows.length + ' (' + pct(silent, rows.length) + '%)');
console.log('  recall considered ' + considered + '  offered ' + kept + '  held back ' + dropped +
            (considered ? '  (' + pct(kept, kept + dropped) + '% of scored memories offered)' : ''));
console.log('  recall timeouts  ' + timeouts + '/' + tracedTurns + ' traced turns');
console.log('  blocks by kind:');
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + k.padEnd(18) + n + ' turn(s)  (' + pct(n, rows.length) + '%)');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outJson = join(REPO, 'benchmarks', 'results', 'surface-probe-' + stamp + '.json');
writeFileSync(outJson, JSON.stringify({
  generated_at: new Date().toISOString(), db: basename(DB), budget_ms: BUDGET_MS,
  prompts: prompts.length,
  blocks: { p50: q(blocks, 0.5), p95: q(blocks, 0.95), max: Math.max(...blocks) },
  chars: { p50: q(chars, 0.5), p95: q(chars, 0.95), max: Math.max(...chars) },
  latency_ms: { p50: q(msArr, 0.5), p95: q(msArr, 0.95), over_budget: over },
  silent_turns: silent,
  recall: { considered, offered: kept, held_back: dropped, timeouts, traced_turns: tracedTurns,
            ms: { p50: q(recallMs, 0.5), p95: q(recallMs, 0.95),
                  over_budget: recallMs.filter(v => v > BUDGET_MS).length, n: recallMs.length } },
  by_kind: byKind,
  rows: rows.map(({ _prompt_local, ...keep }) => keep)
}, null, 2));
console.log('\n  raw: ' + outJson);

try { rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* scratch */ }
