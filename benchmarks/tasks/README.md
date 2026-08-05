# troth Benchmark Task Suite

Reproducible tasks for measuring the plugin's real-world impact on Claude Code sessions. Every task is:

- **Deterministic in setup** — you run `bash setup.sh`, starting state is identical across runs.
- **Clear success criteria** — `verify.sh` returns 0 if the task was completed correctly, non-zero otherwise.
- **Realistic workload** — real bugs, real features, real refactors. No synthetic toy problems.
- **Reproducible by anyone** — any dev with Max + Claude Code can run the same benchmark and compare numbers with us.

## How to run one task

```bash
# 0. Ensure plugin state is clean
plugin-bench.mjs profile full             # or: off, for baseline

# 1. Setup the task scratch dir
cd benchmarks/tasks/01-fix-null-guard
bash setup.sh                             # copies /sample/ into /tmp/troth-bench-<task>/

# 2. Mark the benchmark window
plugin-bench.mjs start --label=01-full

# 3. Open Claude Code in the task dir and issue the prompt from prompt.md
cd /tmp/troth-bench-01-fix-null-guard
claude                                     # → paste prompt.md verbatim, let it run

# 4. When the agent indicates done:
plugin-bench.mjs report --label=01-full

# 5. Verify task actually succeeded
bash /path/to/benchmarks/tasks/01-fix-null-guard/verify.sh /tmp/troth-bench-01-fix-null-guard
#    exit 0 = passed, anything else = failed (don't count this run)

# 6. Repeat steps 1-5 with --label=01-off (plugin profile off) for A/B
# 7. Compare:
plugin-bench.mjs compare 01-off 01-full
```

## Task suite

| # | Task | Difficulty | Expected turns (plain CC) | Tests |
|---|------|:---:|:---:|:---:|
| 01 | Fix a null-guard bug in a hot loop | easy | 3-5 | unit test |
| 02 | Add CSV export to an existing Express API | medium | 8-15 | integration test |
| 03 | Refactor 3 duplicated auth middlewares into one (planned, no task file yet) | medium | 10-20 | existing tests must still pass |
| 04 | Implement JWT auth from scratch + test coverage (planned, no task file yet) | hard | 20-40 | full test suite |
| 05 | Debug a race condition in a message queue consumer (planned, no task file yet) | hard | 15-30 | repro test passes |

Expected-turn numbers are calibrated for Claude Code 2.x on Opus 4.7 without any plugin. Deviations from this range are the headline measurement.

## Metrics we capture per run

- **Wall-clock duration** (from plugin-bench start → report)
- **Turn count** (from transcript)
- **Tokens per turn** (sum of ledger + archive compression / turn count)
- **Max quota consumed** (`/context` snapshot at end)
- **Task passed** (verify.sh exit code)
- **Hook activations by event** (troth/plugin-bench report)
- **Savings breakdown** (editmatch rescues / loopbreaker denials / bash compression / …)

## Aggregation protocol for publication

Every task is run **3 times** in each profile (plain CC, plugin full, plugin full+proxy+tier). Medians go in the table; ranges go in the appendix. Runs where verify.sh fails are reported separately (completion rate) and excluded from token/time stats.

This is the suite behind any headline numbers we publish.
