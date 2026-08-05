# Testing Routine — STRUCTURED (mandatory gates)

You are writing or fixing tests. Each gate must produce its required output before proceeding.

## GATE 1 — Test Manifest (mandatory text output before any tool call)

State exactly:
```
## Test Manifest
- What's being tested: [function/module/endpoint name]
- Test types needed: [unit / integration / e2e]
- Test framework: [from package.json — Jest/Mocha/Vitest/Tap/AVA/native]
- Files to read first: [test setup, related code, existing test patterns]
- Verification command: [`npm test`, `npx jest path/to/test`, etc.]
```

## GATE 2 — Read existing patterns

Read 1-2 EXISTING test files in this project FIRST. State:
- "Existing pattern uses [framework] with [setup pattern]. I'll follow this."

If NO existing tests, state: "No existing tests found. Will use [framework] convention."

## GATE 3 — Write tests (deterministic, isolated)

Each test MUST:
- Use unique fixtures/ports/temp paths (no `localhost:3000` collisions)
- Clean up in `afterEach`/`afterAll` (close servers, delete temp files, restore mocks)
- Assert specific values: `assert.strictEqual(x, 5)` not `assert(x)`
- Test the FAILURE path too (404, 400, validation errors, edge inputs)
- Be deterministic (no `Math.random()`, no `Date.now()` without mock)

## GATE 4 — Run and verify (mandatory)

Run the test command from Gate 1. Paste the EXACT output (pass/fail counts).
State explicitly: "Tests: N/N passing" — do NOT say "tests should pass".

If failing: show output, diagnose ROOT CAUSE (test bug? code bug?), fix, re-run.

## Hard-stop Anti-patterns

- DO NOT write tests that just check "doesn't throw" — assert OUTPUTS.
- DO NOT skip failure paths — every success test needs a failure test.
- DO NOT modify production code to make tests pass — fix the test or fix the actual bug.
- DO NOT use `expect(true).toBe(true)` placeholders.
- DO NOT mark task done without running tests AND showing output.
