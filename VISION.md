# Where troth is going

If you read one module in this tree and wonder why it is here, this document is the answer. troth is not a chat proxy plus features; it is a deliberate build toward one thing:

**a partner that can act on its own behalf, safely, on a machine you own.**

Every subsystem below exists as an organ for that destination. Read the tree through this lens and the parts stop looking like scope creep and start looking like anatomy.

## The organs, and why each exists

- **The substrate** (`shared-core/`) — a mind that survives the model. Engrams, multi-axis recall, identity, drift detection, refusal walls, all in one SQLite file you own. A partner that acts on its own is unthinkable without memory that nobody can reset and refusals that nobody can talk it out of.
- **Governance walls** (`shared-core/danger.js`, verification, pinning) — hands that can be trusted. Every edit ships a before/after fingerprint; dangerous commands are classified before they run. Autonomy without walls is a liability, so the walls came first.
- **The proxy** (`proxy/`) — a place to stand. Engine routing across the subscriptions you already pay for, BYOK and local models, failover, response caching, savings you can audit per model on the dashboard. A partner that works all day needs its costs governed and its engines interchangeable.
- **Working alongside you** (`plugin/`) — the apprenticeship. The Claude Code plugin, MCP servers, role-specialist orchestration, and an action ledger that records what was done, verified, and learned. The partner learns your work by doing your work, on the record.
- **The dashboard** (`proxy/ui/`) — the window. What it remembers, what it read, what it changed, what it costs. A Code Map of the code it knows. You cannot trust what you cannot inspect.
- **The app** ([troth.one](https://troth.one)) — a body anyone can install. Signed, zero-setup, voice, Keychain secrets. Distribution for people who will never clone a repo.

## The road

- [x] A mind that survives the model — substrate, recall, identity, walls *(this repo, working today)*
- [x] Governed hands — verified edits, command classification, pinning *(this repo)*
- [x] A place to stand — proxy, engines, failover, auditable savings *(this repo)*
- [x] The apprenticeship — plugin, MCP, orchestration, action ledger *(this repo)*
- [x] The window — dashboard, records, Code Map *(this repo)*
- [x] A body for everyone — the signed macOS app *(shipping at [troth.one](https://troth.one))*
- [ ] **Acting unattended** — goal pursuit, heartbeat, reactive self-operation
- [ ] **A sandboxed body** — VM embodiment for work that needs its own machine

The unchecked boxes are the point. They land in the app first — the boundary, and the honesty about what is shipped versus named, is in the [README's open-vs-app table](README.md#what-is-open-here-vs-what-the-app-adds). Everything you can do *with* the partner is and stays open; the partner working *unattended with a body* is the paid destination.

## What this means for a contributor

The open tree is not a demo of the app. It is the full governed partner when you drive it, and every improvement to recall quality, engine adapters, governance, or the dashboard makes both the open partner and the destination better. If the direction speaks to you, [CONTRIBUTING.md](CONTRIBUTING.md) is short, and [AGENTS.md](AGENTS.md) will orient you (or your AI) inside the tree in a few minutes.
