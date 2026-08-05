---
description: Escape hatch — force the next action to route to the strongest available model (claude-opus-4-7 with max effort). Use sparingly.
argument-hint: Optional note about what's hard (otherwise inherits the current task).
---

# /hard

The task that follows is genuinely hard — architectural design, tricky debugging, security-sensitive refactor, or similar. You are instructed to approach it with maximum care:

1. **Think longer.** Use extended reasoning for this turn.
2. **Read more.** Pull in adjacent files, prior commits for this area, and related tests before proposing a change.
3. **Sanity-check your work.** Before Writing/Editing, explain your plan in 3-5 bullets. Only proceed if each bullet is defensible.
4. **Prefer small, reversible steps** over one big speculative change. If you aren't sure, split the task.

Ignore speed optimisation instructions from other hooks for this turn only. Token cost is secondary; correctness is primary.

Context from user: $ARGUMENTS
