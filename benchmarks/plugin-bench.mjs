#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// plugin-bench — measure plugin savings on a running Claude Code session.
//
// Usage:
//   node benchmarks/plugin-bench.mjs start  [--label=<name>]
//   node benchmarks/plugin-bench.mjs report [--label=<name>]
//   node benchmarks/plugin-bench.mjs list
//   node benchmarks/plugin-bench.mjs compare <labelA> <labelB>
//   node benchmarks/plugin-bench.mjs profile <off|minimal|full>
//
// Workflow for a compound benchmark (the gate):
//   1.  profile off       → disable all troth hooks in plugin settings
//       start --label=off
//       <run your task A once>
//       report --label=off
//   2.  profile full      → re-enable all hooks
//       start --label=full
//       <run THE SAME task A again>
//       report --label=full
//   3.  compare off full  → prints deltas; this is the table that
//       goes into the launch README.
//
// No LLM calls, no synthetic tasks — measurements come straight from
// state.db, populated by real hook fires in real Claude Code sessions.

import { createRequire } from 'node:module';
import { existsSync, writeFileSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

// Plugin-installed hooks write to ~/.claude/plugins/data/<plugin>/state.db
// (via CLAUDE_PLUGIN_DATA), not ~/.troth/state.db. If the user hasn't
// set CLAUDE_PLUGIN_DATA and a plugin-scoped DB exists, point state.js
// there automatically so `report` actually sees hook activity.
if (!process.env.CLAUDE_PLUGIN_DATA) {
  const pluginDb = join(homedir(), '.claude', 'plugins', 'data', 'troth-troth-local', 'state.db');
  if (existsSync(pluginDb)) {
    process.env.CLAUDE_PLUGIN_DATA = dirname(pluginDb);
  }
}

const state = require(join(process.cwd(), 'shared-core', 'state.js'));

const DATA_DIR = join(homedir(), '.troth', 'bench');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function markerPath(label) { return join(DATA_DIR, (label || 'default') + '.json'); }
function reportPath(label) { return join(DATA_DIR, (label || 'default') + '.report.json'); }

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    const m = /^--(\w[\w-]*)=(.+)$/.exec(a);
    if (m) flags[m[1]] = m[2];
  }
  return flags;
}

function fmtNum(n) { return (n == null ? '-' : n.toLocaleString()); }
function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + r + 's';
}

// ────────────────────────────────────────────────────────────────────────
// start — stamp a marker file with the current timestamp.
// ────────────────────────────────────────────────────────────────────────
function cmdStart(label) {
  const now = Date.now();
  writeFileSync(markerPath(label), JSON.stringify({ started_at: now, iso: new Date(now).toISOString(), label }, null, 2));
  console.log('Benchmark window "' + (label || 'default') + '" started at', new Date(now).toISOString());
  console.log('Go do the work in Claude Code. When done:  plugin-bench.mjs report' + (label ? ' --label=' + label : ''));
}

// ────────────────────────────────────────────────────────────────────────
// report — compute deltas from state.db since the marker, persist to disk.
// ────────────────────────────────────────────────────────────────────────
function computeReport(started_at) {
  const db = state.db();
  const events = db.prepare(`
    SELECT event, COUNT(*) AS n FROM hook_events
    WHERE ts >= ? GROUP BY event ORDER BY n DESC
  `).all(started_at);
  const savings = db.prepare(`
    SELECT kind, COUNT(*) AS entries, SUM(tokens) AS total_tokens
    FROM savings_ledger WHERE ts >= ? GROUP BY kind ORDER BY total_tokens DESC
  `).all(started_at);
  const archive = db.prepare(`
    SELECT COUNT(*) AS n, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out
    FROM tool_output_archive WHERE ts >= ?
  `).get(started_at);

  const totalSavedTokens = savings.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const archiveSavedBytes = (archive.bytes_in || 0) - (archive.bytes_out || 0);
  const archiveSavedTokens = Math.round(archiveSavedBytes / 3.3);

  return {
    started_at,
    ended_at: Date.now(),
    duration_ms: Date.now() - started_at,
    hookCounts: events,
    savings,
    archive,
    totalSavedTokens,
    archiveSavedTokens,
    grandTotalSaved: totalSavedTokens + archiveSavedTokens
  };
}

function cmdReport(label) {
  const mp = markerPath(label);
  if (!existsSync(mp)) {
    console.error('No open benchmark window for label "' + (label || 'default') + '". Run `start` first.');
    process.exit(1);
  }
  const marker = JSON.parse(readFileSync(mp, 'utf8'));
  const report = computeReport(marker.started_at);
  report.label = label || 'default';
  writeFileSync(reportPath(label), JSON.stringify(report, null, 2));

  console.log('');
  console.log('═══ troth plugin-bench · "' + report.label + '" ═══');
  console.log('Window       : ' + new Date(report.started_at).toISOString() + ' → now');
  console.log('Duration     : ' + fmtMs(report.duration_ms));
  console.log('');
  console.log('Hook activations:');
  if (!report.hookCounts.length) console.log('  (none — plugin disabled in this window, or no turns ran)');
  for (const e of report.hookCounts) console.log('  ' + e.event.padEnd(40) + fmtNum(e.n).padStart(6));
  console.log('');
  console.log('Savings ledger (per category):');
  if (!report.savings.length) console.log('  (no recorded savings)');
  for (const s of report.savings) {
    console.log('  ' + (s.kind || '?').padEnd(30) + fmtNum(s.entries).padStart(6) + ' entries  ' + fmtNum(s.total_tokens).padStart(10) + ' tokens');
  }
  console.log('');
  console.log('Tool-output archive:');
  console.log('  Archives created : ' + fmtNum(report.archive.n || 0));
  console.log('  Raw bytes        : ' + fmtNum(report.archive.bytes_in || 0));
  console.log('  Summary bytes    : ' + fmtNum(report.archive.bytes_out || 0));
  console.log('  Compression      : ' + (report.archive.bytes_in ? (100 * ((report.archive.bytes_in - (report.archive.bytes_out || 0)) / report.archive.bytes_in)).toFixed(1) + '%' : '-'));
  console.log('  Est tokens saved : ' + fmtNum(report.archiveSavedTokens));
  console.log('');
  console.log('  GRAND TOTAL saved: ' + fmtNum(report.grandTotalSaved) + ' tokens');
  console.log('');
  console.log('Saved as: ' + reportPath(label));
  try { unlinkSync(mp); } catch (e) {}
}

// ────────────────────────────────────────────────────────────────────────
// list — show known report files.
// ────────────────────────────────────────────────────────────────────────
function cmdList() {
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.report.json'));
  if (!files.length) {
    console.log('No reports yet. Run a window:  start --label=<name> … report --label=<name>');
    return;
  }
  console.log('Saved reports:');
  for (const f of files) {
    const r = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
    console.log('  ' + r.label.padEnd(20) + fmtMs(r.duration_ms).padStart(10) +
      '   saved=' + fmtNum(r.grandTotalSaved).padStart(10) + ' tokens');
  }
}

// ────────────────────────────────────────────────────────────────────────
// compare — diff two reports. Assumes the same task was run in both
// windows (honesty burden on the operator — there's no magic check).
// ────────────────────────────────────────────────────────────────────────
function cmdCompare(labelA, labelB) {
  const pA = reportPath(labelA), pB = reportPath(labelB);
  if (!existsSync(pA) || !existsSync(pB)) {
    console.error('Both reports must exist. Missing: ' +
      (existsSync(pA) ? '' : labelA + ' ') +
      (existsSync(pB) ? '' : labelB));
    process.exit(1);
  }
  const A = JSON.parse(readFileSync(pA, 'utf8'));
  const B = JSON.parse(readFileSync(pB, 'utf8'));

  function pct(a, b) {
    if (!a) return 'n/a';
    return (100 * (b - a) / a).toFixed(1) + '%';
  }

  console.log('');
  console.log('═══ troth plugin-bench compare: "' + A.label + '" → "' + B.label + '" ═══');
  console.log('');
  console.log('                        ' + A.label.padEnd(18) + B.label.padEnd(18) + 'Δ');
  console.log('Duration              : ' + fmtMs(A.duration_ms).padEnd(18) + fmtMs(B.duration_ms).padEnd(18) + pct(A.duration_ms, B.duration_ms));
  console.log('Hook activations (sum): ' +
    fmtNum(A.hookCounts.reduce((s, e) => s + e.n, 0)).padEnd(18) +
    fmtNum(B.hookCounts.reduce((s, e) => s + e.n, 0)).padEnd(18));
  console.log('Tokens saved (ledger) : ' + fmtNum(A.totalSavedTokens).padEnd(18) + fmtNum(B.totalSavedTokens).padEnd(18) + pct(A.totalSavedTokens, B.totalSavedTokens));
  console.log('Archive raw bytes     : ' + fmtNum(A.archive.bytes_in || 0).padEnd(18) + fmtNum(B.archive.bytes_in || 0).padEnd(18) + pct(A.archive.bytes_in || 0, B.archive.bytes_in || 0));
  console.log('Archive summary bytes : ' + fmtNum(A.archive.bytes_out || 0).padEnd(18) + fmtNum(B.archive.bytes_out || 0).padEnd(18) + pct(A.archive.bytes_out || 0, B.archive.bytes_out || 0));
  console.log('GRAND TOTAL saved     : ' + fmtNum(A.grandTotalSaved).padEnd(18) + fmtNum(B.grandTotalSaved).padEnd(18) + pct(A.grandTotalSaved, B.grandTotalSaved));
  console.log('');
  console.log('Honesty check: the task run during "' + A.label + '" and "' + B.label +
    '" must be the same, or these deltas mean nothing.');
}

// ────────────────────────────────────────────────────────────────────────
// profile — toggle plugin hooks between presets by rewriting
// plugin/hooks/hooks.json. Preserves the file under.bak.
//   off     → removes the hooks key so nothing fires
//   minimal → keeps only loopbreaker + verifyfirst (baseline safety)
//   full    → restores from.bak or from git if missing
// ────────────────────────────────────────────────────────────────────────
function cmdProfile(name) {
  const hooksPath = join(process.cwd(), 'plugin', 'hooks', 'hooks.json');
  if (!existsSync(hooksPath)) {
    console.error('plugin/hooks/hooks.json not found — is this running from the troth repo?');
    process.exit(1);
  }
  const bakPath = hooksPath + '.bench-bak';

  if (name === 'off') {
    if (!existsSync(bakPath)) writeFileSync(bakPath, readFileSync(hooksPath, 'utf8'));
    writeFileSync(hooksPath, JSON.stringify({ description: 'benched off', hooks: {} }, null, 2) + '\n');
    console.log('profile=off — all hooks disabled. Restart any running CC session for the change to apply.');
    return;
  }

  if (name === 'minimal') {
    if (!existsSync(bakPath)) writeFileSync(bakPath, readFileSync(hooksPath, 'utf8'));
    const full = JSON.parse(existsSync(bakPath) ? readFileSync(bakPath, 'utf8') : readFileSync(hooksPath, 'utf8'));
    const minimal = { description: 'benched minimal (loopbreaker + verifyfirst only)', hooks: {} };
    for (const ev of Object.keys(full.hooks || {})) {
      const entries = (full.hooks[ev] || []).filter(block =>
        (block.hooks || []).some(h =>
          (h.command || '').includes('loopbreaker.mjs') || (h.command || '').includes('verifyfirst.mjs')
        )
      );
      if (entries.length) minimal.hooks[ev] = entries.map(e => ({
        matcher: e.matcher,
        hooks: (e.hooks || []).filter(h =>
          (h.command || '').includes('loopbreaker.mjs') || (h.command || '').includes('verifyfirst.mjs')
        )
      }));
    }
    writeFileSync(hooksPath, JSON.stringify(minimal, null, 2) + '\n');
    console.log('profile=minimal — only LoopBreaker + VerifyFirst remain. Restart CC.');
    return;
  }

  if (name === 'full') {
    if (!existsSync(bakPath)) {
      console.error('No backup to restore from. Use git checkout plugin/hooks/hooks.json to recover.');
      process.exit(1);
    }
    writeFileSync(hooksPath, readFileSync(bakPath, 'utf8'));
    console.log('profile=full — all hooks restored from .bench-bak. Restart CC.');
    return;
  }

  console.error('Unknown profile: ' + name + '  (use off | minimal | full)');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = parseFlags(argv);
const label = flags.label || undefined;

if (cmd === 'start') cmdStart(label);
else if (cmd === 'report') cmdReport(label);
else if (cmd === 'list') cmdList();
else if (cmd === 'compare') cmdCompare(argv[1], argv[2]);
else if (cmd === 'profile') cmdProfile(argv[1]);
else {
  console.log('Usage:');
  console.log('  plugin-bench.mjs start   [--label=<name>]');
  console.log('  plugin-bench.mjs report  [--label=<name>]');
  console.log('  plugin-bench.mjs list');
  console.log('  plugin-bench.mjs compare <labelA> <labelB>');
  console.log('  plugin-bench.mjs profile <off|minimal|full>');
  process.exit(cmd ? 1 : 0);
}
