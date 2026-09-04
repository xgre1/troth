---
name: inspect
description: Read the operator's machine and troth's own state through the proxy — burners, unified log, proxy log, plan window, a ChatGPT-lane probe — without asking the operator to run anything.
allowed-tools: ["Bash"]
kind: deterministic
---

The partner's shell runs inside a ground wall. Two things no wall can carry:
setuid tools (`ps`, `top`) refuse to exec under a seatbelt, and `log show`
refuses to run while sandboxed. `~/.troth` stays dark by design (keys, the
token store, the substrate database). The proxy runs OUTSIDE the walls under
its service manager and answers these questions on your behalf, read-only,
localhost-only, redacted. Use these roads; never ask the operator to run
`ps`, `top`, `log show` or an engine probe for you.

All at `http://localhost:8000` (or the port in `TROTH_PROXY_URL`):

- **What is burning the machine** — `GET /api/system/load`: troth's own
  processes (role, pid, memory, CPU seconds, port, idle countdown) and
  `top.by_cpu` / `top.by_rss`, the machine-wide leaders by CPU time consumed
  and by resident memory, command name only. CPU time consumed identifies a
  burner; %CPU is a lifetime average and lies.
- **What the system logged** — `GET /api/system/log?last=5m&predicate=process == "troth-app"&limit=200`:
  a bounded `log show`. `last` is a number and a unit (`30s`, `5m`, `2h`, at
  most a day); the predicate is plain `log` syntax; macOS only.
- **What the proxy logged** — `GET /api/logs?grep=PAYLOAD&limit=40` over a
  2000-line buffer (`since=<ms>` for the newer part). `PAYLOAD BREAKDOWN` and
  `PAYLOAD AFTER INJECT` lines measure a lane's request shape.
- **Does the ChatGPT lane answer** — `GET /api/providers/codex/probe?model=gpt-5.6-sol`:
  one word through the proxy's own token. Answers `ok` and the model that
  served, or the status, the reason and `resets_in_seconds` on a plan limit.
  The token never leaves the proxy.
- **Usage and the plan window** — `GET /api/stats`
  (`persistent_provider_usage.recent_5h.by_model`), `GET /api/usage/plan-window`.
- **Health** — `GET /api/health/vitals`, `GET /api/doctor`,
  `GET /api/providers/codex/status`, `GET /api/config` (redacted).

Writing a handoff file for the operator: run from the operator's own folder
(`cwd: ~/Desktop` or a project). The tree holding the substrate
(`/Users/<operator>`) is scratch-only ground.

If the proxy is offline (curl fails), say so plainly; do not invent numbers.
