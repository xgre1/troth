---
name: forget
description: Soft-delete substrate engrams matching a pattern by recording a tombstone. Originals stay for audit; retrieval excludes them.
argument-hint: [pattern or statement to forget]
allowed-tools: [engram_search, engram_record]
kind: deterministic
---

User wants the substrate to stop surfacing certain memories:

> $ARGUMENTS

Forget protocol (NEVER do a hard delete):

1. `engram_search({ query: "$ARGUMENTS", k: 5 })` — locate candidates.
2. Show the user the top 3 matches and ask them to confirm WHICH to tombstone unless their statement is unambiguous (e.g., "forget my old email address" with one obvious match).
3. For each confirmed engram, retire it by writing a SUPERSEDER, not a
   free-standing marker. The blessed path is `reconsolidate()` (it inherits the
   prior's audience/class/scope so the superseder lands in the same recall pool
   where the pointer is seen). It writes a successor with:
   - `statement` = `"FORGOTTEN: <original statement>"` (carries the original
     terms so an FTS recall co-retrieves it — that is how the pointer registers)
   - `tier` = `"flagged"` (the successor never surfaces in any default read)
   - `lifetime.supersedes` = `<original_id>`
4. Reply with the forgotten statements and the engram_ids for audit.

Why a superseder (not a `system:tombstone` marker): retirement in this
substrate is a supersession pointer. `listEngrams` AND `recall.recall` both
hide any engram referenced by a `lifetime.supersedes` pointer, and both
suppress `tier:"flagged"` rows — so the superseder retires the original AND
does not surface itself (the "FORGOTTEN: …" text is only visible in an explicit
`include_flagged` audit view, which is the point of a recoverable soft-delete).
A bare `scope:"system:tombstone"` engram is NOT filtered by anything (older
versions of this skill wrongly claimed it was), so the original kept surfacing.
Soft, not hard: the original row stays for audit/recovery; retrieval just stops
returning it.

Signed operator facts (`source_authority:"operator_confirmed"`) are the
crypto-anchored floor — `/forget` can not retire them (the tier-gate rejects
the pointer); that needs a signed operation. The built-in deterministic
`/forget` handler already does all of the above; these steps are the manual
fallback.

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
