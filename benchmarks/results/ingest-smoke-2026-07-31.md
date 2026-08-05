# RESEARCH-INGEST SMOKE — troth substrate Chameleon doc-QA path

Run: 2026-07-31T02:00:04.877Z

## Summary

| Metric | Value |
|---|---|
| Sample size | 20 paper+question items (offset 0) |
| Graded | 20/20 |
| Correct | 15 |
| Incorrect | 5 |
| Errors | 0 |
| **Accuracy (of graded)** | **75.0%** |
| Wall time | 100.2s |
| top_k retrieved per question | 8 |
| Retrieval path(s) observed | semantic+lexical |
| Embed server probe target | http://127.0.0.1:11437 |

## What this measures (and how it differs from LongMemEval)

LongMemEval (see `benchmarks/results/longmemeval-smoke-*.md`) tests **conversational memory**: dialogue turns written via `dialogueMemory.recordTurn()` and recalled via `engram.retrieveRelevant()`'s no-scope cross-type branch (`recall.recall({class:'all'})`).

This benchmark tests the **Chameleon L3 document-ingest path** (`shared-core/chameleon.js`) instead — a structurally different code path: a whole research paper's full text is chunked (paragraph/sentence-aware, ~800 chars/100-char overlap) and embedded via `chameleon.ingestDocument()`, persisted as engrams tagged with a per-paper `scope` (`docs:qasper-<paper_id>`), then queried via `chameleon.queryScope()`, which routes `engram.retrieveRelevant()` into its **scope-locked legacy commitment+embedding path** (`engram.js` — the "caller wants a specific commitment corpus (chameleon docs:* etc)" branch), NOT the dialogue-turn cross-type branch LongMemEval exercises. This is the same function the MCP `troth_chameleon_query` tool calls.

## Honest caveats

- **20-item smoke slice**, not a full QASPER run (the dev split alone has 281 papers / ~1.3k answerable non-yes/no questions). Accuracy at n=20 has a wide confidence interval (~±20pp at 95% CI for a binomial proportion) — treat as a pipeline-works signal, not a publishable number.
- **Dataset**: QASPER dev split (`allenai/qasper`), downloaded from the official Allen AI S3 mirror (`https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz`) because the HuggingFace `allenai/qasper` repo only ships the dataset-loader script (`qasper.py`), not data files or a parquet mirror.
- **Slice construction**: filtered to papers with 8k-35k chars of full text (fast-enough ingest, still a real paper — not an abstract), excluded `unanswerable` and `yes_no` questions (noisy to grade against a single free-text composed answer per the task spec), then took 15 `extractive_spans` items (gold = spans joined by "; ") + 5 short `free_form_answer` items (gold < 200 chars), one question per distinct paper, seeded random shuffle (seed 42) for selection order. Selection script: not committed (one-off, see this file's header for the exact filter/seed logic to reproduce).
- **Ingest is the paper's real full text**: title + abstract + every section's paragraphs from QASPER's already-PDF-segmented `full_text` field, joined in document order — not a summary or truncated excerpt.
- Retrieval path: worker probes `http://127.0.0.1:11437`/health itself per paper and reports `semantic+lexical` when the local embed server answered, `lexical_fallback` otherwise (see `retrieval_path` column). This is a side-channel label only — `chameleon.ingestDocument`/`queryScope` always run for real and self-degrade (null embedding per chunk, lexical-only rerank) on embed failure regardless of what the probe says.
- Ingest and query both go through the REAL substrate path: `chameleon.ingestDocument()` (chunks+embeds+persists as scoped engrams) and `chameleon.queryScope()` -> `engram.retrieveRelevant()` with `scope` set (the scope-locked legacy corpus path). No benchmark-only shortcut, no raw SQL read.
- Each paper runs in a fully isolated, throwaway HOME (fresh child process per paper, mirrors `tests/hermetic-db.js`'s HOME-redirect mechanism — `STATE_DB_PATH` alone does NOT isolate `shared-core/state.js`, which resolves off HOME/CLAUDE_PLUGIN_DATA) — nothing was written to the operator's real `~/.troth`.
- The compose+judge model is `codex-oneshot.mjs` (a GPT-5 class model through the ChatGPT Responses endpoint), NOT the original QASPER paper's F1/token-overlap evaluator, so numbers are not directly comparable to published QASPER leaderboard scores without re-running their exact metric.
- "Our answer" is composed by handing the model ONLY the retrieved chunk excerpts (no gold answer visible at compose time) and asking it to answer from those alone, saying "unknown" if absent — isolates retrieval quality from judge leniency, same contract as the LongMemEval harness's `composeAnswerPrompt`.

## Per-question verdicts

| # | paper_id | kind | verdict | retrieved | path | question |
|---|---|---|---|---|---|---|
| 1 | 1911.01371 | extractive | CORRECT | 8 | semantic+lexical | How did they obtain the OSG dataset? |
| 2 | 1606.03676 | extractive | CORRECT | 8 | semantic+lexical | which languages are explored? |
| 3 | 1801.10293 | extractive | INCORRECT | 8 | semantic+lexical | Which translation systems do they compare against? |
| 4 | 1912.08904 | extractive | INCORRECT | 8 | semantic+lexical | What interface does Macaw currently have? |
| 5 | 1910.14537 | extractive | CORRECT | 8 | semantic+lexical | What is meant by closed test setting? |
| 6 | 1910.08293 | extractive | INCORRECT | 8 | semantic+lexical | How does dataset model character's profiles? |
| 7 | 1909.03405 | extractive | CORRECT | 8 | semantic+lexical | How much is performance improved on NLI? |
| 8 | 1911.02855 | extractive | CORRECT | 8 | semantic+lexical | What are method's improvements of F1 w.r.t. baseline BERT tagger for Chinese POS datasets? |
| 9 | 1703.07476 | extractive | INCORRECT | 8 | semantic+lexical | How is the vocabulary of word-like or phoneme-like units automatically discovered? |
| 10 | 1810.04428 | extractive | CORRECT | 8 | semantic+lexical | what are the sizes of both datasets? |
| 11 | 1912.01214 | extractive | CORRECT | 8 | semantic+lexical | which datasets did they experiment with? |
| 12 | 1806.04511 | extractive | CORRECT | 8 | semantic+lexical | which non-english language had the best performance? |
| 13 | 1910.12574 | extractive | CORRECT | 8 | semantic+lexical | What existing approaches do they compare to? |
| 14 | 1712.00991 | extractive | CORRECT | 8 | semantic+lexical | What clustering algorithms were used? |
| 15 | 1811.08603 | extractive | CORRECT | 8 | semantic+lexical | How effective is their NCEL approach overall? |
| 16 | 2002.12612 | free_form_short | CORRECT | 8 | semantic+lexical | How is the political bias of different sources included in the model? |
| 17 | 1909.01383 | free_form_short | INCORRECT | 8 | semantic+lexical | by how much did the BLEU score improve? |
| 18 | 1705.01265 | free_form_short | CORRECT | 8 | semantic+lexical | How were the cluster extracted?  |
| 19 | 1710.03348 | free_form_short | CORRECT | 8 | semantic+lexical | In what cases is attention different from alignment? |
| 20 | 1911.10049 | free_form_short | CORRECT | 8 | semantic+lexical | How larger are the training sets of these versions of ELMo compared to the previous ones? |

## Detail (gold vs our answer, judge reason)

### 1. 1911.01371 — CORRECT

- **Title:** Affective Behaviour Analysis of On-line User Interactions: Are On-line Support Groups more Therapeutic than Twitter?
- **Question:** How did they obtain the OSG dataset?
- **Gold answer:** crawling and pre-processing an OSG web forum
- **Our answer:** By “crawling and pre-processing an OSG web forum.”
- **Judge reason:** The candidate exactly matches the gold answer.
- **Ingest:** {"ok":true,"chunks":41,"recorded":41,"embedded":41}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 3706ms

### 2. 1606.03676 — CORRECT

- **Title:** External Lexical Information for Multilingual Part-of-Speech Tagging
- **Question:** which languages are explored?
- **Gold answer:** Bulgarian, Croatian, Czech, Danish, English, French, German, Indonesian, Italian, Norwegian, Persian, Polish, Portuguese, Slovenian, Spanish and Swedish
- **Our answer:** Bulgarian, Croatian, Czech, Danish, English, French, German, Indonesian, Italian, Norwegian, Persian, Polish, Portuguese, Slovenian, Spanish, and Swedish.
- **Judge reason:** The candidate lists exactly the same sixteen languages as the gold answer.
- **Ingest:** {"ok":true,"chunks":32,"recorded":32,"embedded":32}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4388ms

### 3. 1801.10293 — INCORRECT

- **Title:** Paraphrase-Supervised Models of Compositionality
- **Question:** Which translation systems do they compare against?
- **Gold answer:** hierarchical phrase-based system BIBREF29; appropriate additional baseline would be to mark translation rules with these indicator functions but without the scores, akin to identifying rules with phrases in them (Baseline + SegOn)
- **Our answer:** A hierarchical phrase-based baseline system with a 4-gram language model, tuned using MIRA.
- **Judge reason:** It mentions only the hierarchical phrase-based baseline and omits the additional Baseline + SegOn comparison system.
- **Ingest:** {"ok":true,"chunks":48,"recorded":48,"embedded":48}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 6382ms

### 4. 1912.08904 — INCORRECT

- **Title:** Macaw: An Extensible Conversational Information Seeking Platform
- **Question:** What interface does Macaw currently have?
- **Gold answer:** File IO; Standard IO; Telegram
- **Our answer:** A command-line interface and mobile, desktop, and web apps, including a Telegram bot.
- **Judge reason:** It omits File IO and incorrectly adds mobile, desktop, and web apps.
- **Ingest:** {"ok":true,"chunks":20,"recorded":20,"embedded":20}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5655ms

### 5. 1910.14537 — CORRECT

- **Title:** Attention Is All You Need for Chinese Word Segmentation
- **Question:** What is meant by closed test setting?
- **Gold answer:** closed test limits all the data for learning should not be beyond the given training set, while open test does not take this limitation
- **Our answer:** “Closed test limits all the data for learning [to] not be beyond the given training set.”
- **Judge reason:** The candidate correctly states that a closed test restricts learning data to the given training set.
- **Ingest:** {"ok":true,"chunks":41,"recorded":41,"embedded":41}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4098ms

### 6. 1910.08293 — INCORRECT

- **Title:** Follow Alice into the Rabbit Hole: Giving Dialogue Agents Understanding of Human Level Attributes.
- **Question:** How does dataset model character's profiles?
- **Gold answer:** attributes are determined by human viewers and their impressions of the characters, and are correlated with human-like characteristics
- **Our answer:** By combining detailed Human Level Attribute (HLA) data with dialogue data for specific characters.
- **Judge reason:** The candidate describes combining attribute and dialogue data, not that profiles are based on viewers' impressions and correlated with human-like characteristics.
- **Ingest:** {"ok":true,"chunks":56,"recorded":56,"embedded":56}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5950ms

### 7. 1909.03405 — CORRECT

- **Title:** Symmetric Regularization based BERT for Pair-wise Semantic Reasoning
- **Question:** How much is performance improved on NLI?
- **Gold answer:**  improvement on the RTE dataset is significant, i.e., 4% absolute gain over the BERTBase
- **Our answer:** “4% absolute gain over the BERTBase” on the RTE dataset.
- **Judge reason:** The candidate exactly matches the reported 4% absolute gain over BERTBase on RTE.
- **Ingest:** {"ok":true,"chunks":42,"recorded":42,"embedded":42}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4896ms

### 8. 1911.02855 — CORRECT

- **Title:** Dice Loss for Data-imbalanced NLP Tasks
- **Question:** What are method's improvements of F1 w.r.t. baseline BERT tagger for Chinese POS datasets?
- **Gold answer:** +1.86 in terms of F1 score on CTB5; +1.80 on CTB6; +2.19 on UD1.4
- **Our answer:** +1.86 on CTB5, +1.80 on CTB6, and +2.19 on UD1.4.
- **Judge reason:** The candidate exactly matches the reported F1 improvements for CTB5, CTB6, and UD1.4.
- **Ingest:** {"ok":true,"chunks":40,"recorded":40,"embedded":40}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4378ms

### 9. 1703.07476 — INCORRECT

- **Title:** Topic Identification for Speech without ASR
- **Question:** How is the vocabulary of word-like or phoneme-like units automatically discovered?
- **Gold answer:** Zero Resource Toolkit (ZRTools) BIBREF7
- **Our answer:** By unsupervised term discovery (UTD) using segmental DTW for word-like units, or Variational Bayesian HMM-based acoustic unit discovery (AUD) for phoneme-like units.
- **Judge reason:** The candidate describes discovery methods but does not identify the Zero Resource Toolkit (ZRTools) named in the gold answer.
- **Ingest:** {"ok":true,"chunks":42,"recorded":42,"embedded":42}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5254ms

### 10. 1810.04428 — CORRECT

- **Title:** Improving Neural Text Simplification Model with Simplified Corpora
- **Question:** what are the sizes of both datasets?
- **Gold answer:** training set has 89,042 sentence pairs, and the test set has 100 pairs; training set contains 296,402; 2,000 for development and 359 for testing
- **Our answer:** WikiSmall: 89,042 training pairs and 100 test pairs; WikiLarge: 296,402 training pairs, plus 2,000 development and 359 test sentences, each with 8 simplifications.
- **Judge reason:** The candidate accurately reports the training, development, and test sizes for both WikiSmall and WikiLarge.
- **Ingest:** {"ok":true,"chunks":26,"recorded":26,"embedded":26}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 3957ms

### 11. 1912.01214 — CORRECT

- **Title:** Cross-lingual Pre-training Based Transfer for Zero-shot Neural Machine Translation
- **Question:** which datasets did they experiment with?
- **Gold answer:** Europarl; MultiUN
- **Our answer:** Europarl and MultiUN.
- **Judge reason:** The candidate names both datasets in the gold answer: Europarl and MultiUN.
- **Ingest:** {"ok":true,"chunks":47,"recorded":47,"embedded":47}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 3978ms

### 12. 1806.04511 — CORRECT

- **Title:** Multilingual Sentiment Analysis: An RNN-Based Framework for Limited Data
- **Question:** which non-english language had the best performance?
- **Gold answer:** Russian
- **Our answer:** Russian, with 85.62% accuracy.
- **Judge reason:** The candidate correctly identifies Russian as the best-performing non-English language.
- **Ingest:** {"ok":true,"chunks":31,"recorded":31,"embedded":31}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5634ms

### 13. 1910.12574 — CORRECT

- **Title:** A BERT-Based Transfer Learning Approach for Hate Speech Detection in Online Social Media
- **Question:** What existing approaches do they compare to?
- **Gold answer:** Waseem and Hovy BIBREF5, Davidson et al. BIBREF9, and Waseem et al. BIBREF10
- **Our answer:** Waseem and Hovy, Davidson et al., and Waseem et al. baselines.
- **Judge reason:** The candidate names the same three prior approaches as the gold answer.
- **Ingest:** {"ok":true,"chunks":46,"recorded":46,"embedded":46}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5832ms

### 14. 1712.00991 — CORRECT

- **Title:** Mining Supervisor Evaluation and Peer Feedback in Performance Appraisals
- **Question:** What clustering algorithms were used?
- **Gold answer:** CLUTO; Carrot2 Lingo
- **Our answer:** CLUTO and Carrot2 Lingo.
- **Judge reason:** The candidate names both clustering algorithms: CLUTO and Carrot2 Lingo.
- **Ingest:** {"ok":true,"chunks":35,"recorded":35,"embedded":35}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4235ms

### 15. 1811.08603 — CORRECT

- **Title:** Neural Collective Entity Linking
- **Question:** How effective is their NCEL approach overall?
- **Gold answer:** NCEL consistently outperforms various baselines with a favorable generalization ability
- **Our answer:** NCEL “consistently outperforms various baselines” and state-of-the-art collective methods across five datasets, with favorable generalization and efficiency.
- **Judge reason:** The candidate matches the gold answer by stating that NCEL consistently outperforms baselines and has favorable generalization.
- **Ingest:** {"ok":true,"chunks":47,"recorded":47,"embedded":47}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5084ms

### 16. 2002.12612 — CORRECT

- **Title:** A multi-layer approach to disinformation detection on Twitter
- **Question:** How is the political bias of different sources included in the model?
- **Gold answer:** By assigning a political bias label to each news article and training only on left-biased or right-biased outlets of both disinformation and mainstream domains
- **Our answer:** By assigning political-bias labels to US outlets—and thus their articles—following the procedure in BIBREF2, then training only on left- or right-biased networks.
- **Judge reason:** It matches the gold answer by describing article-level bias labels and training restricted to left- or right-biased sources.
- **Ingest:** {"ok":true,"chunks":57,"recorded":57,"embedded":57}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5136ms

### 17. 1909.01383 — INCORRECT

- **Title:** Context-Aware Monolingual Repair for Neural Machine Translation
- **Question:** by how much did the BLEU score improve?
- **Gold answer:** On average 0.64
- **Our answer:** 0.7 BLEU over the baseline and CADec.
- **Judge reason:** The candidate states a 0.7 BLEU improvement, while the gold answer specifies an average improvement of 0.64.
- **Ingest:** {"ok":true,"chunks":41,"recorded":41,"embedded":41}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 6787ms

### 18. 1705.01265 — CORRECT

- **Title:** On the effectiveness of feature set augmentation using clusters of word embeddings
- **Question:** How were the cluster extracted? 
- **Gold answer:** Word clusters are extracted using k-means on word embeddings
- **Our answer:** By clustering the embeddings with k-means, initialized using “k-means++” and run for 300 iterations.
- **Judge reason:** The candidate correctly states that clusters were extracted by applying k-means to word embeddings.
- **Ingest:** {"ok":true,"chunks":29,"recorded":29,"embedded":29}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4671ms

### 19. 1710.03348 — CORRECT

- **Title:** What does Attention in Neural Machine Translation Pay Attention to?
- **Question:** In what cases is attention different from alignment?
- **Gold answer:** For certain POS tags, e.g. VERB, PRON.
- **Our answer:** “In the case of verbs,” attention “captures other information rather than only the translational equivalent,” attending to “context words influencing the current word translation.”
- **Judge reason:** The candidate identifies verbs as a POS case where attention differs from alignment and explains the difference.
- **Ingest:** {"ok":true,"chunks":37,"recorded":37,"embedded":37}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 4437ms

### 20. 1911.10049 — CORRECT

- **Title:** High Quality ELMo Embeddings for Seven Less-Resourced Languages
- **Question:** How larger are the training sets of these versions of ELMo compared to the previous ones?
- **Gold answer:** By 14 times.
- **Our answer:** “A few hundred million tokens” versus the previous “20-million token corpora.”
- **Judge reason:** A few hundred million tokens compared with 20 million implies an approximately 14-fold increase.
- **Ingest:** {"ok":true,"chunks":34,"recorded":34,"embedded":34}, **retrieved:** 8, **path:** semantic+lexical, **wall:** 5764ms

## Rerun commands

```bash
# The 20-item QASPER slice this run measured ships with the repository
# (benchmarks/datasets/qasper/smoke-slice-20.json, CC BY 4.0), so this
# runs from a clean clone with nothing to download.

# This smoke run (20 items, offset 0)
node benchmarks/ingest-smoke.mjs --n 20 --offset 0

# Fast check (first 5 only)
node benchmarks/ingest-smoke.mjs --n 5
```
