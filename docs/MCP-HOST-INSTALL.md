# Substrate MCP — install in any host

> The substrate is the mind. The host's LLM is just one of the language
> faculties it can speak through. Wire troth into any MCP-aware host
> (Claude Code, Cursor, Continue, Zed, custom) and that host gains access
> to the same engrams, dialogue history, commitments, chameleon corpora,
> and dispatch surface as every other host.
>
> Single L1 SQLite file (`~/.troth/state.db`) backs every host. Per-host
> `agent_id` keeps separate dialogue lanes; engrams + commitments are
> typically shared.

## The shape: a 4-server gateway, not dozens of loose tools

Every install wires the same lean surface (~10 tools):

| server | tools | what it is |
|---|---|---|
| `troth-router` | `mcp_list` / `mcp_describe` / `mcp_call` / `troth_image_generate` | the GATEWAY to the heavy servers |
| `troth-bash` | `run` / `cd` / `pwd` | shell with persistent cwd, output compression, SQLite archive |
| `troth-cache` | `cached_read` / `cached_grep` | content-hash read/grep cache |
| `troth-hashline` | `hashline_read` / `hashline_edit` | drift-safe anchored editing |

The heavy servers (`troth-substrate` ~40 tools, `troth-memory` ~18,
`troth-entity` 6; the substrate count varies slightly by build because a
few tools are injected dynamically) are NOT wired top-level: the router
reaches them on demand through `~/.troth/router.json`, which the installer
provisions. Wiring all seven directly used to push dozens of tool schemas
into every session (a permanent token tax + tool-choice overload); the
gateway keeps full access at a tenth of the surface. Call a substrate tool
either directly if your session has it, or through the router:

```
mcp_call({ server: "troth-substrate", tool: "troth_engram_record",
           args: { statement: "..." } })
```

## One-command install (recommended)

```bash
troth mcp install claude    # Claude Code (~/.claude.json)
troth mcp install cursor    # Cursor (~/.cursor/mcp.json)
troth mcp install all       # every detected host
troth mcp hosts             # see what is wired where
```

What the installer guarantees (same semantics on every surface: this
CLI, the dashboard's Wire buttons, and the desktop app's button):

- **merge-only** — your other MCP servers are never touched
- **fail-closed** — corrupt config aborts the write, never clobbers
- **rolling backup** — `<config>.bak-troth` beside every file it writes
- **absolute node + absolute paths** — works with no system Node (app
  installs) and regardless of the host's working directory
- **router provisioning** — `~/.troth/router.json` gets the three heavy
  servers (merge-only too: your own downstream entries survive)
- **7→4 migration** — legacy direct entries for substrate/memory/entity
  are pruned; rerun the install once if `troth mcp hosts` flags them
- **Claude Code pre-approval** — the four gateway servers are added to
  `~/.claude/settings.json` `permissions.allow` so the shell steer never
  stalls on an accept prompt (see below; backup taken, foreign entries
  untouched)

## Claude Code: tools + slash commands + skills + hooks

Claude Code gets more than tools. The plugin adds `/troth:*` commands,
skills, and the lifecycle hooks (memory capture, recall injection, and
`bash-steer`, which routes shell through `troth-bash` so every command
lands in the substrate's recall):

```bash
claude plugin marketplace add /path/to/your/troth/checkout
claude plugin install troth@troth-local
```

Installing from GitHub instead: `claude plugin marketplace add https://github.com/xgre1/troth` then `claude plugin install troth@troth`.
`marketplace add <checkout>` registers the local directory under the
marketplace id `troth-local`, so the install target is `troth@troth-local`
(this is exactly what `troth mcp install` runs under the hood). The checkout
root carries `.claude-plugin/marketplace.json`, so the local-directory form
works offline and pre-publication. `troth mcp
install claude` detects an installed plugin and skips the top-level
server entries (the plugin already provides them) while still
provisioning the router + permissions.

Note on the pre-approval: `bash-steer` denies the built-in Bash tool and
reroutes to `troth-bash`. Built-in Bash is usually covered by your
accumulated allow rules; the MCP tool is not, so the installer
pre-approves exactly the four troth servers (never the heavy ones, never
wildcards beyond them). Opt out of steering with `TROTH_BASH_STEER=0` or
`{"features": {"bash_steer": false}}` in `~/.troth/config.json`.

## Dashboard buttons

The local proxy serves the same installer over HTTP (loopback free,
token-gated for anything remote):

```
GET  /api/mcp/status              # plugin + marketplace state
POST /api/mcp/install             # Claude Code plugin flow
POST /api/mcp/install?client=cursor   # any other detected host
```

The dashboard's Integrations card is just these endpoints.

## Building the native module

`better-sqlite3` compiles against YOUR node at `npm install` time, so the
ABI always matches. Minimal Linux images need `build-essential` and
`python3` first. On macOS, if a Homebrew Python is broken (symptom:
`pyexpat` import errors from node-gyp), point gyp at the CLT python:

```bash
PYTHON=/usr/bin/python3 npm install
```

## Per-host setup (manual)

`troth mcp install <host>` writes these for you; the recipes show what
lands. Use ABSOLUTE paths: hosts do not expand `~` inside JSON args.

### Cursor (`~/.cursor/mcp.json`), Windsurf, Cline, Claude Desktop

```json
{
  "mcpServers": {
    "troth-router":   { "command": "/abs/path/to/node", "args": ["/abs/path/to/troth/plugin/mcp-servers/troth-router/server.mjs"] },
    "troth-bash":     { "command": "/abs/path/to/node", "args": ["/abs/path/to/troth/plugin/mcp-servers/troth-bash/server.mjs"] },
    "troth-cache":    { "command": "/abs/path/to/node", "args": ["/abs/path/to/troth/plugin/mcp-servers/troth-cache/server.mjs"] },
    "troth-hashline": { "command": "/abs/path/to/node", "args": ["/abs/path/to/troth/plugin/mcp-servers/troth-hashline/server.mjs"] }
  }
}
```

### Continue / Zed / any custom MCP-aware host

Same four stdio servers, adapted to the host's config schema (Continue:
`mcpServers` array in `~/.continue/config.json`; Zed: `context_servers`
in `.config/zed/settings.json`). For a single-purpose custom host you
can also spawn a heavy server directly:

```bash
node /abs/path/to/troth/plugin/mcp-servers/troth-substrate/server.mjs
```

Speak MCP `initialize`, then `tools/list`, then `tools/call`. Direct
spawn only works from a full checkout or the app bundle (the servers
require sibling `proxy/` + `shared-core/`).

## `agent_id` strategy

Per the substrate's "engine swap doesn't break identity" claim
(one mind, several surfaces), the recommended pattern is:

| Host | `TROTH_ENTITY_AGENT_ID` |
|---|---|
| Claude Code | `user-collab` (the canonical "us together" lane) |
| Cursor      | `user-cursor` |
| Continue    | `user-continue` |
| Zed         | `user-zed` |
| custom CLI  | `user-cli` |

Engrams the auto-judge writes are scoped per-agent_id, so each host
captures its own dialogue but the chameleon corpora and the
substrate's commitment set (anchors, refusals) are shared (cross-
agent reads work; the engram tool surface enforces per-agent
isolation only on writes).

To force one agent_id across hosts (single shared lane), set the same
`TROTH_ENTITY_AGENT_ID` everywhere.

## Verification

Gateway end-to-end (this is the check that matters):

```bash
{ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'; \
  sleep 0.3; \
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp_list","arguments":{"server":"troth-substrate"}}}'; \
  sleep 3; } | node /abs/path/to/troth/plugin/mcp-servers/troth-router/server.mjs
```

Expect the `id:2` response to carry the substrate's tool list (dozens of
entries: `troth_engram_record`, `troth_recall`, ...). That proves the
whole chain: router → `~/.troth/router.json` → substrate → `state.db`.
The router stays resident after answering (it keeps its downstream
servers warm) — Ctrl-C when you have the `id:2` line.

## Cross-host smoke test (one mind, several surfaces, checked by hand)

1. From Claude Code: `troth_engram_record({statement: "test fact for cross-host check"})`
2. From Cursor (via the router): `mcp_call({server:"troth-substrate", tool:"troth_engram_search", args:{query:"cross-host check"}})`
3. Same engram returned. Same substrate, different LLM faculty.

## What this enables

Every conversation in every host writes to one substrate. Drift
detection (G3), proactive insights (G7), commitment revisions (G6),
and structural disagreement (G2) all see the union of dialogue
across hosts. The substrate is genuinely the mind; the host's LLM
is whichever speech organ happens to be talking right now.
