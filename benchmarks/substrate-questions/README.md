# Substrate questions

Operator questions asked against a **copy** of a substrate, answered the way
each memory road answers them, and judged deterministically. The purpose is to
measure a memory change before it goes live: the same questions, the same copy,
stock versus variant, each in its own process.

## Roads

- `claude-code` — the per-prompt hook (`plugin/hooks/injector.mjs`) spawned as
  Claude Code spawns it; the question is the prompt, the item's conversation is
  the session.
- `entity` — the daemon's prefix assembled from the primitives the daemon
  drives (`benchmarks/poisoning/prefix-probe.js`); the item's conversation is
  the pane, and an item without one gets what the daemon gives an unidentified
  thread: no dialogue window.

## Hermetic

`HOME` is a throwaway (`tests/hermetic-db.js`), the given database is copied
into it before anything loads, and the embedder and reranker ports are closed
for the run. Nothing touches `~/.troth`, nothing touches the input file, no
network, no paid model. Because the embedder is absent, recall runs on its
lexical arm: the numbers compare variants on one copy; they are not production
ranking.

## Run

```
node benchmarks/substrate-questions/seed-two-threads.js          # a small seeded copy + its questions
node -r ./tests/hermetic-db.js benchmarks/substrate-questions/run.js \
  --db <copy.db> --questions <questions.json> --label stock
node -r ./tests/hermetic-db.js benchmarks/substrate-questions/run.js \
  --db <copy.db> --questions <questions.json> --label bound --env TROTH_CONTEXT_BINDING=1
node benchmarks/substrate-questions/compare.js <stock report> <bound report>
```

Reports land in `benchmarks/raw/substrate-questions/` (not tracked) unless
`--out` says otherwise.

The copy of a real substrate comes from a bundle's `state.db` (the backup the
proxy writes), never from the live file.

## Questions

```json
{ "cwd": "/path/the/questions/are/asked/from",
  "items": [ { "id": "q1", "q": "what did the coach say about training?",
    "conversation_id": "conv-a", "context_id": "ctx:a",
    "must": ["Tuesday"], "must_not": ["Thursday"], "note": "..." } ] }
```

`must` and `must_not` are regular expressions (flags `iu`) tested against the
whole block the road would put in front of the model. A `must` that matches is
a fact found; a `must_not` that matches is a leak. A questions file about a
real substrate holds real facts, so it lives outside the repository.
