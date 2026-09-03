// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What went wrong, and how long things took, on the operator's own machine:
// small append-only files under ~/.troth/telemetry that the doctor reads.
// Nothing here leaves the machine. A hook writes one line per run with its
// duration; the proxy writes one line per error it answered with. The
// doctor turns them into two lines a person can act on: which hook is slow
// and how often, which error the proxy keeps meeting.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 2 * 1024 * 1024;   // a file rolls to .1 past this; two files at most

function dir() {
  const root = process.env.CLAUDE_PLUGIN_DATA || path.join(process.env.HOME || os.homedir(), '.troth');
  return path.join(root, 'telemetry');
}

function fileFor(name) { return path.join(dir(), String(name).replace(/[^a-z0-9._-]+/gi, '-')); }

// Append one JSON line. Never throws: a timing line is not worth a failed hook.
function append(name, obj) {
  try {
    const f = fileFor(name);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    try {
      const st = fs.statSync(f);
      if (st.size > MAX_BYTES) { try { fs.renameSync(f, f + '.1'); } catch (_) {} }
    } catch (_) { /* absent: first line */ }
    fs.appendFileSync(f, JSON.stringify(Object.assign({ ts: Date.now() }, obj)) + '\n', { mode: 0o600 });
    return true;
  } catch (_) { return false; }
}

// Read the lines newer than `since` (ms), the rolled file first.
function read(name, since) {
  const f = fileFor(name);
  const out = [];
  for (const p of [f + '.1', f]) {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch (_) { continue; }
      if (j && (!since || (Number(j.ts) || 0) >= since)) out.push(j);
    }
  }
  return out;
}

function _pct(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

// Per hook: runs, median and 95th-percentile duration, and how many ran past
// the budget (the harness discards a hook's output past its timeout).
function hookSummary(since, opts) {
  opts = opts || {};
  const budgetMs = Number.isFinite(opts.budget_ms) ? opts.budget_ms : 4000;
  const by = new Map();
  for (const r of read('hook-timing.jsonl', since)) {
    const hook = String(r.hook || '?');
    if (!by.has(hook)) by.set(hook, []);
    by.get(hook).push(Number(r.ms) || 0);
  }
  const rows = [];
  for (const [hook, ms] of by) {
    const sorted = ms.slice().sort((a, b) => a - b);
    rows.push({ hook, n: sorted.length, p50: _pct(sorted, 0.5), p95: _pct(sorted, 0.95), max: sorted[sorted.length - 1], over_budget: sorted.filter((x) => x > budgetMs).length });
  }
  rows.sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
  return { since: since || 0, budget_ms: budgetMs, hooks: rows, runs: rows.reduce((n, r) => n + r.n, 0), over_budget: rows.reduce((n, r) => n + r.over_budget, 0) };
}

// Proxy errors: how many, and which reasons lead.
function errorSummary(since) {
  const by = new Map();
  let n = 0;
  let last = null;
  for (const r of read('proxy-errors.jsonl', since)) {
    n++;
    const where = String(r.where || 'other');
    by.set(where, (by.get(where) || 0) + 1);
    if (!last || (Number(r.ts) || 0) >= (Number(last.ts) || 0)) last = r;   // file order is arrival order; a tie goes to the later line
  }
  const reasons = [...by.entries()].map(([where, count]) => ({ where, count })).sort((a, b) => b.count - a.count);
  return { since: since || 0, n, reasons, last };
}

module.exports = { dir, append, read, hookSummary, errorSummary, MAX_BYTES };
