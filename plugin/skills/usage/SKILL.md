---
name: usage
description: Show token, request, and cost stats from the troth proxy for the current period.
allowed-tools: ["Bash"]
kind: deterministic
---

User wants a usage / cost snapshot. We DO NOT have a substrate tool for proxy stats — they live on the local proxy at http://localhost:8000/api/stats.

Action:

1. Use the `Bash` tool to call: `curl -s http://localhost:8000/api/stats` (if your policy denies Bash, run the curl yourself and paste the output)
2. If the proxy is offline (curl fails), say so plainly — do not invent numbers.
3. If the proxy returned data, surface (in ≤120 words):
   - Total requests this session
   - Tokens in / out (sum across providers)
   - Cost estimate $
   - Top provider by token volume
4. End with one line on whether usage is on track for the user's stated budget if you can recall it via `engram_search({ query: "monthly budget cost target" })`.

This is a pure read-side surface. No engram writes.

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
