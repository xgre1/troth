# troth as the memory of Hermes Agent

Hermes Agent keeps its own notes in `MEMORY.md` and `USER.md`; this provider
gives it troth's memory instead: before each model call it receives the same
context the Claude Code hooks build (identity, standing rules, recall, open
goals), the session starts with troth's orientation, and every completed turn
is recorded back into the substrate.

## Install

Copy this folder to `~/.hermes/plugins/memory/troth/`, then:

```
hermes memory setup      # choose troth; proxy_url defaults to http://127.0.0.1:8000
```

or set it by hand in `~/.hermes/config.yaml`:

```yaml
memory:
  provider: troth
  memory_enabled: false        # one memory: troth keeps it, Hermes reads it
  user_profile_enabled: false
```

The troth proxy must be running on this machine (`node bin/troth.js restart`).
Tools reach Hermes through troth's MCP servers: see `docs/MCP-HOST-INSTALL.md`,
section "Hermes Agent".

## What it calls

| Hermes hook | troth proxy route |
|---|---|
| `system_prompt_block()` | `POST /api/context/session` |
| `prefetch(query)` | `POST /api/context/prompt` |
| `sync_turn(...)` | `POST /api/substrate/dialogue/record-turn` |
| `on_memory_write(...)` | the same route, as an assistant note |

The provider is written against the Hermes memory-provider contract as
published in its developer guide; the argument names of `sync_turn` and
`on_memory_write` are read defensively because the guide does not fix them.
