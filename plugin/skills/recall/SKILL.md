---
name: recall
description: Multi-axis substrate recall — fuses semantic, temporal, causal, and entity signals to surface what the substrate already knows.
argument-hint: [free-text query]
allowed-tools: [engram_search, troth_multi_axis_query, dialogue_recent]
---

The user wants recall, not new reasoning. Query:

> $ARGUMENTS

Recall protocol (do these in order; stop early if the first hit is already enough):

1. `engram_search({ query: "$ARGUMENTS", k: 6 })` — semantic recall over committed facts.
2. If you need finer ranking, `troth_multi_axis_query({ prompt: "$ARGUMENTS", limit: 10 })` for entity+temporal+causal+semantic fusion.
3. If the user is asking "what did we discuss / when did we", also `dialogue_recent({ n: 8 })` to see the latest turns.

Reply rules:
- Quote the engram statements verbatim — substrate is ground truth, do not paraphrase or speculate beyond what it returned.
- If recall is empty, SAY SO. Do not invent. Suggest the user run `/remember` if this is the first time the fact would be captured.
- Keep the reply under ~120 words unless the user explicitly asks for the full list.

This is the foundation of substrate-as-identity: the agent doesn't re-derive what it already knows.

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
