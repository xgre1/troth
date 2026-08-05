---
name: engine
description: Override which engine answers THIS conversation from now on (per pane, wins over the global pin). Bare /engine shows the current effective engine and options.
allowed-tools: []
kind: deterministic
---

The operator wants to steer WHICH engine answers this one conversation, without
touching the global engine pin that governs every other pane. The override is
scoped to this conversation_id, wins inside this pane over the global default,
and lasts for the life of the daemon (an app restart drops it).

Deterministic protocol (no LLM, no substrate write beyond the command trace):

1. `/engine <engine>` sets the per-pane engine. Recognized words:
   - `claude`   -> the Claude engine (claude_cli faculty)
   - `chatgpt`  -> the ChatGPT engine (codex_oauth faculty)
   - `local`    -> the on-device model (llamacpp faculty)
   - `kimi`     -> rides the backbone engine setting; NOT switchable per-pane in
     v1 (Kimi is selected by the global backbone env, not a faculty). Reply
     honestly and point the operator at Settings.
   - router provider names (`deepseek`, `openrouter`, `nvidia`, `deepinfra`,
     `alibaba`, `router`) -> the router faculty. The router walks its own
     configured provider chain; v1 cannot cheaply pin ONE provider inside the
     router without touching the shared router module, so this selects the
     router faculty and says so.
2. `/engine auto` clears the per-pane override — this pane falls back to the
   global default dispatch again.
3. `/engine auto local-first` / `/engine auto best-first` set the pane's dispatch
   preference (local-first = try the on-device model first; best-first = try the
   hosted/subscription engines first). v1 applies this to NEW turns in this pane.
4. Bare `/engine` reports the current effective engine for this pane plus the
   list of available engine words.

Reply structure (terse, always states the SCOPE = this pane only):

```
Engine for this pane -> <engine> (<faculty>).
This pane only; other panes keep the global default. Lasts until the app restarts.
```

For a report/no-change form:

```
This pane: <effective engine>.
Options: claude | chatgpt | local | auto | auto local-first | auto best-first
         (router providers: deepseek, openrouter, nvidia, ...).
```

The override is stored in the daemon's per-conversation engine map and consulted
at the dispatch site BEFORE the global pin fence, so an explicit /engine override
beats the global pin (operator explicitness wins) and the dispatch frame carries
an `engine_override` annotation so the trace shows why this pane routed where it
did. Do NOT write anything durable to substrate for this command; it is a
runtime routing switch by design, exactly like /context and /mcps are read-only.
