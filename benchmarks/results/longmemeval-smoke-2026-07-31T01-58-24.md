# LongMemEval SMOKE — troth substrate

Run: 2026-07-31T01:58:24.581Z

## Summary

| Metric | Value |
|---|---|
| Sample size | 20 questions (offset 0) |
| Graded | 20/20 |
| Correct | 17 |
| Incorrect | 3 |
| Errors | 0 |
| **Accuracy (of graded)** | **85.0%** |
| Wall time | 190.0s |
| Retrieval path(s) observed | semantic+lexical |
| Embed server probe target | http://127.0.0.1:11437 |

## Honest caveats

- **20-sample smoke test**, not the full 500-question LongMemEval-S set. Accuracy at this sample size has a wide confidence interval (roughly ±20pp at 95% CI for a binomial proportion) — treat as a smoke signal that the pipeline works end-to-end, not a publishable recall number.
- Sample is a **fixed offset slice** (first 20 by dataset order), not a random or stratified sample. The dataset's question_type distribution for this slice may not match the full set's distribution — check the `question_type` column below.
- Retrieval path: worker probes `http://127.0.0.1:11437`/health itself per question and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise. See the `retrieval_path` column per row.
- Ingest and recall both go through the REAL substrate write path (`dialogueMemory.recordTurn`, same function `bin/troth-entity.js` calls after every real turn) and REAL recall path (`engram.retrieveRelevant` with no `agent_id`, matching `shared-core/substrate-tools.js`'s `troth_engram_search` MCP tool and `bin/troth-entity.js`'s live per-turn prefix provider, both of which omit `agent_id` so cross-type episodic/semantic/procedural recall is reachable). No benchmark-only shortcut or raw SQL read. A real `taskEmbeddingBackfill` pass (`shared-core/background-worker.js`) runs between ingest and recall so semantic rerank has stored vectors to work with, mirroring what a long-running entity's idle-cadence backfill would have by the time an old conversation is queried.
- Each question runs in a fully isolated, throwaway `STATE_DB_PATH` (fresh child process per question, mirrors `tests/hermetic-db.js`) — haystacks never leak between questions, and nothing was written to the operator's real `~/.troth`.
- The judge is `claude -p` (a Claude model via the Claude Code CLI) grading CORRECT/INCORRECT against the gold answer with a single lenient-match prompt — not the original LongMemEval paper's GPT-4o judge, so numbers are not directly comparable to published Mem0/Zep LongMemEval results without re-running their judge methodology.
- "Our answer" is composed by handing the judge model ONLY the retrieved statement list (no gold answer visible at compose time) and asking it to answer from those statements alone, saying "unknown" if absent — this isolates retrieval quality from judge leniency, but is a thinner answer-composition step than a full entity turn (no full identity envelope, no multi-turn context beyond the retrieved set).

## Per-question verdicts

| # | question_id | type | verdict | retrieved | path | question |
|---|---|---|---|---|---|---|
| 1 | e47becba | single-session-user | CORRECT | 10 | semantic+lexical | What degree did I graduate with? |
| 2 | 118b2229 | single-session-user | CORRECT | 2 | semantic+lexical | How long is my daily commute to work? |
| 3 | 51a45a95 | single-session-user | INCORRECT | 0 | semantic+lexical | Where did I redeem a $5 coupon on coffee creamer? |
| 4 | 58bf7951 | single-session-user | CORRECT | 10 | semantic+lexical | What play did I attend at the local community theater? |
| 5 | 1e043500 | single-session-user | CORRECT | 10 | semantic+lexical | What is the name of the playlist I created on Spotify? |
| 6 | c5e8278d | single-session-user | CORRECT | 9 | semantic+lexical | What was my last name before I changed it? |
| 7 | 6ade9755 | single-session-user | CORRECT | 7 | semantic+lexical | Where do I take yoga classes? |
| 8 | 6f9b354f | single-session-user | CORRECT | 3 | semantic+lexical | What color did I repaint my bedroom walls? |
| 9 | 58ef2f1c | single-session-user | CORRECT | 10 | semantic+lexical | When did I volunteer at the local animal shelter's fundraising dinner? |
| 10 | f8c5f88b | single-session-user | CORRECT | 8 | semantic+lexical | Where did I buy my new tennis racket from? |
| 11 | 5d3d2817 | single-session-user | INCORRECT | 4 | semantic+lexical | What was my previous occupation? |
| 12 | 7527f7e2 | single-session-user | CORRECT | 4 | semantic+lexical | How much did I spend on a designer handbag? |
| 13 | c960da58 | single-session-user | CORRECT | 10 | semantic+lexical | How many playlists do I have on Spotify? |
| 14 | 3b6f954b | single-session-user | CORRECT | 8 | semantic+lexical | Where did I attend for my study abroad program? |
| 15 | 726462e0 | single-session-user | INCORRECT | 10 | semantic+lexical | What was the discount I got on my first purchase from the new clothing brand? |
| 16 | 94f70d80 | single-session-user | CORRECT | 10 | semantic+lexical | How long did it take me to assemble the IKEA bookshelf? |
| 17 | 66f24dbb | single-session-user | CORRECT | 10 | semantic+lexical | What did I buy for my sister's birthday gift? |
| 18 | ad7109d1 | single-session-user | CORRECT | 2 | semantic+lexical | What speed is my new internet plan? |
| 19 | af8d2e46 | single-session-user | CORRECT | 9 | semantic+lexical | How many shirts did I pack for my 5-day trip to Costa Rica? |
| 20 | dccbc061 | single-session-user | CORRECT | 3 | semantic+lexical | What was my previous stance on spirituality? |

## Detail (gold vs our answer, judge reason)

### 1. e47becba — CORRECT

- **Question:** What degree did I graduate with?
- **Gold answer:** Business Administration
- **Our answer:** A degree in Business Administration.
- **Judge reason:** The candidate states the same degree, Business Administration.
- **Ingested turns:** 277, **retrieved:** 10, **path:** semantic+lexical, **wall:** 11039ms

### 2. 118b2229 — CORRECT

- **Question:** How long is my daily commute to work?
- **Gold answer:** 45 minutes each way
- **Our answer:** 90 minutes round trip.
- **Judge reason:** A 90-minute round trip is equivalent to 45 minutes each way.
- **Ingested turns:** 244, **retrieved:** 2, **path:** semantic+lexical, **wall:** 9613ms

### 3. 51a45a95 — INCORRECT

- **Question:** Where did I redeem a $5 coupon on coffee creamer?
- **Gold answer:** Target
- **Our answer:** (none — nothing retrieved or error)
- **Judge reason:** The candidate provided no answer and did not identify Target.
- **Ingested turns:** 266, **retrieved:** 0, **path:** semantic+lexical, **wall:** 6767ms

### 4. 58bf7951 — CORRECT

- **Question:** What play did I attend at the local community theater?
- **Gold answer:** The Glass Menagerie
- **Our answer:** The Glass Menagerie.
- **Judge reason:** The candidate answer exactly matches the gold answer.
- **Ingested turns:** 311, **retrieved:** 10, **path:** semantic+lexical, **wall:** 8567ms

### 5. 1e043500 — CORRECT

- **Question:** What is the name of the playlist I created on Spotify?
- **Gold answer:** Summer Vibes
- **Our answer:** Summer Vibes.
- **Judge reason:** The candidate answer matches the playlist name 'Summer Vibes'.
- **Ingested turns:** 257, **retrieved:** 10, **path:** semantic+lexical, **wall:** 10774ms

### 6. c5e8278d — CORRECT

- **Question:** What was my last name before I changed it?
- **Gold answer:** Johnson
- **Our answer:** Johnson.
- **Judge reason:** The candidate answer matches the gold answer exactly.
- **Ingested turns:** 236, **retrieved:** 9, **path:** semantic+lexical, **wall:** 8577ms

### 7. 6ade9755 — CORRECT

- **Question:** Where do I take yoga classes?
- **Gold answer:** Serenity Yoga
- **Our answer:** Serenity Yoga.
- **Judge reason:** The candidate answer exactly matches the gold answer.
- **Ingested turns:** 261, **retrieved:** 7, **path:** semantic+lexical, **wall:** 8297ms

### 8. 6f9b354f — CORRECT

- **Question:** What color did I repaint my bedroom walls?
- **Gold answer:** a lighter shade of gray
- **Our answer:** A lighter shade of gray.
- **Judge reason:** The candidate answer exactly matches the gold answer.
- **Ingested turns:** 253, **retrieved:** 3, **path:** semantic+lexical, **wall:** 8310ms

### 9. 58ef2f1c — CORRECT

- **Question:** When did I volunteer at the local animal shelter's fundraising dinner?
- **Gold answer:** February 14th
- **Our answer:** On Valentine’s Day in February.
- **Judge reason:** Valentine’s Day is February 14th.
- **Ingested turns:** 262, **retrieved:** 10, **path:** semantic+lexical, **wall:** 8797ms

### 10. f8c5f88b — CORRECT

- **Question:** Where did I buy my new tennis racket from?
- **Gold answer:** the sports store downtown
- **Our answer:** A sports store downtown.
- **Judge reason:** The candidate matches the gold answer: a sports store downtown.
- **Ingested turns:** 246, **retrieved:** 8, **path:** semantic+lexical, **wall:** 9576ms

### 11. 5d3d2817 — INCORRECT

- **Question:** What was my previous occupation?
- **Gold answer:** Marketing specialist at a small startup
- **Our answer:** Unknown.
- **Judge reason:** The candidate answer does not identify the previous occupation as a marketing specialist at a small startup.
- **Ingested turns:** 259, **retrieved:** 4, **path:** semantic+lexical, **wall:** 9350ms

### 12. 7527f7e2 — CORRECT

- **Question:** How much did I spend on a designer handbag?
- **Gold answer:** $800
- **Our answer:** $800.
- **Judge reason:** The candidate answer exactly matches the gold amount of $800.
- **Ingested turns:** 247, **retrieved:** 4, **path:** semantic+lexical, **wall:** 9333ms

### 13. c960da58 — CORRECT

- **Question:** How many playlists do I have on Spotify?
- **Gold answer:** 20
- **Our answer:** 20 playlists.
- **Judge reason:** The candidate states that there are 20 playlists, matching the gold answer.
- **Ingested turns:** 254, **retrieved:** 10, **path:** semantic+lexical, **wall:** 9275ms

### 14. 3b6f954b — CORRECT

- **Question:** Where did I attend for my study abroad program?
- **Gold answer:** University of Melbourne in Australia
- **Our answer:** The University of Melbourne.
- **Judge reason:** The candidate identifies the University of Melbourne, matching the gold answer.
- **Ingested turns:** 238, **retrieved:** 8, **path:** semantic+lexical, **wall:** 10345ms

### 15. 726462e0 — INCORRECT

- **Question:** What was the discount I got on my first purchase from the new clothing brand?
- **Gold answer:** 10%
- **Our answer:** unknown
- **Judge reason:** The candidate answer does not state the 10% discount.
- **Ingested turns:** 252, **retrieved:** 10, **path:** semantic+lexical, **wall:** 9064ms

### 16. 94f70d80 — CORRECT

- **Question:** How long did it take me to assemble the IKEA bookshelf?
- **Gold answer:** 4 hours
- **Our answer:** 4 hours.
- **Judge reason:** The candidate answer exactly matches the gold answer of 4 hours.
- **Ingested turns:** 256, **retrieved:** 10, **path:** semantic+lexical, **wall:** 11350ms

### 17. 66f24dbb — CORRECT

- **Question:** What did I buy for my sister's birthday gift?
- **Gold answer:** a yellow dress
- **Our answer:** A yellow dress and a matching pair of earrings.
- **Judge reason:** The candidate includes the key fact that the gift was a yellow dress.
- **Ingested turns:** 255, **retrieved:** 10, **path:** semantic+lexical, **wall:** 9521ms

### 18. ad7109d1 — CORRECT

- **Question:** What speed is my new internet plan?
- **Gold answer:** 500 Mbps
- **Our answer:** 500 Mbps.
- **Judge reason:** The candidate answer exactly matches the 500 Mbps speed.
- **Ingested turns:** 234, **retrieved:** 2, **path:** semantic+lexical, **wall:** 9850ms

### 19. af8d2e46 — CORRECT

- **Question:** How many shirts did I pack for my 5-day trip to Costa Rica?
- **Gold answer:** 7
- **Our answer:** 7 shirts.
- **Judge reason:** The candidate states that 7 shirts were packed.
- **Ingested turns:** 249, **retrieved:** 9, **path:** semantic+lexical, **wall:** 12118ms

### 20. dccbc061 — CORRECT

- **Question:** What was my previous stance on spirituality?
- **Gold answer:** A staunch atheist
- **Our answer:** You used to be a staunch atheist.
- **Judge reason:** The candidate exactly conveys that the previous stance was being a staunch atheist.
- **Ingested turns:** 255, **retrieved:** 3, **path:** semantic+lexical, **wall:** 9488ms

## Rerun commands

```bash
# LongMemEval-S is ~277 MB and is downloaded, not committed.
# benchmarks/datasets/README.md says where to get it and where to put it,
# and records the sha256 of the copy this run measured.

# This smoke run (20 questions, offset 0)
node benchmarks/longmemeval-smoke.mjs --n 20 --offset 0

# Full LongMemEval-S (500 questions) — budget wall time accordingly,
# see wall-time-per-question in this report to extrapolate.
node benchmarks/longmemeval-smoke.mjs --n 500 --offset 0
```
