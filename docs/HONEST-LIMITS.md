# Honest limits — what troth does NOT solve

troth is substrate-as-mind: persistent identity, memory continuity,
drift detection, compiled procedures, multi-axis retrieval. Real
mechanisms with measurable benchmarks
([`benchmarks/results/`](../benchmarks/results/)).

This page documents what troth **deliberately does not claim to solve**,
so users and contributors can decide whether the actual deliverables
match what they need. Better to under-promise than to ship a "fake
partner" experience.

---

## Two genuinely unsolved properties

These are open research problems across the whole field, not only here.
troth flags them for the operator; it does not prevent them.

### Conviction — holding a position under pressure

A real collaborator pushes back when they think you're wrong and updates
only when you show them new evidence. The LLMs troth orchestrates
(Claude, Kimi, GPT, Gemini, Qwen, Llama, etc.) are RLHF-trained toward
helpfulness, which produces sycophantic agreement under sustained
pressure. The substrate detects drift after the fact, but cannot
prevent the model from folding mid-turn.

What troth offers that helps marginally:
- A drift signal that flags suspected agreement-without-evidence in
  conversation history; it surfaces in the next prompt's context.
- Optional base models with less aggressive helpfulness tuning produce
  better stance-holding when available.
- The known limit is documented; no shipped feature claims to solve it.

### Metacognitive integrity — "knowing what it knows"

Reliably saying "I don't know" instead of generating confident-sounding
plausible content remains unsolved across reasoning depths. Substrate
write-time integrity catches contradictory or near-duplicate notes and
flags them; it does not catch pattern-match-presented-as-analysis on
complex reasoning.

What troth offers that helps narrowly:
- Write-time verification flags contradictory engram writes so the
  substrate stops silently accumulating contradictions.
- A critic hook catches some "promise without follow-through" patterns
  at turn boundaries.

---

## What troth does solve

Different category of problem, all real and measurable:

- **Cross-session memory** — engram pool persists; the next session
  sees prior facts and decisions.
- **Cross-surface identity** — voice and CLI and plugin share the same
  identity state via the substrate.
- **Compiled procedures** — recurring tool-call sequences are detected
  daily and surfaced as hints.
- **Multi-axis retrieval** — semantic + temporal + causal + entity
  signals are fused per lookup.
- **Write-time integrity** — contradiction and duplicate flagging at
  engram write.
- **Always-present identity surface** — extracted facts are promoted
  as foundational context for each turn.
- **Idle processing** — contradiction scans, drift detection, anchor
  suggestions, and procedure detection run in the background.
- **Drift / sycophancy detection** — surfaced as insights after the
  fact (detection, not prevention — see "Conviction" above).

---

## Reading the benchmarks honestly

The headline numbers in [`README.md`](../README.md) are real and
reproducible (see [`benchmarks/results/`](../benchmarks/results/)),
but they measure specific properties:

- **Cross-session recall** measures persistent memory, not conviction.
  A model can remember your codebase perfectly and still cave when you
  push back.
- **Anti-sycophancy** is measured against contradictory inputs with the
  explicit disagreement rule enabled. With the rule off (default for
  general workloads), the LLM still defaults to agreement.
- **Self-detection of drift** is detection, not prevention. The signal
  flags the issue after the in-flight turn has already happened.

---

## Operational limits (current release)

- **The substrate is plaintext at rest.** `~/.troth/state.db` is a normal
  SQLite file on your disk. At-rest encryption is planned; until then,
  disk access equals memory access. Treat backups accordingly.
- **Single operator by design.** One substrate serves one person. There is
  no multi-tenant isolation inside a single `~/.troth`.
- **Primary testing is macOS + Node 22.** The suite runs green there;
  Linux is expected to work (CI covers it) but has had less real-world use.
- **Version 0.1.x bootstrap.** Interfaces can still move before 1.0.

---

## When to use troth, and when not to

**Use troth when:**
- You want substrate-backed memory continuity across sessions.
- You work across multiple surfaces (CLI, voice, plugin) and want the
  same identity in all of them.
- You want recurring workflows detected and surfaced.
- You want drift and sycophancy detected so you can correct course.
- You want a local-LLM-first stack with optional cloud fallback.
- You want measurable benchmarks rather than marketing claims.

**Also know what this repo deliberately gates off** (see the feature matrix
in [`README.md`](../README.md)): autonomous background operation and the VM
body belong to the closed overlay and are NOT in this tree at all; today they
are not shipped in the paid app either. There are no `/api/l4/*` routes here
to switch on. File that as the designed boundary, not a bug.

Two things here deserve naming, because they are the closest thing in the open
tree to acting on their own.

The first is `troth run "<task>"`. It creates a git worktree in your
repository and spawns a Claude Code worker against it, and unlike the
scheduler below it needs no environment variable: it is available the moment
you install. When Docker is running the worker executes inside a container.
When Docker is NOT running, and that is the default state of most machines,
it falls back to a plain subprocess on your host and launches the worker with
`--dangerously-skip-permissions`, which turns off Claude Code's own approval
prompts for that process. The status line says `mode: subprocess (no Docker)`
and now says what that means. This is the honest shape of it: a real
unattended worker with host access, one command away, and the sentence
elsewhere in our docs about "Docker isolation" describes the container path
only. If that is more autonomy than you want, run it with Docker up, or do
not use `troth run` at all; nothing else in the open tree starts a worker.

The second is `proxy/modules/scheduler.js`, the v6.3
time-based scheduler behind `troth schedule`. When a schedule fires it runs
`git worktree add -b troth/<runId>` in your repository and spawns a worker
against that worktree with nobody watching. The timer does not run unless you
set `TROTH_ENABLE_SCHEDULER=1`, and with it off the CLI and the API say so
rather than quietly storing work that never happens. It is a clock, not the
autonomy layer: it has no goals, no heartbeat and no judgment about when to
act. It does exactly what you wrote in `~/.troth/schedules.json`, at the times
you wrote.

**Don't use troth if you need:**
- An agent that reliably pushes back with conviction during a
  conversation. No zero-training stack solves this today.
- An agent that reliably refuses to hallucinate on complex reasoning.
  Same — open research problem.
- A turnkey "AGI partner" experience. No shipping product is this yet.
- Hands-off magic. troth works best when you actively use the
  substrate primitives rather than treating it as black-box memory.

---

## What the harness enforces about its own tests

Until 2026-07-31 the test runner started every async test body at load time
and only serialised the awaiting, so bodies from different suites shared one
event loop. Three tests turned out to pass only because of that overlap:
one raced a require-cache wipe, two spawned daemons before another suite
moved HOME. The runner is now genuinely serial and all three were fixed to
pin what they depend on. It is recorded here because a test that passes by
accident is not evidence, and finding three of them is the strongest reason
to keep re-checking the rest.

---

The honest answer: troth closes some real gaps, names the ones it
doesn't, and leaves the operator informed enough to decide.
