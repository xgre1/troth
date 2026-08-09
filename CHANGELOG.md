# Changelog

> This changelog covers the whole product. Entries touching the autonomy
> overlay or the macOS app describe code that lives outside this repository.


All notable changes to troth are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.14] — 2026-08-10

### Added
- Memory maintenance now lives where every install keeps a process: the
  proxy hosts the upkeep worker (embedding drain, import sync, weekly
  backup, opt-in WAL replica) under a cross-process ledger lease, so a
  dashboard-only machine drains its index — and takes backups — instead of
  freezing its counts. Readiness gained the drain's
  proof-of-life (last run, its notes) and true progress pairs; the
  dashboard renders them as bars with a heartbeat line, plus a Recent
  memories list served read-only at `/api/memory/recent`. `troth doctor`
  gains a Background drain verdict whenever work is owed.
- Chat-history import grew its flow half: once a source has been imported
  by a human, new sessions auto-sync into the archive on idle cycles —
  raw half only (local, free); the distill half stays on the explicit
  Import action. `TROTH_IMPORT_SYNC=0` or `import_auto: false` turns it
  off; a source never joins uninvited.
- `troth service install` on Linux now also enables lingering
  (best-effort), so the login service survives reboots nobody has logged
  into yet; `service status` reports it, and the doctor's drain verdict
  points at the service as the permanent fix.

### Changed
- The memory index counts only rows that carry embeddable text — blank
  turns and bare tool telemetry are no longer promised as "still
  indexing" (they are untouched, simply outside the promise), and the
  drain quarantines per-row failures so the archive lane can never starve
  behind them.
- Document ingest is atomic per session: chunk rows (the import's own
  done-marker) commit in one transaction, so an interrupt — closed
  laptop, killed process — leaves nothing behind and the next run
  imports the session whole. No duplicates, no half-remembered
  sessions; re-running Import stays safe and is stated as such in the
  dashboard.
- The upkeep worker hardened around its own perimeter: only mutating
  requests count as foreground (an open dashboard's status polls can no
  longer hold the drain hostage), the ledger lease finds long-cadence
  runs through any amount of drain noise, first ticks carry a jitter and
  backups a pid suffix so a login burst can never race two workers into
  the same window or the same bundle path, one machine-wide lock keeps
  the auto-sync and the Import button from importing the same session
  twice, and a daily ledger prune keeps the heartbeat bookkeeping from
  growing forever (each task's newest row survives at any age).
- `troth doctor` gains a Login service verdict — including the stale-unit
  case where the service points at a tree an update moved — and systemd
  units quote their paths.

- Every shell the partner runs now answers to the same walls. The app's
  claude_cli spawns live in an isolated config home that loads none of the
  operator's Claude Code wiring, so their native Bash ran ungated; the
  faculty home now provisions its own PreToolUse gate asking the same
  bash-safety verdict as the troth-bash door (one wall, two doors), with
  refused reads of secret stores, refused writes to protected
  destinations, egress gating, and credential-literal refusal all riding
  along.
- The turn states its real token accounting. The claude_cli lane's result
  frame now yields usage with the cache columns summed into the true
  prompt size and the model's stated context window alongside, so the app
  can show an honest context meter in advanced mode instead of nothing on
  the one lane a subscription user runs.
- Importing a chat means the archive too: `--full` runs the raw
  chunk+embed archive (docs:chats, the searchable record) AND the
  distilled identity facts in one idempotent pass, each half keeping its
  own provenance. The app's import sends it; the bare CLI keeps its
  raw-only default.
- Every recordAction extends the ed25519 signed audit chain (read-head +
  append in one immediate transaction, so concurrent writers serialize
  instead of forking the chain), and supersession pointers persist in
  their own index so a "forgotten" fact stays hidden beyond any fetch
  window. /forget retires through the reconsolidation primitive instead
  of writing a tombstone nothing filtered.
- Usage from Claude Code sessions now reaches the ledger without touching
  the proxy: the plugin tails Claude Code's own per-message usage logs into
  usage_ledger, deduped by message id and watermarked by byte offset, so
  the dashboard and Analytics show the Claude subscription lane alongside
  the proxied ones. Ingested rows carry a ' (plan)' marker priced flat/$0
  — subscription tokens never appear as API spend — while unsuffixed model
  names keep their API rates for the savings valuation. Only claude-*
  models ingest; transcripts of proxied sessions stay with the proxy's own
  count.

### Fixed
- The distill import half never registered as done (its provenance landed
  in a field the skip check does not read), so every re-run re-distilled
  and re-billed every session. Both halves are now independently
  idempotent.
- Tool output is harvested and masked before the model, the archive and
  the savings label see it; medium danger classifications travel with the
  result instead of vanishing; the STVC bypass is stripped from the
  partner env and refused inline; a no-port browse can no longer land in
  the operator's own debug Chrome.
- The dashboard's commitment counts exclude GC tombstones and test seeds,
  and embedding coverage joins on recallable rows instead of clamping to
  a permanent 100%.
- The operator's model pick (providers.anthropic.model) reaches the
  claude_cli spawn, env override first, ambient id last, every source
  behind the same claude-only guard.
- The proxy answered its port minutes late on large home directories and
  stalled requests after listen: hotcache pre-hashed the whole tree
  synchronously at module scope, and the CodeLens file walks applied their
  time cap only on candidate files, so candidate-free trees (cloud-backed
  mounts, where a single readdir can block on network) walked without
  bound. The hotcache walk now yields to the event loop, caps files and
  total bytes, skips files over 512KB, and goes watch-only when the watch
  dir is a home or root; both CodeLens walkers enforce their time budget
  per directory.
- File watching on Linux is now per-directory over the indexed tree only,
  non-recursive and capped at 1024 directories, so it stays within the
  kernel's `fs.inotify.max_user_watches` budget on any tree size. Watcher
  errors are handled at the watcher and reported once, and whenever no
  healthy watcher is running the hash cache reads fresh from disk instead
  of serving cached entries. macOS and Windows keep the single recursive
  handle.

## [0.1.10] — 2026-08-05

### Fixed
- The local embedding server never started. The environment it was spawned
  with read a `path` binding that belonged to the block above it, so every
  attempt raised a reference error, and the fallback caught it silently:
  embedding ran in-process instead, and on machines where the in-process
  build is unavailable it did not run at all. Measured on Apple Silicon with
  the model already resident, the in-process path this masked reaches 93.8
  embeddings/sec against the server's 64.9 at its default of no GPU offload,
  so on that hardware nothing was lost while it was broken — the loss falls
  on machines that have no in-process path at all.
- A restart forgot a model that was already downloaded. Whether the memory
  model was present came from process state, so setup offered to install the
  333 MB file sitting in `~/.troth/models`, and the check that proves recall
  really works — gated on the same flag — never ran again. The file on disk
  is now the answer, which is what the loader has always used.
- `/api/setup/local` reported whether recall had been proven but never
  started the proof; only `/api/embed/status` did. The dashboard polls both,
  so it worked there, but anything polling one of them alone waited forever.
  Both start it now.

## [0.1.9] — 2026-08-05

### Fixed
- The model pickers in the app still offered Claude ids the API no longer
  serves. They now match the one catalog the rest of the product reads.

## [0.1.8] — 2026-08-04

### Fixed
- Starting troth when something else already held its port left you with no
  way in: the dashboard address printed was the one it could not use, and
  the wait for the proxy watched a port it had moved off. Both now follow it
  to the port it actually took, and the app adopts a proxy already running
  there instead of starting a second one against the same memory.
- A first run said nothing about `troth setup`, the guided path that asks
  which engine you want and takes your key, and sent you to a dashboard of
  switches instead. It now offers to run it, and names it in the help and
  the README.
- Setup wrote two hooks into Claude Code that pointed at files this project
  does not ship, and they failed on every edit. That step now points at the
  plugin, which is what actually installs them.
- With nothing configured, a message got no answer and no explanation. It
  now says so, and names the command that fixes it.
- `troth doctor` reports the dashboard address, the port the proxy really
  holds, and whether recall is running on meaning or on plain word matching,
  which until now degraded silently.

## [0.1.7] — 2026-08-04

Everything here was found by installing the app in a clean macOS account and
walking the path a buyer walks. None of it was visible from a machine that
had been set up for months.

### Fixed
- Abandoning setup left an install that believed it was finished. The boot
  check was "does a passphrase exist", and the passphrase is written at the
  end of the first of two steps, so quitting after it opened the app with no
  engine configured and no way back to the wizard. Setup completion is now
  recorded explicitly, and an unfinished run reopens where it stopped
  instead of asking for a passphrase that already exists.
- Signing in with a ChatGPT subscription stored a model this endpoint
  refuses, so every message after a successful sign-in failed. Sign-in no
  longer picks a model, the proxy corrects one that is already stored, and
  the dashboard stops writing it back when its model field is left empty.
- A new install preferred "This Mac first" before any local model existed,
  so the first message went nowhere. The preference is worked out from what
  is actually configured, and an explicit choice always wins over it.

## [0.1.6] — 2026-08-04

### Fixed
- The in-app update could never complete. Its Gatekeeper assessment ran
  `spctl` without `-v`, so the command printed nothing at all, and the
  guard then required the word "accepted" to appear in that nothing. Every
  download was refused no matter how well it was notarised. The check is
  intact and now passes on a notarised image and still refuses an unsigned
  one; installs from 0.1.4 or 0.1.5 need one manual download to reach a
  build that can update itself.

## [0.1.5] — 2026-08-04

### Fixed
- Signing in with a ChatGPT subscription failed on every machine that had
  not been configured by hand. The OAuth client identity had been removed
  from the tree on the grounds that bundling it decided, for the operator,
  that their subscription may be spent this way. The objection was about
  consent, so consent is what it gets: the identifiers ship again with
  defaults, and the sign-in states first that it uses the operator's own
  account and quota, that troth is not affiliated with OpenAI, and that
  the interface is undocumented for third-party clients. Setting
  `TROTH_CODEX_CLIENT_ID` or `~/.troth/codex-client-id` to `none` declines
  the provider outright.

## [0.1.4] — 2026-08-02

First public release of the open engine.

The tree published here is the whole open core: substrate, CLI, proxy,
the Claude Code plugin, the tests, and the benchmarks with their data.
Version numbers before this one exist in a private history and were
never distributed; the app bundle a user installs reports the same
0.1.4 as this package.

### Fixed
- Stop in the app's simple surface cancelled nothing: the send resolved
  a missing conversation id to the app-global conversation while the
  stop looked for an untagged turn, so the two ends named different
  things. Both ends resolve the same way now, and a tagless interactive
  turn is cancellable.
- A bare greeting could resume prior work, because the always-injected
  focus and handoff blocks read as instructions. Both now say what they
  are.
- The proxy treated the inside of the macOS app bundle as a project
  directory and wrote state into it, which broke the code signature of
  an installed app minutes after install.
- Structured-envelope tagging was asked of every model on every
  substantial turn, so replies arrived as filled-in forms with the tags
  visible. It is opt-in now.
- `npm run test:standalone` discovered three fewer files in a tree
  without `.git` than in a clone, so the published count depended on
  how you obtained the source. The no-git path now covers the same
  directories; in a git checkout where git itself fails it refuses to
  guess rather than walking the disk, because an untracked file is
  invisible to one method and visible to the other.

## [Unreleased]

### Added

- **Conversational MCP registration: paste a config in chat, approve once,
  it works.** The partner stages a pasted MCP server snippet itself via the
  new `mcp_register_request` tool (strict validation, atomic 0600 write into
  the inert `~/.troth/mcp-pending.json`; `$vault` env refs stored verbatim,
  never resolved at stage time). The pending file is invisible to the
  resolver, so a staged server cannot be listed or called. The operator
  approves ONCE with the new `troth mcp approve <name>` (plus
  `troth mcp pending` / `troth mcp reject <name>`; headless via
  `TROTH_OPERATOR_PASSPHRASE`, single-JSON-line output for the app), which
  moves the entry into the active registry and seals
  `capability:mcp:<name>` (max medium) through the same signer path as
  `troth cap mint`. The partner still cannot activate anything: the active
  registry stays partner-write-blocked (path-policy + bash-safety), and the
  system prompt now tells the partner to stage-and-ask instead of editing
  registry files. Pinned by `tests/suite-18-mcp-hands.js` MCPH-9..15.
  (`shared-core/tools/mcp-client.js`, `bin/cmd-mcp.js`, `bin/troth.js`,
  `shared-core/tools/path-policy.js`, `shared-core/tools/system-prompt.js`)

### Removed

- **A scheduler and its API surface, both already inert here.** The modules
  they called were archived out of this repository earlier; what is dropped
  now is the shell that referenced them and an endpoint that answered 501 to
  every caller, along with the unit tests that only covered the dead path.
  Embedding-based identity scoring is unrelated and stays.

### Fixed

- **A pinned engine that runs out (plan cap, expired sign-in, not linked) now
  says so instead of hanging for two minutes.** With a routing pin set and the
  pinned provider excluded (disabled / no token / health cooldown) or its own
  call returning 429/401, the proxy used to return a generic
  `503 all_providers_unavailable`; the upstream CLI retries 5xx/429 with
  exponential backoff, so the operator stared at 128+ seconds of silence
  (silent-drop incident 2026-07-18). The router now fills a distinct fail-fast
  descriptor and the proxy returns `400` with an Anthropic-shaped
  `invalid_request_error` that names the pinned engine, the reason (plan rate
  limit / sign-in expired / not linked / unreachable), and the way out
  (switch engines in Settings or wait for the limit window). 400 is deliberate:
  upstream CLIs treat it as fatal and surface it immediately. The fail-closed
  decision is unchanged (a pinned turn never falls through to another engine),
  only the response body; non-pinned fallback is untouched. Pinned by
  `tests/suite-19-router-pin-failfast.js` (PIN-FAIL-1..3) and simulator profile
  p9. (`proxy/modules/router.js`, `proxy/server.js`)
- **Every no-work claude_cli death now falls through to the next faculty.**
  A dead Claude CLI (expired OAuth, missing binary, empty exit, plain-text
  auth error from an old CLI, zero-output hang) used to end the turn as a
  silent empty reply or "(Stopped — took too long)" while working faculties
  sat idle. Spawn failures and empty exits are tagged transport aborts
  (`cli_spawn` / `cli_empty`), the raw-passthrough path applies the auth
  regex, an untagged `{done,error}` aborts instead of returning empty-"ok",
  and the entity's cross-faculty walk also rescues zero-output timeouts.
  Contract pinned by `tests/suite-16-faculty-fallthrough.js` (FT-1..FT-6).
- **An explicit "Local" engine pin actually binds.** llamacpp is always wired
  as a backstop faculty (demoted to last in default priority, so it never
  hijacks selection): a `transport_hint: 'llamacpp'` used to be silently
  dropped when the faculty wasn't wired — claude_cli then served the "local"
  turn. A dropped hint is now annotated on the dispatch event.
- **CI is green again.** The standards runner hard-required the closed-side
  `s2` check (gitignored by the repo split), so every push since 2026-06-25
  failed with MODULE_NOT_FOUND before running a single check. Checks absent
  from the open checkout are now skipped and announced.

### Added

- **Claude Code session capture tools ship in-repo.** `tools/claude-session-watcher.js`
  (live capture, 10s poll) and `tools/backfill-claude-sessions.js` (historical
  import) were left behind in the pre-split tree while the proxy autostart hook
  and the `/api/substrate/watcher/*` endpoints still referenced them — the
  watcher silently never ran. Ported with troth-native state paths
  (`~/.troth`, `TROTH_ENTITY_AGENT_ID`).

### Changed

- **The two monoliths are split, behavior-identically.** `tests/test-all.js`
  (1.3MB) is now a 21-line ordered runner over `tests/harness.js` +
  `tests/suite-01..07-*.js` (verbatim section bodies, V8-verified standalone
  parse, identical 1654/0 results). `bin/troth.js` (5.4k lines) is now a
  2.1k-line router + 44 `bin/cmd-*.js` command modules; each keeps its own
  `if (command === ...)` guard and runs in the original chain position via a
  lazy-getter context, so flag parsing, fall-through and exit semantics are
  unchanged (state-writing blocks stayed inline by design).
- **Public-repo comment hygiene.** Stripped stale internal "design phase" /
  internal planning qualifiers from ~80 file headers and inline comments (comment-only
  pass) and rewrote the `shared-core/chameleon-runtime.js` header to stand alone.
- **`benchmarks/` is the single bench root.** `bench/lmdt-runner.mjs` moved into
  `benchmarks/` with references updated; dev probes dropped from tracking; the
  fidelity/orchestration dev tests resolve the repo root portably instead of via
  hardcoded absolute paths.

### Fixed

- **Archived experimental paths fail honestly when absent.** The archived
  export endpoint returns 501 instead of a TypeError, the scheduler emits a
  skip event instead of crashing, and `server-lifecycle.js` dropped its
  unused experimental requires.

- **Autonomous goals now actually pursue instead of bouncing to approval.** The
  goal classifier keyword-scored the whole goal text and ignored an explicit
  `[code]`/`[research]`/… operator tag, so an autonomous `[code] …` goal scored
  ~0.03, tripped `fallback_to_llm`, and the coordinator filed a `pending_approval`
  request instead of pursuing — every autonomous goal silently died there.
  `goal-class-classifier.classify()` now treats a leading `[<known-class>]` as
  authoritative (`confidence:1`, no fallback); untagged goals keyword-classify as
  before; unknown tags fall through to chat.
- **`Write` creates missing parent directories** (matches Claude Code's Write and
  the `intent:fs:do` write path) instead of erroring `parent_missing`. An
  autonomous step whose tool set had no shell could not `mkdir` and stalled with
  "Write doesn't create parent directories" — it now writes into a not-yet-existing
  folder in one step.
- **Autonomous pursuits are serialized — one at a time.** A pursuit is async and
  runs for minutes; the heartbeat's `in_flight` gate only inspected the runtime
  queue, so the ~30s heartbeat stacked concurrent pursuits of the SAME goal
  (wasted spend + satisfaction races). Added an in-flight guard (set at submit,
  cleared in the handler `finally`, with stuck-pursuit recovery after 20 min).
- **`troth-import-memory` default path no longer hardcodes the author's home** —
  derives the Claude Code project key from `os.homedir()` so it resolves on any
  installed machine (removes the hard-coded home-dir literal flagged in review).

- **Every selectable faculty now ACTS, not just narrates (R9).** `ollama`,
  direct-API `anthropic`, and `codex` (ChatGPT subscription) transports dropped
  the advertised `tools[]` on send and never parsed tool calls on receive, so
  selecting any of them made the partner *describe* actions ("I edited X")
  instead of calling Read/Write/Edit/Bash. Each now forwards the substrate tool
  surface in that provider's native shape (ollama OpenAI-tools; anthropic
  `input_schema`; codex Responses-API flat function shape) and parses tool calls
  back: ollama `message.tool_calls` (object args → stringified), anthropic
  streamed `tool_use` + `input_json_delta` blocks, codex
  `response.output_item`/`function_call_arguments.*` lifecycle — each accumulated
  across the stream and flushed as ONE `tool_calls` chunk (composeAgentic
  overwrites per-chunk). Verified 16/16 with synthetic frames in each provider's
  documented event shape + ollama via a real local http mock. (codex omits
  `tool_choice` — the ChatGPT-subscription endpoint rejects non-essential params.)
- **The UI now shows which model actually served (R2).** Local/Automatic chat
  showed a BLANK model label. Backend: `llamacpp`, `ollama`, `anthropic`, `codex`
  transports now emit `served_by {provider, model, host}` (llamacpp verified live
  → real `…Qwen2.5-7B…` + host). App: `facultyLabel` gained the `local`/
  `local_inprocess` case (the blank-label blocker) + a `codex` case; the existing
  provider-agnostic `served` event (brain_entity → `servedLabel`) then shows the
  real model post-call. No regression (suite 1638 pass / 3 pre-existing).

### Security

- **Local services no longer silently exposed / hijackable (default-deny binds).**
  Forensic check on a real Mac (2026-06-18) found two confused-deputy surfaces:
  (1) the bundled local **llama-server bound to `0.0.0.0` (all interfaces), no
  auth** → any host on the LAN or a Tailscale network could use the operator's personal model. Fixed:
  `server-lifecycle.restartLocal` now defaults `bind_host` to **127.0.0.1**
  (this is the documented local-only lifecycle; expose to LAN only by explicitly
  passing `bind_host:'0.0.0.0'`), and `local-server.js` passes loopback
  explicitly. (2) The **CDP daemon used Chrome's well-known port 9222**, so
  `ensure()` could silently ATTACH to whatever Chrome was already there —
  including the operator's REAL browser (every logged-in session) or another
  agent's instance (observed live: two Chromes fighting over 9222). Fixed: the
  host Mode-1 daemon now defaults to a **private port 18222** (Mode-2 VM body
  keeps 19222; both off 9222), so a live instance on it is OURS. To DELIBERATELY
  drive the operator's own browser ("do a job in my account") set
  `TROTH_BROWSER_CDP_PORT=9222` explicitly — that is now the only opt-in path to
  the real session. `cdp-client` + `browser-observer` fallback ports aligned to
  18222. (Verified: CDP port was loopback-only, firewall on, no tunnel/funnel —
  no remote-exploit path existed; these close the local confused-deputy risk.)

### Fixed

- **Sovereign web search that actually works (Option B — our own CDP browser, no
  vendor/key).** Two problems fixed: (1) we had silently shipped Marginalia (an
  obscure indie engine, weak for mainstream queries) as the default — a silent
  low-quality default that undermines the product; removed. (2) The real bug:
  `web-research.js` forced the CDP browser **headless**, and a deep-research
  pass + a measured on-Mac benchmark (2026-06-18) proved **every mainstream SERP
  blocks headless CDP** (Brave→CAPTCHA, Ecosia→Cloudflare, Startpage→Blocked,
  Mojeek→403) while the SAME engines return Google-grade results **headful**.
  Fixes: `_withPage` now defaults **headful** (opt into headless via
  `TROTH_BROWSER_HEADLESS=1`); `web_search` drives a **prioritised fallback
  chain Brave → Ecosia → Startpage → Marginalia** (quality order, measured), each
  block/empty falls through to the next = resilience; `TROTH_SEARCH_URL` still
  overrides the whole chain with a single backend (e.g. self-hosted SearXNG).
  No API key, no vendor, no extra daemon. Verified live on a real Mac: a national e-invoicing query resolved
  through Brave to the relevant government portal; "best NC headphones 2026" →
  rtings/nytimes. (Research verdict: NO no-key/no-vendor option gives mainstream quality
  reliably in 2026 — Whoogle dead, Mojeek/Brave APIs now paid+keyed, Marginalia
  API rate-limited+indie-only; the durable sovereign answer is our CDP browser
  over automation-tolerant SERPs, headful, with SearXNG as operator opt-in.)

- **Local autonomous now ACTS instead of narrating (anti-LARP).** A weak local
  faculty (e.g. Qwen2.5-7B) would say "I created the file" without ever emitting
  the tool call, so the goal "succeeded" with nothing done. Action steps now
  require a real tool call before the step can close. Read-only steps are
  unaffected. (Closed tier.) Forcing
  a weak model to "read" on a from-scratch goal just spins on nonexistent files.
  Honored only by the llamacpp/local transport (claude_cli runs its own tools;
  router/anthropic/ollama/codex don't forward `tool_choice`), so the fix is
  inherently scoped to the faculty where the LARP happens — zero change to the
  claude/chat paths. Verified live: local 7B produced a real correct file under
  the autonomous coordinator. Kill-switch: `TROTH_STEP_FORCE_FIRST_TOOL=0`.
- **Cross-family reflection (Wall 4) — stop a weak model judging its OWN work.**
  Observed live: a local 7B reflecting on its own *correct* file-write
  fabricated a concern ("the agent waited for approval" — there is no approval
  gate) and returned `not_achieved`, flipping a genuinely-successful run to
  failure. The coordinator now routes the reflection call to the GLOBALLY
  STRONGEST available faculty (`claude_cli` ahead of API `anthropic` per operator
  policy; not merely "a different one" — cross-routing strong work to a weaker
  judge would re-introduce the same fabrication). Independence comes for free
  when the strongest differs from the worker; when the worker already IS the
  strongest, same-faculty is kept (no downgrade). Falls back to same-faculty for
  local-only operators (one faculty). Verified live: claude judging the same
  trace returned `achieved` AND independently confirmed the real artifact on
  disk (it runs its own tools). reflection.js: `cross_family` clears the
  same-faculty warning; a no-op `tool_runner` fallback makes reflection
  fail-safe (it advertises zero tools but composeAgentic guards `tool_runner`).
  Kill-switch: `TROTH_REFLECT_CROSS_FAMILY=0`.

### Changed

- **Reliability pass (chat/voice/autonomous): live action visibility + no
  premature aborts.** So a real multi-step turn runs visibly and doesn't die:
  - The per-LLM-call timeout (`TROTH_LLM_TIMEOUT_MS`) is now IDLE-based, not
    absolute wall-clock — a long but still-streaming generation is no longer
    killed mid-work. Bounded by `TROTH_LLM_HARD_CEIL_MS` (default 30min) and a
    racing idle timer that also catches genuinely silent/hung streams (needed
    because the entity heartbeat now keeps the Rust idle timer alive, so the
    orchestrator must self-bound a hang).
  - A single TRANSIENT transport error (5xx / dropped SSE / refused
    connection) now retries the same request up to `TROTH_LLM_TRANSIENT_RETRIES`
    (default 2) before aborting the turn — never duplicating committed output,
    never looping.
  - Streamed text now surfaces as `text_delta` events on the entity path, so
    the UI shows tokens flowing ("writing") instead of a frozen "Thinking".
    Suppressed on voice/audio turns (TTS reads the final reply).
  - `claude_cli` faculty switched to `--output-format stream-json`: claude's
    OWN internal tool use is surfaced as visibility-only `tool_activity` chips
    (NOT re-executed by composeAgentic), with a raw-text fallback if the CLI
    build doesn't emit stream-json.

### Added

- **Provider-agnostic web research (`shared-core/tools/web-research.js`)** —
  `web_search` + `web_fetch` driven by the EXISTING CDP browser (real Chrome via
  perception/chromium-daemon + cdp-client; JS-rendered, innerText-sanitized). Lets
  any native-tool-calling faculty (router/llamacpp/…) research the web; claude_cli
  keeps its own built-in WebSearch. Registered in tools/index.js + classified
  read-only in permission.js. Search backend = Marginalia (independent, keyless,
  no anti-bot) via CDP, with `TROTH_SEARCH_URL` ({q} placeholder) to point at a
  self-hosted SearXNG for broader coverage. NO vendor API/key, NO Playwright.
  (Verified: commercial SERPs — DuckDuckGo, Mojeek — serve anti-bot CAPTCHA/403 to
  automation even headful, so they are not used.)
- **Long-horizon goal pursuit** (closed tier) — a substantive
  chat task (detected by `isSubstantiveTask`: build/research verbs EN/EL/greeklish
  + length; questions/chitchat excluded) now runs as a bounded WORK →
  SELF-EVALUATE → CONTINUE loop instead of a single turn. Each pass the faculty
  does real work (streamed live); then a tool-enabled self-eval VERIFIES against
  the ACTUAL files/results (anti-LARP — not the model's narration) and either
  declares DONE or feeds the verified-remaining work into the next pass, until
  genuinely complete or a budget (`TROTH_GOAL_MAX_PASSES`=6, `TROTH_GOAL_MAX_MS`=30m).
  Reports honestly when the budget runs out (no faked completion). Simple chat
  stays a single turn (untouched). Disable with `TROTH_ENTITY_GOAL_LOOP=0`. The
  decision engine attaches `goal_text`/`goal_class` to the chat action; the entity
  `llm` path branches on it. Per-pass progress emits `worker_event` (Activity).
- **claude_cli model label** — the `claude_cli` faculty now surfaces the real
  model it used (`message.model`, e.g. "claude-opus-4-8") as `served_by`, so the
  engine/"via" pill shows it (it is not the router, so it reported nothing before).
- **Anti-fabrication system-prompt rule** — the partner is told it has NO
  background execution and must never claim work is "running in the background" or
  "in progress"; report only what tools did this turn. (`shared-core/tools/system-prompt.js`;
  the char cap was also raised 1500→2400 — it was already silently truncating
  the identity-capture / audio sections.)
- **`TROTH_ENTITY_HEARTBEAT_MS`** (entity env, default 12000) — keep-alive
  pulse emitted while an agentic turn is in flight so a long/silent step
  (e.g. a multi-minute claude_cli run) doesn't trip the Rust idle-stall timer
  and the UI never looks frozen. The autonomous coordinator's `worker_event`
  now also counts as activity.
- **`GET /api/providers/openrouter/models`** (proxy) + **`provider_models`**
  (Tauri command) + `fetchProviderModels()` (UI) — live OpenRouter catalog for
  the Settings model dropdown (previously a static one-item list, the "add key
  but no models" gap). Fail-closed to the static list when offline.

- **`TROTH_ENTITY_DISPATCH_PREFER`** (entity env) — operator preference for
  the dispatch priority fallback. `hosted` puts cloud faculties (anthropic,
  router) ahead of local; unset keeps the local-first default. Content rules
  (decode constraints, hard reasoning, creative, project preference) always
  run first — this only reorders which faculty answers when no rule fires.
- **`served` entity event** — post-turn attribution truth. The router's
  fallback chain now reports which provider/model ACTUALLY answered
  (`callFallbackChain(body, { wantMeta: true })` → `{ body, served_by }`,
  threaded through the router transport and orchestrator to a
  `{ kind: "served", provider, model }` event before each response).
  Default chain return shape is unchanged for existing callers.
- **`config.routing.pin`** — operator pin: "always use this provider".
  When set to a usable provider name the fallback chain is exactly that
  one entry (no silent fallback — errors surface visibly); a stale pin
  (disabled / no key / cooldown) logs and falls back to the auto chain.
  Substrate dispatch signals are outranked by the pin. Unlike the legacy
  per-class routing prefs (dashboard display only), pin is enforced.

## [0.1.0-bootstrap] — 2026-06-10

Initial public release of the troth substrate engine. This is the bootstrap
cut: the engine, CLI, Claude Code plugin, the plugin MCP servers, and reproducible
benchmarks are public; the polished macOS app and production-tuned configs are
sold separately.

### Added

- **Substrate engine** (`shared-core/`) — event-sourced state machine, classed
  memory (identity / episodic / semantic / procedural / operational /
  ephemeral) with per-class retrieval routing, engram write path, and
  multi-axis recall.
- **STVC** (State-Transition-Validated Cognition) — pre-LLM validation gate
  that rejects invalid substrate transitions before the model is called.
- **Audience field** — `model_visible` / `substrate_internal` /
  `synthesis_of_external` partitioning so internal memory never auto-mounts
  into model context.
- **Operator-key sovereignty** — Ed25519 key, passphrase-encrypted
  (scrypt + AES-GCM), binding the substrate to a single operator.
- **Cross-engine continuity** — the same substrate drives any LLM faculty
  (Anthropic / OpenAI / Google / local llama.cpp / Ollama).
- **CLI** (`bin/troth.js`) — `chat`, `setup`, `doctor`, `init`, `status`,
  `providers`, `model`, `atlas` export/import, `install-plugin`.
- **Claude Code plugin** + the plugin MCP servers (substrate, bash, cache, hashline,
  router).
- **Benchmarks** (`benchmarks/`) — the harnesses, so anyone can measure the
  same properties on the current tree.
- **Honest limits** ([`docs/HONEST-LIMITS.md`](docs/HONEST-LIMITS.md)) — the
  two properties the substrate does not claim to solve.
- The test suite and 5 enforced standards (counts grow release to release; `npm test` prints the current truth).

### Notes

- The substrate-native REPL is the default surface (`troth`). The
  Claude-Code-proxy mode is opt-in via
  `troth config set default_command classic`.
- `tree-sitter` parsers are optional dependencies; the AST-validation stage
  degrades gracefully on hosts without a native build toolchain.

[Unreleased]: https://github.com/xgre1/troth
