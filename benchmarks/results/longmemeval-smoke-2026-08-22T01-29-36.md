# LongMemEval SMOKE — troth substrate

Run: 2026-08-22T01:29:36.916Z

## Summary

| Metric | Value |
|---|---|
| Sample size | 20 questions (offset 0) |
| Graded | 0/1 |
| Correct | 0 |
| Incorrect | 0 |
| Errors | 1 |
| **Accuracy (of graded)** | **0.0%** |
| Wall time | 6.6s |
| Judge | local-llamacpp (local-temp0-thinking-off), prompts longmemeval-official-v1 |
| Answer | claude (sonnet) |
| Retrieval path(s) observed | semantic+lexical |
| Embed server probe target | http://127.0.0.1:11437 |
| Dataset | `benchmarks/datasets/longmemeval/longmemeval_s_cleaned.json` |
| Dataset sha256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |

## By question type

| Type | n | Correct | Accuracy |
|---|---|---|---|
| single-session-user | 1 | 0 | 0.0% |

## Honest caveats

- **1-question sample** (fixed offset slice), not the full 500-question LongMemEval-S set unless n=500. Binomial CI applies — treat sub-100 samples as smoke signals, not publishable numbers.
- Sample is a **fixed offset slice** (dataset order), and the dataset is ordered by question_type — an offset-0 slice measures ONLY the first type(s). Check the `question_type` column below.
- Retrieval path: worker probes `http://127.0.0.1:11437`/health itself per question and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise. See the `retrieval_path` column per row.
- Ingest and recall both go through the REAL substrate write path (`dialogueMemory.recordTurn`, same function `bin/troth-entity.js` calls after every real turn) and REAL recall path (`engram.retrieveRelevant` with no `agent_id`, matching `shared-core/substrate-tools.js`'s `troth_engram_search` MCP tool and `bin/troth-entity.js`'s live per-turn prefix provider, both of which omit `agent_id` so cross-type episodic/semantic/procedural recall is reachable). No benchmark-only shortcut or raw SQL read. A real `taskEmbeddingBackfill` pass (`shared-core/background-worker.js`) runs between ingest and recall so semantic rerank has stored vectors to work with, mirroring what a long-running entity's idle-cadence backfill would have by the time an old conversation is queried.
- Each question runs in a fully isolated, throwaway `STATE_DB_PATH` (fresh child process per question, mirrors `tests/hermetic-db.js`) — haystacks never leak between questions, and nothing was written to the operator's real `~/.troth`.
- The judge uses the official LongMemEval per-type prompt templates (longmemeval-official-v1: standard, temporal off-by-one allowance, knowledge-update updated-answer rule, preference rubric, abstention) with a yes/no verdict, faithfully reproduced from the upstream evaluate_qa.py. The remaining protocol deviation is the judge MODEL: local-temp0-thinking-off instead of the paper's GPT-4o.
- "Our answer" is composed by handing the judge model ONLY the retrieved statement list (no gold answer visible at compose time) and asking it to answer from those statements alone, saying "unknown" if absent — this isolates retrieval quality from judge leniency, but is a thinner answer-composition step than a full entity turn (no full identity envelope, no multi-turn context beyond the retrieved set).

## Per-question verdicts

| # | question_id | type | verdict | retrieved | path | question |
|---|---|---|---|---|---|---|
| 1 | e47becba | single-session-user | ERROR | 10 | semantic+lexical | What degree did I graduate with? |

## Detail (gold vs our answer, judge reason)

### 1. e47becba — ERROR

- **Question:** What degree did I graduate with?
- **Gold answer:** Business Administration
- **Our answer:** (none — nothing retrieved or error)
- **Judge reason:** claude -p exit 1: 
- **Ingested turns:** 277, **retrieved:** 10, **path:** semantic+lexical, **wall:** 6569ms

## Rerun commands

```bash
# Dataset placement (once): benchmarks/datasets/README.md

# This smoke run (20 questions, offset 0)
node benchmarks/longmemeval-smoke.mjs --n 20 --offset 0

# Full LongMemEval-S (500 questions) — budget wall time accordingly,
# see wall-time-per-question in this report to extrapolate.
node benchmarks/longmemeval-smoke.mjs --n 500 --offset 0
```
