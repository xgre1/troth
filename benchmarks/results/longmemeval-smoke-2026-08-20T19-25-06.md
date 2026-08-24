# LongMemEval SMOKE — troth substrate

Run: 2026-08-20T19:25:06.339Z

## Summary

| Metric | Value |
|---|---|
| Sample size | 6 questions (stratified 1/type) |
| Graded | 6/6 |
| Correct | 3 |
| Incorrect | 3 |
| Errors | 0 |
| **Accuracy (of graded)** | **50.0%** |
| Wall time | 171.3s |
| Judge | claude (sonnet), prompts longmemeval-official-v1 |
| Answer | claude (sonnet) |
| Retrieval path(s) observed | semantic+lexical |
| Embed server probe target | http://127.0.0.1:11437 |
| Dataset | `benchmarks/datasets/longmemeval/longmemeval_s_cleaned.json` |
| Dataset sha256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |

## By question type

| Type | n | Correct | Accuracy |
|---|---|---|---|
| knowledge-update | 1 | 1 | 100.0% |
| multi-session | 1 | 0 | 0.0% |
| single-session-assistant | 1 | 1 | 100.0% |
| single-session-preference | 1 | 0 | 0.0% |
| single-session-user | 1 | 1 | 100.0% |
| temporal-reasoning | 1 | 0 | 0.0% |

## Honest caveats

- **6-question sample** (stratified 1/type), not the full 500-question LongMemEval-S set unless n=500. Binomial CI applies — treat sub-100 samples as smoke signals, not publishable numbers.
- Stratified sampling takes the first 1 questions of each question_type in dataset order — deterministic and reproducible, but within-type dataset order is arbitrary upstream.
- Retrieval path: worker probes `http://127.0.0.1:11437`/health itself per question and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise. See the `retrieval_path` column per row.
- Ingest and recall both go through the REAL substrate write path (`dialogueMemory.recordTurn`, same function `bin/troth-entity.js` calls after every real turn) and REAL recall path (`engram.retrieveRelevant` with no `agent_id`, matching `shared-core/substrate-tools.js`'s `troth_engram_search` MCP tool and `bin/troth-entity.js`'s live per-turn prefix provider, both of which omit `agent_id` so cross-type episodic/semantic/procedural recall is reachable). No benchmark-only shortcut or raw SQL read. A real `taskEmbeddingBackfill` pass (`shared-core/background-worker.js`) runs between ingest and recall so semantic rerank has stored vectors to work with, mirroring what a long-running entity's idle-cadence backfill would have by the time an old conversation is queried.
- Each question runs in a fully isolated, throwaway `STATE_DB_PATH` (fresh child process per question, mirrors `tests/hermetic-db.js`) — haystacks never leak between questions, and nothing was written to the operator's real `~/.troth`.
- The judge uses the official LongMemEval per-type prompt templates (longmemeval-official-v1: standard, temporal off-by-one allowance, knowledge-update updated-answer rule, preference rubric, abstention) with a yes/no verdict, faithfully reproduced from the upstream evaluate_qa.py. The remaining protocol deviation is the judge MODEL: sonnet instead of the paper's GPT-4o.
- "Our answer" is composed by handing the judge model ONLY the retrieved statement list (no gold answer visible at compose time) and asking it to answer from those statements alone, saying "unknown" if absent — this isolates retrieval quality from judge leniency, but is a thinner answer-composition step than a full entity turn (no full identity envelope, no multi-turn context beyond the retrieved set).

## Per-question verdicts

| # | question_id | type | verdict | retrieved | path | question |
|---|---|---|---|---|---|---|
| 1 | e47becba | single-session-user | CORRECT | 10 | semantic+lexical | What degree did I graduate with? |
| 2 | 0a995998 | multi-session | INCORRECT | 10 | semantic+lexical | How many items of clothing do I need to pick up or return from a store? |
| 3 | 8a2466db | single-session-preference | INCORRECT | 10 | semantic+lexical | Can you recommend some resources where I can learn more about video editing? |
| 4 | gpt4_59149c77 | temporal-reasoning | INCORRECT | 10 | semantic+lexical | How many days passed between my visit to the Museum of Modern Art (MoMA) and the 'Ancient  |
| 5 | 6a1eabeb | knowledge-update | CORRECT | 10 | semantic+lexical | What was my personal best time in the charity 5K run? |
| 6 | 7161e7e2 | single-session-assistant | CORRECT | 10 | semantic+lexical | I'm checking our previous chat about the shift rotation sheet for GM social media agents.  |

## Detail (gold vs our answer, judge reason)

### 1. e47becba — CORRECT

- **Question:** What degree did I graduate with?
- **Gold answer:** Business Administration
- **Our answer:** Business Administration
- **Judge reason:** official single-session-user judge: yes
- **Ingested turns:** 277, **retrieved:** 10, **path:** semantic+lexical, **wall:** 33544ms

### 2. 0a995998 — INCORRECT

- **Question:** How many items of clothing do I need to pick up or return from a store?
- **Gold answer:** 3
- **Our answer:** Two: the Zara boots (pick up) and the navy blue blazer dry cleaning (pick up).
- **Judge reason:** official multi-session judge: no
- **Ingested turns:** 242, **retrieved:** 10, **path:** semantic+lexical, **wall:** 29045ms

### 3. 8a2466db — INCORRECT

- **Question:** Can you recommend some resources where I can learn more about video editing?
- **Gold answer:** The user would prefer responses that suggest resources specifically tailored to Adobe Premiere Pro, especially those that delve into its advanced settings. They might not prefer general video editing resources or resources related to other video editing software.
- **Our answer:** Adobe's official documentation/tutorials, YouTube channels (Premiere Bro, Video Copilot, Adobe Creative Cloud), Udemy/LinkedIn Learning/Skillshare courses, and forums like r/premierepro and Adobe's Premiere Pro forum.
- **Judge reason:** official single-session-preference judge: no
- **Ingested turns:** 258, **retrieved:** 10, **path:** semantic+lexical, **wall:** 31195ms

### 4. gpt4_59149c77 — INCORRECT

- **Question:** How many days passed between my visit to the Museum of Modern Art (MoMA) and the 'Ancient Civilizations' exhibit at the Metropolitan Museum of Art?
- **Gold answer:** 7 days. 8 days (including the last day) is also acceptable.
- **Our answer:** Unknown.
- **Judge reason:** official temporal-reasoning judge: no
- **Ingested turns:** 244, **retrieved:** 10, **path:** semantic+lexical, **wall:** 26597ms

### 5. 6a1eabeb — CORRECT

- **Question:** What was my personal best time in the charity 5K run?
- **Gold answer:** 25 minutes and 50 seconds (or 25:50)
- **Our answer:** 25:50
- **Judge reason:** official knowledge-update judge: yes
- **Ingested turns:** 208, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25999ms

### 6. 7161e7e2 — CORRECT

- **Question:** I'm checking our previous chat about the shift rotation sheet for GM social media agents. Can you remind me what was the rotation for Admon on a Sunday?
- **Gold answer:** Admon was assigned to the 8 am - 4 pm (Day Shift) on Sundays.
- **Our answer:** Admon worked the 8 am–4 pm (Day) shift on Sunday.
- **Judge reason:** official single-session-assistant judge: yes
- **Ingested turns:** 277, **retrieved:** 10, **path:** semantic+lexical, **wall:** 24919ms

## Rerun commands

```bash
# Dataset placement (once): benchmarks/datasets/README.md

# This smoke run (20 questions, offset 0)
node benchmarks/longmemeval-smoke.mjs --n 20 --offset 0

# Full LongMemEval-S (500 questions) — budget wall time accordingly,
# see wall-time-per-question in this report to extrapolate.
node benchmarks/longmemeval-smoke.mjs --n 500 --offset 0
```
