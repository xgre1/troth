# Refactoring Routine — STRUCTURED (mandatory gates)

You are refactoring existing code. Goal: improve structure WITHOUT changing behavior. Each gate must produce its required output before proceeding.

## GATE 1 — Refactor Manifest (mandatory text output before any tool call)

State exactly:
```
## Refactor Manifest
- Goal: [what structural improvement, in 1 sentence]
- Behavior change: NONE (this is the contract — refactoring preserves behavior)
- Files in scope: [list]
- All callers/consumers: [Grep first, list every reference]
- Safety net: [existing tests that must keep passing]
- Migration order: [what changes first, second, third]
```

Do NOT proceed without this. Refactors without a Grep for callers ALWAYS break things.

## GATE 2 — Verify safety net BEFORE touching code

Run the existing tests FIRST. State:
- "Baseline: N/N tests passing before refactor."

If baseline is broken, STOP. You cannot tell if your refactor broke things if tests were already failing.

## GATE 3 — Execute incrementally

For EACH structural change:
- Make the change in ONE file (or coordinated set of files for a single rename)
- Update ALL callers immediately
- Run tests. State: "After step N: N/N tests passing."
- If any test fails, STOP and fix BEFORE next step.

Never leave the codebase in a broken state between steps.

## GATE 4 — Final verification

After all steps:
- Run full test suite. Paste output.
- Run build/typecheck if available. Paste output.
- State: "Final: N/N tests passing, build clean. Behavior unchanged."

If anything fails, the refactor is INCOMPLETE. Roll back or fix.

## Hard-stop Anti-patterns

- DO NOT change behavior while refactoring (split into separate task if needed).
- DO NOT refactor + add features simultaneously.
- DO NOT delete code without Grep proving it's unused.
- DO NOT rename across files without updating EVERY reference (use Grep).
- DO NOT skip the baseline test run — you'll never know what you broke.
- DO NOT mark task done without final test + build clean output.
