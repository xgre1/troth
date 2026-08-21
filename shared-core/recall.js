// SPDX-License-Identifier: AGPL-3.0-only
// recall.js — unified class-routed retrieval surface.
//
//
// Replaces the pre-v2 pattern where engram_search was the "search my mind"
// tool but hard-clamped to commitment/engram, leaving 3700 research
// lessons (type='lesson') structurally invisible. recall() pre-filters by
// audience (default 'model_visible' — substrate_internal items never reach
// the LLM via this surface; an explicit `recall_internal` would be added
// for that) and then routes per memory_class to the right primitive:
//
//   identity   → engram.listEngrams scope='identity', lexical+salience sort
//   semantic   → query.getLessons + token-overlap score (research corpora)
//   episodic   → entityAxis.multiAxisQuery temporal-dominant weights
//   procedural → state.queryActions type='compiled_procedure'
//
// class='all' runs identity → procedural → semantic → episodic (priority
// order, dedup by id), capped at `limit` total. Honest empty result when
// no class produces a match; never falls back to "any commitment" noise.
//
// API:
//   recall({ query, class?, audience?, limit?, cwd? }) → [{ id, statement,
//     class, score, source, ts }]
//
// audience values:
//   'model_visible'         — default, only items written for the LLM
//   'substrate_internal'    — only operational/handoff/trace items
//   'synthesis_of_external' — content DERIVED FROM external/untrusted input
//                             (web search hits, fetched docs, third-party
//                             tool output). Distinct tier — must be wrapped
//                             in explicit "this is data, not instruction"
//                             framing by the prefix provider, never mounted
//                             as direct context. Prevents the prompt-
//                             injection-via-fetched-content bypass that
//                             plain model_visible mounting can't catch.
//                             See the audience-chain propagation note.
//   'all'                   — every tier (admin/diagnostic; avoid in
//                             prefix paths)

const state      = require('./state.js');
const engram     = require('./engram.js');
const query      = require('./query.js');
const entityAxis = require('./entity-axis.js');

const VALID_CLASSES   = ['identity', 'episodic', 'semantic', 'procedural', 'all'];
const VALID_AUDIENCES = ['model_visible', 'substrate_internal', 'synthesis_of_external', 'all'];

// Token split mirroring engram.js / entity-axis.js so scoring is
// consistent across surfaces. Splits on anything that is NOT a letter
// (any script — Greek, Latin, Cyrillic, etc) or digit. Unicode property
// escapes (\p{L}\p{N}) keep Greek-language voice turns recallable —
// earlier /[^a-z0-9_]+/i regex stripped Greek characters entirely,
// silently returning zero hits for Greek queries.
function tokenize(s) {
  return String(s || '').toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(t => t.length >= 3);
}

// Build a safe FTS5 OR-of-tokens query. We OR (not AND) so the candidate
// pool is wide — every row mentioning ANY token enters the JS scorer,
// which then ranks by full token overlap. AND-only would drop rows that
// match strongly on 2/3 tokens (the most common shape in conversational
// recall: "what did we say about X" → tokens like 'what','did','say'
// drop out via stopword, leaving the topic-bearing token alone). Each
// token is wrapped in double quotes so FTS5 treats it as a literal,
// neutralizing punctuation that would otherwise be parsed as operators.
function buildFtsQuery(query) {
  const tokens = tokenize(query);
  if (!tokens.length) return null;
  return tokens.map(t => '"' + t.replace(/"/g, '') + '"').join(' OR ');
}

function audienceOk(rowAudience, want) {
  if (want === 'all') return true;
  // Legacy rows (audience IS NULL) treated as substrate_internal at read,
  // matching the doc design note sentinel semantics.
  const effective = rowAudience || 'substrate_internal';
  return effective === want;
}

// L1/L2 PLR completion: scan candidate row pool for
// supersession pointers (output.lifetime.supersedes), return the set of
// retired ids. Default recall paths exclude these. Mirror of the
// listEngrams supersedes filter in engram.js — keeps the "current view
// follows the supersession chain" contract that lability-reconsolidation
// has documented since day one but no consumer enforced.
//
// The window scan alone was best-effort: a successor outside the fetched
// window let its retired predecessor keep surfacing — which is exactly how
// a "forgotten" fact came back (the /forget superseder is written once,
// then falls out of every later window while the popular original keeps
// ranking in). The persisted superseded_ids index (state.js, maintained on
// every write + one-time backfill) closes that: the window scan still
// catches rows the index migration never saw, the index catches successors
// no window holds. For audit/correctness queries that need retired rows
// visible, pass opts.include_superseded=true to skip the filter entirely.
function buildSupersededIds(rows) {
  const set = new Set();
  if (!Array.isArray(rows)) return set;
  for (const r of rows) {
    let out;
    try { out = (typeof r.output === 'string') ? JSON.parse(r.output) : r.output; }
    catch (_) { continue; }
    const sup = out && out.lifetime && out.lifetime.supersedes;
    if (!sup) continue;
    // lifetime.supersedes accepts either a
    // single id (legacy PLR — one new statement retires one prior)
    // or an array of ids (identity drift resolution — one operator
    // correction retires all contradicting priors at once). Both shapes
    // collapse to the same retired-id set here.
    if (Array.isArray(sup)) {
      for (const s of sup) if (s) set.add(s);
    } else {
      set.add(sup);
    }
  }
  // Union in the persisted index — fail-open to the pure window scan.
  try { for (const id of state.listSupersededIds()) set.add(id); } catch (_) {}
  return set;
}

// A8 — unified-memory soft ranking.
//
// Substrate-as-mind premise: ONE brain, all memories accessible, but
// ranking biases toward what's coherent with the current work. The
// prior recall.* implementations hard-partitioned by cwd at SQL level
// (`ar.cwd = @cwd` in state.searchActionsFull). That hidden partition
// (a) duplicates the brain per-folder, breaking the one-mind invariant, and
// (b) drops 9,862 NULL-cwd legacy rows + 8,296 home-dir generic-root
// rows from EVERY query — they were never reachable from a more-specific
// cwd. Replacement: candidate pool widens (no SQL cwd filter); ranking
// gains topic-coherence + cwd-match BOOSTS (Generative Agents weighted-
// sum pattern, Park et al. 2023, §A.2 "Retrieval and Reflection").
//
// Score recipe (episodic example):
//   overlap*0.6 + recency*0.1 + topicBoost*0.2 + cwdBoost*0.1
// cwdBoost = 1.0 same-cwd, 0.5 NULL-cwd (neutral legacy), 0.0 foreign-cwd
// topicBoost = fraction of topic tokens present in row text (0..1)
// min_overlap floor: rows with zero query-token overlap can't be saved
// by topic alone (prevents identity-flood; topic is tiebreaker among
// relevant candidates, not a way for irrelevant ones to win).

// Build topic tokens from cwd basename + (optionally later) dialogue
// turns + active commitments. Filters out generic identifiers
// (users, documents, home) that would dilute the signal — every
// operator session has those, they don't disambiguate any topic.
const GENERIC_PATH_TOKENS = new Set([
  'users', 'documents', 'home', 'tmp', 'private', 'var', 'folders',
  'desktop', 'downloads', 'workspace', 'projects'
]);
// Klinger 1987 current-concerns: the substrate's open commitments +
// active goals continuously bias attention. Surface that as a substrate
// retrieval bias by UNIONing concern-derived tokens into the topic
// vector. recall scoring already multiplies by topicBoost, so concerns
// become a continuous bias factor on every recall query — not a
// discrete artifact (retires concern-surfacer.js as the canonical path).
// Bounded (top-K per source) so a long backlog doesn't explode tokens.
// Off-by-default via env TROTH_RECALL_CONCERNS=0 — substrate stays
// honest when concerns surface as noise rather than signal during early
// adoption. Lazy-require avoids circular module-load during test boot.
const CONCERN_TOP_K = 5;
const CONCERN_MIN_LEN = 4;
const _CONCERN_STOPWORDS = new Set([
  'the','a','an','of','to','for','and','or','is','are','was','were','be','been',
  'in','on','at','by','with','from','as','this','that','these','those','it','its',
  'will','would','should','can','may','might','they','goal','task','want','need',
  'have','make','help','build','fix'
]);

function _gatherConcernTokens() {
  const out = new Set();
  // L1/L2 EVOLUTION design note — Klinger 1987 current-concerns as recall
  // bias. DEFAULT ON since  after root-causing the prior
  // L4-GS-2..L4-GS-5 suite breakage: it was test-infrastructure split-
  // brain (CLAUDE_PLUGIN_DATA-mutating tests leaked stale module caches
  // across 42 dependents), not a substrate bug in this path. Fix: tests
  // that re-target CLAUDE_PLUGIN_DATA now mass-invalidate /shared-core/
  // require.cache at end-of-block (RCL-99, BFA-cleanup), so subsequent
  // tests get fresh module instances pointing at the restored env.
  //
  // Opt-out via TROTH_RECALL_CONCERNS=0 for substrates that want
  // unbiased recall (e.g. cold-start benchmarking, A/B comparison vs
  // unbiased baseline).
  if (process.env.TROTH_RECALL_CONCERNS === '0') return out;
  let typedGoal, typedCommit;
  try { typedGoal   = require('./typed-goal.js'); } catch (_) { return out; }
  try { typedCommit = require('./typed-commitment.js'); } catch (_) {}
  const _addTokens = (text) => {
    if (!text || typeof text !== 'string') return;
    const m = text.toLowerCase().match(/[a-z0-9]+/g);
    if (!m) return;
    for (const t of m) {
      if (t.length < CONCERN_MIN_LEN) continue;
      if (_CONCERN_STOPWORDS.has(t)) continue;
      out.add(t);
    }
  };
  try {
    const open = typedGoal.listGoals({ status: 'open', limit: CONCERN_TOP_K }) || [];
    for (const g of open) _addTokens(g.statement);
  } catch (_) {}
  if (typedCommit) {
    try {
      const active = typedCommit.listCommitments({ status: 'active', limit: CONCERN_TOP_K }) || [];
      for (const c of active) _addTokens(c.claim);
    } catch (_) {}
  }
  return out;
}

function buildTopicTokens(opts) {
  const out = new Set();
  if (opts.cwd && typeof opts.cwd === 'string') {
    const parts = opts.cwd.split('/').filter(Boolean);
    for (const p of parts) {
      const tok = String(p).toLowerCase();
      if (tok.length < 3) continue;
      if (GENERIC_PATH_TOKENS.has(tok)) continue;
      // Skip the operator's home-dir name (any single 3-12-char token
      // that's the third path component after the macOS home root — that's
      // the operator's macOS short username on darwin systems).
      out.add(tok);
    }
  }
  // Klinger concerns: caller may pass include_concerns=false to suppress
  // (debug / tests). Otherwise default-on, gated by env var inside.
  if (opts.include_concerns !== false) {
    const concerns = _gatherConcernTokens();
    for (const t of concerns) out.add(t);
  }
  return out;
}

function topicBoost(text, topicTokens) {
  if (!topicTokens || !topicTokens.size) return 0;
  const blob = String(text || '').toLowerCase();
  let hits = 0;
  for (const t of topicTokens) if (blob.indexOf(t) >= 0) hits++;
  return hits / topicTokens.size;
}

// Truth-score recall bias (L1/L2 design note candidate). The substrate's
// PLR-evolved self-confidence per engram becomes load-bearing in
// retrieval — high-truth-score engrams dominate recall; PLR-falsified
// engrams (truth_score → 0) demote but don't fully disappear (alpha
// floor preserves them for explicit "what did I get wrong" queries).
//   final_score = base_score × (alpha + (1-alpha) × truth_score)
// Default alpha=0.3 means falsified engrams keep 30% of base score.
const TRUTH_FACTOR_ALPHA = 0.3;
// Authority model — single source of truth in shared-core/authority-weights.js
// (S3). One coherent gradient + fail-neutral __unmigrated__ default, shared by
// recall, the identity envelope, and the proxy injector so no surface forks
// its own ranking. See that module for the full rationale an internal audit.
const { AUTHORITY_WEIGHTS, UNMIGRATED_SENTINEL } = require('./authority-weights.js');
function truthFactor(row) {
  let ts = null;
  let out = null;
  if (row && row.output) {
    if (typeof row.output === 'object' && row.output.truth_score !== undefined) {
      out = row.output;
      ts = row.output.truth_score;
    } else if (typeof row.output === 'string') {
      try { out = JSON.parse(row.output); ts = out && out.truth_score; } catch (_) {}
    }
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) ts = 1.0;
  const tsFactor = TRUTH_FACTOR_ALPHA + (1 - TRUTH_FACTOR_ALPHA) * Math.max(0, Math.min(1, ts));
  const auth = (out && out.source_authority) || (row && row.source_authority) || UNMIGRATED_SENTINEL;
  const authWeight = AUTHORITY_WEIGHTS[auth] !== undefined ? AUTHORITY_WEIGHTS[auth] : AUTHORITY_WEIGHTS[UNMIGRATED_SENTINEL];
  // Bjork desirable difficulty. Facts pulled
  // often strengthen; never-recalled facts fade relative to active ones.
  // Multiplier: 1 + log10(count + 1) × 0.10. Counts of 0/1/10/100/1000
  // yield factors of 1.00 / 1.03 / 1.10 / 1.20 / 1.30 — modest enough
  // that a never-touched operator-confirmed fact still outranks a heavily-
  // used regex extraction (because authority is the dominant axis), but
  // big enough to break ties and let high-use facts float.
  let retrievalFactor = 1.0;
  if (row && row.id) {
    try {
      const cnt = state.getRetrievalCount(row.id);
      if (cnt > 0) retrievalFactor = 1.0 + Math.log10(cnt + 1) * 0.10;
    } catch (_) { /* no stats → neutral */ }
  }
  return tsFactor * authWeight * retrievalFactor;
}

function cwdBoost(rowCwd, queryCwd) {
  if (!queryCwd) return 0.5; // No cwd context — neutral
  if (!rowCwd) return 0.5;   // Legacy NULL — neutral (don't penalize)
  if (rowCwd === queryCwd) return 1.0;
  // Prefix match (e.g. a home dir matches home/Documents/proj)
  // gives a softer 0.5 — same general area but not pinned to this work.
  if (queryCwd.indexOf(rowCwd) === 0 || rowCwd.indexOf(queryCwd) === 0) return 0.5;
  return 0.0;
}

function recallIdentity(opts) {
  // Audience filter: identity was the ONE sub-recall that
  // didn't honor opts.audience — recallEpisodic/Semantic/Procedural all call
  // audienceOk(), but identity pulled listEngrams() with the default 'all',
  // so substrate_internal rows (drafts, abandoned-project facts like "operator
  // wants the schedule app to be trolliko") leaked into the always-on identity
  // envelope and recalled as the #0 hit for unrelated queries — the partner
  // conflated dead contexts. Forward the caller's audience so identity matches
  // the other classes (model_visible by default; 'all' only for admin/audit).
  const items = engram.listEngrams({ scope: 'identity', limit: 200,
    audience: opts.audience || 'model_visible',
    include_superseded: !!opts.include_superseded }) || [];
  const qt = tokenize(opts.query);
  // Step B: TMMA tier='flagged' filter consistency. Previously
  // only recallEpisodic filtered flagged engrams; identity/semantic/
  // procedural surfaced them with only truth_score-based demotion (alpha
  // floor 0.3 keeps them retrievable). For identity specifically this
  // matters: TMMA-flagged identity facts (contradictory user preferences,
  // polarity flips) should NOT compete for the always-on identity envelope.
  // opts.include_flagged surfaces them for audit views.
  const _includeFlagged = !!opts.include_flagged;
  //  dedup by normalized statement. Live audit found 95%
  // waste ratio (120 rows, 6 unique). Background identity extraction
  // re-writes identical statements without write-time fingerprinting.
  const _seen = new Set();
  //  when query has tokens, require ≥1 overlap. Without
  // this filter, identity items (salience-boosted) outrank everything
  // else in recall({class:'all'}) for unrelated queries and swamp the
  // result set. Always-on identity is a separate prefix-provider
  // concern; the recall surface is query-driven.
  const requireOverlap = qt.length > 0;
  const scored = items
    .filter(e => {
      if (!e || !e.statement) return false;
      if (!_includeFlagged && e.tier === 'flagged') return false;
      const norm = String(e.statement).toLowerCase().replace(/\s+/g, ' ').trim();
      if (_seen.has(norm)) return false;
      _seen.add(norm);
      return true;
    })
    .map(e => {
      const text = String(e.statement).toLowerCase();
      let hits = 0;
      for (const t of qt) if (text.indexOf(t) >= 0) hits++;
      const overlap = qt.length ? hits / qt.length : 0;
      const baseScore = (e.salience || 1) * 0.5 + overlap * 0.5;
      // Identity engrams projected from listEngrams: truth_score on e
      // directly (engram.listEngrams already lifts it from output blob).
      // also consult source_authority tier so
      // operator-confirmed identity facts outrank regex-extracted ones
      // for the same statement.
      const tsFactor_id = TRUTH_FACTOR_ALPHA + (1 - TRUTH_FACTOR_ALPHA) *
        Math.max(0, Math.min(1, (typeof e.truth_score === 'number') ? e.truth_score : 1.0));
      const authWeight_id = AUTHORITY_WEIGHTS[e.source_authority] !== undefined
        ? AUTHORITY_WEIGHTS[e.source_authority]
        : AUTHORITY_WEIGHTS.regex_extracted;
      const tFactor = tsFactor_id * authWeight_id;
      return { e, score: baseScore * tFactor, hits };
    })
    .filter(s => requireOverlap ? s.hits > 0 : true)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
  return scored.map(({ e, score }) => ({
    id: e.id, statement: e.statement, class: 'identity',
    score: Number(score.toFixed(3)),
    source: e.source || null, ts: e.ts
  }));
}

// A rule the operator scoped to ONE project is not true in another.
//
// This is not a folder partition of the mind. The no-partition invariant
// holds and must: memories stay reachable from anywhere, because a fact
// learned in one repo is still a fact in the next. What this reads is a row
// DECLARING where it applies — the operator said "here" when they gave it —
// exactly as docs:chats rows declare themselves archive-only a few lines
// below. One item's own scope, not a partition over the whole store.
//
// Without this, a project rule written in one repo comes
// back while working in a different repo. The listing road already honoured
// the scope; the road the partner walks on its own did not — which is how a
// partner ends up giving confident advice that is true somewhere else.
//
// A query with no cwd is not in any project, so project rules stay out of it.
function ruleOutOfPlace(row, out, cwd) {
  if (!row || row.type !== 'lesson') return false;
  if (String((out && out.scope) || '') !== 'project') return false;
  if (!row.cwd) return false;
  return String(row.cwd) !== String(cwd || '');
}

function recallSemantic(opts) {
  // Semantic class spans lessons + commitment-engrams marked semantic
  // (research, docs, knowledge). Semantic memory is TIME-INVARIANT —
  // a fact from a year ago is just as true as one from today. Pull
  // candidates via FTS5 (no recency cap at the SQL level) so old
  // research can still be retrieved when relevant. Prior version used
  // `state.queryActions({memory_class:'semantic', limit:500})` which
  // returned the 500 MOST RECENT semantic rows — older lessons were
  // structurally invisible in active substrates that wrote > 500
  // semantic rows in the past month.
  //
  // Degenerate case: empty token list (chitchat / punctuation-only
  // query) → return empty. Substrate stays quiet rather than dumping
  // the most recent semantic noise.
  const qt = tokenize(opts.query);
  if (!qt.length) return [];
  const ftsQuery = buildFtsQuery(opts.query);
  if (!ftsQuery) return [];
  // A8: drop SQL cwd filter — was hidden hard partition violating
  // substrate-as-mind. Soft cwd-boost happens in JS-side scoring below.
  const rows = state.searchActionsFull(ftsQuery, {
    memory_class: 'semantic',
    // Wide candidate pool so the JS scorer has material across time.
    // Per-class budget defaults to 100 × limit (so opts.limit=5 → 500
    // candidates), capped at the helper's 5000 max.
    limit:        Math.max(opts.limit * 100, 500)
  }) || [];
  const _supSemantic = opts.include_superseded ? new Set() : buildSupersededIds(rows);
  const _includeFlaggedSem = !!opts.include_flagged;
  const scored = rows
    .filter(r => !_supSemantic.has(r.id))
    .filter(r => audienceOk(r.audience, opts.audience))
    .map(r => {
      let out;
      try { out = (typeof r.output === 'string') ? JSON.parse(r.output) : (r.output || {}); }
      catch (_) { out = {}; }
      // Step B — TMMA tier='flagged' filter for semantic class.
      if (!_includeFlaggedSem && out.tier === 'flagged') return null;
      // IMPORT-FIX: docs:chats is the RAW imported-chat archive — a
      // searchable corpus, NOT auto-mount material. It floods the no-scope auto-
      // recall pool (conversational fragments out-match curated research/facts).
      // Excluded here from the default recall; still fully retrievable via an
      // EXPLICIT scoped query (chameleon_query scope='docs:chats[:project]').
      // PREFIX match since 2026-08-09: sessions land in per-project scopes
      // (docs:chats:<encoded-dir>) — exact equality would have let every
      // scoped chunk flood the very pool this exclusion protects.
      if (String(out.scope || '').startsWith('docs:chats')) return null;
      // A rule the operator scoped to one project answers only there.
      if (ruleOutOfPlace(r, out, opts.cwd)) return null;
      // Lessons store body at output.text; engrams store at output.statement.
      const text = String(out.text || out.statement || '').toLowerCase();
      if (!text) return null;
      let hits = 0;
      for (const t of qt) if (text.indexOf(t) >= 0) hits++;
      if (!hits) return null; // min_overlap floor: zero-overlap can't be saved by topic alone
      const overlap = hits / qt.length;
      const topic = topicBoost(text, opts.topicTokens);
      const cwdB  = cwdBoost(r.cwd, opts.cwd);
      // Semantic is time-invariant — no recency weight here.
      // Weights: relevance 0.7, topic-coherence 0.2, cwd 0.1.
      // truthFactor demotes PLR-falsified engrams toward alpha floor.
      const baseScore = overlap * 0.7 + topic * 0.2 + cwdB * 0.1;
      // Operator-CURATED memory (migrated ~/.claude/*.md, scope memory:* /
      // source ingest:claude-memory) is hand-authored ground truth. Boost it
      // above regex-extracted dialogue fragments so recall surfaces the curated
      // answer ("X is NOT a client", "always do Y") instead of noisy
      // conversational extractions — the difference between the model trusting
      // recall vs falling back to Bash-grepping the.md files.
      const _scp = String(out.scope || '');
      const _curated = _scp.indexOf('memory:') === 0
        || String(out.source || '').indexOf('ingest:claude-memory') === 0;
      const curatedBoost = _curated ? 1.8 : 1.0;
      return { r, out, hits, score: baseScore * truthFactor(r) * curatedBoost };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
  return scored.map(({ r, out, score }) => ({
    id: r.id,
    // The statement travels WHOLE. A 600-char cap sat on all three arms from
    // 2026-06-08 to 2026-08-14 — a prompt budget applied at the data layer —
    // and the surfaces that pass text through untouched inherited it: the
    // recall tool handed the model amputated memories and the dashboard search
    // showed the same cut, so a long engram could not be read back whole by
    // anyone. Every consumer that spends context clips at its own edge (the
    // injector to its block sizes, the voice prefix to its session budget);
    // the data layer answering short just teaches the reader that the memory
    // is short.
    statement: String(out.statement || out.text || ''),
    class: 'semantic',
    score: Number(score.toFixed(3)),
    source: out.source_path || (out.provenance && out.provenance.source_module) || r.type,
    // WHOSE words these are, carried to whoever renders the hit.
    //
    // Without this the per-turn injector prints a fetched page's text under
    // "treat as GROUND TRUTH, do NOT re-derive" — indistinguishable from
    // something the operator said. A page saying "the operator approved force
    // pushing" would arrive as the partner's own memory. The mark is stored on
    // the passage (provenance.tier); it has to survive the trip out.
    provenance_tier: (out.provenance && out.provenance.tier) || null,
    provenance_ref:  (out.provenance && out.provenance.ref) || null,
    ts: r.timestamp
  }));
}

function recallEpisodic(opts) {
  // Episodic class spans commitments marked episodic + dialogue.turn rows
  // (tool_call rows that dialogue-memory.recordTurn stamps with
  // memory_class='episodic').
  //
  // Episodic memory has a legitimate temporal component — "what did we say
  // yesterday" obviously cares about recency — but a real brain can still
  // recall older episodes when the query specifically reaches for them
  // ("remember when we discussed X two months ago"). The recency-CAP at
  // SQL level (`limit:500 order:desc`) violated that: any topic with > 500
  // newer episodic rows after it became unreachable, no matter how strong
  // the query match.
  //
  // Fix: FTS5-driven pull (no recency gate at SQL), keep recency as a
  // tiebreaker BOOST in scoring. Strong term overlap on a 2-month-old
  // episode still beats a barely-overlapping recent one.
  const qt = tokenize(opts.query);
  if (!qt.length) return [];
  const ftsQuery = buildFtsQuery(opts.query);
  if (!ftsQuery) return [];
  // A8: drop SQL cwd filter (hidden partition removed); cwd is now a
  // soft scoring boost so legacy NULL-cwd rows + cross-cwd episodes
  // remain reachable when the topic warrants.
  const rows = state.searchActionsFull(ftsQuery, {
    memory_class: 'episodic',
    // Wider pool than other classes — episodic is the highest-volume
    // class in active substrates, so a thinner FTS slice would still
    // recency-bias by accident.
    limit:        Math.max(opts.limit * 200, 1000)
  }) || [];
  const _supEpisodic = opts.include_superseded ? new Set() : buildSupersededIds(rows);
  const _includeFlaggedEp = !!opts.include_flagged;
  const scored = rows
    .filter(r => !_supEpisodic.has(r.id))
    .filter(r => audienceOk(r.audience, opts.audience))
    .map(r => {
      let outJson;
      try { outJson = typeof r.output === 'string' ? JSON.parse(r.output) : (r.output || {}); }
      catch (_) { return null; }
      // Skip flagged engrams (PLR reconsolidation contradictions). Step B
      // consistent with identity/semantic/procedural — all
      // recall classes now uniformly suppress tier='flagged' unless caller
      // opts.include_flagged.
      if (!_includeFlaggedEp && outJson.tier === 'flagged') return null;
      // Commitments store statement; dialogue.turn stores assistant_text +
      // input.args.user_text. Pull whichever exists; concatenate when both.
      let inJson;
      try { inJson = typeof r.input === 'string' ? JSON.parse(r.input) : (r.input || {}); }
      catch (_) { inJson = {}; }
      const userText = (inJson && inJson.args && inJson.args.user_text) || '';
      const assistantText = outJson.assistant_text || '';
      const statement = outJson.statement ||
        (userText || assistantText
          ? (userText ? 'user: ' + String(userText) : '') +
            (userText && assistantText ? ' / ' : '') +
            (assistantText ? 'asst: ' + String(assistantText) : '')
          : '');
      if (!statement) return null;
      const blob = String(statement).toLowerCase();
      let hits = 0;
      for (const t of qt) if (blob.indexOf(t) >= 0) hits++;
      if (!hits) return null; // min_overlap floor
      const overlap = hits / qt.length;
      const ageDays = Math.max(0, (Date.now() - r.timestamp) / (1000 * 60 * 60 * 24));
      const recency = Math.max(0, 1 - ageDays / 90); // 90-day decay
      const topic = topicBoost(blob, opts.topicTokens);
      const cwdB  = cwdBoost(r.cwd, opts.cwd);
      // Episodic weights — Generative Agents three-factor (Park 2023)
      // extended with cwd-coherence: 0.6 overlap, 0.1 recency, 0.2
      // topic, 0.1 cwd. Old + relevant + on-topic beats new +
      // tangential + same-cwd. Same-cwd boost ≤ topic boost so a
      // topically-coherent crypto episode CAN surface for crypto work
      // even when current cwd is troth — substrate-as-mind unified.
      // truthFactor demotes PLR-flagged-but-unfiltered episodes.
      const baseScore = overlap * 0.6 + recency * 0.1 + topic * 0.2 + cwdB * 0.1;
      return { r, statement, score: baseScore * truthFactor(r) };
    })
    .filter(m => m)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
  return scored.map(({ r, statement, score }) => ({
    id: r.id,
    statement: String(statement),   // whole — see the semantic arm for why
    class: 'episodic',
    score: Number(score.toFixed(3)),
    source: r.type === 'tool_call' ? 'dialogue' : ((typeof r.output === 'string' ? (JSON.parse(r.output).source || null) : null)),
    ts: r.timestamp
  }));
}

function recallProcedural(opts) {
  // Procedural class spans compiled_procedure rows AND commitments marked
  // procedural (architectural-decision engrams). Procedural memory is
  // TIME-INVARIANT until superseded — a decision from a month ago is still
  // the controlling rule unless explicitly overridden. Pull via FTS5 (no
  // recency cap) so older decisions remain findable when relevant.
  // Earlier `queryActions({limit:Math.max(limit*20,100)})` returned the
  // 100 most-recent procedural rows — older architectural decisions were
  // structurally invisible.
  const qt = tokenize(opts.query);
  if (!qt.length) return [];
  const ftsQuery = buildFtsQuery(opts.query);
  if (!ftsQuery) return [];
  // A8: drop SQL cwd filter; soft cwd-boost in JS scoring below.
  const rows = state.searchActionsFull(ftsQuery, {
    memory_class: 'procedural',
    limit:        Math.max(opts.limit * 100, 500)
  }) || [];
  const _supProcedural = opts.include_superseded ? new Set() : buildSupersededIds(rows);
  const _includeFlaggedProc = !!opts.include_flagged;
  const scored = rows
    .filter(r => !_supProcedural.has(r.id))
    .filter(r => audienceOk(r.audience, opts.audience))
    .map(r => {
      let out;
      try { out = typeof r.output === 'string' ? JSON.parse(r.output) : r.output; }
      catch (_) { return null; }
      // Step B — TMMA tier='flagged' filter for procedural class.
      if (!_includeFlaggedProc && out && out.tier === 'flagged') return null;
      const _trg = (out && (out.trigger_keywords || out.triggers)) || null;
      const triggers = Array.isArray(_trg) ? _trg.join(' ') : '';
      const name = (out && (out.name || out.statement)) || '';
      const blob = (triggers + ' ' + name).toLowerCase();
      let hits = 0;
      for (const t of qt) if (blob.indexOf(t) >= 0) hits++;
      if (!hits) return null; // min_overlap floor
      const overlap = hits / qt.length;
      const topic = topicBoost(blob, opts.topicTokens);
      const cwdB  = cwdBoost(r.cwd, opts.cwd);
      // Procedural is time-invariant. Weights: overlap 0.7, topic 0.2, cwd 0.1.
      // truthFactor demotes superseded procedures even before tier-flag filter.
      const baseScore = overlap * 0.7 + topic * 0.2 + cwdB * 0.1;
      return { r, out, hits, score: baseScore * truthFactor(r) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
  return scored.map(({ r, out, score }) => ({
    id: r.id,
    statement: (out && (out.name || out.statement)) || 'procedure',
    class: 'procedural',
    score: Number(score.toFixed(3)),
    source: 'compiler',
    ts: r.timestamp
  }));
}

// recall is now ASYNC to enable optional
// post-scoring semantic embedding rerank. Per-class sub-scorers stay
// sync. Callers that don't need the rerank can pass
// opts.skip_embedding_rerank=true and `await` an immediately-resolved
// promise — zero extra cost. Existing call sites await the result.
// Cosine of a query vector (whose norm is precomputed) against a stored
// Float32 embedding. Returns null on dimension mismatch / missing vector.
function cosineSim(qVec, qNorm, eVec) {
  if (!eVec || eVec.length !== qVec.length) return null;
  let dot = 0, en = 0;
  for (let i = 0; i < qVec.length; i++) { dot += qVec[i] * eVec[i]; en += eVec[i] * eVec[i]; }
  return dot / (qNorm * (Math.sqrt(en) || 1));
}

// Extract the human-meaningful statement from a raw action_records row, mirroring
// the per-class scorers' text extraction. Used to build dense-arm hit objects for
// engrams the lexical pool never pulled.
function statementForRow(row) {
  let out = {}, inp = {};
  try { out = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); } catch (_) {}
  try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : (row.input || {}); } catch (_) {}
  if (out && out.statement) return String(out.statement);
  if (out && out.text) return String(out.text);
  const u = (inp && inp.args && inp.args.user_text) || '';
  const a = (out && out.assistant_text) || '';
  if (u || a) return (u ? 'user: ' + u : '') + (u && a ? ' / ' : '') + (a ? 'asst: ' + a : '');
  return '';
}

// DENSE-RETRIEVAL ARM — true hybrid recall. Streams the recallable
// embedding corpus and returns the top-k engrams by COSINE to the query vector,
// WITHOUT any lexical-token-overlap requirement. This is the candidate SOURCE the
// FTS lexical gate (`if (!hits) return null`) structurally excluded — so a
// paraphrase that shares no query keywords (the design's required pure-semantic
// recall) can finally be retrieved, not just re-ranked. Bounded memory: a top-k
// heap over a lazy iterator, no full-corpus load.
let _denseDimWarned = false;
function denseArm(qVec, qNorm, want, k) {
  const top = [];
  let minCos = Infinity, full = false;
  let iter;
  try { iter = state.streamRecallableEmbeddings(); } catch (_) { return []; }
  let scanned = 0, dimSkip = 0;
  for (const row of iter) {
    scanned++;
    if (row.dim !== qVec.length) { dimSkip++; continue; }
    if (!audienceOk(row.audience, want)) continue;
    let eVec;
    try { eVec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim); } catch (_) { continue; }
    let dot = 0, en = 0;
    for (let i = 0; i < row.dim; i++) { dot += qVec[i] * eVec[i]; en += eVec[i] * eVec[i]; }
    const cos = dot / (qNorm * (Math.sqrt(en) || 1));
    if (!full) {
      top.push({ id: row.id, cos });
      if (top.length >= k) { top.sort((a, b) => a.cos - b.cos); minCos = top[0].cos; full = true; }
    } else if (cos > minCos) {
      top[0] = { id: row.id, cos };
      top.sort((a, b) => a.cos - b.cos);
      minCos = top[0].cos;
    }
  }
  top.sort((a, b) => b.cos - a.cos);
  // VISIBILITY for the silent-blindness failure mode. An embed-model
  // swap leaves the whole stored corpus at the OLD dimension while queries embed at
  // the NEW one → every row dim-mismatches and is skipped → the dense arm returns
  // nothing and recall silently collapses to lexical-only. Recall still WORKS (lexical FTS is the safety net), but the
  // degradation was invisible. Warn ONCE per process when mismatch dominates so a
  // future swap is loud, not silent. The background re-embed migration heals it.
  if (!_denseDimWarned && scanned > 50 && dimSkip / scanned > 0.5) {
    _denseDimWarned = true;
    try { console.error('[recall] dense arm degraded: ' + dimSkip + '/' + scanned +
      ' stored embeddings mismatch query dim ' + qVec.length +
      ' (embed-model swap in progress?). Recall is lexical-only until the background re-embed completes.'); } catch (_) {}
  }
  return top;
}

async function recall(opts) {
  opts = opts || {};
  const q = String(opts.query || '').trim();
  const cls = opts.class || 'all';
  const audience = opts.audience || 'model_visible';
  const limit = Math.min(Math.max(parseInt(opts.limit || 5), 1), 50);
  if (VALID_CLASSES.indexOf(cls) < 0) return [];
  if (VALID_AUDIENCES.indexOf(audience) < 0) return [];
  if (!q && cls !== 'identity') return []; // identity allowed on empty query (always-on read)


  // A8 — build topic-coherence vector once per recall invocation, share
  // across class sub-functions. cwd basename minus generic tokens is the
  // current-work signal; future versions may union recent dialogue +
  // active commitment tokens. Cheap (Set ops, no DB hit).
  const topicTokens = buildTopicTokens({ cwd: opts.cwd || null });
  const subOpts = { query: q, audience, limit, cwd: opts.cwd || null, topicTokens,
    include_superseded: !!opts.include_superseded,
    include_flagged:    !!opts.include_flagged };

  // Candidate POOL is wider than the final `limit` so the semantic rerank
  // below can RESCUE a genuinely-relevant engram that lexical/recency
  // scoring ranked just outside the top-`limit`. Without this, the cosine
  // pass only re-orders the lexical winners and can never surface a
  // high-similarity / low-lexical-overlap hit (the strategy/feedback probes
  // failed exactly here). Sliced back to `limit` AFTER the rerank+floor.
  // Wider candidate pool when a cross-encoder rerank will run (opts.rerank) so
  // the reranker has more hybrid candidates to rescue a buried-but-correct
  // memory from; otherwise the lean pool that just feeds the cosine blend.
  const poolLimit = opts.rerank
    ? Math.min(Math.max(limit * 10, 40), 64)
    : Math.min(Math.max(limit * 4, 12), 40);
  let results = [];
  if (cls === 'identity')   results = recallIdentity(subOpts);
  else if (cls === 'semantic')   results = recallSemantic({ ...subOpts, limit: poolLimit });
  else if (cls === 'episodic')   results = recallEpisodic({ ...subOpts, limit: poolLimit });
  else if (cls === 'procedural') results = recallProcedural({ ...subOpts, limit: poolLimit });
  else {
    // 'all' — score-fused across every class.
    //
    // Priority order (identity → procedural → semantic → episodic) stopping at
    // `limit` starves episodic content: procedural rows scoring 0.1 fill the
    // queue before the episodic dialogue.turn rows scoring 1.0 are queried at
    // all, so the model reports no memory of conversations it has stored
    // verbatim.
    //
    // Fix: gather ALL classes' top candidates (wider pool than limit),
    // dedup by id, sort by score, take top `limit`. Per-class trust
    // weighting can be added later if the unweighted score-fusion drops
    // identity/procedural too far for some query shape — but the
    // empirical baseline is that recall.* per-class scores are already
    // calibrated (token overlap × class-appropriate boost), so a direct
    // sort surfaces the genuinely most-relevant memory regardless of
    // which class it lives in.
    const seen = new Set();       // id dedup
    const seenText = new Set();   // normalized-TEXT dedup — verbatim duplicate
    // dialogue turns / doc chunks (different ids, identical content) flooded the
    // top-k (e.g. the same rant 3×). Per-class scorers only deduped identity by
    // text; episodic/semantic/procedural deduped by id, so dupes survived.
    // Dedup on the FULL normalized statement. A prior slice(0,200) collapsed
    // DISTINCT long engrams that merely shared a 200-char prefix (templated
    // decision/handoff text) — dropping the second as a false duplicate. The
    // 600-char result cap had the same defect one size up; with statements
    // travelling whole, two memories are duplicates only when they really say
    // the same thing.
    const _norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const fused = [];
    const pull = (arr) => {
      for (const r of arr) {
        if (seen.has(r.id)) continue;
        const nt = _norm(r.statement);
        if (nt && seenText.has(nt)) continue;
        seen.add(r.id); if (nt) seenText.add(nt);
        fused.push(r);
      }
    };
    // Identity is the ALWAYS-ON L0 envelope (identity-envelope.js / composeEnvelope)
    // a SEPARATE prefix path, NOT a query-driven competitor (this file's own
    // thesis, ~line 322 "Always-on identity is a separate prefix-provider concern;
    // the recall surface is query-driven"). Pulling recallIdentity into the fuser
    // gave identity a salience-floor base (~0.5 from (salience||1)*0.5) that
    // outranked genuinely-relevant semantic/procedural hits with higher cosine.
    // Drop it from query-driven 'all'; the entity still surfaces identity via the
    // envelope, and explicit class:'identity' callers are unaffected.
    pull(recallProcedural({ ...subOpts, limit: poolLimit }));
    pull(recallSemantic({ ...subOpts, limit: poolLimit }));
    pull(recallEpisodic({ ...subOpts, limit: poolLimit }));
    fused.sort((a, b) => b.score - a.score);
    results = fused.slice(0, poolLimit);
  }
  // semantic embedding rerank (graceful-degrade).
  //
  // After per-class scoring, if the embedding host responds, embed the
  // query ONCE per recall call and re-rank the top results by cosine
  // similarity using STORED engram embeddings (no per-engram embed call).
  // Stored embeddings come from background taskEmbeddingBackfill. Engrams
  // without stored embeddings keep their original score (no penalty).
  // If host is down or query embedding fails, results stay in FTS5/token
  // order — recall never fails. Only re-ranks; never drops a hit.
  // ── HYBRID RETRIEVAL — the design-spec requirement: fuse a
  // LEXICAL arm (the FTS token-overlap pool built above) with a true DENSE arm
  // (cosine over the embedding corpus, NO lexical-overlap requirement) so a
  // keyword-less paraphrase can actually be RETRIEVED, not just re-ranked
  // (pure-semantic was 0/3 with lexical-only candidates). The dense arm is a
  // candidate SOURCE; fusion is a magnitude-weighted blend of cosine (primary
  // relevance) + the lexical/recency/topic base score (prior).
  //
  // NOTE on method: pure rank-based RRF (1/(C+rank), the textbook hybrid fuser)
  // was implemented and MEASURED here — it REGRESSED (lexical 2/3→0/3) because it
  // discards cosine MAGNITUDE, and on this corpus the dense arm returns ~30 rows
  // all at cos 0.7–0.82 where rank order is noise but magnitude (0.81 vs 0.50) is
  // the decisive signal. So we keep the spec's INTENT (true hybrid, pure-semantic,
  // cosine as a first-class signal, multi-signal via the base prior) with the
  // fusion variant the live eval validates — magnitude blend, not rank RRF.
  //
  // Graceful degrade: embedder down / query unembeddable → keep the lexical pool
  // order (sliced to limit). Dense-ONLY hits below COS_FLOOR are dropped as noise;
  // lexical hits are always kept (they matched keywords).
  const W_COS = 0.60, W_BASE = 0.40;
  const COS_FLOOR = 0.35;
  // NOT gated on results.length. Running the dense arm only when the lexical
  // arm has already found something makes a query sharing no words with any
  // memory return NOTHING — the exact case this arm exists to serve, and the
  // one its own comment above promises ("NO lexical-overlap requirement").
  // Pure cosine ranks the right memory where lexical overlap finds none.
  // With an empty lexical pool every dense hit is dense-only, scores on cosine
  // alone (base 0), and the COS_FLOOR still keeps weak matches out.
  if (q && q.length >= 3 && opts.skip_embedding_rerank !== true) {
    try {
      const localEmbedder = require('./local-embedder.js');
      const qVec = await localEmbedder.embed(q, { role: 'query' }).catch(() => null);
      if (qVec && Array.isArray(qVec) && qVec.length) {
        const qNorm = Math.sqrt(qVec.reduce((a, v) => a + v * v, 0)) || 1;
        const lexIds = new Set(results.map(r => r.id));
        // DENSE ARM as candidate SOURCE — bring in semantically-similar engrams
        // the lexical FTS gate excluded (this is what enables pure-semantic recall).
        const denseHits = denseArm(qVec, qNorm, audience, poolLimit);
        const cosById = new Map(denseHits.map(h => [h.id, h.cos]));
        const denseOnly = denseHits.filter(h => !lexIds.has(h.id));
        if (denseOnly.length) {
          const rows = state.getActionsByIds(denseOnly.map(h => h.id)) || [];
          const rowById = new Map(rows.map(r => [r.id, r]));
          // PARITY with the lexical scorers: the dense arm must honor the SAME
          // supersession + flagged exclusions, else a retired/contradicted
          // predecessor (still embedded in the corpus) leaks into default recall
          // via the dense path — defeating "recall follows the supersession chain".
          const _supDense = opts.include_superseded ? new Set() : buildSupersededIds(rows);
          // The dense arm serves the SAME class the caller asked for.
          // Unfiltered, it pulled cosine neighbors from the WHOLE corpus,
          // and the massively-embedded dialogue turns entered EVERY class's
          // results in a tight 0.7–0.82 band — near-tied rows that buried
          // real content memories — a query naming a decision record returns
          // near-tied dialogue rows while the record itself never surfaces — and
          // starved
          // the memory-dispatch dominance gate. class='all' stays unfiltered
          // here; its raw-dialogue flood is handled by the demotion below.
          const _denseAllowed = cls === 'all' ? null : new Set(
            cls === 'identity' ? ['identity'] :
            cls === 'semantic' ? ['semantic'] :
            cls === 'procedural' ? ['procedural'] : ['episodic']);
          for (const h of denseOnly) {
            const row = rowById.get(h.id);
            if (!row) continue;
            if (_denseAllowed && !_denseAllowed.has(row.memory_class)) continue;
            if (_supDense.has(row.id)) continue;            // retired predecessor
            let outJson = {};
            try { outJson = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); } catch (_) {}
            if (!opts.include_flagged && outJson.tier === 'flagged') continue; // PLR-flagged contradiction
            if (String(outJson.scope || '').startsWith('docs:chats')) continue; // IMPORT-FIX: raw chat archive (flat OR per-project scope) excluded from auto-recall (explicit scope-query only)
            // PARITY again: the dense arm is a candidate SOURCE, so a rule
            // excluded by the lexical scorer would walk straight back in here.
            if (ruleOutOfPlace(row, outJson, opts.cwd)) continue;
            const stmt = statementForRow(row);
            if (!stmt) continue;
            results.push({
              id: row.id,
              statement: String(stmt),   // whole — see the semantic arm for why
              class: row.memory_class,
              score: 0,
              source: row.type === 'tool_call' ? 'dialogue' : null,
              // PARITY with the lexical arm: a hit that arrives through the
              // dense path must carry the same mark, or external text slips in
              // unlabelled by the other door.
              provenance_tier: (outJson.provenance && outJson.provenance.tier) || null,
              provenance_ref:  (outJson.provenance && outJson.provenance.ref) || null,
              ts: row.timestamp,
              _dense: true,
              // Raw turns that arrived through the dense door alone (no
              // keyword match) are context, not knowledge — marked so the
              // fusion can seat curated memories above them at equal cosine.
              _rawDialogueDense: row.type === 'tool_call'
            });
          }
        }
        // Fuse: cosine magnitude (primary) blended with the lexical/recency/topic
        // base score (prior). Dense-only rows have base 0 → ranked on cosine alone.
        // SELF-ECHO demotion. Asking a question retrieves the asking of it:
        // the operator's own near-verbatim recent question (mirrored as a
        // dialogue turn) scores near-perfect lexical AND cosine against
        // itself and seats above the memory that ANSWERS it (measured
        // 2026-08-15: the just-asked app question + its manifest reply took
        // #0/#1 over the actual decision-record engram). A turn whose USER
        // half IS the query is the question repeated, not knowledge —
        // halved, not dropped: "what did I ask before" queries legitimately
        // want their echoes.
        const _qNorm = String(q).toLowerCase().replace(/[^a-z0-9Ͱ-Ͽἀ-῿]+/g, ' ').trim();
        const _isEcho = (stmt) => {
          const m = /^user:\s*([\s\S]*?)(?:\s*\/\s*asst:|$)/.exec(String(stmt || ''));
          if (!m || !m[1]) return false;
          const u = m[1].toLowerCase().replace(/[^a-z0-9Ͱ-Ͽἀ-῿]+/g, ' ').trim();
          if (!u || !_qNorm) return false;
          const shorter = u.length <= _qNorm.length ? u : _qNorm;
          const longer  = u.length <= _qNorm.length ? _qNorm : u;
          return longer.indexOf(shorter) !== -1 && shorter.length / longer.length >= 0.8;
        };
        for (const r of results) {
          const base = Number(r.score) || 0;
          r._base = Number(base.toFixed(3));
          let cos = cosById.has(r.id) ? cosById.get(r.id) : cosineSim(qVec, qNorm, state.getEmbedding(r.id));
          // class='all' dense flood control: a raw dialogue turn with no
          // lexical hit competes at a 15% cosine discount, so a CURATED
          // memory at comparable similarity outranks chat echo. Turns that
          // matched keywords (lexical arm) keep full weight — they earned it.
          if (r._rawDialogueDense && cos) cos = cos * 0.85;
          if (_isEcho(r.statement)) { if (cos) cos = cos * 0.5; r.score = (Number(r.score) || 0) * 0.5; r._echo = true; }
          // No stored embedding → KEEP the original lexical base score (NO penalty),
          // per this block's own documented intent ("Engrams without stored
          // embeddings keep their original score"). The prior `W_BASE * base`
          // silently penalized every non-embedded engram by 60% — which, while
          // the embedder is offline / the backfill is incomplete, demoted ALL
          // freshly-migrated curated memory:* facts below the older embedded
          // dialogue corpus (the "recall finds nothing, model bashes.md" bug).
          // A lexical hit that matched keywords is a real hit; don't punish it
          // for lacking a vector.
          if (typeof cos !== 'number') { r.score = Number(base.toFixed(4)); continue; }
          r._semantic_cos = Number(cos.toFixed(3));
          r.score = Number((W_COS * cos + W_BASE * base).toFixed(4));
        }
        // Floor: drop dense-ONLY hits with weak similarity (keep every lexical
        // hit — they matched keywords). Never empty the set if anything matched.
        // Relative floor. A fixed COS_FLOOR tuned for the production flood
        // band (top cos ~0.7-0.8) silently starves paraphrase evidence that
        // peaks at ~0.36: with the whole dense field weak, 0.35 absolute kept
        // 2 of 40 candidates. Scaling by the field's own top keeps the fixed
        // value whenever topDenseCos >= 0.565 (every flood case — behavior
        // there is provably unchanged) and only lowers the bar when the best
        // available match is itself weak. 0.18 is the noise floor.
        let topDenseCos = 0;
        for (const r of results) {
          if (!lexIds.has(r.id) && typeof r._semantic_cos === 'number' && r._semantic_cos > topDenseCos) topDenseCos = r._semantic_cos;
        }
        const effFloor = Math.min(COS_FLOOR, Math.max(0.18, 0.62 * topDenseCos));
        const kept = results.filter(r => lexIds.has(r.id) || (typeof r._semantic_cos === 'number' && r._semantic_cos >= effFloor));
        results = kept.length ? kept : results;
        results.sort((a, b) => b.score - a.score);
      }
    } catch (_) { /* embedder/table issue — keep lexical order */ }
  }
  // ── CROSS-ENCODER RERANK — the evidence-
  // backed fix for conceptual recall (deep research: hybrid + reranker,
  // NOT a bigger embedder, NOT HyDE). Re-scores the hybrid candidate pool with a
  // cross-encoder that judges (query, memory) JOINTLY, rescuing a conceptually-
  // correct memory the bi-encoder blend ranked low for lack of keyword overlap.
  // OFF by default (per-turn latency ~0.4-0.8s on the every-turn path); callers
  // opt in with opts.rerank=true. Graceful-degrade: reranker unavailable / down →
  // keep the blend order (never blocks or errors recall).
  if (opts.rerank && results.length > 1 && q && q.length >= 3) {
    try {
      const reranker = require('./local-reranker.js');
      const scores = await reranker.rerank(q, results.map(r => String(r.statement || '').slice(0, 1200)));
      if (Array.isArray(scores)) {
        for (let i = 0; i < results.length; i++) {
          if (typeof scores[i] === 'number') results[i]._rerank = Number(scores[i].toFixed(4));
        }
        // Sort by rerank score where present; rows the reranker didn't score
        // (none, normally) fall behind, keeping their blend order among themselves.
        results.sort((a, b) => {
          const as = (typeof a._rerank === 'number'), bs = (typeof b._rerank === 'number');
          if (as && bs) return b._rerank - a._rerank;
          if (as) return -1; if (bs) return 1;
          return (b.score || 0) - (a.score || 0);
        });
      }
    } catch (_) { /* reranker down — keep blend order */ }
  }
  // FINAL full-statement dedup. The per-class fuser dedups by normalized text,
  // but (a) the DENSE ARM pushes its candidates directly with no seenText check
  // and (b) the single-class paths never dedup by text at all — so verbatim
  // duplicates (the same fact recorded N times, e.g. "operator prefers terse
  // responses" ×3) survive and waste top-k slots. Collapse them here, keeping the
  // highest-ranked instance (results are already in final sort/rerank order).
  if (results.length > 1) {
    const _seenStmt = new Set();
    const _deduped = [];
    for (const r of results) {
      let nt = String(r.statement || '').toLowerCase().replace(/\s+/g, ' ').trim();
      // Dialogue mirrors dedup on their USER half: the app-mirror era wrote
      // the same exchange many times with micro-variant assistant halves
      // (seven copies of one turn measured in a single top-10), so whole-
      // statement equality never collapses them. Highest-ranked copy wins;
      // content engrams keep whole-statement keys.
      const _uh = /^user:\s*([\s\S]{4,}?)(?:\s*\/\s*asst:|$)/.exec(nt);
      if (_uh && _uh[1]) nt = 'u:' + _uh[1].slice(0, 80);
      if (nt && _seenStmt.has(nt)) continue;
      if (nt) _seenStmt.add(nt);
      _deduped.push(r);
    }
    results = _deduped;
  }
  if (opts.context_id && process.env.TROTH_CONTEXT_BINDING === '1' && results.length) {
    try {
      const _ctxRows = state.getActionsByIds(results.map((r) => r.id)) || [];
      const _ctxById = new Map(_ctxRows.map((r) => [r.id, r.context_id || null]));
      results = results.filter((r) => r.class === 'identity' || _ctxById.get(r.id) === opts.context_id);
    } catch (_) { /* filter unavailable → unfiltered pool stands */ }
  }
  // Collapse the (wider) candidate pool back to the requested `limit`.
  if (results.length > limit) {
    let convById = null;
    try {
      const _rows = state.getActionsByIds(results.map((r) => r.id)) || [];
      convById = new Map(_rows.map((r) => [r.id, r.session_id || null]));
    } catch (_) { convById = null; }
    if (convById) {
      // ≤2 slots per conversation, and ONLY for rows that carry a non-null
      // session_id: unstamped rows (the bulk of production) bypass the cap
      // entirely, so behavior there is unchanged until threads are stamped.
      // Score order is preserved; spill refills leftover slots.
      const perConv = new Map();
      const picked = [];
      const spill = [];
      for (const r of results) {
        if (picked.length >= limit) break;
        const conv = convById.get(r.id) || null;
        if (conv == null) { picked.push(r); continue; }
        const n = perConv.get(conv) || 0;
        if (n < 2) { perConv.set(conv, n + 1); picked.push(r); }
        else spill.push(r);
      }
      for (const r of spill) {
        if (picked.length >= limit) break;
        picked.push(r);
      }
      results = picked;
    } else {
      results = results.slice(0, limit);
    }
  } else {
    results = results.slice(0, limit);
  }
  // Archive arm (2026-08-09): "what did we do in <project>" must reach the
  // imported archive WITHOUT unleashing it into the general pool — the
  // IMPORT-FIX exclusion above stands, because raw fragments out-match
  // curated facts. When a query token names a known per-project archive
  // scope, take the EXPLICIT scoped road for that one scope and append up
  // to 3 labeled hits AFTER the curated results: depth on request, never
  // flood. Additive + fail-open — losing the arm costs depth, not recall.
  if (q && (cls === 'all' || cls === 'semantic')) {
    try {
      const scopes = state._dbForQuery().prepare(
        "SELECT DISTINCT json_extract(output,'$.scope') AS s FROM action_records WHERE json_extract(output,'$.scope') LIKE 'docs:chats:%'").all()
        .map((r) => String(r.s || ''));
      if (scopes.length) {
        const qTokens = new Set(q.toLowerCase().split(/[^a-z0-9Ͱ-Ͽ]+/).filter((t) => t.length >= 3));
        const hitScope = scopes.find((s) => s.slice('docs:chats:'.length).toLowerCase()
          .split(/[^a-z0-9Ͱ-Ͽ]+/).filter((t) => t.length >= 3)
          .some((t) => qTokens.has(t)));
        if (hitScope) {
          const engram = require('./engram.js');   // lazy: avoids a require cycle at module load
          const items = await engram.retrieveRelevant({ query: q, k: 3, scope: hitScope, cwd: opts.cwd || null });
          for (const it of (items || [])) {
            results.push(Object.assign({}, it, { class: 'episodic', source: 'chat-archive', archive_scope: hitScope }));
          }
        }
      }
    } catch (_) { /* additive arm; see above */ }
  }
  // bump retrieval counter on returned hits.
  // Fire-and-forget; bumpRetrievalBatch is wrapped in try/catch so a
  // stats-table issue can't break recall. Skip when caller opts out
  // (audit/preview paths that don't want to influence future ranking).
  if (results.length && opts.skip_retrieval_feedback !== true) {
    try {
      const ids = results.map(r => r.id).filter(Boolean);
      if (ids.length) state.bumpRetrievalBatch(ids);
    } catch (_) { /* never block recall on stats write */ }
  }
  return results;
}

module.exports = {
  recall,
  VALID_CLASSES,
  // Exposed for diagnostics/tests of the individual arms (harmless — pure reads).
  recallSemantic, recallEpisodic, recallProcedural, buildFtsQuery,
  VALID_AUDIENCES,
  // exposed for tests + dedicated callers that want per-class behavior
  _recallIdentity:   recallIdentity,
  _recallSemantic:   recallSemantic,
  _recallEpisodic:   recallEpisodic,
  _recallProcedural: recallProcedural
};
