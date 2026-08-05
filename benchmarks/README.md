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
