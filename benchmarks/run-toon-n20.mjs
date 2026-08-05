#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// run-toon-n20.mjs — aggregate the LMDT (TOON wire-format cost reduction)
// benchmark over N runs.
//
// The current TOON measurement (~54% payload / ~45% token reduction) is from
// benchmarks/results/ (dated per run), a single 5-query run. That is not
// enough to publish a headline number: re-run at n>=20 with variance
// reported, so one counter-benchmark from a stranger cannot fairly
// overturn it.
//
// This script:
//   1. Spawns benchmarks/lmdt-runner.mjs as a child process N times (default 20).
//      Driver writes one JSON+MD per run into benchmarks/results/.
//   2. Aggregates the 4-arm metric series (Verbose JSON / Minified / TOON /
//      TOON+profile) across runs.
//   3. Writes benchmarks/results/toon-aggregate-n<N>-<timestamp>.{json,md}.
//   4. Reports per-arm mean ± stdev for: input_tokens, output_tokens, latency,
//      total_cost, recall@1.
//
// Run from the repo root:
//   node benchmarks/run-toon-n20.mjs --queries 8           # n=20 runs × 8 queries each
//   node benchmarks/run-toon-n20.mjs --n 30 --dry-run      # n=30 runs, encoder-only

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = join(__dirname, "..");
const RESULTS_DIR = join(__dirname, "results");
const DRIVER = join(REPO, "benchmarks/lmdt-runner.mjs");

const args = process.argv.slice(2);
const nFlag = args.indexOf("--n");
const N = nFlag >= 0 ? Math.max(2, parseInt(args[nFlag + 1] ?? "20", 10)) : 20;
const driverArgs = args.filter((a, i) => a !== "--n" && args[i - 1] !== "--n");

console.log(`[toon-n20] running ${N} LMDT samples with args: ${driverArgs.join(" ") || "(defaults)"}`);

function runOnce() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DRIVER, ...driverArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TROTH_REPO: REPO },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`lmdt exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

function latestLmdtJson(after) {
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith("lmdt-") && f.endsWith(".json"))
    .map((f) => {
      const stamp = Date.parse(
        f.replace("lmdt-", "").replace(".json", "").replace(/-/g, ":").slice(0, 19) + "Z"
      );
      return { f, t: Number.isNaN(stamp) ? 0 : stamp };
    })
    .filter((x) => x.t >= after)
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}

const samples = [];
let failures = 0;
const t0 = Date.now() - 1000;

for (let i = 1; i <= N; i++) {
  process.stdout.write(`[toon-n20] sample ${i}/${N} … `);
  const tStart = Date.now();
  try {
    await runOnce();
    const fname = latestLmdtJson(tStart - 1000);
    if (!fname) {
      console.log("no result file (skip)");
      failures++;
      continue;
    }
    samples.push({ index: i, file: fname, ...JSON.parse(readFileSync(join(RESULTS_DIR, fname), "utf8")) });
    console.log(`ok (${fname})`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    failures++;
  }
}

if (samples.length === 0) {
  console.error("[toon-n20] no successful samples — aborting aggregate");
  process.exit(2);
}

// ─── Aggregate per arm (A=verbose JSON, B=minified, C=TOON, D=TOON+profile)
const perArm = { A: {}, B: {}, C: {}, D: {} };

function pushMetric(arm, key, value) {
  if (typeof value !== "number" || Number.isNaN(value)) return;
  (perArm[arm][key] ??= []).push(value);
}

for (const s of samples) {
  const results = s.results ?? s.arms ?? {};
  for (const arm of ["A", "B", "C", "D"]) {
    const armData = results[arm];
    if (!armData) continue;
    pushMetric(arm, "payload_bytes", armData.payload_bytes ?? s.payload_sizes?.[arm]);
    pushMetric(arm, "input_tokens", armData.input_tokens);
    pushMetric(arm, "output_tokens", armData.output_tokens);
    pushMetric(arm, "latency_ms", armData.latency_ms);
    pushMetric(arm, "total_cost_usd", armData.total_cost_usd ?? armData.cost_usd);
    pushMetric(arm, "recall_at_1", armData.recall_at_1 ?? armData.recall ?? armData.recall_pct);
  }
}

function summ(xs) {
  if (!xs || xs.length === 0) return { mean: null, std: null, n: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return { mean: m, std: Math.sqrt(v), n: xs.length };
}

const summary = {};
for (const arm of ["A", "B", "C", "D"]) {
  summary[arm] = {
    payload_bytes: summ(perArm[arm].payload_bytes),
    input_tokens: summ(perArm[arm].input_tokens),
    output_tokens: summ(perArm[arm].output_tokens),
    latency_ms: summ(perArm[arm].latency_ms),
    total_cost_usd: summ(perArm[arm].total_cost_usd),
    recall_at_1: summ(perArm[arm].recall_at_1),
  };
}

function reduction(armRef, armNew, metric) {
  const r = summary[armRef]?.[metric]?.mean;
  const n = summary[armNew]?.[metric]?.mean;
  if (r == null || n == null || r === 0) return null;
  return (r - n) / r; // positive = reduction
}

const headline = {
  toon_payload_reduction_vs_verbose: reduction("A", "C", "payload_bytes"),
  toon_input_token_reduction_vs_verbose: reduction("A", "C", "input_tokens"),
  toon_profile_payload_reduction_vs_verbose: reduction("A", "D", "payload_bytes"),
  toon_profile_input_token_reduction_vs_verbose: reduction("A", "D", "input_tokens"),
  toon_profile_cost_reduction_vs_verbose: reduction("A", "D", "total_cost_usd"),
  recall_delta_arm_D_vs_A: (() => {
    const a = summary.A?.recall_at_1?.mean;
    const d = summary.D?.recall_at_1?.mean;
    return a == null || d == null ? null : d - a;
  })(),
};

const aggregate = {
  benchmark: "LMDT / TOON wire-format cost reduction",
  n: samples.length,
  attempted: N,
  failures,
  arms: {
    A: "Verbose JSON (baseline)",
    B: "Minified JSON",
    C: "TOON (P17 Tier 1)",
    D: "TOON + active wire-format profile (P17 Tier 3)",
  },
  acceptance_thresholds: {
    note: "Falsifier: arm D ≥40% token cost reduction vs A AND recall@1 within ±2pp.",
    cost_reduction_min: 0.4,
    recall_delta_within_pp: 0.02,
  },
  headline,
  summary,
  sample_files: samples.map((s) => s.file),
  generated_at: new Date().toISOString(),
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(
  join(RESULTS_DIR, `toon-aggregate-n${samples.length}-${stamp}.json`),
  JSON.stringify(aggregate, null, 2)
);

// ─── Markdown report ──────────────────────────────────────────────────────
const md = [];
md.push(`# LMDT/TOON wire-format aggregate — n=${samples.length}`);
md.push("");
md.push(`Generated: ${aggregate.generated_at}`);
md.push(`Attempted samples: ${N}; successful: ${samples.length}; failed: ${failures}.`);
md.push("");
md.push("## Arms");
md.push("");
for (const [k, v] of Object.entries(aggregate.arms)) md.push(`- **${k}** — ${v}`);
md.push("");
md.push("## Headline reductions (mean across runs)");
md.push("");
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const pp = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}pp`);
md.push(`- TOON payload vs verbose JSON: **${pct(headline.toon_payload_reduction_vs_verbose)}** reduction`);
md.push(`- TOON+profile payload vs verbose: **${pct(headline.toon_profile_payload_reduction_vs_verbose)}** reduction`);
md.push(`- TOON+profile input tokens vs verbose: **${pct(headline.toon_profile_input_token_reduction_vs_verbose)}** reduction`);
md.push(`- TOON+profile cost vs verbose: **${pct(headline.toon_profile_cost_reduction_vs_verbose)}** reduction`);
md.push(`- recall@1 delta (D − A): **${pp(headline.recall_delta_arm_D_vs_A)}**`);
md.push("");
md.push("## Per-arm summary (mean ± std)");
md.push("");
md.push("| Arm | Payload bytes | Input tokens | Output tokens | Latency ms | Cost $ | Recall@1 |");
md.push("|---|---|---|---|---|---|---|");
const fmt = (s) =>
  s.mean == null
    ? "—"
    : `${s.mean.toFixed(s.mean < 10 ? 4 : 0)} ± ${s.std.toFixed(s.std < 10 ? 4 : 0)} (n=${s.n})`;
for (const arm of ["A", "B", "C", "D"]) {
  const s = summary[arm];
  md.push(
    `| ${arm} | ${fmt(s.payload_bytes)} | ${fmt(s.input_tokens)} | ${fmt(s.output_tokens)} | ${fmt(s.latency_ms)} | ${fmt(s.total_cost_usd)} | ${fmt(s.recall_at_1)} |`
  );
}
md.push("");
md.push("## Sample files");
md.push("");
for (const f of aggregate.sample_files) md.push(`- \`benchmarks/results/${f}\``);
md.push("");
md.push("## Methodology");
md.push("");
md.push(
  "Each sample is one full run of `benchmarks/lmdt-runner.mjs` against the soak-test substrate. The driver encodes the same N retrieval records under 4 wire-format arms (Verbose JSON / Minified / TOON / TOON+profile), issues the same retrieval queries against a frontier model, and emits a JSON result per run. This aggregate is the JSON-side concat with per-metric mean ± std over the N runs."
);
md.push("");
md.push("Replicate locally:");
md.push("```bash");
md.push("export ANTHROPIC_API_KEY=sk-ant-...");
md.push("node benchmarks/run-toon-n20.mjs --n 20 --queries 8");
md.push("```");

writeFileSync(
  join(RESULTS_DIR, `toon-aggregate-n${samples.length}-${stamp}.md`),
  md.join("\n")
);

console.log("");
console.log("[toon-n20] aggregate written:");
console.log(`  results/toon-aggregate-n${samples.length}-${stamp}.json`);
console.log(`  results/toon-aggregate-n${samples.length}-${stamp}.md`);
console.log("");
console.log(`  TOON+profile payload reduction vs verbose: ${pct(headline.toon_profile_payload_reduction_vs_verbose)}`);
console.log(`  TOON+profile cost reduction vs verbose:    ${pct(headline.toon_profile_cost_reduction_vs_verbose)}`);
console.log(`  recall@1 delta D−A:                        ${pp(headline.recall_delta_arm_D_vs_A)}`);
