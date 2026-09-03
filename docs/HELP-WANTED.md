# Help wanted — things a contributor can pick up

Each item below is scoped, has a place in the code, and is not on the
maintainer's own path right now. Open an issue naming the item before you
start (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the maintainer answers with
the constraints that matter for that spot. Read
[HONEST-LIMITS.md](HONEST-LIMITS.md) first so you know what the product does
not claim.

## Surfaces

**Hermes Agent, verified live.** troth ships a memory provider for Hermes
(`integrations/hermes/memory/troth`) and `troth mcp install hermes` writes the
wiring. The provider is written against the published provider contract and
has not been exercised inside a running Hermes. Wanted: a run that shows the
prompt context arriving before each turn and the turn recorded back, and a
note of any argument name the contract passes differently from its guide.

**Hermes in the app's Integrations tab.** The app's host table writes JSON
configs. Hermes reads `~/.hermes/config.yaml`. The CLI installer already merges
YAML as text (`shared-core/mcp-hosts.js`, `installIntoYaml`); the app needs to
call `troth mcp install hermes` or carry the same merge.

**An OpenAI-shaped door on the proxy.** The proxy speaks the Anthropic
messages shape. A `/v1/chat/completions` façade would let Hermes, and any
OpenAI-shaped client, run on troth's engines and daily budget instead of its
own key. `proxy/server.js` holds the messages route to mirror.

## Onboarding (`proxy/ui/dashboard.html`, the `tob-` steps)

**Wire buttons from detection.** The last step lists every host. Wanted: the
hosts found on this machine first, the rest under "more". `shared-core/mcp-hosts.js`
already knows each host's config path; `/api/mcp/install?client=<id>` does
the wiring for any host in that table.

**Notes beside chat history.** When Obsidian vaults are found
(`GET /api/memory/notes-sources`), offer them in the import step the way chat
history is offered. No folder field in onboarding; the Memory page has one.

**The dispatch label names where the local engine lives.** "This device
first" reads wrong when the local engine is a server on another machine
(`providers.local.host`). One line of copy driven by the config.

**End with a reply.** The setup ends on "Open the dashboard". The proof of a
working install is one real reply; the last step should send one.

## Memory

**Keep a notes folder in sync.** `troth knowledge import <folder>` reads a
folder once. A watcher that re-queues a changed file (the spool already keys
by content hash, so unchanged files cost nothing) would keep an Obsidian
vault current. `shared-core/notes-import.js` is the entry.

**Show the local engine's context in the dashboard.** The router reads the
local server's `n_ctx` from `/props` once a minute to keep oversized requests
off it (`proxy/modules/router.js`, `localFits`). The Engines page could show
that number beside the host so an operator sees why a request went hosted.

## Chat surface (`bin/troth-chat.js`)

**A terminal test for the composer.** The composer repaints as one block and
keeps one height for a whole turn. A test that drives a pseudo-terminal
through a resize during a turn and asserts no rows are left behind would pin
that behaviour, which today is pinned by source inspection only.

## Docs and site

**A "works with" strip.** Claude Code, Codex, Cursor, Windsurf, Cline, Claude
Desktop, Hermes Agent, Obsidian, llama.cpp, Ollama, MLX: the README and the
site name them in prose; a short visual strip with one line per surface is
missing.
