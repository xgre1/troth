# Benchmark datasets

Two of the published benchmarks read a dataset that is too large to keep in the
repository. This file says exactly where to get each one and where to put it, so
the rerun commands printed in `benchmarks/results/*.md` actually run from a fresh
clone. A number nobody else can reproduce is a claim, not a measurement.

## QASPER (document ingest) — already here

`qasper/slice-20.json` ships with the repository. It is the exact 20-item
slice the published ingest number was measured on, so nothing needs downloading:

```bash
node benchmarks/ingest-recall.mjs
```

- Source: [QASPER v0.3](https://allenai.org/data/qasper), dev split, Allen
  Institute for AI.
- Licence: CC BY 4.0. Cite Dasigi et al., *A Dataset of Information-Seeking
  Questions and Answers Anchored in Research Papers* (NAACL 2021).
- `sha256(qasper/slice-20.json)`
  = `b9d091767910aa3b337b9fe64c2b62dae9cb5baa58e2c8573c108116783a928c`
- Derived from `qasper-dev-v0.3.json`
  (`sha256 2ae7ee62a65b1c4225791c70de80c2aad4e8998cf1fd4f09a53103db4f21af93`),
  which is not redistributed here. Download the full dev set from the link above
  if you want to build a different slice.

## LongMemEval (conversational recall) — download once

The LongMemEval-S set is ~277 MB, so it is fetched rather than committed.

1. Get `longmemeval_s.json` from the
   [LongMemEval repository](https://github.com/xiaowu0162/LongMemEval) (the
   authors distribute the data through the link in their README).
2. Put it at `benchmarks/datasets/longmemeval/longmemeval_s.json`.
3. Run:

```bash
node benchmarks/longmemeval.mjs --n 20 --offset 0
```

The runner accepts either filename: `longmemeval_s.json` (what you download) or
`longmemeval_s_cleaned.json` (see below). It reports which file it read and that
file's sha256 in the result document, so any two runs can be compared honestly.

### About the `_cleaned` copy

The published run used a locally re-serialised copy named
`longmemeval_s_cleaned.json`:

- 500 questions, upstream LongMemEval-S schema
  (`question_id, question_type, question, question_date, answer,
  answer_session_ids, haystack_dates, haystack_session_ids, haystack_sessions`).
- question_type distribution: 133 multi-session, 133 temporal-reasoning,
  78 knowledge-update, 70 single-session-user, 56 single-session-assistant,
  30 single-session-preference.
- `sha256` = `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`

That copy is not published and we do not claim it is byte-identical to the
upstream file. Use the upstream `longmemeval_s.json`; if your numbers differ from
ours, compare the sha256 line in the two result documents before concluding
anything about the substrate.
