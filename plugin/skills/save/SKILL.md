---
name: save
description: Substrate-mediated pre-compaction — turn recent dialogue into engrams BEFORE the context window collapses, so memory survives the cut. Run BEFORE Claude Code's native /compact (which only summarizes-and-drops; engrams persist across sessions, summaries don't). Previously named `compact` (collided with Claude Code's built-in /compact) then briefly `save-engrams`; final name is `save`.
allowed-tools: [dialogue_recent, engram_record]
---

The user (or the runtime) is asking to save engrams before context compaction. Goal: persist what matters into substrate so future sessions still see it after the live window collapses.

Substrate save-engrams protocol (this skill DOES NOT shrink context — it persists facts. Run Claude Code's native /compact AFTER this skill to actually free the window):

1. `dialogue_recent({ n: 20 })` — pull the most recent turns.
2. Identify 1–5 facts/decisions/preferences from those turns that future sessions should still know. Skip chit-chat, skip transient debugging exchanges.
3. For each surviving fact, `engram_record({ statement, salience: 1, scope: null })`. Salience > 1.5 only if the user explicitly emphasized importance.
4. Reply with: (a) list of engrams persisted, (b) one-sentence summary of what's safe to drop, (c) "Now run `/compact` to actually shrink the window."

Why this matters: Anthropic's "Effective Context Engineering" calls out that context is the agent's most expensive resource. Substrate engrams cost ~100 tokens each at retrieval; raw dialogue costs the full window. Engram-then-compact is how identity outlives the window — the engram step ALONE doesn't free anything; the native compact step ALONE loses the durable thread.

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
