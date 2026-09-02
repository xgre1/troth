#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// prewarm-extract — fill the extraction cache for a LongMemEval slice before a
// run, so the run's workers digest from the cache alone. Sessions are built
// exactly as the worker ingests them (one turn per assistant reply carrying
// the user text before it, timestamps from the haystack dates), keyed the way
// digest.cjs keys them, and extracted through the chosen extractor with a
// bounded number of calls in flight.
//   --ids-from <results.json>  the question ids of a finished run
//   --only id1,id2             explicit ids
//   --stratified N             the harness's stratified slice (N per type)
//   --extractor proxy|llamacpp (default proxy)
//   --concurrency K            calls in flight (default 4)
//   --dry                      count sessions, hits and misses; call nothing
//   TROTH_BENCH_EXTRACT_CACHE  the cache directory (required)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const IDS_FROM = argVal('--ids-from', '');
const ONLY = argVal('--only', '');
const STRATIFIED = parseInt(argVal('--stratified', '0'), 10);
const EXTRACTOR = argVal('--extractor', 'proxy');
const CONCURRENCY = Math.max(1, parseInt(argVal('--concurrency', '4'), 10));
const DRY = args.includes('--dry');
const CACHE_DIR = process.env.TROTH_BENCH_EXTRACT_CACHE || '';
if (!CACHE_DIR) { console.error('TROTH_BENCH_EXTRACT_CACHE is required'); process.exit(2); }

const DATASET_PATH = join(REPO, 'benchmarks/datasets/longmemeval/longmemeval_s_cleaned.json');
const all = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));

function slice() {
  if (IDS_FROM) {
    const ids = (JSON.parse(readFileSync(IDS_FROM, 'utf8')).rows || []).map((r) => r.question_id);
    return all.filter((x) => ids.includes(x.question_id));
  }
  if (ONLY) {
    const ids = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
    return all.filter((x) => ids.includes(x.question_id));
  }
  if (STRATIFIED > 0) {
    // The harness's slice: the first N of each type in dataset order, woven.
    const byType = new Map();
    for (const q of all) {
      const t = q.question_type;
      if (!byType.has(t)) byType.set(t, []);
      const bucket = byType.get(t);
      if (bucket.length < STRATIFIED) bucket.push(q);
    }
    const buckets = [...byType.values()];
    const woven = [];
    for (let i = 0; i < STRATIFIED; i++) for (const b of buckets) if (b[i]) woven.push(b[i]);
    return woven;
  }
  console.error('give --ids-from, --only or --stratified');
  process.exit(2);
}

// Turns as the worker records them: one per assistant reply, carrying the
// user text before it; timestamps from the session date, a second apart.
function sessionsOf(q) {
  const out = [];
  let tsCursor = Date.now() - (q.haystack_sessions.length * 3600 * 1000);
  for (let si = 0; si < q.haystack_sessions.length; si++) {
    const session = q.haystack_sessions[si] || [];
    const sessDateStr = (q.haystack_dates && q.haystack_dates[si]) || null;
    let sessTs = tsCursor;
    if (sessDateStr) {
      const c = String(sessDateStr).replace(/\s*\([^)]*\)\s*/, ' ').trim();
      const parsed = Date.parse(c + ' UTC') || Date.parse(c);
      if (!Number.isNaN(parsed)) sessTs = parsed;
    }
    const turns = [];
    let userText = null, pairIdx = 0;
    for (const turn of session) {
      if (turn.role === 'user') { userText = turn.content; continue; }
      if (turn.role !== 'assistant') continue;
      const u = userText || '';
      if (u) turns.push({ id: 'prewarm', timestamp: sessTs + pairIdx * 1000, session_id: 'sess-' + si, user_text: u });
      pairIdx++;
      userText = null;
    }
    if (turns.length) out.push(turns);
    tsCursor = sessTs + 60_000;
  }
  return out;
}

async function main() {
  const digest = require(join(REPO, 'benchmarks/digest.cjs'));
  const ic = require(join(REPO, 'shared-core/instance-consolidation.js'));
  const llmCall = EXTRACTOR === 'proxy'
    ? require(join(REPO, 'benchmarks/proxy-extractor.cjs')).makeProxyExtractor({})
    : ic.makeLlamacppExtractor({ host: process.env.TROTH_BENCH_EXTRACTOR_HOST || undefined, timeout_ms: 120000 });
  const qs = slice();
  // Dedupe by the cache key: the same session on the same day is one call.
  const crypto = require('node:crypto');
  const keyOf = (turns) => {
    const h = crypto.createHash('sha1'); h.update(digest.PROMPT_VERSION);
    for (const t of turns) h.update(' ' + new Date(t.timestamp).toISOString().slice(0, 10) + ' ' + t.user_text);
    return h.digest('hex');
  };
  const work = new Map();
  let sessions = 0;
  for (const q of qs) for (const turns of sessionsOf(q)) { sessions++; const k = keyOf(turns); if (!work.has(k)) work.set(k, turns); }
  const pending = [...work.entries()].filter(([k]) => !existsSync(join(CACHE_DIR, k + '.json')));
  console.log('prompt ' + digest.PROMPT_VERSION + ' | questions ' + qs.length + ' | sessions ' + sessions + ' | unique ' + work.size + ' | cached ' + (work.size - pending.length) + ' | to extract ' + pending.length + ' | extractor ' + EXTRACTOR + ' x' + CONCURRENCY);
  if (DRY || !pending.length) return;
  const t0 = Date.now();
  let done = 0, errors = 0, dropped = 0, instances = 0;
  let next = 0;
  async function lane() {
    while (next < pending.length) {
      const [, turns] = pending[next++];
      try {
        const ex = await digest.extractSession({ turns, llmCall, cacheDir: CACHE_DIR });
        dropped += ex.parsed.dropped || 0;
        instances += (ex.parsed.instances || []).length;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error('  extract error: ' + String(e && e.message || e).slice(0, 200));
      }
      done++;
      if (done % 50 === 0 || done === pending.length) {
        const s = (Date.now() - t0) / 1000;
        console.log('  ' + done + '/' + pending.length + ' | ' + s.toFixed(0) + 's | ' + (done / s * 60).toFixed(1) + '/min | errors ' + errors + ' | instances ' + instances + ' | dropped rows ' + dropped);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  console.log('done: ' + done + ' extracted, ' + errors + ' errors, ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  if (errors) process.exit(1);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
