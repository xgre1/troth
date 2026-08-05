# Licensing

Copyright (C) 2026 troth. All rights reserved except as granted by the licenses below.

The default license for this repository is **AGPL-3.0-only** (see [LICENSE](LICENSE)).
Everything not otherwise marked below is AGPL-3.0-only.

## Exceptions

- **`plugin/` and all its subdirectories: Apache-2.0** (see [plugin/LICENSE](plugin/LICENSE)).
  This is the Claude Code / agent-host integration layer (hooks, MCP server glue,
  skills, configs). Note: some MCP servers under `plugin/mcp-servers/` load modules
  from `shared-core/` at runtime; the plugin FILES are Apache-2.0, but a combined
  work that includes the AGPL core remains governed by AGPL-3.0-only.

## What is in this repository, and what is not

troth ships in two parts. This repository is the engine: the substrate, the
governance walls, the tools, the proxy, the CLI and the Claude Code plugin. It
is complete and it runs on its own.

A closed overlay adds the autonomy layer (unattended goal pursuit, the
sandboxed VM body, the scheduler that drives them) and is not published here.
Comments in this tree occasionally name a module that belongs to it, because a
seam has to say what it is a seam for; those modules are absent by design, not
by accident, and nothing here depends on them to work. README's feature matrix
lists which capabilities are which.

## Runtime-downloaded third-party artifacts

troth fetches these onto the user's machine at runtime; each stays under its own
upstream license (see THIRD-PARTY-LICENSES for the notices):

- `llama-server` binary (llama.cpp) — MIT, © The ggml authors
- Whisper GGML speech models — MIT, © 2022 OpenAI (+ ggml conversion)
- `bge-reranker-v2-m3` GGUF — Apache-2.0, © BAAI
- `embeddinggemma-300M` GGUF — Google **Gemma Terms of Use**
  (https://ai.google.dev/gemma/terms) including the Gemma Prohibited Use Policy
  (https://ai.google.dev/gemma/prohibited_use_policy). Commercial use permitted;
  your use of the embedding model is additionally subject to those terms.

## Commercial licensing

The copyright holder offers the AGPL-3.0-only components under separate
commercial terms. Contact: hello@troth.one
