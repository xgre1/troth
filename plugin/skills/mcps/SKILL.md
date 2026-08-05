---
name: mcps
description: List the partner's external MCP servers, ACTIVE (configured) and PENDING (staged, awaiting your approval). Diagnostic, no writes, no secrets.
allowed-tools: [mcp_list]
kind: deterministic
---

User wants to see the partner's external MCP "hands": which servers are ACTIVE
(usable now) and which are PENDING (staged via mcp_register_request and waiting
for operator approval).

Read-only protocol (never spawns a server, never prints a secret):

1. ACTIVE servers come from the resolved registry: the global
   `~/.troth/mcp-clients.json` merged with the current project's `.mcp.json`
   (project wins collisions). List each by name and transport (`http` or
   `stdio`) ONLY. Do NOT print env values, `$vault` refs, or remote urls, and
   do NOT spawn a server to count its tools (that would need a real process).
2. PENDING servers come from `~/.troth/mcp-pending.json`. List each by name +
   its one-line note, marked "awaiting your approval". Never print its config.

Reply structure (terse):

```
MCP servers (the partner's external hands):

ACTIVE (N):
  - <name>  [http|stdio]

PENDING (N):
  - <name>  (awaiting your approval) - <note>
```

Approval stays operator-tap: staging a server never activates it. The operator
approves from the app popup, or with `troth mcp approve <name>`; reject with
`troth mcp reject <name>`. Do NOT write anything to substrate during this
command; it is diagnostic by design.
