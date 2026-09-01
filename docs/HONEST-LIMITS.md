# Honest limits — what troth solves, what it flags, and what nobody solves yet

troth is substrate-as-mind: persistent identity, memory continuity,
drift detection, compiled procedures, multi-axis retrieval. Real
mechanisms with measurable benchmarks
([`benchmarks/results/`](../benchmarks/results/)).

This page documents what troth **deliberately does not claim to solve**,
so users and contributors can decide whether the actual deliverables
match what they need. Better to under-promise than to ship a "fake
partner" experience.

Audited against: 0.1.18 (2026-09-01). The release gate refuses to ship a
newer version until this line moves with it: an honesty page that stops
being re-read stops being honest.

Two different questions live on this page, and they have different answers.
What the *mind* does — holding a position under pressure, knowing what it
knows — is detected, not prevented; no shipped stack prevents it. What the
*hands* do — files, shell, network — is prevented at the kernel on macOS and
guarded at the tool layer everywhere else. Read "does not prevent" below as
a statement about the first, never about the second.

---

## Two genuinely unsolved properties

These are open research problems across the whole field, not only here.
troth flags them for the operator; it does not prevent them. This is about
the model's judgment, not about what its hands may touch — that is governed
separately, and described further down.

### Conviction — holding a position under pressure

A real collaborator pushes back when they think you're wrong and updates
only when you show them new evidence. The LLMs troth orchestrates
(Claude, Kimi, GPT, Gemini, Qwen, Llama, etc.) are RLHF-trained toward
helpfulness, which produces sycophantic agreement under sustained
pressure. The substrate detects drift after the fact, but cannot
prevent the model from folding mid-turn.

What troth does about it:
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

What troth does about it:
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
- **Governed hands** — on macOS every shell command runs inside a
  per-command kernel sandbox shaped to the ground it stands on; package
  installs land in a jail that cannot see your home; everything a command
  or an edit stands to change is photographed for undo before it lands;
  publishing destinations can be guarded behind a gate that must pass on
  the exact tree being pushed. Prevention, not detection — the one place
  on this page where that word applies.

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

- **Not encrypted at rest.** `~/.troth/state.db` is a normal SQLite file on
  your disk. What it holds is structured engrams with provenance, not
  transcripts — but anyone with disk access can read it all the same.
  `troth init --seal` adds an encrypted vault for operator-confirmed
  memories; encryption of the whole substrate is an open item, and until it
  lands, disk access equals memory access. Treat backups accordingly.
- **Single operator by design.** One substrate serves one person. There is
  no multi-tenant isolation inside a single `~/.troth`.
- **Tested on macOS and Linux.** The full suite runs green on both in CI on
  every push (Node 22). The kernel wall is macOS today; on Linux the same
  commands run behind the tool-layer guards.
- **Version 0.1.x.** Interfaces can still move before 1.0.

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
and says what that means. What that worker can touch depends on one thing:
whether troth is connected to your Claude Code. The worker inherits your
`~/.claude` as it is. If troth is connected — the step that installs
troth-bash and its steer hook — the hook refuses the worker's native shell
and routes every command through troth-bash: on macOS that is the same
per-command kernel wall the interactive shell gets, with the same install
jail, undo photographs and guarded publish destinations; on Linux it is the
same tool-layer guards. If troth is NOT connected, the worker has ordinary
host access with no wall, and that is the shape to assume until you have
checked. `--dangerously-skip-permissions` removes Claude Code's prompts; it
does not remove troth's wall, because the wall never depended on a prompt.
The sentence elsewhere in our docs about "Docker isolation" describes the
container path only. If that is more autonomy than you want, run it with
Docker up, or do not use `troth run` at all; nothing else in the open tree
starts an unattended worker.

The interactive shell is a different lane with a different answer. On macOS
every command the partner's hands run is wrapped in a per-command kernel
sandbox (Seatbelt): ssh key material and cloud credential stores are
unreadable, the substrate and its policy files take no writes, and partner
project ground is deny-default — the project and its scratch, nothing else.
No prompt is involved and nothing depends on a judgment call at the moment
of running. On a host without that runtime — Linux today — the same commands
run with no kernel wall at all, the tool output says so, and what remains
are the tool-layer guards (path policy, bash judgment, STVC). A kernel wall
for Linux is an open item, not a promise.

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
- **A team substrate.** One substrate serves one person by design; there is
  no multi-tenant isolation inside a single `~/.troth`.
- **A kernel wall on Linux today.** The per-command sandbox is macOS
  (Seatbelt). On Linux the same commands run behind the tool-layer guards
  only — path policy, bash judgment, STVC — and the tool output says so.
- **An encrypted substrate at rest today.** `troth init --seal` seals
  operator-confirmed memories; the rest of `state.db` is readable by anyone
  with disk access until whole-substrate encryption lands.
- **A hosted service with nothing on your machine.** The mind is a file on
  your disk; that is the point, and there is no cloud copy of it.
- **Unattended autonomy from the open tree.** The open tree is the governed
  partner in manual use. Background autonomy belongs to the paid app layer,
  and today it is not shipped there either.

Conviction under pressure and knowing-what-it-knows are deliberately not on
this list: no product on the market delivers them, so they are not a reason
to choose a different one. They are documented at the top of this page as
the field-wide limits they are.

And troth is not black-box memory you install and forget: the substrate
reads, digests and recalls on its own every turn, and a fleet of background
passes — contradiction and drift scans, instance consolidation, identity
extraction, embedding backfill, backups — runs on cadence with nobody
watching. It still rewards a partner who names goals and saves decisions:
unattended it works; with named intent it works better.

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
