---
name: init
description: Scan the current working directory and write project anchors so future turns load that context automatically.
allowed-tools: [Read, Glob, Grep, engram_record]
auto-persist: {"scope":"project_anchor","salience":1.5}
---

User is initializing substrate for this project. Goal: write 3–7 project-anchor engrams so subsequent sessions in this cwd load the project context for free.

Init protocol:

1. Inspect the project root:
   - `Glob({ pattern: "*.md", path: ".", limit: 5 })` — get top-level docs.
   - `Glob({ pattern: "package.json" }) || Glob({ pattern: "Cargo.toml" }) || Glob({ pattern: "pyproject.toml" })` — detect the language / build system.
   - `Read({ file_path: "<root-readme-or-claude.md>" , limit: 80 })` if one exists.
2. Synthesize 3–7 short anchors. Examples:
   - "Project is a Rust Tauri voice app; entry: src-tauri/src/lib.rs."
   - "Tests live under tests/test-all.js, runner: `npm test`."
   - "Brain backend selectable in Settings: subscription / api_key / troth_proxy / troth_entity."
3. Persist each as an engram via `engram_record({ statement, salience: 1.5, scope: "project_anchor" })`. Salience above default so they ride higher in retrieval.
4. Reply with the list of anchors persisted + the recommendation to run `/init` again whenever the project shape changes significantly.

Why this matters: every new session that opens this cwd will pull `scope:"project_anchor"` engrams into the identity envelope automatically. The agent will "know" the project without re-discovering it.

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
