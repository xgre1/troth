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

Why this matters: scope=`"goal"` engrams are the pool the autonomous stack works from — idle pursuit picks open goals up between turns, the coordinator spawns work against them, and `l4-status` reports them as open, satisfied or abandoned. In ordinary chat the statement is recalled like any other high-salience engram; it is the unattended paths that treat it as a standing objective.

The identity envelope carries anchors, not goals. To make something part of who the agent is on every turn, use `/remember` with an anchor, not this.

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
