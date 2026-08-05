---
name: dialogue-reset
description: Reset ONLY the substrate live dialogue turn buffer (NOT Claude Code's /clear). Identity, anchors, goals, engrams are preserved. Use /clear for the context window.
allowed-tools: []
kind: deterministic
---

User wants to clear the live dialogue. Critical distinction from Claude's /clear:

> Our /clear resets ONLY the current session's transient turn buffer. Substrate identity — anchors, refusals, goals, engrams, dialogue history persisted to L1 — all survives. The next turn will load the identity envelope as usual; only this session's in-memory continuation is dropped.

Action:

1. Acknowledge in ≤1 sentence: "Cleared. Identity preserved. (N engrams, M goals still loaded.)"
2. Fetch those counts so the reply is concrete:
   - `engram_search({ query: "goal", scope: "goal", k: 1 })` → if results.length > 0, you have at least 1 goal (count via engram_search with larger k if useful).
3. Do NOT call any tool that mutates substrate. /clear is non-destructive.

The runtime — not this skill — performs the actual session reset; this skill is just the user-facing confirmation.

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
