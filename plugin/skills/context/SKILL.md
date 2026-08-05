---
name: context
description: Snapshot the current substrate identity — active goals, recent engrams, dialogue depth. Diagnostic, no writes.
allowed-tools: [engram_search, dialogue_recent]
kind: deterministic
---

User wants a snapshot of the substrate's current state for this agent_id + cwd.

Diagnostic protocol (read-only):

1. `engram_search({ query: "goal", scope: "goal", k: 5 })` — active goals.
2. `engram_search({ query: "", k: 8 })` — most recent / highest-relevance engrams overall.
3. `dialogue_recent({ n: 4 })` — last 4 turns to anchor the snapshot to the live session.

Reply structure (terse, ≤200 words):

```
GOALS:
  - <statement>  (salience=…)

RECENT ENGRAMS:
  - <statement>  (scope=…, ts=…)

LAST TURNS:
  user: <…>
  faculty: <…>
```

Do NOT write anything to substrate during this command — it's diagnostic by design.

## Tool routing (both topologies)
The substrate tools this skill uses may be DIRECT in your tool list (names like
`troth_engram_record`, `troth_recall`, `troth_dialogue_recent`) OR behind the
troth-router gateway (app installs wire only: troth-router, troth-bash,
troth-cache, troth-hashline). If a named tool is NOT in your tool list, do NOT
conclude the substrate is down and do NOT fall back to file-based memory.
Route it through the router instead:
  1. `mcp_list({server: "troth-substrate"})` (or `"troth-memory"`) to see names.
  2. `mcp_call({server: "troth-substrate", tool: "<same troth_* name>", args: {...same args...}})`.
Substrate lives on server `troth-substrate` (engrams, recall, dialogue, slash);
mind/actions on `troth-memory`. Same tools, same args, one hop through mcp_call.
