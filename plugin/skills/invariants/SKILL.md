---
name: invariants
description: Manage STVC invariants. `list` shows registered, `remove <id>` deletes one. Read-only by default.
argument-hint: [list | remove <id>]
kind: deterministic
---

Operator manages the STVC invariant set:

> $ARGUMENTS

- `list` — print every registered invariant (id, severity, scope, predicate kind, description).
- `remove <id>` — delete the named invariant from `state_invariants`.

Seeded invariants (`seed:audience-required`, `seed:memory-class-enum`)
are universal safety floor; removing them disables core substrate
guarantees. /refuse-registered invariants are prefixed `refuse:` for
easy filtering.

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
