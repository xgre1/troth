---
name: troth-memory
description: Use this skill when starting any code task in a project that has a troth substrate. It mandates a query-first workflow — load prior verified work and unresolved page-handles before editing, instead of re-deriving from scratch.
---

# Query-first memory protocol

When a code task begins (or whenever you see a `<troth:page:UUID>` marker
in your context), follow this protocol BEFORE issuing any Edit / Write /
MultiEdit tool call.

## Step 1 — Discover prior verified work

Call `troth_query_actions` to see what was previously built and verified
in this project:

```
troth_query_actions({
  filter: { type: "edit", cwd: "<your current working directory>" },
  limit: 5,
  order: "desc"
})
```

Read the returned records. If any of them touch the file you're about to
edit, fetch the full content and respect the prior pattern:

```
troth_fetch_action({ id: "<uuid from query>" })
```

This is cheaper than re-reading the file plus deriving the edit shape
again from scratch. The substrate has the verified diff, the format
(hashline / str_replace / apply_patch), and the AST-validation result.

## Step 2 — Resolve any page-handles you can see

If your context contains `<troth:page:UUID>` markers — these are
substrate-evicted records — load them BEFORE proceeding:

```
troth_fault_in({ handle: "<troth:page:UUID>" })
```

A handle without a fault-in is wasted context: the marker takes ~40
tokens and gives you nothing actionable until you fault.

## Step 3 — Search for class-level patterns

If the task is a class of bug you might have seen before (null guard,
auth check, etc.), search the substrate's full-text index:

```
troth_search_actions({ query: "null check guard", limit: 5 })
```

Returns prior lessons + verified edits that matched the same pattern.

## Step 4 — Only then act

After steps 1–3, you have the project's verified context loaded into
your working memory. Now apply the user's request.

## Why this matters

- Re-deriving costs ~10× more tokens than fetching a verified record.
- Your context window is bounded; the substrate is not. Keep the window
  for the current task; pull history only when relevant.
- Prior verified edits are AST-checked and outcome-tracked. Trusting
  them is structurally safer than guessing.

## Anti-patterns to avoid

- Reading a file with the built-in Read tool when a `<troth:page:...>`
  marker for that exact record exists in your context. Use `fault_in`.
- Editing a file in a class you've seen 5× before without first calling
  `troth_query_actions`. The substrate already knows the pattern.
- Ignoring `troth_search_actions` because "I'll just figure it out".
  The lesson rows are how you avoid repeating mistakes.

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
