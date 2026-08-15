# troth

**Three weeks ago you said you prefer tabs. Today, new session, different model, it still prefers tabs. Last Tuesday you changed your mind. Within ten minutes the substrate had overwritten the old belief.**

That's the whole pitch. troth is a brain — not a memory store, not a context window, not a RAG layer. A persistent SQLite-backed substrate that holds positions across sessions, reconsolidates them when you contradict yourself, compiles routines after watching you twice, and can run silent background hygiene tasks between sessions (off by default; `shared-core/deliberator.js` documents exactly what ships). Same brain whether you reach it by **voice** (Tauri desktop), **CLI** (`troth` REPL), **HTTP proxy + dashboard**, or the **Claude Code plugin documented below**.

Memory tools forget the gap between turns. troth uses the gap. Drift detection, contradiction scan, dormant-commitment review, identity extraction, lability reconsolidation — all running while idle, none requiring an LLM to fire.

> *This README covers the Claude Code plugin surface. Standalone REPL: `troth cli`. Proxy + dashboard: `troth start` → `localhost:8000/ui`. The desktop app is a separate closed-source product built on this core.*

## What the plugin actually does in your session

Every tool call your agent makes lands in the same brain that the voice app reads three weeks later. Reads, edits, decisions, intents — typed, append-only, causally linked. The next turn's prompt is assembled from a relevance-floored prefix provider that pulls only the engrams and held positions that match what you just said (semantic + lexical hybrid, identity-vector reranked) — not the everything-firehose that makes prior-context features feel like noise.

That's the substrate-side win. The token-efficiency side-effect is real but secondary: a Max 5-hour window gives you ~220K input tokens; the per-request pipeline (repo map, skimmer, prefix-cache stabilizer, content-hash tool-output cache) hands back a large share of it; measure on your own workload with `/usage`. No proxy in the auth path.

**Installed in 30 seconds. Measurable in one session.**

## Install

```bash
# 1. Add the marketplace
claude plugin marketplace add https://github.com/xgre1/troth

# 2. Install the plugin
claude plugin install troth@troth

# 3. (Recommended) Deny built-in Bash so the agent routes shell work
#    through mcp__troth-bash__run, which compresses verbose output 65-95%.
#    Add to ~/.claude/settings.json:
#      { "permissions": { "deny": ["Bash"] } }
```

That's it. Start your next Claude Code session normally.

## What's inside

### Hooks that fire automatically

| Hook | Event | What it catches |
|---|---|---|
| **LoopBreaker** | PreToolUse | Model stuck retrying the same failing command → nudge at 3rd repeat, block at 5th |
| **VerifyFirst** | PreToolUse | Edit on a file not yet Read in this session → ask for a Read first |
| **Edit matcher** | PreToolUse | `old_string` close-but-not-exact → fuzzy-correct via 4-strategy cascade |
| **AST validate** | PreToolUse | Write/Edit would leave broken syntax → refuse with precise line:column |
| **Output sandbox** | PostToolUse | Verbose tool output → archive to SQLite, return dense summary |
| **Mark-read** | PostToolUse | Maintains session's "file-was-read" set for VerifyFirst |
| **Error taxonomy** | PostToolUse | Tool failure → classify + inject concrete recovery hint |
| **Injector** | UserPromptSubmit | Project type + mode-aware guidance + keyword-boosted repo map in ≤1.5K chars |
| **Critic** | Stop | Refusal/bail/placeholder content → force regeneration |
| **SessionStart** | SessionStart | Session boundary stamp for per-session state scoping |

### MCP servers

A plugin install wires FOUR servers (see `plugin/.mcp.json`): troth-bash,
troth-cache, troth-hashline, troth-router. The substrate/memory/entity
surfaces below are NOT auto-wired; reach them through troth-router's
`mcp_call`, or add them to your MCP config yourself (`../docs/MCP-HOST-INSTALL.md`
has the exact blocks).

| Server | Tools | Purpose |
|---|---|---|
| **troth-bash** | `run`, `cd`, `pwd` | Sandboxed shell with command-aware compression (git log 65%, grep 75%+) + destructive-command refusal |
| **troth-cache** | `cached_read`, `cached_grep` | Content-hash-keyed cache; 0 backend tokens on hit, identical correctness vs Read/Grep |
| **troth-hashline** | `hashline_read`, `hashline_edit` | LINE#TAG-anchored edits, AST-validated for JS/TS/PY/JSON; whole batch rejected on any failure |
| **troth-router** | `mcp_list`, `mcp_describe`, `mcp_call` | Lazy-load heavy MCPs behind 3 compact tools (saves 9-15K tokens/turn per deferred server) |
| **troth-substrate** | engram / chameleon / identity / dialogue / orchestrate | Substrate-as-mind surface: semantic recall, multi-axis query (entity+temporal+causal+semantic), corpus ingest, identity bootstrap, sub-agent dispatch |
| **troth-memory** | GMP v0.1+v0.2 | Append-only ActionRecord ledger with typed-edge causal graph and TOON wire-format. Reference implementation of GMP. |
| **troth-entity** | `entity_active_commitments`, `entity_record_commitment`, `entity_recent_decisions`, `entity_check_drift`, `entity_state` | Substrate-as-Entity v0.1 control surface — read commitments, record positions, observe drift |

> Note: archived tool-output search lives inside `troth-memory` as a compatibility shim (`troth/archive_search`). The standalone `troth-archive` server name from earlier docs is retired — same FTS5 backing, different surface.

### Slash commands

- `/research <question>` — delegate broad codebase exploration to the `troth-researcher` subagent so the parent's context stays lean.
- `/hard <context>` — escape hatch for genuinely hard work: think longer, read more, sanity-check before writing.

## Measure the wins

```bash
node benchmarks/plugin-bench.mjs start    # mark a window
# …do real work in Claude Code for 30-60 min…
node benchmarks/plugin-bench.mjs report   # see deltas
```

Reports hook activations, savings ledger, tool-output compression ratio, and estimated total tokens saved — all from the shared SQLite at `~/.troth/state.db` that every hook writes to.

## Does it work with the standard Claude Code proxy gateway (troth proxy)?

Yes. The plugin and the proxy share state via the same SQLite file, and the proxy auto-detects when the plugin is active (via the `plugin_presence` heartbeat) so the two don't double-work on the same signal. Use the plugin for your interactive Max/Pro sessions; keep the proxy for background agents (`claude -p` and similar headless runs) where you want the full 12-module scaffolding and the provider failover chain.

## FAQ

**Q: How does this sit with Anthropic's terms?**
That is a question about your account, and only Anthropic's terms can answer it, so read them and decide. What this plugin does is stated plainly: it installs hooks, MCP servers and skills through Claude Code's documented extension points, and it touches nothing in the authentication path. There is no proxy and no interception. Your credentials, your session and your requests reach Anthropic exactly as they would without it.

**Q: What if I don't use all the hooks?**
Every hook is independent. Disable individual ones by editing `~/.claude/settings.json`'s `hooks` block after install.

**Q: Does it work with non-Max plans?**
Yes. Pro plans get the same relative effect. BYOK API users benefit even more because savings are billed directly.

**Q: Where does state live, and what leaves the machine?**
`~/.troth/state.db` (WAL-journaled SQLite). Override with the `CLAUDE_PLUGIN_DATA` env var. Your substrate is that file: it is never uploaded, synced or reported anywhere, and nothing about your usage is sent to us.

What does leave is what you ask to leave. The plugin wires the `troth-router` MCP server, and two of its tools reach outside the machine when you call them: a request routed to a cloud provider goes to the provider you configured with your own key, and `troth_image_generate` posts your prompt to the ChatGPT plan you linked or to Google's image endpoint with your own Google AI key. Neither can run before you supply that credential, and neither runs on its own. Every other tool, hook and skill in this plugin is local.

## License

Apache-2.0. See [LICENSE](LICENSE) in this directory. The rest of the repository is AGPL-3.0-only — see the repo root [LICENSING.md](../LICENSING.md).
