---
name: help
description: List every available command with a one-line summary and argument hint. Diagnostic, no writes.
allowed-tools: []
kind: deterministic
---

User wants to see the full command surface: every slash command the daemon can
run right now, one per line, compact.

Deterministic protocol (no LLM, no substrate write beyond the command trace):

1. Enumerate ALL commands from the SAME source the app's command palette uses -
   the loaded SKILL.md set across every skills directory (bundled, user-global,
   user-claude, project), which already includes every deterministic handler
   because each ships a SKILL.md. Driving both surfaces off one enumeration is
   why the palette and /help can never drift: add a skill, both see it.
2. For each command print `/<name>`, its argument hint when the frontmatter
   declares one, an `[instant]` marker for deterministic (no-LLM) commands, and
   the first line of its description as a one-line summary.
3. Fail-safe: an unreadable skills directory yields a shorter list, never an
   error card.

Reply structure (compact, one command per line):

```
Available commands (N):
  /engine - Override which engine answers THIS conversation ...
  /goal <statement> [instant] - Pin a project goal ...
  /mcps [instant] - List the partner's external MCP servers ...
  ...
```

Read-only by design, exactly like /context and /mcps. Do NOT write anything
durable to substrate for this command.
