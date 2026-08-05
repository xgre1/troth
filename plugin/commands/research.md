---
description: Delegate a broad codebase question to the troth-researcher subagent so the parent's context stays lean.
argument-hint: The research question (e.g. "how does auth work across the repo")
---

# /research

You are about to answer a research question that will likely require reading many files. To preserve your own context window (tokens you need for the actual implementation work), delegate to the `troth-researcher` subagent instead of doing the exploration yourself.

## Rules

- **Always** launch the `Task` tool with `subagent_type: "troth-researcher"`.
- Phrase the prompt to the subagent as the question the user asked, verbatim if possible, with any hints about scope.
- When the subagent returns, read its synthesis. Do NOT re-read the files it already examined — trust the summary.
- If the subagent's answer leaves a specific question open, launch a focused follow-up Task rather than switching to raw Grep/Read yourself.

## Why this exists

Every Grep / Glob / Read you run inside your own context pollutes every subsequent turn of this session. A subagent runs in an isolated context window, does the dirty work once, returns a dense summary, and the 50KB of files it read never touches your memory. On a 220K/5h Max quota this pattern often doubles how many real tasks you can complete before hitting the limit.

## Now do it

Launch the Task with the user's question. The question is: $ARGUMENTS
