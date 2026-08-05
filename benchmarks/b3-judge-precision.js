#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// b3-judge-precision — measured value bench #3.
// Question: are the engrams the auto-judge writes ACTUALLY useful, or
// is the judge producing noise that pollutes identity injection?
//
// Method:
//   1. Sample 30 random engrams written by auto_judge for the
//      operator's primary agent (default: env TROTH_ENTITY_AGENT_ID).
//   2. Write them to a Markdown rubric file for the operator to fill in.
//   3. Operator marks each: U (useful) / W (wrong) / D (duplicate) / T (trivial).
//   4. After operator review, run with --score <path> to compute
//      precision % per category.
//
// Acceptance: ≥ 60% useful, ≤ 10% wrong.
//
// Why this matters: judge precision is upstream of every other
// substrate-as-mind feature. If 40% of engrams are noise, the
// `[troth/identity]` injection surfaces noise; G3 drift detector
// fires on noise; G6 revision protocol proposes against noise.
// Audit precision FIRST, then trust downstream.

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveAgentId } = require('../shared-core/agent-id.js');

const DB_PATH = path.join(process.env.HOME || require('os').homedir(), '.troth', 'state.db');
const DEFAULT_AGENT = resolveAgentId();
const DEFAULT_N = 30;

function sampleEngrams(agent_id, n) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT id, timestamp, output, cwd FROM action_records " +
      "WHERE agent_id = ? AND type = 'commitment' " +
      "  AND json_extract(output, '$.commitment_type') = 'engram' " +
      "  AND json_extract(input, '$.source') = 'auto_judge' " +
      "ORDER BY RANDOM() LIMIT ?"
    ).all(agent_id, n);
    return rows.map(r => {
      let out; try { out = JSON.parse(r.output); } catch (_) { out = {}; }
      return {
        id: r.id,
        ts: r.timestamp,
        cwd: r.cwd,
        statement: out.statement || '',
        salience: out.salience || 1.0
      };
    });
  } finally { db.close(); }
}

function buildRubric(samples, outPath) {
  const lines = [];
  lines.push('# B3 — Auto-judge Precision Audit');
  lines.push('');
  lines.push('**Generated:** ' + new Date().toISOString() + '  ');
  lines.push('**Sample size:** ' + samples.length + '  ');
  lines.push('**Agent:** auto-judged engrams from ' + DEFAULT_AGENT);
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  lines.push('For each engram below, write **U / W / D / T** in the `verdict` line:');
  lines.push('- **U** = Useful (durable, true, worth remembering)');
  lines.push('- **W** = Wrong (factually incorrect or misleading)');
  lines.push('- **D** = Duplicate (essentially same as another engram)');
  lines.push('- **T** = Trivial (true but worthless — e.g., "User said hello")');
  lines.push('');
  lines.push('Optionally add a one-line note explaining why.');
  lines.push('');
  lines.push('After filling in, run: `node benchmarks/b3-judge-precision.js --score ' + outPath + '`');
  lines.push('');
  lines.push('---');
  lines.push('');
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const date = new Date(s.ts).toISOString().slice(0, 10);
    lines.push('## ' + (i + 1) + '. ' + s.statement);
    lines.push('');
    lines.push('- **id:** `' + s.id + '`');
    lines.push('- **recorded:** ' + date + (s.cwd ? '  •  cwd: `' + s.cwd + '`' : ''));
    lines.push('- **salience:** ' + s.salience);
    lines.push('- **verdict:** ');
    lines.push('- **note:** ');
    lines.push('');
  }
  fs.writeFileSync(outPath, lines.join('\n'));
}

function scoreRubric(rubricPath) {
  const txt = fs.readFileSync(rubricPath, 'utf8');
  const verdictRe = /^- \*\*verdict:\*\*\s*([UWDT])/gmi;
  const counts = { U: 0, W: 0, D: 0, T: 0, blank: 0 };
  // Count expected sections
  const totalSections = (txt.match(/^## \d+\. /gm) || []).length;
  let m;
  while ((m = verdictRe.exec(txt)) !== null) {
    counts[m[1].toUpperCase()]++;
  }
  const filled = counts.U + counts.W + counts.D + counts.T;
  counts.blank = totalSections - filled;
  return { totalSections, filled, counts };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };

  if (args.includes('--score')) {
    const rubricPath = argVal('--score', null);
    if (!rubricPath || !fs.existsSync(rubricPath)) {
      console.error('--score requires path to a filled rubric');
      process.exit(1);
    }
    const r = scoreRubric(rubricPath);
    if (!r.totalSections) { console.error('no sections found'); process.exit(1); }
    const usefulRate = r.counts.U / r.totalSections;
    const wrongRate  = r.counts.W / r.totalSections;
    const dupRate    = r.counts.D / r.totalSections;
    const trivRate   = r.counts.T / r.totalSections;
    const pass = usefulRate >= 0.60 && wrongRate <= 0.10;
    console.log('--- B3 Auto-judge Precision ---');
    console.log('total samples:', r.totalSections, '  filled:', r.filled, '  blank:', r.counts.blank);
    console.log('useful  (U): ' + r.counts.U + '  (' + (usefulRate*100).toFixed(0) + '%)');
    console.log('wrong   (W): ' + r.counts.W + '  (' + (wrongRate*100).toFixed(0) + '%)');
    console.log('dup     (D): ' + r.counts.D + '  (' + (dupRate*100).toFixed(0) + '%)');
    console.log('trivial (T): ' + r.counts.T + '  (' + (trivRate*100).toFixed(0) + '%)');
    console.log('---');
    console.log('Acceptance ≥ 60% U AND ≤ 10% W: ' + (pass ? '✅ PASS' : '❌ FAIL'));
    process.exit(pass ? 0 : 2);
  }

  const agent = argVal('--agent', DEFAULT_AGENT);
  const n     = parseInt(argVal('--n', String(DEFAULT_N))) || DEFAULT_N;
  const samples = sampleEngrams(agent, n);
  if (!samples.length) { console.error('no auto-judged engrams found for', agent); process.exit(1); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const rubricPath = path.join(outDir, 'b3-judge-rubric-' + stamp + '.md');
  buildRubric(samples, rubricPath);
  console.log('--- B3 — Sampled', samples.length, 'engrams from', agent, '---');
  console.log('Rubric written to:', rubricPath);
  console.log('');
  console.log('Edit that file, fill verdict (U/W/D/T) for each entry, then:');
  console.log('  node benchmarks/b3-judge-precision.js --score', rubricPath);
}

main();
