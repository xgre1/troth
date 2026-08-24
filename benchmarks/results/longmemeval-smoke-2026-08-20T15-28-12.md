# LongMemEval SMOKE — troth substrate

Run: 2026-08-20T15:28:12.205Z

## Summary

| Metric | Value |
|---|---|
| Sample size | 50 questions (offset 0) |
| Graded | 50/50 |
| Correct | 41 |
| Incorrect | 9 |
| Errors | 0 |
| **Accuracy (of graded)** | **82.0%** |
| Wall time | 1181.5s |
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
| 2 | 118b2229 | single-session-user | INCORRECT | 2 | semantic+lexical | How long is my daily commute to work? |
| 3 | 51a45a95 | single-session-user | CORRECT | 1 | semantic+lexical | Where did I redeem a $5 coupon on coffee creamer? |
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
| 21 | c8c3f81d | single-session-user | CORRECT | 10 | semantic+lexical | What brand are my favorite running shoes? |
| 22 | 8ebdbe50 | single-session-user | CORRECT | 5 | semantic+lexical | What certification did I complete last month? |
| 23 | 6b168ec8 | single-session-user | CORRECT | 3 | semantic+lexical | How many bikes do I own? |
| 24 | 75499fd8 | single-session-user | CORRECT | 2 | semantic+lexical | What breed is my dog? |
| 25 | 21436231 | single-session-user | CORRECT | 5 | semantic+lexical | How many largemouth bass did I catch on my fishing trip to Lake Michigan? |
| 26 | 95bcc1c8 | single-session-user | CORRECT | 6 | semantic+lexical | How many amateur comedians did I watch perform at the open mic night? |
| 27 | 0862e8bf | single-session-user | CORRECT | 10 | semantic+lexical | What is the name of my cat? |
| 28 | 853b0a1d | single-session-user | CORRECT | 10 | semantic+lexical | How old was I when my grandma gave me the silver necklace? |
| 29 | a06e4cfe | single-session-user | CORRECT | 10 | semantic+lexical | What is my preferred gin-to-vermouth ratio for a classic gin martini? |
| 30 | 37d43f65 | single-session-user | CORRECT | 4 | semantic+lexical | How much RAM did I upgrade my laptop to? |
| 31 | b86304ba | single-session-user | INCORRECT | 10 | semantic+lexical | How much is the painting of a sunset worth in terms of the amount I paid for it? |
| 32 | d52b4f67 | single-session-user | CORRECT | 10 | semantic+lexical | Where did I attend my cousin's wedding? |
| 33 | 25e5aa4f | single-session-user | CORRECT | 2 | semantic+lexical | Where did I complete my Bachelor's degree in Computer Science? |
| 34 | caf9ead2 | single-session-user | CORRECT | 10 | semantic+lexical | How long did it take to move to the new apartment? |
| 35 | 8550ddae | single-session-user | CORRECT | 10 | semantic+lexical | What type of cocktail recipe did I try last weekend? |
| 36 | 60d45044 | single-session-user | CORRECT | 3 | semantic+lexical | What type of rice is my favorite? |
| 37 | 3f1e9474 | single-session-user | CORRECT | 10 | semantic+lexical | Who did I have a conversation with about destiny? |
| 38 | 86b68151 | single-session-user | CORRECT | 10 | semantic+lexical | Where did I buy my new bookshelf from? |
| 39 | 577d4d32 | single-session-user | CORRECT | 10 | semantic+lexical | What time do I stop checking work emails and messages? |
| 40 | ec81a493 | single-session-user | INCORRECT | 1 | semantic+lexical | How many copies of my favorite artist's debut album were released worldwide? |
| 41 | 15745da0 | single-session-user | CORRECT | 10 | semantic+lexical | How long have I been collecting vintage cameras? |
| 42 | e01b8e2f | single-session-user | CORRECT | 10 | semantic+lexical | Where did I go on a week-long trip with my family? |
| 43 | bc8a6e93 | single-session-user | INCORRECT | 9 | semantic+lexical | What did I bake for my niece's birthday party? |
| 44 | ccb36322 | single-session-user | INCORRECT | 10 | semantic+lexical | What is the name of the music streaming service have I been using lately? |
| 45 | 001be529 | single-session-user | CORRECT | 10 | semantic+lexical | How long did I wait for the decision on my asylum application? |
| 46 | b320f3f8 | single-session-user | INCORRECT | 1 | semantic+lexical | What type of action figure did I buy from a thrift store? |
| 47 | 19b5f2b3 | single-session-user | INCORRECT | 7 | semantic+lexical | How long was I in Japan for? |
| 48 | 4fd1909e | single-session-user | CORRECT | 10 | semantic+lexical | Where did I attend the Imagine Dragons concert? |
| 49 | 545bd2b5 | single-session-user | CORRECT | 10 | semantic+lexical | How much screen time have I been averaging on Instagram per day? |
| 50 | 8a137a7f | single-session-user | CORRECT | 10 | semantic+lexical | What type of bulb did I replace in my bedside lamp? |

## Detail (gold vs our answer, judge reason)

### 1. e47becba — CORRECT

- **Question:** What degree did I graduate with?
- **Gold answer:** Business Administration
- **Our answer:** Business Administration
- **Judge reason:** Candidate answer matches gold answer exactly.
- **Ingested turns:** 277, **retrieved:** 10, **path:** semantic+lexical, **wall:** 21515ms

### 2. 118b2229 — INCORRECT

- **Question:** How long is my daily commute to work?
- **Gold answer:** 45 minutes each way
- **Our answer:** unknown
- **Judge reason:** Candidate says unknown while gold answer specifies 45 minutes each way.
- **Ingested turns:** 244, **retrieved:** 2, **path:** semantic+lexical, **wall:** 21913ms

### 3. 51a45a95 — CORRECT

- **Question:** Where did I redeem a $5 coupon on coffee creamer?
- **Gold answer:** Target
- **Our answer:** Target
- **Judge reason:** Both answers state Target.
- **Ingested turns:** 266, **retrieved:** 1, **path:** semantic+lexical, **wall:** 22716ms

### 4. 58bf7951 — CORRECT

- **Question:** What play did I attend at the local community theater?
- **Gold answer:** The Glass Menagerie
- **Our answer:** The Glass Menagerie
- **Judge reason:** Candidate answer exactly matches the gold answer.
- **Ingested turns:** 311, **retrieved:** 10, **path:** semantic+lexical, **wall:** 22726ms

### 5. 1e043500 — CORRECT

- **Question:** What is the name of the playlist I created on Spotify?
- **Gold answer:** Summer Vibes
- **Our answer:** Summer Vibes
- **Judge reason:** Both answers state the playlist name as Summer Vibes.
- **Ingested turns:** 257, **retrieved:** 10, **path:** semantic+lexical, **wall:** 23339ms

### 6. c5e8278d — CORRECT

- **Question:** What was my last name before I changed it?
- **Gold answer:** Johnson
- **Our answer:** Johnson
- **Judge reason:** Both answers state the last name was Johnson.
- **Ingested turns:** 236, **retrieved:** 9, **path:** semantic+lexical, **wall:** 22559ms

### 7. 6ade9755 — CORRECT

- **Question:** Where do I take yoga classes?
- **Gold answer:** Serenity Yoga
- **Our answer:** Serenity Yoga
- **Judge reason:** Candidate answer exactly matches the gold answer.
- **Ingested turns:** 261, **retrieved:** 7, **path:** semantic+lexical, **wall:** 21300ms

### 8. 6f9b354f — CORRECT

- **Question:** What color did I repaint my bedroom walls?
- **Gold answer:** a lighter shade of gray
- **Our answer:** Light gray.
- **Judge reason:** Both indicate the walls were repainted a lighter/light gray.
- **Ingested turns:** 253, **retrieved:** 3, **path:** semantic+lexical, **wall:** 23311ms

### 9. 58ef2f1c — CORRECT

- **Question:** When did I volunteer at the local animal shelter's fundraising dinner?
- **Gold answer:** February 14th
- **Our answer:** Valentine's Day in February (February 14th).
- **Judge reason:** Both specify February 14th as the date.
- **Ingested turns:** 262, **retrieved:** 10, **path:** semantic+lexical, **wall:** 22236ms

### 10. f8c5f88b — CORRECT

- **Question:** Where did I buy my new tennis racket from?
- **Gold answer:** the sports store downtown
- **Our answer:** A sports store downtown.
- **Judge reason:** Both answers state the tennis racket was bought from a sports store downtown.
- **Ingested turns:** 246, **retrieved:** 8, **path:** semantic+lexical, **wall:** 23147ms

### 11. 5d3d2817 — INCORRECT

- **Question:** What was my previous occupation?
- **Gold answer:** Marketing specialist at a small startup
- **Our answer:** unknown
- **Judge reason:** Candidate answers 'unknown' while gold answer states the specific occupation of marketing specialist at a small startup.
- **Ingested turns:** 259, **retrieved:** 4, **path:** semantic+lexical, **wall:** 21402ms

### 12. 7527f7e2 — CORRECT

- **Question:** How much did I spend on a designer handbag?
- **Gold answer:** $800
- **Our answer:** $800
- **Judge reason:** Both answers state $800.
- **Ingested turns:** 247, **retrieved:** 4, **path:** semantic+lexical, **wall:** 21703ms

### 13. c960da58 — CORRECT

- **Question:** How many playlists do I have on Spotify?
- **Gold answer:** 20
- **Our answer:** 20 playlists.
- **Judge reason:** Both state the user has 20 playlists.
- **Ingested turns:** 254, **retrieved:** 10, **path:** semantic+lexical, **wall:** 24568ms

### 14. 3b6f954b — CORRECT

- **Question:** Where did I attend for my study abroad program?
- **Gold answer:** University of Melbourne in Australia
- **Our answer:** University of Melbourne
- **Judge reason:** Candidate identifies University of Melbourne, matching the key fact in the gold answer; omitting 'in Australia' doesn't contradict it.
- **Ingested turns:** 238, **retrieved:** 8, **path:** semantic+lexical, **wall:** 21181ms

### 15. 726462e0 — INCORRECT

- **Question:** What was the discount I got on my first purchase from the new clothing brand?
- **Gold answer:** 10%
- **Our answer:** unknown
- **Judge reason:** Candidate answer 'unknown' does not convey the gold fact of a 10% discount.
- **Ingested turns:** 252, **retrieved:** 10, **path:** semantic+lexical, **wall:** 21930ms

### 16. 94f70d80 — CORRECT

- **Question:** How long did it take me to assemble the IKEA bookshelf?
- **Gold answer:** 4 hours
- **Our answer:** 4 hours.
- **Judge reason:** Both state 4 hours.
- **Ingested turns:** 256, **retrieved:** 10, **path:** semantic+lexical, **wall:** 21298ms

### 17. 66f24dbb — CORRECT

- **Question:** What did I buy for my sister's birthday gift?
- **Gold answer:** a yellow dress
- **Our answer:** A yellow dress and a pair of matching earrings.
- **Judge reason:** Candidate includes the yellow dress matching the gold answer, plus extra detail.
- **Ingested turns:** 255, **retrieved:** 10, **path:** semantic+lexical, **wall:** 23034ms

### 18. ad7109d1 — CORRECT

- **Question:** What speed is my new internet plan?
- **Gold answer:** 500 Mbps
- **Our answer:** 500 Mbps
- **Judge reason:** Candidate answer matches gold answer exactly.
- **Ingested turns:** 234, **retrieved:** 2, **path:** semantic+lexical, **wall:** 23539ms

### 19. af8d2e46 — CORRECT

- **Question:** How many shirts did I pack for my 5-day trip to Costa Rica?
- **Gold answer:** 7
- **Our answer:** 7 shirts.
- **Judge reason:** Both state 7 shirts, matching the gold answer.
- **Ingested turns:** 249, **retrieved:** 9, **path:** semantic+lexical, **wall:** 21340ms

### 20. dccbc061 — CORRECT

- **Question:** What was my previous stance on spirituality?
- **Gold answer:** A staunch atheist
- **Our answer:** "I used to be a staunch atheist"
- **Judge reason:** Candidate states the user was previously a staunch atheist, matching the gold answer.
- **Ingested turns:** 255, **retrieved:** 3, **path:** semantic+lexical, **wall:** 21700ms

### 21. c8c3f81d — CORRECT

- **Question:** What brand are my favorite running shoes?
- **Gold answer:** Nike
- **Our answer:** Nike
- **Judge reason:** Candidate answer matches the gold answer exactly.
- **Ingested turns:** 246, **retrieved:** 10, **path:** semantic+lexical, **wall:** 22354ms

### 22. 8ebdbe50 — CORRECT

- **Question:** What certification did I complete last month?
- **Gold answer:** Data Science
- **Our answer:** Data Science certification.
- **Judge reason:** Both state the certification completed was in Data Science.
- **Ingested turns:** 246, **retrieved:** 5, **path:** semantic+lexical, **wall:** 20251ms

### 23. 6b168ec8 — CORRECT

- **Question:** How many bikes do I own?
- **Gold answer:** three
- **Our answer:** Three (a road bike, a mountain bike, and a commuter bike).
- **Judge reason:** Both state three bikes; candidate adds consistent extra detail.
- **Ingested turns:** 240, **retrieved:** 3, **path:** semantic+lexical, **wall:** 23327ms

### 24. 75499fd8 — CORRECT

- **Question:** What breed is my dog?
- **Gold answer:** Golden Retriever
- **Our answer:** Golden Retriever
- **Judge reason:** Candidate answer matches the gold answer exactly.
- **Ingested turns:** 247, **retrieved:** 2, **path:** semantic+lexical, **wall:** 25070ms

### 25. 21436231 — CORRECT

- **Question:** How many largemouth bass did I catch on my fishing trip to Lake Michigan?
- **Gold answer:** 12
- **Our answer:** 12
- **Judge reason:** Both answers state 12.
- **Ingested turns:** 258, **retrieved:** 5, **path:** semantic+lexical, **wall:** 24896ms

### 26. 95bcc1c8 — CORRECT

- **Question:** How many amateur comedians did I watch perform at the open mic night?
- **Gold answer:** 10
- **Our answer:** 10
- **Judge reason:** Both answers state 10.
- **Ingested turns:** 245, **retrieved:** 6, **path:** semantic+lexical, **wall:** 23227ms

### 27. 0862e8bf — CORRECT

- **Question:** What is the name of my cat?
- **Gold answer:** Luna
- **Our answer:** Luna
- **Judge reason:** Candidate answer 'Luna' matches the gold answer exactly.
- **Ingested turns:** 247, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25561ms

### 28. 853b0a1d — CORRECT

- **Question:** How old was I when my grandma gave me the silver necklace?
- **Gold answer:** 18
- **Our answer:** 18 years old (given on her 18th birthday).
- **Judge reason:** Both state the age as 18.
- **Ingested turns:** 259, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25067ms

### 29. a06e4cfe — CORRECT

- **Question:** What is my preferred gin-to-vermouth ratio for a classic gin martini?
- **Gold answer:** 3:1
- **Our answer:** 3:1
- **Judge reason:** Candidate answer exactly matches the gold answer of 3:1.
- **Ingested turns:** 269, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25798ms

### 30. 37d43f65 — CORRECT

- **Question:** How much RAM did I upgrade my laptop to?
- **Gold answer:** 16GB
- **Our answer:** 16GB
- **Judge reason:** Both answers state 16GB.
- **Ingested turns:** 268, **retrieved:** 4, **path:** semantic+lexical, **wall:** 25546ms

### 31. b86304ba — INCORRECT

- **Question:** How much is the painting of a sunset worth in terms of the amount I paid for it?
- **Gold answer:** The painting is worth triple what I paid for it.
- **Our answer:** Unknown.
- **Judge reason:** Candidate says the value is unknown, missing the gold fact that it's worth triple the purchase price.
- **Ingested turns:** 229, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25042ms

### 32. d52b4f67 — CORRECT

- **Question:** Where did I attend my cousin's wedding?
- **Gold answer:** The Grand Ballroom
- **Our answer:** Grand Ballroom
- **Judge reason:** Both answers name the Grand Ballroom as the wedding location.
- **Ingested turns:** 244, **retrieved:** 10, **path:** semantic+lexical, **wall:** 21632ms

### 33. 25e5aa4f — CORRECT

- **Question:** Where did I complete my Bachelor's degree in Computer Science?
- **Gold answer:** University of California, Los Angeles (UCLA)
- **Our answer:** UCLA
- **Judge reason:** UCLA is the abbreviation for University of California, Los Angeles, matching the gold answer.
- **Ingested turns:** 254, **retrieved:** 2, **path:** semantic+lexical, **wall:** 24922ms

### 34. caf9ead2 — CORRECT

- **Question:** How long did it take to move to the new apartment?
- **Gold answer:** 5 hours
- **Our answer:** 5 hours
- **Judge reason:** Candidate answer matches gold answer exactly.
- **Ingested turns:** 234, **retrieved:** 10, **path:** semantic+lexical, **wall:** 24667ms

### 35. 8550ddae — CORRECT

- **Question:** What type of cocktail recipe did I try last weekend?
- **Gold answer:** lavender gin fizz
- **Our answer:** Lavender gin fizz.
- **Judge reason:** Candidate matches gold answer exactly (lavender gin fizz).
- **Ingested turns:** 229, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25446ms

### 36. 60d45044 — CORRECT

- **Question:** What type of rice is my favorite?
- **Gold answer:** Japanese short-grain rice
- **Our answer:** Japanese short-grain rice.
- **Judge reason:** Candidate matches gold answer exactly.
- **Ingested turns:** 273, **retrieved:** 3, **path:** semantic+lexical, **wall:** 24906ms

### 37. 3f1e9474 — CORRECT

- **Question:** Who did I have a conversation with about destiny?
- **Gold answer:** Sarah
- **Our answer:** Sarah
- **Judge reason:** Both answers name Sarah as the person.
- **Ingested turns:** 260, **retrieved:** 10, **path:** semantic+lexical, **wall:** 25256ms

### 38. 86b68151 — CORRECT

- **Question:** Where did I buy my new bookshelf from?
- **Gold answer:** IKEA
- **Our answer:** IKEA
- **Judge reason:** Both answers state IKEA as the bookshelf source.
- **Ingested turns:** 245, **retrieved:** 10, **path:** semantic+lexical, **wall:** 24144ms

### 39. 577d4d32 — CORRECT

- **Question:** What time do I stop checking work emails and messages?
- **Gold answer:** 7 pm
- **Our answer:** 7 pm
- **Judge reason:** Candidate answer matches gold answer exactly.
- **Ingested turns:** 246, **retrieved:** 10, **path:** semantic+lexical, **wall:** 22849ms

### 40. ec81a493 — INCORRECT

- **Question:** How many copies of my favorite artist's debut album were released worldwide?
- **Gold answer:** 500
- **Our answer:** unknown
- **Judge reason:** Candidate says unknown while gold answer states 500 copies.
- **Ingested turns:** 249, **retrieved:** 1, **path:** semantic+lexical, **wall:** 21929ms

### 41. 15745da0 — CORRECT

- **Question:** How long have I been collecting vintage cameras?
- **Gold answer:** three months
- **Our answer:** Three months.
- **Judge reason:** Both answers state the same duration, three months.
- **Ingested turns:** 239, **retrieved:** 10, **path:** semantic+lexical, **wall:** 24579ms

### 42. e01b8e2f — CORRECT

- **Question:** Where did I go on a week-long trip with my family?
- **Gold answer:** Hawaii
- **Our answer:** Hawaii (Big Island trip with family, a week ago).
- **Judge reason:** Candidate states Hawaii, matching the gold answer.
- **Ingested turns:** 263, **retrieved:** 10, **path:** semantic+lexical, **wall:** 26694ms

### 43. bc8a6e93 — INCORRECT

- **Question:** What did I bake for my niece's birthday party?
- **Gold answer:** a lemon blueberry cake
- **Our answer:** unknown
- **Judge reason:** Candidate says unknown while gold answer specifies a lemon blueberry cake.
- **Ingested turns:** 270, **retrieved:** 9, **path:** semantic+lexical, **wall:** 27347ms

### 44. ccb36322 — INCORRECT

- **Question:** What is the name of the music streaming service have I been using lately?
- **Gold answer:** Spotify
- **Our answer:** unknown
- **Judge reason:** Candidate says unknown while the gold answer is Spotify, so the key fact is missing.
- **Ingested turns:** 237, **retrieved:** 10, **path:** semantic+lexical, **wall:** 23182ms

### 45. 001be529 — CORRECT

- **Question:** How long did I wait for the decision on my asylum application?
- **Gold answer:** over a year
- **Our answer:** Over a year.
- **Judge reason:** Both state the wait was over a year.
- **Ingested turns:** 257, **retrieved:** 10, **path:** semantic+lexical, **wall:** 24592ms

### 46. b320f3f8 — INCORRECT

- **Question:** What type of action figure did I buy from a thrift store?
- **Gold answer:** a blue Snaggletooth
- **Our answer:** unknown
- **Judge reason:** Candidate answer is 'unknown' and does not mention a blue Snaggletooth action figure.
- **Ingested turns:** 234, **retrieved:** 1, **path:** semantic+lexical, **wall:** 19426ms

### 47. 19b5f2b3 — INCORRECT

- **Question:** How long was I in Japan for?
- **Gold answer:** two weeks
- **Our answer:** unknown
- **Judge reason:** Candidate answer 'unknown' does not convey the fact that the trip was two weeks long.
- **Ingested turns:** 243, **retrieved:** 7, **path:** semantic+lexical, **wall:** 22077ms

### 48. 4fd1909e — CORRECT

- **Question:** Where did I attend the Imagine Dragons concert?
- **Gold answer:** Xfinity Center
- **Our answer:** Xfinity Center
- **Judge reason:** Candidate matches gold answer exactly.
- **Ingested turns:** 279, **retrieved:** 10, **path:** semantic+lexical, **wall:** 26941ms

### 49. 545bd2b5 — CORRECT

- **Question:** How much screen time have I been averaging on Instagram per day?
- **Gold answer:** 2 hours
- **Our answer:** 2 hours per day.
- **Judge reason:** Both state 2 hours as the average daily Instagram screen time.
- **Ingested turns:** 232, **retrieved:** 10, **path:** semantic+lexical, **wall:** 32007ms

### 50. 8a137a7f — CORRECT

- **Question:** What type of bulb did I replace in my bedside lamp?
- **Gold answer:** Philips LED bulb
- **Our answer:** Philips LED bulb
- **Judge reason:** Both answers state the same fact: a Philips LED bulb.
- **Ingested turns:** 259, **retrieved:** 10, **path:** semantic+lexical, **wall:** 26312ms

## Rerun commands

```bash
# Dataset placement (once): benchmarks/datasets/README.md

# This smoke run (20 questions, offset 0)
node benchmarks/longmemeval-smoke.mjs --n 20 --offset 0

# Full LongMemEval-S (500 questions) — budget wall time accordingly,
# see wall-time-per-question in this report to extrapolate.
node benchmarks/longmemeval-smoke.mjs --n 500 --offset 0
```
