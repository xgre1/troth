---
name: think
description: Emit a structured reasoning trace and persist it to substrate as a causal record for future /recall to walk.
argument-hint: [topic to reason about]
allowed-tools: [engram_record, engram_search, decision_record]
auto-persist: {"scope":"reasoning","salience":1}
---

User wants you to think out loud about:

> $ARGUMENTS

Reasoning protocol:

1. First, `engram_search({ query: "$ARGUMENTS", k: 4 })` to load what substrate already believes on this topic. Do not duplicate prior reasoning.
2. Reason in 3–5 bullet points: known facts → hypotheses → implication → recommended next action. Cite engram statements verbatim where they ground the reasoning.
3. Persist what the reasoning produced — two roads, pick by what it IS:
   - **It produced a reusable strategy** (a way to approach this class of
     problem again): `decision_record({ strategy, trigger, steps, contrast?,
     example?, provenance: { model: "<your model id>", verdict: "unverified" } })`.
     The trigger line is the retrieval key — write the SITUATION SHAPE it
     applies to, not the topic name. Include the contrast (mistake → why →
     correct) whenever the reasoning rejected a tempting wrong road — it is
     the highest-value field. Set verdict above `unverified` ONLY for what
     was actually verified: `test_passed` needs a test that ran, `operator_confirmed`
     needs the operator's word.
   - **It is a conclusion but not a strategy** (a fact, an assessment):
     `engram_record({ statement: "<one-sentence synthesis>", salience: 1, scope: "reasoning" })`.
4. Reply with the trace + the record id so the user can audit.

This is the canonical entry point for substrate-as-reasoning-history. The /think → engram → /recall → /think chain is what lets troth improve across sessions without re-thinking from scratch.

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
