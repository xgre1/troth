#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// run-g1-n20.mjs — aggregate G1 cross-engine continuity over N runs.
//
// The single G1 run in benchmarks/results/ (dated per run)
// is a single sample (n=1), which is not enough to publish a cost or parity
// claim: re-run G1 at n>=20 first, so the number has a distribution behind it
// and one counter-benchmark from a stranger cannot fairly overturn it.
//
// This script:
//   1. Spawns the existing benchmarks/cross-engine-continuity.js as a child
//      process N times (default 20). Each run produces its own JSON+MD result
//      file (the existing script does that).
//   2. Aggregates the per-engine acceptance results across all runs.
//   3. Writes an aggregate report to
//      benchmarks/results/g1-aggregate-n<N>-<timestamp>.{json,md}.
//   4. Reports mean ± stdev recall + context + voice persistence per engine,
//      plus PASS/FAIL counts.
//
// Run from the repo root:
//   node benchmarks/run-g1-n20.mjs            # default N=20
//   node benchmarks/run-g1-n20.mjs --n 30     # override

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, "results");
const DRIVER = join(__dirname, "cross-engine-continuity.js");

const args = process.argv.slice(2);
const nFlag = args.indexOf("--n");
const N = nFlag >= 0 ? Math.max(2, parseInt(args[nFlag + 1] ?? "20", 10)) : 20;

console.log(`[g1-n20] running ${N} G1 cross-engine-continuity samples`);

async function runOnce(i) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DRIVER], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) => {
      if (code === 0) resolve({ i, stdout, stderr });
      else reject(new Error(`g1 run ${i} exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

function latestResultBefore(stamp) {
  // The driver writes cross-engine-continuity-<ISO>.json. Find the most
  // recent file modified after `stamp`.
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith("cross-engine-continuity-") && f.endsWith(".json"))
    .map((f) => ({ f, t: Date.parse(f.replace("cross-engine-continuity-", "").replace(".json", "")) }))
    .filter((x) => !Number.isNaN(x.t) && x.t >= stamp)
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}

const samples = [];
let failures = 0;
const startStamp = Date.now() - 1000;

for (let i = 1; i <= N; i++) {
  const tStart = Date.now();
  process.stdout.write(`[g1-n20] sample ${i}/${N} … `);
  try {
    await runOnce(i);
    const fname = latestResultBefore(tStart - 1000);
    if (!fname) {
      console.log("no result file produced (skipping)");
      failures++;
      continue;
    }
    const sample = JSON.parse(readFileSync(join(RESULTS_DIR, fname), "utf8"));
    samples.push({ index: i, file: fname, ...sample });
    console.log(`ok (${fname})`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    failures++;
  }
}

if (samples.length === 0) {
  console.error("[g1-n20] no successful samples — aborting aggregate");
  process.exit(2);
}

// ─── Aggregate ────────────────────────────────────────────────────────────
// Each driver run writes a JSON shaped roughly like:
//   { agent_id, started, engines: { [engine]: { mem_recall, voice_under_60w, ... } } }
// We collect per-engine numeric series and compute mean / stdev / pass-rate.

const perEngine = {};
for (const s of samples) {
  const enginesObj = s.engines ?? {};
  for (const [engine, r] of Object.entries(enginesObj)) {
    const bucket = (perEngine[engine] ??= { runs: 0, recall: [], context: [], voice: [], passes: 0 });
    bucket.runs++;
    if (typeof r.mem_recall === "number") bucket.recall.push(r.mem_recall);
    if (typeof r.context_recall === "number") bucket.context.push(r.context_recall);
    if (typeof r.voice_under_60w === "number") bucket.voice.push(r.voice_under_60w);
    else if (typeof r.voice_persistence === "number") bucket.voice.push(r.voice_persistence);
    if (r.overall === "pass" || r.overall === "PASS" || r.pass === true) bucket.passes++;
  }
}

function meanStd(xs) {
  if (xs.length === 0) return { mean: null, std: null };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return { mean: m, std: Math.sqrt(v) };
}

const summary = {};
for (const [engine, b] of Object.entries(perEngine)) {
  summary[engine] = {
    runs: b.runs,
    pass_rate: b.runs ? b.passes / b.runs : 0,
    mem_recall: meanStd(b.recall),
    context_recall: meanStd(b.context),
    voice_under_60w: meanStd(b.voice),
  };
}

const aggregate = {
  benchmark: "G1 cross-engine continuity",
  n: samples.length,
  attempted: N,
  failures,
  acceptance_thresholds: {
    mem_recall: 0.6,
    voice_under_60w: 0.8,
  },
  engines: summary,
  sample_files: samples.map((s) => s.file),
  generated_at: new Date().toISOString(),
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonOut = join(RESULTS_DIR, `g1-aggregate-n${samples.length}-${stamp}.json`);
const mdOut = join(RESULTS_DIR, `g1-aggregate-n${samples.length}-${stamp}.md`);
writeFileSync(jsonOut, JSON.stringify(aggregate, null, 2));

// ─── Markdown report ──────────────────────────────────────────────────────
const lines = [];
lines.push(`# G1 cross-engine continuity — n=${samples.length} aggregate`);
lines.push("");
lines.push(`Generated: ${aggregate.generated_at}`);
lines.push(`Attempted samples: ${N}; successful: ${samples.length}; failed: ${failures}.`);
lines.push("");
lines.push("Acceptance thresholds: memory recall ≥ 0.60, voice ≤60w ≥ 0.80 per engine.");
lines.push("");
lines.push("## Per-engine summary");
lines.push("");
lines.push("| Engine | Runs | Pass rate | Memory recall (mean ± std) | Context recall | Voice ≤60w |");
lines.push("|---|---|---|---|---|---|");
for (const [engine, s] of Object.entries(summary)) {
  const fmt = (x) =>
    x.mean === null
      ? "—"
      : `${(x.mean * 100).toFixed(1)}% ± ${(x.std * 100).toFixed(1)}pp`;
  lines.push(
    `| ${engine} | ${s.runs} | ${(s.pass_rate * 100).toFixed(0)}% | ${fmt(s.mem_recall)} | ${fmt(s.context_recall)} | ${fmt(s.voice_under_60w)} |`
  );
}
lines.push("");
lines.push("## Raw sample files");
lines.push("");
for (const f of aggregate.sample_files) lines.push(`- \`benchmarks/results/${f}\``);
lines.push("");
lines.push("## Methodology");
lines.push("");
lines.push(
  "Each sample is one full run of `benchmarks/cross-engine-continuity.js`. The driver seeds engrams for a fixed agent_id, probes each reachable engine, runs three substrate-prefixed bench scopes (memory recall, working-context recall, voice ≤60w), and emits one JSON+MD per run. This aggregate is the JSON-side concat over those runs."
);
writeFileSync(mdOut, lines.join("\n"));

console.log("");
console.log(`[g1-n20] wrote aggregate:`);
console.log(`  ${jsonOut}`);
console.log(`  ${mdOut}`);
console.log("");
for (const [engine, s] of Object.entries(summary)) {
  const r = s.mem_recall;
  if (r.mean === null) continue;
  console.log(
    `  ${engine.padEnd(12)}  recall ${(r.mean * 100).toFixed(1)}% ± ${(r.std * 100).toFixed(1)}pp  pass-rate ${(s.pass_rate * 100).toFixed(0)}%`
  );
}
