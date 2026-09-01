# The ground your commands run on

troth's hands — the shell behind its tools — do real work on your real
machine. On macOS, every command they run is wrapped in a kernel sandbox
profile built for the ground it stands on. No prompt asks you to approve
anything, and nothing depends on someone judging a command correctly at the
moment it runs: the wall is the kernel's answer.

## The grounds

- **Your own folders.** Work the operator opened runs as your own machine —
  ordinary reads, ordinary writes — minus the short list of walls below.
- **Partner project ground.** A project the partner manages is deny-default:
  writes land in the project and its scratch, nothing else. A path that
  claims to be inside the project and is not is refused, never run bare.
- **The substrate.** `~/.troth` — the partner's own memory — takes no writes
  from any walled command, and its contents stay dark behind a stat pinhole,
  so path walks and installs survive without reading it.
- **Ground nobody declared.** Writes confine to the folder itself. When the
  folder is your own work, the partner opens it for the session from its own
  hand — a one-line purpose on record, the tree photographed for undo first —
  and your permanent registry never takes a write from it. Foreign code and
  the substrate never open, by anyone's hand.

## What is always dark

ssh key material and cloud credential stores (`~/.aws`, `~/.gnupg` and their
kin) are unreadable on every ground. The keychain takes no writes while the
stored git credential keeps serving ordinary pushes, and the ssh agent keeps
answering — agent-side git works untouched. The host inventory everyday
connections need (`known_hosts`, the ssh client config) stays readable
through literal read-only carves; the keys beside it never travel with it.

## What is always open

Your work. A wall that blocks a legitimate workflow is treated as a bug in
the wall: builds, installs, tests and pushes run to completion inside the
walls, and the release checks themselves run from the partner's own hand.
A refusal is never a dead end — it says which wall spoke and names a road
the partner can take itself: opening your own folder for the session,
widening one project's install registry list with the reason on record,
per-repo configuration for the files no ground writes.

## Undo rides along

Before a command or an edit lands, the files it stands to change are
photographed into a content-addressed shadow repository. `troth checkpoint`
photographs by hand, `troth checkpoint list` shows what is held, and
`troth rollback` restores — reversibly, because the restore first
photographs the state it replaces. Retention keeps the footprint bounded.

## Where the kernel wall stops

A host without the sandbox runtime — Linux today — runs the same commands
without the kernel wall; the tool-layer guards stay on — path policy, bash
judgment, STVC, undo photographs, guarded publish destinations — and the
tool output says which layer answered. A kernel wall for Linux is an open
item, not a promise.

The walls prove themselves on every proxy boot — engagement, the credential
road, the read carves, the jail — and the verdicts ride the health board at
`/api/doctor`.
