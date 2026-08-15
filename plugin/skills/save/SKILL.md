---
name: save
description: Substrate-mediated pre-compaction — turn recent dialogue into engrams and standing rules BEFORE the context window collapses, so memory survives the cut. Run BEFORE Claude Code's native /compact (which only summarizes-and-drops; engrams persist across sessions, summaries don't). Previously named `compact` (collided with Claude Code's built-in /compact) then briefly `save-engrams`; final name is `save`.
allowed-tools: [dialogue_recent, engram_record, rule_record, rule_list]
---

The user (or the runtime) is asking to save before context compaction. Goal: persist what matters into substrate so future sessions still see it after the live window collapses.

This skill DOES NOT shrink context — it persists. Run Claude Code's native `/compact` AFTER it to actually free the window.

## Two kinds of memory, written two ways

The window is about to drop everything. Two different things in it are worth keeping, and they are asked for differently later:

- **A fact, decision or state** — what is true, what was chosen, where something lives, what was measured. → `engram_record`
- **A standing rule the operator gave** — how they want work done, what they never want done again. → `rule_record`

Writing a rule as an engram buries it among facts; writing a fact as a rule pollutes the shelf the partner works under. Sort before writing.

## Protocol

1. `dialogue_recent({ n: 20 })` — pull the most recent turns.
2. `rule_list({})` — see the rules already held, so you neither restate nor contradict them.
3. Sort what happened into the two kinds above, then write each one.
4. Reply with: (a) what was persisted, by kind, (b) one sentence on what is safe to drop, (c) "Now run `/compact` to actually shrink the window."

## How many

**As many as pass the bar, and no more.** There is no target number. Three real findings are a good save; eight are a good save after a long working session; padding to reach a number is how the substrate fills with noise nobody will ever want back.

What passes the bar: something a future session would be wrong without. A measurement and what it killed. A decision and the reason. A rule the operator stated. Where something lives that was hard to find.

What does not: chit-chat, transient debugging, anything already in the code or git history, restatements of what is already held, "we discussed X" without saying what was concluded.

## Rules need more care than facts

A fact is either true or it is not. A rule changes how the partner works from now on, in sessions the operator will not be watching. So:

- **Be selective.** A rule is something worth following again next month, not an instruction for the task at hand. "Use tabs in this file" is not a rule. "Never fix a symptom before confirming the cause" is.
- **Carry the why.** Pass `why` with what happened that made it a rule. A rule with a reason survives being questioned; a bare imperative gets argued with and then ignored.
- **Ask when the wording is ambiguous.** If the operator said something that could be a standing rule or could be about this one task, ask which they meant. If two readings would produce different rules, ask. Guessing wrong installs a rule they never agreed to, and it will quietly steer work for months.
- **Scope it.** `scope: 'project'` when it only applies in this working directory; `global` otherwise. Default is global — most working rules are about how the operator wants to work, not about one repository.
- **On `similar_rules_exist`** the substrate is not refusing; it is showing you what it already holds. Read them. If one of them IS this rule, leave it alone or improve that one instead. If this is genuinely different, send it again with `confirm: true`. If you cannot tell, ask the operator.

## One conclusion about the work itself

Facts and rules are what was *said*. Every working session also has a shape:
where the operator had to correct the same thing twice, where you went the long
way round, what they had to insist on, what went smoothly and why. That shape
is invisible to both lists above and it is the part that makes the next session
better.

So, **once, at the end of the save**, write a single observation about how the
work actually went, with `engram_record` and `scope: 'working-relationship:YYYY-MM-DD'`.

- **One.** Not one per topic. If nothing about the collaboration was distinctive,
  write nothing — a session where the work simply proceeded has no lesson in it,
  and inventing one teaches the substrate to distrust this scope.
- **Name what happened, not how it felt.** "Corrected three times for proposing
  fixes before confirming the cause; the third correction was sharp" is usable.
  "The operator was frustrated" is not.
- **It is an observation, never a rule.** If the pattern suggests a standing rule,
  say so to the operator and let them decide — do not call `rule_record` on your
  own reading of their mood. A rule installed without agreement steers months of
  work they never signed off on.

Why this matters: Anthropic's "Effective Context Engineering" calls out that context is the agent's most expensive resource. Substrate engrams cost ~100 tokens each at retrieval; raw dialogue costs the full window. Engram-then-compact is how identity outlives the window — the engram step ALONE doesn't free anything; the native compact step ALONE loses the durable thread.

## Tool routing (both topologies)
The substrate tools this skill uses may be DIRECT in your tool list (names like
`troth_engram_record`, `troth_rule_record`, `troth_rule_list`,
`troth_dialogue_recent`) OR behind the troth-router gateway (app installs wire
only: troth-router, troth-bash, troth-cache, troth-hashline). If a named tool
is NOT in your tool list, do NOT conclude the substrate is down and do NOT fall
back to file-based memory. Route it through the router instead:
  1. `mcp_list({server: "troth-substrate"})` (or `"troth-memory"`) to see names.
  2. `mcp_call({server: "troth-substrate", tool: "<same troth_* name>", args: {...same args...}})`.
Substrate lives on server `troth-substrate` (engrams, rules, recall, dialogue,
slash); mind/actions on `troth-memory`. Same tools, same args, one hop through
mcp_call.
