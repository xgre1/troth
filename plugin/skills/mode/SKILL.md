---
name: mode
description: Put THIS conversation in plan mode (reads and proposals only, writes and commands off) or back in build mode. Bare /mode shows the current mode.
allowed-tools: []
kind: deterministic
---

The operator wants to think with the partner before anything changes. Plan
mode is scoped to this conversation (a pane by its id, the terminal surface as
one shared surface), survives a daemon restart, and ends with `/mode build`.

Deterministic protocol (no LLM, no substrate write beyond the command trace):

1. `/mode plan` turns plan mode on. From the next turn the partner reads and
   proposes; Write, Edit, Bash, job_stop, image_generate, video_generate and
   vault_capture refuse with a reason that names `/mode build`.
2. `/mode build` turns plan mode off; writes and commands are on again.
3. Bare `/mode` reports the current mode and the two options.

Reply structure (terse, always names the scope):

```
✓ plan · writes and commands are off for this pane; /mode build turns them back on
```
