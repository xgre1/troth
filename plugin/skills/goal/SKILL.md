---
name: goal
description: Pin a project goal as a high-salience substrate engram so it shapes every future turn's identity envelope.
argument-hint: [goal statement]
allowed-tools: [engram_record, engram_search]
kind: deterministic
---

The user is declaring an active goal for this project. Statement:

> $ARGUMENTS

Substrate action you MUST take:

1. Call `engram_record` with:
   - `statement` = `$ARGUMENTS`
   - `salience` = `2` (max — goals are identity anchors)
   - `scope` = `"goal"`
2. Confirm in ≤2 sentences that the goal is now persisted, and how it will bias upcoming work.

Why this matters: scope=`"goal"` engrams are surfaced into the identity envelope on every subsequent turn, including across new sessions and the voice app. The goal is now part of who the agent is, not just a note for this conversation.

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
