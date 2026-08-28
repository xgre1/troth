// SPDX-License-Identifier: AGPL-3.0-only
// The CLI command surface, as DATA. One list, two consumers: bin/troth.js
// builds its dispatch Set from it, and the proxy's /api/commands reference
// serves it to the dashboard. Kept as data, never as a literal regexed out
// of troth.js source: shipped source is minified, a source-shape pattern
// stops matching, and the reference returns zero commands.
// Data survives minification; source-shape never has to.
module.exports = [
  "setup", "init", "doctor", "accounts", "start", "restart", "tail", "reset",
  "service",
  // Ground registry: which of the operator's own folders the partner may
  // work in with the operator's environment. The only writer of that file.
  "open", "close", "opened",
  "version", "help", "ui", "app",
  // `troth classic` as an explicit subcommand: force Claude-Code-through-proxy
  // for ONE run without flipping default_command (the gate below honors it).
  "classic",
  // Run lifecycle:
  "run", "status", "logs", "diff", "merge", "kill", "clean",
  // MCP server (stdio protocol for AI chat agents):
  "mcp",
  // ChatGPT-subscription OAuth (cmd-codex.js). Kept as its OWN entry:
  // folded into the comment above it, `troth codex login` — the command
  // docs/SETUP_GUIDE.md tells people to run — answers "Run not found".
  "codex",
  // Scheduled runs (the timer is off unless TROTH_ENABLE_SCHEDULER=1):
  "schedule",
  // Scaffolding introspection:
  "stats", "telemetry", "checkpoint", "rollback", "reflect", "dream", "plan",
  // Memory management:
  "memory-clear",
  // Plugin ecosystem:
  "mcp-audit", "install-plugin", "uninstall-plugin",
  // Substrate CLI:
  "race", "race-result", "atlas",
  // Counterfactual replay CLI:
  "replay", "record-intent",
  // Schema reflector CLI:
  "schema",
  // Mind layer introspection CLI:
  "mind",
  // Knowledge import (curriculum tier — pre-Chameleon):
  "knowledge",
  "agents",
  // L3 Chameleon Protocol — adapter registry + runtime driver:
  "chameleon",
  //  multi-tenant + role orchestrator:
  "tenant", "orchestrate", "orchestrate-status",
  //  incognito mode (substrate read-only, no writes/persists):
  "incognito",
  //  substrate skills layer — human-facing REPL on top of the
  // troth substrate brain. Use the same backend, same tools, same
  // substrate that the voice app uses; bypass `claude` entirely.
  // `cli` is the canonical name; `chat` is kept as a back-compat alias.
  "cli",
  "chat",
  // autonomous mode — REPL into the autonomous runtime. Same partner
  // as cli/chat/app, just reached through the signed control channel.
  // `troth body` interactive, `troth body --once 'go build X'`
  // one-shot for scripts + Claude-as-operator autonomous use.
  "body",
  //  local llama-server KV slot health-check (Mode A
  // physical-continuity diagnostic). Pure HTTP probe, no proxy spawn.
  "kv-state",
  // operator-controlled config gate for autonomous features.
  // `troth config l4 <get|enable|disable|set|verify>` mirrors the
  // dashboard knobs from the shell.
  "config",
  // design: operator cryptographic surface.
  // init     — first-time substrate bootstrap (integration point root)
  // confirm  — promote an llm_inferred engram to operator_confirmed (signed)
  // pause    — global kill-switch on (signed)
  // resume   — global kill-switch off (signed)
  // recover  — re-anchor authority via pre-authorized recovery key
  "init", "confirm", "pause", "resume", "recover",
  // design: operator presence proof + WAL replication
  "presence", "replicate-wal",
  // design: operator seal for high-irreversibility intents
  "seal",
  // design: encrypted vault (cryptographically protected, capability-scope auto-attach)
  "vault",
  // design: voice profile (faculty-swap continuity)
  "voice",
  // design: end-of-life inheritance (successor claim)
  "inheritance",
  // substrate sync — one mind, many devices: pair devices on the mind
  // machine (device add/list/revoke) and point a satellite install at it
  // (sync connect/status/flush/off).
  "device", "sync",
  // design: operator-self primitives for autonomous setup
  "cap", "schedule", "project",
  // design: vessel deployment wrapper. Spawns / manages the
  // partner docker container locally OR remotely (DOCKER_HOST=ssh://).
  "partner",
  // design: two-regime FS graduation: copy sandbox workspace to
  // operator host path after scanner + diff review.
  "graduate",
  // design note — session-scoped signer cache. `troth unlock`
  // unlocks the operator key once for N hours; subsequent CLI calls
  // pick up the cached signer instead of re-prompting passphrase.
  // `troth lock` wipes the session.
  "unlock", "lock",
  // design audit — draft active_project pipeline. When operator
  // chats with the partner and the substrate classifier detects a
  // directive shape, a DRAFT active_project lands at llm_inferred
  // tier. Operator inspects + confirms via `troth drafts confirm <id>`
  // to promote to operator_confirmed — uses session cache so no
  // passphrase prompt. `troth drafts list` shows the queue.
  "drafts",
  // Read-only activity snapshot for Tauri Activity tab + CLI overview.
  "activity",
  // operator audit step — operator audit verifier. `troth audit verify`
  // walks the tamper-evident signed_audit chain end-to-end and exits 0
  // on intact / 1 on first tamper / 2 on bad invocation. The design
  // acceptance A4.4.
  "audit",
];
