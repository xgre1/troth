#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Fill the knowledge reservoir from what is already on disk.
//
// Live capture only sees documents from the moment it was wired. Everything
// the operator collected before that is still sitting in their folders, while
// what has been ingested comes from whichever folder the capture happened to
// watch.
//
// This does not ingest. It QUEUES — the same spool the proxy and the read hook
// write to — so the same drain does the work, with the same extractor, the
// same secret gate, the same chunking and the same provenance. One road.
//
// SCOPE IS A DELIBERATE CHOICE, NOT A DEFAULT. Queuing all 2,069 would add
// ~86,000 chunks to an index of 60,929 and the dense recall arm streams every
// vector on every call: 164ms would become roughly 395ms on every turn,
// permanently. So this takes explicit roots, prints what it would cost, and
// requires --go to write anything.
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_EXT = /\.(pdf|docx?|rtf|md|markdown|txt|csv|html?|adoc|rst)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|target|\.venv|venv|__pycache__|\.next|\.cache|Library|\.Trash)(\/|$)/;
const MIN_BYTES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

function walk(root, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(root, e.name);
    if (SKIP_DIR.test(p)) continue;
    try {
      if (e.isDirectory()) walk(p, out, depth + 1);
      else if (e.isFile() && KNOWLEDGE_EXT.test(e.name)) {
        const st = fs.statSync(p);
        if (st.size >= MIN_BYTES && st.size <= MAX_BYTES) out.push({ path: p, size: st.size });
      }
    } catch (_) { /* unreadable: not ours to fix */ }
  }
}

// Rough text yield per format, from measured samples — enough to price the
// decision before making it, not enough to pretend it is exact.
function textEstimate(file) {
  const e = path.extname(file.path).toLowerCase();
  if (e === '.pdf') return file.size * 0.25;
  if (e === '.html' || e === '.htm') return file.size * 0.20;
  if (e === '.rtf' || e === '.doc' || e === '.docx') return file.size * 0.35;
  return file.size;
}

(async () => {
  const args = process.argv.slice(2);
  const go = args.includes('--go');
  const roots = args.filter((a) => !a.startsWith('--')).map((r) => r.replace(/^~/, process.env.HOME));
  if (!roots.length) {
    console.log('usage: node tools/knowledge-backfill.js <dir> [<dir>...] [--go]');
    console.log('       without --go it only prices the work.');
    process.exit(1);
  }

  const state = require('../shared-core/state.js');
  const files = [];
  for (const r of roots) walk(r, files, 0);

  const chars = files.reduce((a, f) => a + textEstimate(f), 0);
  const chunks = Math.round(chars / 800);
  const before = state._dbForQuery().prepare('SELECT COUNT(*) AS n FROM engram_embeddings').get().n;

  console.log('roots      : ' + roots.map((r) => r.replace(process.env.HOME, '~')).join(', '));
  console.log('documents  : ' + files.length);
  console.log('text       : ' + (chars / 1024 / 1024).toFixed(1) + ' MB  ->  ~' + chunks.toLocaleString() + ' passages');
  console.log('embed time : ~' + (chunks * 51 / 1000 / 60).toFixed(0) + ' min (idle worker, 8 documents per pass)');
  console.log('index      : ' + before.toLocaleString() + ' vectors now  ->  ~' + (before + chunks).toLocaleString() +
              '  (dense scan ~' + Math.round(164 * (before + chunks) / (before || 1)) + 'ms per recall, from 164ms)');

  if (!go) { console.log('\nnothing queued. re-run with --go to queue it.'); return; }

  let queued = 0, already = 0;
  const crypto = require('crypto');
  for (const f of files) {
    let sha;
    try { sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex').slice(0, 32); }
    catch (_) { continue; }
    if (state.knowledgeAlreadyIngested(sha)) { already++; continue; }
    if (state.spoolKnowledge({ kind: 'file', ref: f.path, sha, bytes: f.size, why: null }) !== null) queued++;
  }
  console.log('\nqueued ' + queued + ' documents (' + already + ' already held). The idle worker drains them; ' +
              'run `node -e "require(\'./shared-core/knowledge-drain.js\').drainOnce(require(\'./shared-core/state.js\'),{budget:50})"` to pull sooner.');
})();
