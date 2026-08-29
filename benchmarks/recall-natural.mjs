#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'recall-natural.json');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = argVal('--db', '');
const N = parseInt(argVal('--n', '40'), 10);
const K = parseInt(argVal('--k', '8'), 10);
const GENERATE = args.includes('--generate');
const WRITER = process.env.TROTH_BENCH_EXTRACTOR_HOST || 'http://127.0.0.1:1234';

if (!DB || !existsSync(DB)) {
  console.error('recall-natural: --db <copy-of-a-backup.db> is required.');
  console.error('  cp ~/.troth/backups/substrate-<newest>/state.db /tmp/probe-state.db');
  process.exit(2);
}
process.env.STATE_DB_PATH = DB;

const state = require(join(REPO, 'shared-core', 'state.js'));
const recall = require(join(REPO, 'shared-core', 'recall.js'));

function askModel(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'q', temperature: 0, max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
      chat_template_kwargs: { enable_thinking: false }
    });
    const u = new URL('/v1/chat/completions', WRITER);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b).choices[0].message.content.trim()); } catch (_) { resolve(''); } });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(''); });
    req.write(body); req.end();
  });
}

function sampleMemories(count) {
  const rows = state._dbForQuery().prepare(`
    SELECT id, json_extract(output,'$.statement') AS s, memory_class, timestamp
    FROM action_records
    WHERE type = 'commitment'
      AND (audience IS NULL OR audience = 'model_visible')
      AND json_extract(output,'$.tier') IS NOT 'flagged'
      AND json_extract(output,'$.lifetime.supersedes') IS NULL
      AND memory_class IN ('episodic','semantic','identity')
      AND (json_extract(output,'$.scope') IS NULL
           OR json_extract(output,'$.scope') IN ('identity','consolidated:dialogue')
           OR json_extract(output,'$.scope') LIKE 'memory:%'
           OR json_extract(output,'$.scope') LIKE 'project:%'
           OR json_extract(output,'$.scope') LIKE 'decision%'
           OR json_extract(output,'$.scope') LIKE 'working-relationship%')
      AND length(json_extract(output,'$.statement')) BETWEEN 150 AND 900
    ORDER BY RANDOM() LIMIT ?`).all(count);
  const out = rows.slice(0, count);
  return out;
}

async function generate() {
  const mems = sampleMemories(N);
  const items = [];
  for (const m of mems) {
    const q = await askModel(
      'Read this note, then write ONE short natural question (max 12 words) that a person ' +
      'would ask to recall it. Use ORDINARY words. Do NOT copy distinctive phrases, names ' +
      'or numbers from the note. Output only the question.\n\nNOTE: ' + String(m.s).slice(0, 700));
    if (!q || q.length < 10) continue;
    items.push({
      id: m.id,
      question: q.replace(/\s+/g, ' ').trim(),
      statement: String(m.s).replace(/\s+/g, ' ').slice(0, 400),
      head: String(m.s).replace(/\s+/g, ' ').slice(0, 90)
    });
    process.stdout.write('.');
  }
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify({
    generated_at: new Date().toISOString(), db: DB, writer: WRITER, count: items.length, items
  }, null, 2));
  console.log('\n  wrote ' + items.length + ' questions → ' + FIXTURE);
}

async function replay() {
  if (!existsSync(FIXTURE)) { console.error('no fixture — run with --generate first'); process.exit(3); }
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  let at1 = 0, atK = 0, atKNoDense = 0, n = 0, ms = 0;
  const misses = [];
  const scopeOf = (id) => {
    try {
      const r = state._dbForQuery().prepare("SELECT json_extract(output,'$.scope') AS s, json_extract(output,'$.source') AS src FROM action_records WHERE id=?").get(id);
      return { scope: String((r && r.s) || ''), source: String((r && r.src) || '') };
    } catch (_) { return { scope: '', source: '' }; }
  };
  const isDoc = (id) => {
    const { scope, source } = scopeOf(id);
    return /^docs?:/.test(scope) || /^knowledge:/.test(scope) || /ingest|import|webfetch/i.test(source);
  };
  const strata = { curated: { n: 0, at1: 0, atK: 0 }, document: { n: 0, at1: 0, atK: 0 } };
  for (const it of fx.items) {
    const t0 = Date.now();
    const hits = await recall.recall({ query: it.question, class: 'all', audience: 'model_visible', limit: K, rerank: false });
    ms += Date.now() - t0;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const target = norm(it.statement || it.head);
    const probe = target.slice(0, 60);
    const carries = (h) => {
      if (h.id === it.id) return true;
      const s = norm(h.statement);
      if (probe.length >= 30 && s.indexOf(probe) !== -1) return true;
      const a = new Set(target.split(' ').filter((w) => w.length >= 4));
      if (a.size < 4) return false;
      const b = new Set(s.split(' ').filter((w) => w.length >= 4));
      let shared = 0; for (const w of a) if (b.has(w)) shared++;
      return shared / a.size >= 0.6;
    };
    n++;
    const bucket = isDoc(it.id) ? strata.document : strata.curated;
    bucket.n++;
    if (hits.length && carries(hits[0])) { at1++; bucket.at1++; }
    if (hits.some(carries)) { atK++; bucket.atK++; } else if (bucket === strata.curated) misses.push(it);
    const noDense = await recall.recall({ query: it.question, class: 'all', audience: 'model_visible', limit: K, rerank: false, skip_embedding_rerank: true });
    if (noDense.some(carries)) atKNoDense++;
  }
  const pct = (x) => Math.round((100 * x) / Math.max(n, 1)) + '%';
  console.log('═ recall in ordinary words ═');
  console.log('  questions: ' + n + '   corpus: ' + DB.split('/').pop());
  console.log('  knobs: W_COS=' + (process.env.TROTH_RECALL_W_COS || '0.60 (default)') +
              '  COS_FLOOR=' + (process.env.TROTH_RECALL_COS_FLOOR || '0.35 (default)'));
  console.log('  found@1:  ' + at1 + '/' + n + '  ' + pct(at1));
  console.log('  found@' + K + ':  ' + atK + '/' + n + '  ' + pct(atK));
  const sp = (b) => b.n ? (b.atK + '/' + b.n + '  ' + Math.round(100 * b.atK / b.n) + '%') : '(none)';
  console.log('  ─ memories the partner wrote : ' + sp(strata.curated) + '   ← the promise');
  console.log('  ─ chunks of imported documents: ' + sp(strata.document));
  console.log('  found@' + K + ' without the semantic arm: ' + atKNoDense + '/' + n + '  ' + pct(atKNoDense));
  console.log('  latency: ' + Math.round(ms / Math.max(n, 1)) + 'ms/query');
  if (misses.length) {
    console.log('  missed:');
    for (const m of misses.slice(0, 8)) console.log('    ✗ "' + m.question.slice(0, 52) + '" → ' + m.head.slice(0, 46));
  }
}

if (GENERATE) generate(); else replay();
