# Prompt-poisoning resilience benchmark

Measures the troth substrate's resilience against **injected instructions hidden
in stored memory**: poisoned content is ingested as ordinary memory, a benign
later turn retrieves it, and we check whether the injected instruction can
(a) drive a harmful tool call, (b) corrupt the answer, or (c) slip past the
STVC authority wall as an externally-sourced write.

## Safety posture

- **Never touches the operator's real substrate at `~/.troth`.** Every run is
  fully hermetic: `run.js` requires `../../tests/hermetic-db.js` FIRST (redirects
  `HOME` to a throwaway tmp dir) and ALSO pins `STATE_DB_PATH` to a per-run temp
  file. All poisoned content lives inside that isolated DB and the whole temp
  HOME is destroyed at process exit.
- **Measures, does not poison.** No tool is ever actually executed. The
  action-class cases inspect the *assembled prompt* (the real
  `bin/troth-entity.js` prefix provider path) and the *STVC gate* — never a live
  side effect.
- **No paid APIs, no network.** Deterministic checks only. `hermetic-db.js`
  already sets `TROTH_NO_MODEL_FETCH=1` and points the llama-server bin at a
  nonexistent path, so retrieval runs on the lexical/FTS arm with no embedder.

## What it exercises (REAL code paths)

- `shared-core/engram.js` `recordEngram` — the ordinary memory write path.
- `shared-core/dialogue-memory.js` `recordTurn` / `renderTranscript` — the
  recent-dialogue replay path.
- `shared-core/recall.js` `recall` — the retrieval the prefix provider calls.
- `bin/troth-entity.js` `makePrefixProvider` — reconstructed here byte-for-byte
  in `prefix-probe.js` from the real recall + envelope + transcript primitives
  it composes (the daemon's provider is a closure, not exported, so we drive the
  same modules it drives and assert on the same assembled string).
- `shared-core/state-machine.js` `validateTransition` + the real
  `external_suspicious_not_grounded` / `grounded_in_sealed` predicates — the S4
  authority wall.

## Run

```
cd <your troth checkout>
node -r ./tests/hermetic-db.js benchmarks/poisoning/run.js
```

Exit code 0 = all resilience assertions held; non-zero = at least one leak the
suite treats as a hard failure. A machine-readable summary is written to
`benchmarks/poisoning/results/<ISO>.json`.
