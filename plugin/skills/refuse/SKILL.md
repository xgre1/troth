---
name: refuse
description: Register a hard refusal as an STVC invariant. Any future tool_call whose args contain the refused phrase will be rejected pre-LLM. Substrate-stored — survives every session, every surface.
argument-hint: [phrase to refuse, e.g. "drop table" or "production db write"]
kind: deterministic
---

User wants to ban a class of action permanently:

> $ARGUMENTS

Writes a state_invariants row with predicate kind `tool_args_substring`,
severity `error`, phrase = `$ARGUMENTS`. The STVC validation gate in
`recordAction()` rejects every subsequent tool_call whose args contain
that phrase (case-insensitive substring). No LLM involvement — the
substrate enforces it structurally.

To list active refusals: `/invariants list`. To remove: `/invariants remove <id>`.

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
