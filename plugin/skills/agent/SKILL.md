---
name: agent
description: One slash for the entire sub-brain workflow — list, create, switch, team-dispatch, retire, cancel. Behavior follows from args; nothing else to remember.
argument-hint: [name] [+ | --new] [--tag X] [--persona "..."] | <name>,<name2> <task> | stop [group_id] | retire <name>
allowed-tools: []
kind: deterministic
---

The operator wants something with sub-brains. The skill picks the right action from the args:

> $ARGUMENTS

Argument shape → behavior:

| Args | What happens |
|---|---|
| (empty) | List registered sub-brains, mark the active one |
| `<name>` (exists) | Switch active sub-brain to `<name>` |
| `<name>` (missing) | Error — suggest `+` to create |
| `<name> +` or `<name> --new [--tag X] [--persona "..."]` | Create sub-brain, parent = current active agent |
| `<name1>,<name2>[,...] <task...>` | Team dispatch — fan task across N sub-brains in parallel, each in its own substrate slice |
| `stop` or `stop <group_id>` | Cancel team dispatch (most recent group, or specified) |
| `retire <name>` | Mark sub-brain inactive (kept for audit) |

Why one skill: minimum surface area for the operator. The substrate-as-identity workflow has one entry point (the agent), and what you do with it is shaped by what you say next — no separate `/create`, `/team`, `/brains`, `/kill` to memorize.
