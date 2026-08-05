# Setup guide

This walks through a from-source install. Quick version: clone, `npm ci`, then `troth setup` to pick an engine, then `troth`.

## 1. Requirements

- **Node.js >= 22** (`node --version`)
- **Claude Code CLI** if you want the Claude faculty: `npm install -g @anthropic-ai/claude-code`. If it is missing, troth offers to install it on first run (and tells you the exact command in non-interactive shells).
- `better-sqlite3` is a native module. macOS with Xcode Command Line Tools builds it out of the box. Minimal Linux images need a toolchain first: `apt-get install -y build-essential python3` (or your distro's equivalent).

## 2. Install from source

```bash
git clone https://github.com/xgre1/troth.git
cd troth
npm ci
```

Optional, for a global `troth` command:

```bash
npm link
```

## 3. First run

```bash
node bin/troth.js
```

First run does exactly this and exits:

- writes a default config to `~/.troth/config.json`
- starts the local proxy and opens the dashboard at `http://localhost:8000/ui`
- prints where to add a provider

## 4. Add a provider

**Cloud (bring your own key):** dashboard, **Providers**, enable a provider and paste your own API key, Save.

**Local:** run a llama.cpp or Ollama-compatible server, then dashboard, **Settings**, set backend host, port and model name.

**ChatGPT subscription:** troth can talk to the ChatGPT Responses backend with your own ChatGPT account instead of an API key. Sign in with `troth codex login`, or press the ChatGPT button in the app.

Read this once before you do, because the choice is yours to make:

- It signs into **your** ChatGPT account and spends **your** subscription quota. Nothing is billed anywhere else, and no account of ours is involved.
- The sign-in presents the public OAuth client identifier that Codex clients use. It is not a secret and not a credential: a desktop client authenticates with PKCE, so holding that identifier grants nobody anything. It answers *which application is asking*, and troth answers with the value the endpoint recognises, because sending an unrecognised one costs access to the newest models.
- **troth is not affiliated with or endorsed by OpenAI**, and this interface is not documented by OpenAI for third-party clients. It can change or stop working without notice, and your use is subject to OpenAI's terms.

Both values are overridable, so you can present something else if you would rather:

```bash
export TROTH_CODEX_CLIENT_ID=...      # defaults to the public Codex client id
export TROTH_CODEX_ORIGINATOR=...     # defaults to the matching originator
```

A GUI app inherits no shell environment, so the desktop app reads the same two values from one line each in `~/.troth/codex-client-id` and `~/.troth/codex-originator`. Set either one to `none` and the provider stays off, saying why, and nothing else is affected.

## 4b. The two small models it runs locally

Recall uses two local models that troth downloads on first use and runs on
your machine: an embedding model of about 320 MB, which turns what you say
into something searchable, and a reranker of about 610 MB, which orders the
results. With the small `llama-server` runtime they need, that is roughly
950 MB arriving the first time your partner stores or recalls anything.
Nothing asks first, so plan for it. They are what makes memory work without
sending anything anywhere, and they serve whichever engine you talk to.

They live under `~/.troth`, spawn as `llama-server` processes on ports 11437
and 11438, and stay resident while troth is running. `troth doctor` lists
them, and says how to stop any that outlived their parent.

They default to CPU, which costs a few milliseconds per lookup and keeps
your GPU free. Set `TROTH_NGL=999` to move them onto the GPU if you would
rather trade the memory for the speed.

Nothing about this is required, but know what you lose: without them recall
falls back to plain word matching instead of meaning, which is quieter and
worse rather than broken. `troth doctor` says which of the two modes you are
actually in.

## 5. Talk

```bash
node bin/troth.js        # local backend
node bin/troth.js -g     # route through the proxy to cloud providers
```

Your partner's substrate lives at `~/.troth/state.db`. It grows with use and survives model swaps; back it up like any file that matters to you.

## 6. Claude Code plugin (optional)

To mount troth inside Claude Code or another MCP host (hooks, skills, and 4 MCP servers wired by default), follow [`MCP-HOST-INSTALL.md`](MCP-HOST-INSTALL.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` fails to build | Install a C++ toolchain (see Requirements), then `npm install` again. |
| "Claude Code CLI not found" | `npm install -g @anthropic-ai/claude-code`, or use a BYOK/local provider. |
| Dashboard does not open | Visit `http://localhost:8000/ui` manually; another process may own port 8000. |
| Remote machine cannot reach the proxy | That is the default. Set `GF_BIND_HOST=0.0.0.0` and send the bearer token from `~/.troth/config.json` (`remoteToken`) as `Authorization: Bearer <token>`. |
