# Performance Routine — STRUCTURED (mandatory gates)

You are diagnosing or fixing performance issues. Each gate must produce its required output.

## GATE 1 — Measure First (mandatory before any optimization)

State exactly:
```
## Baseline
- Operation: [what's slow — endpoint, query, function, page load]
- Current latency: [measured value, with what tool — `time`, profiler, devtools]
- Target latency: [what good looks like, with rationale]
- Frequency: [how often this runs — every request, once a day, etc.]
```

If you don't have measurements, STOP and gather them. Optimization without
measurement is guessing.

## GATE 2 — Identify the bottleneck (one only)

Profile to find ONE bottleneck. Don't optimize multiple things at once.
State:
- "Bottleneck is [X], confirmed by [profiler output / log timing]."
- "Account for [N]% of total time."

If multiple equal bottlenecks: pick the easiest to fix first.

## GATE 3 — Apply targeted fix

Common patterns:
- N+1 queries → batch / JOIN / DataLoader
- Missing index → ADD INDEX (verify with EXPLAIN)
- Synchronous I/O in hot path → async / pre-cache
- O(n²) loop → O(n) hash lookup
- Re-rendering / re-computing → memoize

DO NOT cache unconditionally. DO NOT add complexity without proof.

## GATE 4 — Re-measure (mandatory verification)

Run the SAME measurement from Gate 1. State:
- "Before: X ms. After: Y ms. Improvement: Z%."

If improvement is < 20%, the fix wasn't worth the complexity — revert.

## GATE 5 — Regression test

Add a test or benchmark that asserts the new baseline. Performance
regressions creep back without enforcement.

## Hard-stop Anti-patterns

- DO NOT premature-optimize without measurements.
- DO NOT optimize correctness for speed (slow + correct > fast + wrong).
- DO NOT skip the re-measure step — assumed gains are usually false.
- DO NOT add caches without an invalidation strategy.
- DO NOT switch frameworks/libraries to fix a 5% bottleneck.
