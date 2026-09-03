#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Operator questions against a copy of the substrate: what the model would
// see on each memory road, judged deterministically.
//
// Roads:
//   claude-code  the per-prompt hook (plugin/hooks/injector.mjs), spawned the
//                way Claude Code spawns it, the question as the prompt and
//                the item's conversation as the session
//   entity       the daemon's prefix, assembled from the same primitives the
//                daemon drives (benchmarks/poisoning/prefix-probe.js), with
//                the item's conversation as the pane
//
// Hermetic: HOME is a throwaway (tests/hermetic-db.js) and the given database
// is COPIED into it before anything loads, so neither ~/.troth nor the input
// file is ever written. No network, no paid model: the embedder and the
// reranker ports are closed for the run, so recall works on its lexical arm.
// The numbers compare variants on one copy; they are not production ranking.
//
// Usage:
//   node -r ./tests/hermetic-db.js benchmarks/substrate-questions/run.js \
//     --db <copy.db> --questions <questions.json> \
//     [--road claude-code|entity|both] [--label stock] [--out <dir>] \
//     [--env KEY=VAL ...] [--assert-no-leaks] [--quiet]
//
// A variant is the same run with --env toggles (for example
// --env TROTH_CONTEXT_BINDING=1); compare two reports with compare.js. Each
// variant runs in its own process on its own copy, never two in one process.
//
// questions.json:
//   { "cwd": "/path/the/questions/are/asked/from",
//     "items": [ { "id": "q1", "q": "what did the coach say about training?",
//       "conversation_id": "conv-a", "context_id": "ctx:a",
//       "must": ["Tuesday"], "must_not": ["Thursday"], "note": "..." } ] }
//   must / must_not are regular expressions (flags iu) tested against the
//   whole block the road would put in front of the model.

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const a = { road: 'both', label: 'stock', env: [], assertNoLeaks: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--db') { a.db = v; i++; }
    else if (k === '--questions') { a.questions = v; i++; }
    else if (k === '--road') { a.road = v; i++; }
    else if (k === '--label') { a.label = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--env') { a.env.push(v); i++; }
    else if (k === '--assert-no-leaks') a.assertNoLeaks = true;
    else if (k === '--quiet') a.quiet = true;
  }
  return a;
}

// The judge. A fact is present when its regex matches the block; a leak is a
// forbidden regex that matches. Pure, so the test pins it.
function judge(item, text) {
  const t = String(text || '');
  const test = (re) => { try { return new RegExp(re, 'iu').test(t); } catch (_) { return false; } };
  const must = Array.isArray(item.must) ? item.must : [];
  const mustNot = Array.isArray(item.must_not) ? item.must_not : [];
  const missing = must.filter((re) => !test(re));
  const leaks = mustNot.filter(test);
  return { must_total: must.length, must_hit: must.length - missing.length, missing, leaks, chars: t.length };
}

function summarize(rows) {
  const n = rows.length || 1;
  const sum = (f) => rows.reduce((acc, r) => acc + f(r), 0);
  return {
    items: rows.length,
    facts_total: sum((r) => r.must_total),
    facts_hit: sum((r) => r.must_hit),
    leaks: sum((r) => r.leaks.length),
    items_with_leak: rows.filter((r) => r.leaks.length).length,
    mean_chars: Math.round(sum((r) => r.chars) / n),
    mean_ms: Math.round(sum((r) => r.ms || 0) / n)
  };
}

function gitHead() {
  try { return execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return 'unknown'; }
}

function prepare(a) {
  if (!process.env._TROTH_TEST_HOME) {
    console.error('substrate-questions: refusing to run outside a hermetic HOME. Launch with -r ./tests/hermetic-db.js');
    process.exit(2);
  }
  if (!a.db || !fs.existsSync(a.db)) { console.error('substrate-questions: --db <copy.db> is required'); process.exit(2); }
  if (!a.questions || !fs.existsSync(a.questions)) { console.error('substrate-questions: --questions <file> is required'); process.exit(2); }
  for (const pair of a.env) {
    const i = pair.indexOf('=');
    if (i > 0) process.env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const dir = path.join(process.env.HOME, '.troth');
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'questions-' + process.pid + '.db');
  fs.copyFileSync(a.db, db);
  for (const suf of ['-wal', '-shm']) { if (fs.existsSync(a.db + suf)) fs.copyFileSync(a.db + suf, db + suf); }
  process.env.STATE_DB_PATH = db;
  // Closed ports: the lexical arm only, whatever servers the operator runs.
  process.env.TROTH_EMBED_PORT = process.env.TROTH_EMBED_PORT || '9';
  process.env.TROTH_RERANK_PORT = process.env.TROTH_RERANK_PORT || '9';
  process.env.TROTH_EMBEDDING_HOST = process.env.TROTH_EMBEDDING_HOST || 'http://127.0.0.1:9';
  process.env.TROTH_LLAMACPP_HOST = process.env.TROTH_LLAMACPP_HOST || 'http://127.0.0.1:9';
  process.env.TROTH_OLLAMA_HOST = process.env.TROTH_OLLAMA_HOST || 'http://127.0.0.1:9';
  process.env.TROTH_RECALL_CONCERNS = '0';
  return db;
}

async function askEntity(item, defaults) {
  const { assemblePrefix } = require(path.join(REPO, 'benchmarks', 'poisoning', 'prefix-probe.js'));
  const t0 = Date.now();
  const r = await assemblePrefix({
    query: item.q,
    cwd: item.cwd || defaults.cwd,
    conversation_id: item.conversation_id || null,
    context_id: item.context_id || null,
    dialogue_window: 'daemon'
  });
  return { text: r.body, ms: Date.now() - t0, dense: r.dense === true };
}

function askClaudeCode(item, defaults) {
  const cwd = item.cwd || defaults.cwd;
  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: item.q,
    session_id: item.conversation_id || ('questions-' + item.id),
    cwd
  });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO, 'plugin', 'hooks', 'injector.mjs')], {
    input: payload, encoding: 'utf8', timeout: 30000,
    cwd: fs.existsSync(cwd) ? cwd : REPO,
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin') })
  });
  const ms = Date.now() - t0;
  let text = '';
  const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i][0] !== '{') continue;
    try {
      const out = JSON.parse(lines[i]);
      text = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || out.additionalContext || '';
      break;
    } catch (_) { /* not the JSON line */ }
  }
  return { text, ms, exit: r.status, stderr: String(r.stderr || '').slice(0, 300) };
}

function print(report, file) {
  console.log('\n=== substrate questions · ' + report.label + ' · ' + report.head + ' ===');
  for (const [road, r] of Object.entries(report.roads)) {
    const s = r.summary;
    console.log('\n' + road + ': facts ' + s.facts_hit + '/' + s.facts_total + ' · leaks ' + s.leaks +
      ' (' + s.items_with_leak + ' items) · mean ' + s.mean_chars + ' chars · ' + s.mean_ms + ' ms');
    for (const it of r.items) {
      const mark = it.leaks.length ? '✗' : (it.must_hit === it.must_total ? '✓' : '○');
      console.log('  ' + mark + ' ' + it.id + ' [' + it.must_hit + '/' + it.must_total +
        (it.leaks.length ? ' leak: ' + it.leaks.join(', ') : '') +
        (it.missing.length ? ' missing: ' + it.missing.join(', ') : '') + ']' +
        (it.dense === false ? ' (no embedder)' : '') + ' ' + String(it.q).slice(0, 70));
    }
  }
  console.log('\nreport: ' + file + '\n');
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  prepare(a);
  const spec = JSON.parse(fs.readFileSync(a.questions, 'utf8'));
  const items = Array.isArray(spec.items) ? spec.items : [];
  const defaults = { cwd: spec.cwd || path.dirname(path.resolve(a.questions)) };
  const roads = a.road === 'both' ? ['entity', 'claude-code'] : [a.road];
  const report = {
    label: a.label, at: new Date().toISOString(),
    db: path.resolve(a.db), questions: path.resolve(a.questions),
    env: a.env, head: gitHead(), node: process.version, embedder: 'closed port (lexical arm)',
    roads: {}
  };
  for (const road of roads) {
    const rows = [];
    for (const item of items) {
      const r = road === 'entity' ? await askEntity(item, defaults) : askClaudeCode(item, defaults);
      const j = judge(item, r.text);
      rows.push(Object.assign({
        id: item.id, q: item.q,
        conversation_id: item.conversation_id || null, context_id: item.context_id || null,
        ms: r.ms, exit: r.exit == null ? null : r.exit, stderr: r.stderr || '',
        dense: r.dense == null ? null : !!r.dense
      }, j, { text: String(r.text || '').slice(0, 20000) }));
    }
    report.roads[road] = { summary: summarize(rows), items: rows };
  }
  const outDir = a.out || path.join(REPO, 'benchmarks', 'raw', 'substrate-questions');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, a.label + '-' + report.at.replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (!a.quiet) print(report, file);
  const leaks = Object.values(report.roads).reduce((n, r) => n + r.summary.leaks, 0);
  process.exit(a.assertNoLeaks && leaks > 0 ? 1 : 0);
}

module.exports = { judge, summarize };

if (require.main === module) {
  require(path.join(REPO, 'tests', 'hermetic-db.js'));
  main().catch((e) => { console.error('substrate-questions: ' + (e && e.stack || e)); process.exit(1); });
}
