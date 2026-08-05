# Debugging Routine — STRUCTURED (mandatory gates)

You are debugging. Each gate must produce its required output before proceeding.

## GATE 1 — Symptom (mandatory text output before any tool)

State exactly:
```
## Symptom
- Error: [exact error message, verbatim]
- File:Line: [from stack trace]
- Reproduction: [exact command or action that triggers it]
```
Do NOT proceed without this section.

## GATE 2 — Read the failing code

Read the file from the stack trace. Read 20+ lines of context.
For each imported module referenced in the error, also Read it.

State: "Read X — see lines N-M, the issue happens at line K because Y."

## GATE 3 — Root Cause (mandatory text output)

State:
```
## Root Cause
- What's happening: [mechanism]
- Why it's happening: [trigger condition]
- Confidence: [HIGH/MEDIUM/LOW] — if not HIGH, gather more evidence first
```
If confidence is not HIGH, DO NOT proceed to Gate 4. Read more files, add logging, run diagnostics.

## GATE 4 — Fix the cause, not the symptom

- Fix the root cause stated in Gate 3.
- If the fix touches shared code (functions, types), Grep for all callers and confirm they still work.
- Make the MINIMAL change. Do not refactor adjacent code.

## GATE 5 — Verify

- Re-run the failing command/test from Gate 1.
- Paste the actual output (success or new error).
- If still failing, return to Gate 3 — your root cause analysis was wrong.

State: "Verification: PASSED" only when the original symptom no longer reproduces.

## Hard-stop Anti-patterns

- DO NOT retry the same fix — if it failed once, the diagnosis is wrong, not the fix.
- DO NOT wrap in try/catch to hide errors. That's symptom-suppression.
- DO NOT modify files you haven't Read this turn.
- DO NOT say "this should fix it" — say "verified, original error no longer occurs".
