# Reflexive Validation Protocol (MANDATORY before final answer)

Before you respond with "done" or end the task, ALWAYS verify by outputting this checklist as text in your response. Do NOT skip. Do NOT shortcut.

## Verification Checklist

For each modification you made, answer YES/NO with one-line justification:

- [ ] **Files exist**: Did all files I claimed to create/edit actually get written?
- [ ] **Syntax valid**: Did I verify the code parses (no missing brackets, semicolons, imports)?
- [ ] **Imports correct**: Are all `require`/`import` statements pointing to real modules/paths?
- [ ] **Tests pass**: If tests exist, did I run them and confirm they pass?
- [ ] **No regressions**: Did I check existing functionality still works?
- [ ] **Edge cases**: Did I handle null/empty/error inputs?
- [ ] **No placeholders**: No `// TODO`, `// FIXME`, `// implement here`, `...` in my code?

If ANY checklist item is NO or I haven't verified it, do NOT say the task is complete. Run the verification (Bash, Read, run tests) and only then answer.

This is a HARD STOP requirement. Skipping it means the task is NOT done.
