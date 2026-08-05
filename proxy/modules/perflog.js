// SPDX-License-Identifier: AGPL-3.0-only
// Performance log — append-only JSONL of every request for analysis.
//
// Each request gets one JSON line in ~/.troth/perflog/YYYY-MM-DD.jsonl with:
//   { ts, requestId, provider, model, latencyMs, inputTokens, outputTokens,
//     cost, isComplex, mode, tools, modulesActive }
//
// Used for: post-hoc analysis, billing audits, identifying slow patterns.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const LOG_DIR = path.join(HOME, '.troth', 'perflog');

let writeBuffer = [];
let flushTimer = null;

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {}
}

function todayLogFile() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10);
  return path.join(LOG_DIR, ymd + '.jsonl');
}

function flush() {
  if (!writeBuffer.length) return;
  ensureDir();
  const lines = writeBuffer.splice(0, writeBuffer.length).map(JSON.stringify).join('\n') + '\n';
  try { fs.appendFileSync(todayLogFile(), lines); } catch (e) {}
}

function record(entry) {
  if (!entry) return;
  writeBuffer.push({ ts: Date.now(), ...entry });
  // Debounced flush — write every 1s
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1000);
  }
  // Force flush if buffer grows large
  if (writeBuffer.length >= 50) flush();
}

// Read recent entries (for dashboard / introspection)
function getRecent(limit) {
  ensureDir();
  limit = limit || 100;
  const file = todayLogFile();
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    return recent.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Aggregate stats over today
function getDailyStats() {
  const entries = getRecent(10000);
  if (!entries.length) return null;
  const stats = {
    requests: entries.length,
    totalLatencyMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    perProvider: {},
  };
  for (const e of entries) {
    stats.totalLatencyMs += e.latencyMs || 0;
    stats.totalInputTokens += e.inputTokens || 0;
    stats.totalOutputTokens += e.outputTokens || 0;
    stats.totalCost += e.cost || 0;
    const p = e.provider || 'unknown';
    if (!stats.perProvider[p]) stats.perProvider[p] = { requests: 0, latencyMs: 0, cost: 0 };
    stats.perProvider[p].requests++;
    stats.perProvider[p].latencyMs += e.latencyMs || 0;
    stats.perProvider[p].cost += e.cost || 0;
  }
  stats.avgLatencyMs = Math.round(stats.totalLatencyMs / stats.requests);
  stats.totalCost = Math.round(stats.totalCost * 1_000_000) / 1_000_000;
  return stats;
}

// Flush on exit
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });

module.exports = { record, getRecent, getDailyStats, flush };
