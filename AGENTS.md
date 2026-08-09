# troth — agent guide

You are reading this because an operator cloned troth and opened it with an AI
tool. Your job is to get their partner running. Everything is local; nothing
phones home.

## Set it up for your operator

Ask one question: **what do they already pay for?** Then follow that path.

| They have | Do this |
|---|---|
| Claude Pro/Max | `node bin/troth.js install-plugin` — mounts troth inside Claude Code AND wires their plan as an engine for troth's own chat. No key touches disk. |
| ChatGPT Plus/Pro | `node bin/troth.js codex login` (browser OAuth), then write config: `{ "providers": { "openai_sub": { "enabled": true } } }` |
| Kimi Code plan | config: `{ "providers": { "kimi_sub": { "enabled": true, "apiKey": "<key>", "model": "k3" } } }` |
| An API key | config: `{ "providers": { "<name>": { "enabled": true, "apiKey": "<key>" } } }` — names: `anthropic`, `deepseek`, `openrouter`, `deepinfra`, `alibaba`, `moonshot`, `google_ai`, `xai`, `zai` |
| Nothing yet | Run `node bin/troth.js setup` and let them pick in the dashboard. |

Config lives at `~/.troth/config.json`. Write it with owner-only permissions.
Enable **one** provider to start — troth fails over between enabled ones, and
more can join later from the dashboard (Engines page).

Then prove it works — do not stop at "configured":

```
node bin/troth.js doctor    # what is configured vs what actually answers
node bin/troth.js           # the chat REPL — send one message, watch it reply
```

Dashboard: `node bin/troth.js ui` (or `setup` on first run). The sidebar is
five doors — Dashboard, Memory, Engines, Settings, Help — with the deep views
under Advanced.

## Memory

Embeddings and reranking install themselves locally on first run — no provider
entry, no key. Offer the operator a history import (dashboard → Memory →
"Import your chat history"): Claude Code and Codex conversations already on the
machine become recall. Additive; nothing is deleted.

## Browser

Once the plugin is mounted you have a `browse` tool (troth-bash server): a real
Chrome over CDP. Navigate, read the DOM, click and fill through `eval`,
screenshot. Call it with no port and it finds or starts the troth browser with
a private profile; nothing needs to be running first. Do not script around it
(no puppeteer installs, no throwaway selenium): the tool already is the
browser. Port 9222 attaches to the operator's own debug Chrome and is their
opt-in, never yours to start.

## Rules for you, the agent

- Never echo, log, or commit an API key. Config is written to disk, not pasted
  into chat. `~/.troth/` never enters version control.
- Do not suggest local chat models — local models here serve **memory**
  (embeddings + reranking), which installs itself. Chat routes through the
  operator's plan or key.
- Do not start daemons beyond the proxy (`node bin/troth.js restart` manages
  it). Subcommands you don't recognize: read `node bin/troth.js help` first —
  some start long-lived processes.
- After setup, the proof is one real reply in the REPL, not a green config.

## Map

- `llms.txt` — full project map, integration surfaces, architecture pointers
- `docs/SETUP_GUIDE.md` — the human-facing version of this file
- `docs/HONEST-LIMITS.md` — what the substrate does not claim to solve
- Contributors: `npm test` (unit), `npm run journey` (behaviour scenarios
  against the shipped surfaces on a throwaway HOME)
