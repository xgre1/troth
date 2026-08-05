# troth-router — MCP Tool Deferral

**Problem**: Every MCP server registers its full tool schema into Claude Code's locked system-prefix. An enterprise stack (Playwright + Supabase + GitHub + …) easily puts **30-50K tokens** into that prefix, silently shrinking your effective context on every turn.

**Solution**: Replace N heavy MCP servers with one lightweight router that exposes **3 compact tools**:

- `mcp_list(server)` — lists tools on a downstream server (names + 120-char descriptions)
- `mcp_describe(server, tool)` — returns full schema for a specific tool
- `mcp_call(server, tool, args)` — invokes a tool on a downstream server

Downstream servers are spawned **lazily** on first use and kept warm.

## Setup

1. Identify your heavy MCPs:

```bash
troth mcp-audit
```

2. Move heavy servers from `~/.claude/settings.json` → `~/.troth/router.json`:

```json
{
  "mcpServers": {
    "analytics-mcp": {
      "command": "/Users/you/.local/bin/analytics-mcp",
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "..." }
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

3. Remove them from `~/.claude/settings.json`. Keep light ones (like `context7`) there.

4. Install this plugin — it registers `troth-router` automatically via `plugin/.mcp.json`.

5. Your agent calls heavy tools through the router:

```
mcp_list("analytics-mcp")              # discover tools
mcp_call("analytics-mcp", "query", {}) # invoke
```

## Trade-off

- **Saves**: schema bytes in every prefix (~9K/turn per heavy server swapped).
- **Costs**: one extra turn of `mcp_list` when the agent first needs a server.
- **Net**: positive for MCPs used rarely, marginal for MCPs used on every turn.

Run `troth mcp-audit --timeout=15000` to re-measure after switching.
