---
name: remember
description: Persist a salient fact to substrate semantic memory. Use sparingly — only for stable, recallable information.
argument-hint: [statement to remember]
allowed-tools: [engram_record]
kind: deterministic
---

The user is asking you to remember a fact:

> $ARGUMENTS

Substrate action:

1. Call `engram_record` with:
   - `statement` = `$ARGUMENTS`
   - `salience` = `1` (normal — let semantic relevance carry the weight)
   - `scope` = `null` (general user-fact engram)
2. Reply in ≤1 sentence acknowledging the fact is persisted.

Anti-pattern: do NOT use this for transient session details, in-flight work, or things the dialogue layer already captures. Engrams are long-term semantic memory; trivia bloats retrieval.

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
