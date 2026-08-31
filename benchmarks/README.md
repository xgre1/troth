# troth Benchmarks

Real-world coding tasks for measuring scaffolding effectiveness.

## What `results/` is, and what it is not

Dated run logs. Each file records what was measured, on which build, on which
day, and several of them argue with themselves afterwards when a later run
showed the first reading was confounded. They are kept unedited on purpose:
the corrections are the point.

They are **not** current product claims and they are **not** a maintained
benchmark suite. A number in here describes the build it was run against on
the date in its filename. Runs from April and May predate most of what the
app does today. If you want a figure you can hold us to, run the harness
yourself against the current tree.

## Structure

```
benchmarks/
  seeds/        - Seed projects (with intentional bugs/missing features)
  tasks/        - Task definitions (JSON)
  results/      - Benchmark results (markdown comparison reports)
  README.md     - This file
```

## How to Run

1. Reset target directory:
   ```bash
   find "$BENCH_TARGET" -mindepth 1 -delete   # BENCH_TARGET: your own scratch dir "$BENCH_TARGET"/.git
   cp benchmarks/seeds/01-bugfix/* "$BENCH_TARGET"/
   cd "$BENCH_TARGET" && npm install express better-sqlite3 && git init && git add -A && git commit -m seed
   ```

2. Verify task fails as expected:
   ```bash
   cd "$BENCH_TARGET" && node test.js
   # Should show 5 passed, 4 failed
   ```

3. Run with modules ON (default):
   ```bash
   cd "$BENCH_TARGET" && troth -g -a
   # Then give the task prompt
   ```

4. Reset and run with modules OFF:
   ```bash
   curl -X POST http://localhost:8000/api/config -H "Content-Type: application/json" \
     -d '{"modules":{"injector":false,"cleaner":false,"verifier":false,"guardian":false,"pinning":false,"loopguard":false,"hotcache":false,"codelens":false,"compressor":false}}'
   cd "$BENCH_TARGET" && git checkout -- .
   # Run again
   ```

5. Compare metrics from proxy logs.

## Tasks

| ID | Difficulty | Description |
|---|---|---|
| 01-bugfix | Medium | Fix 4 bugs in Express + SQLite task API |

## Adding Tasks

Create `seeds/<id>/` with intentionally broken/incomplete code. Include `test.js` that defines success criteria.

## LongMemEval (conversational memory)

[`longmemeval-smoke.mjs`](longmemeval-smoke.mjs) measures the substrate's
long-term conversational memory on [LongMemEval-S](https://github.com/xiaowu0162/LongMemEval):
per question it ingests the whole haystack through the real write path in a
hermetic throwaway database, digests it question-blind (identity registry,
typed instances), answers through the real recall path, and grades with the
official per-type judge prompts at temperature 0. No benchmark-only shortcut
touches the measured road; the latest run log lives in
[`results/longmemeval-smoke-2026-08-31.md`](results/longmemeval-smoke-2026-08-31.md).

Needs three local servers you point it at: an embedding server, a judge, and
(for the local answer arm) a completion server — any llama.cpp-compatible
hosts work. The dataset downloads separately (see
[`datasets/README.md`](datasets/README.md)); the harness refuses to run
without the embedder rather than silently degrade to lexical-only retrieval.

```bash
# full digestion + local reader + local judge, stratified 100-question slice
TROTH_BENCH_FULL_SAUCE=1 \
TROTH_EMBED_HOST=http://127.0.0.1:11437 \
TROTH_LLAMACPP_HOST=http://127.0.0.1:1234 \
TROTH_JUDGE_HOST=http://127.0.0.1:1234 \
TROTH_BENCH_EXTRACT_CACHE="$HOME/.cache/troth-bench-extract" \
node benchmarks/longmemeval-smoke.mjs --stratified 100 --answer llamacpp --judge local
```

Useful flags: `--only id1,id2` reruns specific questions; `--n` and
`--offset` slice the set; `--answer claude --provider claude --model sonnet`
swaps in a cloud reader over the same memory (composition only — digestion,
retrieval and judging stay local); `--answer-timeout-ms` raises the compose
ceiling for slow local models. Digestion results are content-addressed in
`TROTH_BENCH_EXTRACT_CACHE`, so repeat runs only pay for extraction once.
