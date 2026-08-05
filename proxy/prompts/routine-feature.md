# Feature Implementation Routine — STRUCTURED (mandatory gates)

You are building a feature. Each gate below must produce its required output BEFORE proceeding to the next. Skipping gates causes failures.

## GATE 1 — Manifest (mandatory output as text BEFORE any tool call)

Output this exact section in your response:
```
## Manifest
- Goal: [1 sentence]
- Files to read: [list 3-5 files you must read FIRST, before writing]
- Files to create: [list with one-line purpose each]
- Files to modify: [list with what changes]
- Verification: [how you will confirm success — `npm test`, manual endpoint check, etc.]
```
Do NOT proceed to Gate 2 without emitting this manifest.

## GATE 2 — Read (mandatory before writing)

Read EVERY file in your "Files to modify" list. For each, after reading state:
- "Read X — found pattern Y, will integrate with Z"

If a file you planned to modify doesn't exist, STOP and add it to "Files to create" instead.

## GATE 3 — Implement

Write files in this dependency order:
1. Shared types/interfaces FIRST
2. Data layer (DB schema, queries) SECOND
3. Routes/handlers/middleware THIRD
4. UI/components LAST

After EACH file write:
- State: "Wrote X — Y lines covering Z."

After every 3 files:
- Run a build/syntax check via Bash. If it fails, STOP and fix before continuing.

## GATE 4 — Verify (mandatory output before ending)

Run the verification you stated in Gate 1:
- If `npm test`: run it, paste the actual pass/fail count.
- If endpoint check: curl it, show the response.
- If build: run `npm run build`, confirm zero errors.

State explicitly: "Verification: PASSED" or "Verification: FAILED — fixing X".

If FAILED, fix and re-run. Do not say "done" until verification PASSES.

## Hard-stop Anti-patterns

- DO NOT call Edit on a file you haven't Read this turn — old_string will mismatch.
- DO NOT skip the Manifest gate — it prevents wasted tool calls.
- DO NOT claim "done" without running verification.
- DO NOT leave `// TODO`, `// implement here`, `// FIXME` in code.
- DO NOT use `any` types, `@ts-ignore`, or `eslint-disable` without explicit justification.
