# LongMemEval-S, 100-question stratified slice — one memory, two readers

Run date: 2026-08-31. Harness: [`benchmarks/longmemeval-smoke.mjs`](../longmemeval-smoke.mjs). Dataset: LongMemEval-S (`longmemeval_s_cleaned.json`, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`), stratified slice of the first 100 questions in dataset order at 17 per question type. Trees: the local-reader pass ran on `56412d4`; five rows that hit compose timeouts were retried on `5bffc04` with a longer ceiling, after an instrument-level A/B of every count-shaped question in the slice confirmed the two trees mount byte-identical memory.

## What was measured

Per question, a fresh child process ingests the whole haystack through the real substrate write path (`dialogueMemory.recordTurn`), digests it question-blind (identity registry, typed instances — the same pass a long-running entity accrues in idle time), backfills embeddings through the real background task, then answers through the real recall path (`engram.retrieveRelevant`). The answer is composed from the retrieved statements alone — the gold answer is never visible at compose time. Grading uses the official LongMemEval per-type judge prompts, faithfully reproduced from the upstream `evaluate_qa.py`, run at temperature 0.

Two readers composed answers over the **same memory**:

- **Local reader** — an open-weights 27B model served by llama.cpp, temperature 0. The whole stack (digestion, embeddings, retrieval, composition, judging) runs on local hardware; no cloud service is in the loop anywhere.
- **Cloud reader cross-check** — Claude Sonnet via the Claude Code CLI in a stripped environment (no settings, no tools, no ambient context), composing over the identical retrieved statements. Digestion, retrieval and judging stay local.

## Results

**Local reader (fully local stack): 83/100 = 83.0%** — every row graded

| Question type | n | Correct | Accuracy |
|---|---|---|---|
| knowledge-update | 16 | 16 | 100.0% |
| multi-session | 17 | 12 | 70.6% |
| single-session-assistant | 16 | 14 | 87.5% |
| single-session-preference | 17 | 12 | 70.6% |
| single-session-user | 17 | 14 | 82.4% |
| temporal-reasoning | 17 | 15 | 88.2% |

**Cloud reader cross-check (Claude Sonnet): 84/100 = 84.0%** — every row graded

| Question type | n | Correct | Accuracy |
|---|---|---|---|
| knowledge-update | 16 | 14 | 87.5% |
| multi-session | 17 | 11 | 64.7% |
| single-session-assistant | 16 | 14 | 87.5% |
| single-session-preference | 17 | 14 | 82.4% |
| single-session-user | 17 | 16 | 94.1% |
| temporal-reasoning | 17 | 15 | 88.2% |

## How to read this honestly

- **It is a 100-question slice, not the full 500-question set.** Binomial noise at n=100 is roughly ±7 points at these accuracies. Treat differences smaller than that — including the local-vs-cloud gap here — as noise. We publish the slice because full-set digestion costs a night of local compute; the harness runs the full set unchanged when you have the night.
- **The judge is a local open-weights model at temperature 0**, not the GPT-4o the LongMemEval paper used. The prompts are the official ones per question type (temporal off-by-one allowance, knowledge-update newest-value rule, preference rubric, abstention). A different judge model can shift absolute numbers; it applies equally to both readers here.
- **The cloud reader is not deterministic.** Repeated Sonnet passes over identical memory moved individual verdicts by 2-3 questions per hundred. The local reader and the judge run at temperature 0 and are reproducible.
- **The composition step is thinner than a real conversation turn**: the reader sees only the retrieved statement list, with none of the identity envelope a live session carries. That choice isolates what the memory retrieved from what a strong model can reconstruct, and it costs points on questions a fuller context would catch.
- **The two readers agree on what is hard.** Both miss the same core: counting occurrences across many sessions where the haystack itself describes one event in conflicting ways. That agreement — and the near-identical totals — is the result we consider load-bearing: the memory, not the reader, sets the score.
- Every number above regenerates from the checked-in harness against a public dataset. If you doubt one, run it.

## Per-question verdicts — local reader

| # | question_id | type | verdict |
|---|---|---|---|
| 1 | e47becba | single-session-user | CORRECT |
| 2 | 0a995998 | multi-session | INCORRECT |
| 3 | 8a2466db | single-session-preference | CORRECT |
| 4 | gpt4_59149c77 | temporal-reasoning | CORRECT |
| 5 | 6a1eabeb | knowledge-update | CORRECT |
| 6 | 7161e7e2 | single-session-assistant | CORRECT |
| 7 | 118b2229 | single-session-user | CORRECT |
| 8 | 6d550036 | multi-session | INCORRECT |
| 9 | 06878be2 | single-session-preference | CORRECT |
| 10 | gpt4_f49edff3 | temporal-reasoning | CORRECT |
| 11 | 6aeb4375 | knowledge-update | CORRECT |
| 12 | c4f10528 | single-session-assistant | CORRECT |
| 13 | 51a45a95 | single-session-user | INCORRECT |
| 14 | gpt4_59c863d7 | multi-session | CORRECT |
| 15 | 75832dbd | single-session-preference | CORRECT |
| 16 | 71017276 | temporal-reasoning | CORRECT |
| 17 | 830ce83f | knowledge-update | CORRECT |
| 18 | 89527b6b | single-session-assistant | CORRECT |
| 19 | 58bf7951 | single-session-user | CORRECT |
| 20 | b5ef892d | multi-session | CORRECT |
| 21 | 0edc2aef | single-session-preference | CORRECT |
| 22 | b46e15ed | temporal-reasoning | CORRECT |
| 23 | 852ce960 | knowledge-update | CORRECT |
| 24 | e9327a54 | single-session-assistant | INCORRECT |
| 25 | 1e043500 | single-session-user | CORRECT |
| 26 | e831120c | multi-session | CORRECT |
| 27 | 35a27287 | single-session-preference | CORRECT |
| 28 | gpt4_fa19884c | temporal-reasoning | CORRECT |
| 29 | 945e3d21 | knowledge-update | CORRECT |
| 30 | 4c36ccef | single-session-assistant | CORRECT |
| 31 | c5e8278d | single-session-user | CORRECT |
| 32 | 3a704032 | multi-session | INCORRECT |
| 33 | 32260d93 | single-session-preference | INCORRECT |
| 34 | 0bc8ad92 | temporal-reasoning | CORRECT |
| 35 | d7c942c3 | knowledge-update | CORRECT |
| 36 | 6ae235be | single-session-assistant | CORRECT |
| 37 | 6ade9755 | single-session-user | CORRECT |
| 38 | gpt4_d84a3211 | multi-session | CORRECT |
| 39 | 195a1a1b | single-session-preference | INCORRECT |
| 40 | af082822 | temporal-reasoning | CORRECT |
| 41 | 71315a70 | knowledge-update | CORRECT |
| 42 | 7e00a6cb | single-session-assistant | CORRECT |
| 43 | 6f9b354f | single-session-user | CORRECT |
| 44 | aae3761f | multi-session | CORRECT |
| 45 | afdc33df | single-session-preference | CORRECT |
| 46 | gpt4_4929293a | temporal-reasoning | CORRECT |
| 47 | 89941a93 | knowledge-update | CORRECT |
| 48 | 1903aded | single-session-assistant | CORRECT |
| 49 | 58ef2f1c | single-session-user | INCORRECT |
| 50 | gpt4_f2262a51 | multi-session | CORRECT |
| 51 | caf03d32 | single-session-preference | INCORRECT |
| 52 | gpt4_b5700ca9 | temporal-reasoning | CORRECT |
| 53 | ce6d2d27 | knowledge-update | CORRECT |
| 54 | ceb54acb | single-session-assistant | CORRECT |
| 55 | f8c5f88b | single-session-user | CORRECT |
| 56 | dd2973ad | multi-session | CORRECT |
| 57 | 54026fce | single-session-preference | CORRECT |
| 58 | 9a707b81 | temporal-reasoning | INCORRECT |
| 59 | 9ea5eabc | knowledge-update | CORRECT |
| 60 | f523d9fe | single-session-assistant | CORRECT |
| 61 | 5d3d2817 | single-session-user | INCORRECT |
| 62 | c4a1ceb8 | multi-session | CORRECT |
| 63 | 06f04340 | single-session-preference | CORRECT |
| 64 | gpt4_1d4ab0c9 | temporal-reasoning | CORRECT |
| 65 | 07741c44 | knowledge-update | CORRECT |
| 66 | 0e5e2d1a | single-session-assistant | CORRECT |
| 67 | 7527f7e2 | single-session-user | CORRECT |
| 68 | gpt4_a56e767c | multi-session | CORRECT |
| 69 | 6b7dfb22 | single-session-preference | CORRECT |
| 70 | gpt4_e072b769 | temporal-reasoning | CORRECT |
| 71 | a1eacc2a | knowledge-update | CORRECT |
| 72 | fea54f57 | single-session-assistant | CORRECT |
| 73 | c960da58 | single-session-user | CORRECT |
| 74 | 6cb6f249 | multi-session | CORRECT |
| 75 | 1a1907b4 | single-session-preference | INCORRECT |
| 76 | 0db4c65d | temporal-reasoning | CORRECT |
| 77 | 184da446 | knowledge-update | CORRECT |
| 78 | cc539528 | single-session-assistant | CORRECT |
| 79 | 3b6f954b | single-session-user | CORRECT |
| 80 | 46a3abf7 | multi-session | INCORRECT |
| 81 | 09d032c9 | single-session-preference | CORRECT |
| 82 | gpt4_1d80365e | temporal-reasoning | CORRECT |
| 83 | 031748ae | knowledge-update | CORRECT |
| 84 | dc439ea3 | single-session-assistant | CORRECT |
| 85 | 726462e0 | single-session-user | CORRECT |
| 86 | 36b9f61e | multi-session | CORRECT |
| 87 | 38146c39 | single-session-preference | CORRECT |
| 88 | gpt4_7f6b06db | temporal-reasoning | INCORRECT |
| 89 | 4d6b87c8 | knowledge-update | CORRECT |
| 90 | 18dcd5a5 | single-session-assistant | INCORRECT |
| 91 | 94f70d80 | single-session-user | CORRECT |
| 92 | 28dc39ac | multi-session | CORRECT |
| 93 | d24813b1 | single-session-preference | INCORRECT |
| 94 | gpt4_6dc9b45b | temporal-reasoning | CORRECT |
| 95 | 0f05491a | knowledge-update | CORRECT |
| 96 | 488d3006 | single-session-assistant | CORRECT |
| 97 | 66f24dbb | single-session-user | CORRECT |
| 98 | gpt4_2f8be40d | multi-session | INCORRECT |
| 99 | 57f827a0 | single-session-preference | CORRECT |
| 100 | gpt4_8279ba02 | temporal-reasoning | CORRECT |

## Per-question verdicts — cloud reader cross-check

| # | question_id | type | verdict |
|---|---|---|---|
| 1 | e47becba | single-session-user | CORRECT |
| 2 | 118b2229 | single-session-user | CORRECT |
| 3 | 0a995998 | multi-session | INCORRECT |
| 4 | 6d550036 | multi-session | INCORRECT |
| 5 | 8a2466db | single-session-preference | CORRECT |
| 6 | 06878be2 | single-session-preference | CORRECT |
| 7 | gpt4_59149c77 | temporal-reasoning | CORRECT |
| 8 | gpt4_f49edff3 | temporal-reasoning | INCORRECT |
| 9 | 6a1eabeb | knowledge-update | CORRECT |
| 10 | 7161e7e2 | single-session-assistant | CORRECT |
| 11 | 51a45a95 | single-session-user | CORRECT |
| 12 | 58bf7951 | single-session-user | CORRECT |
| 13 | gpt4_59c863d7 | multi-session | INCORRECT |
| 14 | b5ef892d | multi-session | CORRECT |
| 15 | 75832dbd | single-session-preference | CORRECT |
| 16 | 71017276 | temporal-reasoning | CORRECT |
| 17 | 6aeb4375 | knowledge-update | INCORRECT |
| 18 | 830ce83f | knowledge-update | CORRECT |
| 19 | c4f10528 | single-session-assistant | CORRECT |
| 20 | 89527b6b | single-session-assistant | CORRECT |
| 21 | 1e043500 | single-session-user | CORRECT |
| 22 | e831120c | multi-session | CORRECT |
| 23 | 0edc2aef | single-session-preference | CORRECT |
| 24 | 35a27287 | single-session-preference | CORRECT |
| 25 | b46e15ed | temporal-reasoning | CORRECT |
| 26 | gpt4_fa19884c | temporal-reasoning | CORRECT |
| 27 | 852ce960 | knowledge-update | CORRECT |
| 28 | 945e3d21 | knowledge-update | CORRECT |
| 29 | e9327a54 | single-session-assistant | CORRECT |
| 30 | 4c36ccef | single-session-assistant | CORRECT |
| 31 | c5e8278d | single-session-user | CORRECT |
| 32 | 6ade9755 | single-session-user | CORRECT |
| 33 | 3a704032 | multi-session | INCORRECT |
| 34 | gpt4_d84a3211 | multi-session | CORRECT |
| 35 | 32260d93 | single-session-preference | CORRECT |
| 36 | 195a1a1b | single-session-preference | CORRECT |
| 37 | 0bc8ad92 | temporal-reasoning | CORRECT |
| 38 | af082822 | temporal-reasoning | CORRECT |
| 39 | d7c942c3 | knowledge-update | CORRECT |
| 40 | 6ae235be | single-session-assistant | CORRECT |
| 41 | 6f9b354f | single-session-user | CORRECT |
| 42 | 58ef2f1c | single-session-user | CORRECT |
| 43 | aae3761f | multi-session | CORRECT |
| 44 | gpt4_f2262a51 | multi-session | CORRECT |
| 45 | afdc33df | single-session-preference | CORRECT |
| 46 | gpt4_4929293a | temporal-reasoning | CORRECT |
| 47 | 71315a70 | knowledge-update | CORRECT |
| 48 | 89941a93 | knowledge-update | CORRECT |
| 49 | 7e00a6cb | single-session-assistant | CORRECT |
| 50 | 1903aded | single-session-assistant | CORRECT |
| 51 | f8c5f88b | single-session-user | CORRECT |
| 52 | dd2973ad | multi-session | CORRECT |
| 53 | caf03d32 | single-session-preference | INCORRECT |
| 54 | 54026fce | single-session-preference | CORRECT |
| 55 | gpt4_b5700ca9 | temporal-reasoning | CORRECT |
| 56 | 9a707b81 | temporal-reasoning | INCORRECT |
| 57 | ce6d2d27 | knowledge-update | CORRECT |
| 58 | 9ea5eabc | knowledge-update | CORRECT |
| 59 | ceb54acb | single-session-assistant | CORRECT |
| 60 | f523d9fe | single-session-assistant | CORRECT |
| 61 | 5d3d2817 | single-session-user | INCORRECT |
| 62 | 7527f7e2 | single-session-user | CORRECT |
| 63 | c4a1ceb8 | multi-session | CORRECT |
| 64 | gpt4_a56e767c | multi-session | INCORRECT |
| 65 | 06f04340 | single-session-preference | CORRECT |
| 66 | 6b7dfb22 | single-session-preference | CORRECT |
| 67 | gpt4_1d4ab0c9 | temporal-reasoning | CORRECT |
| 68 | gpt4_e072b769 | temporal-reasoning | CORRECT |
| 69 | 07741c44 | knowledge-update | CORRECT |
| 70 | 0e5e2d1a | single-session-assistant | CORRECT |
| 71 | c960da58 | single-session-user | CORRECT |
| 72 | 3b6f954b | single-session-user | CORRECT |
| 73 | 6cb6f249 | multi-session | CORRECT |
| 74 | 46a3abf7 | multi-session | CORRECT |
| 75 | 1a1907b4 | single-session-preference | INCORRECT |
| 76 | 0db4c65d | temporal-reasoning | CORRECT |
| 77 | a1eacc2a | knowledge-update | INCORRECT |
| 78 | 184da446 | knowledge-update | CORRECT |
| 79 | fea54f57 | single-session-assistant | CORRECT |
| 80 | cc539528 | single-session-assistant | CORRECT |
| 81 | 726462e0 | single-session-user | CORRECT |
| 82 | 36b9f61e | multi-session | CORRECT |
| 83 | 09d032c9 | single-session-preference | CORRECT |
| 84 | 38146c39 | single-session-preference | CORRECT |
| 85 | gpt4_1d80365e | temporal-reasoning | CORRECT |
| 86 | gpt4_7f6b06db | temporal-reasoning | CORRECT |
| 87 | 031748ae | knowledge-update | CORRECT |
| 88 | 4d6b87c8 | knowledge-update | CORRECT |
| 89 | dc439ea3 | single-session-assistant | INCORRECT |
| 90 | 18dcd5a5 | single-session-assistant | INCORRECT |
| 91 | 94f70d80 | single-session-user | CORRECT |
| 92 | 66f24dbb | single-session-user | CORRECT |
| 93 | 28dc39ac | multi-session | CORRECT |
| 94 | gpt4_2f8be40d | multi-session | INCORRECT |
| 95 | d24813b1 | single-session-preference | INCORRECT |
| 96 | 57f827a0 | single-session-preference | CORRECT |
| 97 | gpt4_6dc9b45b | temporal-reasoning | CORRECT |
| 98 | gpt4_8279ba02 | temporal-reasoning | CORRECT |
| 99 | 0f05491a | knowledge-update | CORRECT |
| 100 | 488d3006 | single-session-assistant | CORRECT |
