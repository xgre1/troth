// SPDX-License-Identifier: AGPL-3.0-only
// entity-axis — Phase D of the partner-agent design map.
//
// Closes the 4-axis MAGMA design (multi-graph agent memory, arXiv:2601.
// 03236, NeurIPS 2025). The substrate already indexes commitments and
// action records on three axes:
//   - SEMANTIC  — fingerprint dedup + embedding cosine in engram store
//   - TEMPORAL  — UUIDv7 chronology + timestamp filters in queryActions
//   - CAUSAL    — parent_id wiring via DecisionGraph (93% wired per audit)
// The fourth axis — ENTITY — was missing. MAGMA paper measured 18-45%
// improvement on long-context retrieval when an entity-axis fuse is
// added; the substrate could not surface "every record involving X"
// directly because it had no entity index.
//
// Pre-Phase-D: callers had to FTS-search by entity name and dedup by
// hand. Post-Phase-D: this module exposes a multi-axis query that
// extracts entities from text (regex-based, no spaCy / no LLM) and
// fuses entity-matching records with semantic + temporal scoring.
//
// Pure JS. Uses existing state.queryActions + state.searchActions
// (FTS5) — no schema migration. The "entity-axis" is virtual: extracted
// at query time from the candidate's input/output/searchText. Cheap
// because FTS5 narrows the candidate set first.
//
// What we extract (Agent 4 conservative principle: high precision,
// low recall):
//   1. File paths           — `path/file.ext` shapes
//   2. Function/method names — `funcName(` and `class FooBar {` shapes
//   3. Tool / library tokens — same vocabulary as identity-extract
//   4. ALL_CAPS_CONSTANTS    — uppercase identifiers ≥3 chars
//
// What we DO NOT extract:
//   - Generic English words (filtered via length + caps heuristics)
//   - Single-letter symbols
//   - URLs (separate concern; could be future axis)

const state = require('./state.js');

// ── Entity extraction patterns ──────────────────────────────────────────

const FILE_PATH = /\b([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-.]+|[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,6})\b/g;
const FUNCTION_CALL = /\b([a-zA-Z_][a-zA-Z0-9_]{2,40})\s*\(/g;
const CLASS_DECL = /\b(?:class|interface|struct|enum)\s+([A-Z][a-zA-Z0-9_]{1,40})\b/g;
const ALL_CAPS_CONST = /\b([A-Z][A-Z0-9_]{2,40})\b/g;
const TOOL_VOCABULARY = /\b(qwen3?(?:\.\d+)?|claude|opus|sonnet|haiku|llama(?:\.cpp)?|gpt-?[345o]?|tauri|rust|node\.?js|python|sqlite|jest|next\.?js|supabase|tailscale|ollama|elevenlabs|whisper|parakeet|tree-sitter|mcp|svelte|react|vue|deno|bun|cargo|npm|yarn|pnpm)\b/gi;

// Tokens that look like identifiers but are too generic to be useful
// as entity-axis keys (would match every record).
const GENERIC_REJECT = new Set([
  'function','return','const','let','var','class','async','await',
  'true','false','null','undefined','this','null','self','that',
  'console','log','error','print','debug','test','tests','main','run',
  'data','value','args','opts','options','config','result','results',
  'promise','array','object','string','number','boolean'
]);

function isAcceptableEntity(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length < 3 || t.length > 80) return false;
  if (GENERIC_REJECT.has(t.toLowerCase())) return false;
  return true;
}

// Extract entity tokens from arbitrary text. Returns a sorted array of
// unique strings (preserving original case for file paths and class
// names; lowercased for tool vocabulary).
function extractEntities(text) {
  const out = new Set();
  const t = String(text || '');
  if (!t) return [];

  for (const m of t.matchAll(FILE_PATH)) {
    const v = m[1];
    if (isAcceptableEntity(v) && /[\.\/]/.test(v)) out.add(v);
  }
  for (const m of t.matchAll(FUNCTION_CALL)) {
    if (isAcceptableEntity(m[1])) out.add(m[1]);
  }
  for (const m of t.matchAll(CLASS_DECL)) {
    if (isAcceptableEntity(m[1])) out.add(m[1]);
  }
  for (const m of t.matchAll(ALL_CAPS_CONST)) {
    if (isAcceptableEntity(m[1])) out.add(m[1]);
  }
  for (const m of t.matchAll(TOOL_VOCABULARY)) {
    out.add(String(m[1]).toLowerCase());
  }
  return Array.from(out).sort();
}

// ── Axis query ──────────────────────────────────────────────────────────

// Find records on the entity axis: any action_record whose searchable
// content (FTS) mentions the given entity token. Returns rows in the
// same shape as state.queryActions.
//
// FTS5 query is escaped minimally — entity tokens are dot/slash-bearing
// strings, so we wrap in quotes to defeat tokenizer surprises.
function findByEntity(entity, opts) {
  opts = opts || {};
  if (!entity || typeof entity !== 'string') return [];
  const limit = Math.min(parseInt(opts.limit || 50), 200);
  const ftsHits = state.searchActions('"' + entity.replace(/"/g, '') + '"', { limit }) || [];
  if (!ftsHits.length) return [];
  // Substrate-as-mind: principal_id is the read-side brain key (default
  // 'partner'). agent_id stays as optional secondary filter.
  const principalFilter = (opts.principal === null)
    ? null
    : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  const out = [];
  for (const hit of ftsHits) {
    const row = state.getAction(hit.id);
    if (!row) continue;
    if (opts.type && row.type !== opts.type) continue;
    if (principalFilter && row.principal_id !== principalFilter) continue;
    if (opts.agent_id && row.agent_id !== opts.agent_id) continue;
    if (opts.cwd && row.cwd !== opts.cwd) continue;
    if (opts.since && row.timestamp < opts.since) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

// Multi-axis query: take a free-text prompt, extract entities, score
// records on each axis, fuse. Returns array of {row, score, axis_hits}.
//
// Scoring weights are deliberate but tunable:
//   entity:    0.40  (strong signal — exact token match in record)
//   temporal:  0.25  (recency boost, exponential decay over 30 days)
//   causal:    0.20  (record is on the parent-chain of an entity hit)
//   semantic:  0.15  (FTS hit on the prompt as a whole, NOT entity)
//
// Entity axis dominates because it's the new lever this module adds;
// the existing query.js handles pure semantic / temporal queries
// already, so the multi-axis fusion's value is in surfacing entity
// matches the other paths missed.
const DEFAULT_WEIGHTS = Object.freeze({
  entity:   0.40,
  temporal: 0.25,
  causal:   0.20,
  semantic: 0.15
});

const TEMPORAL_DECAY_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function multiAxisQuery(opts) {
  opts = opts || {};
  const prompt = String(opts.prompt || '');
  const limit  = Math.min(parseInt(opts.limit || 25), 100);
  const weights = Object.assign({}, DEFAULT_WEIGHTS, opts.weights || {});
  const now = opts.now || Date.now();
  // cwd handling: by default, cross-cwd retrieval (substrate-as-mind —
  // a real brain doesn't forget what it learned in folder X when you
  // cd to Y). cwd serves as a SOFT BOOST: rows recorded under the same
  // cwd as the current turn get a small score multiplier so local
  // context floats slightly higher, but cross-cwd remains reachable.
  // Pass strict_isolation:true to restore the legacy hard-cwd-filter
  // behavior (multi-tenant / strict per-project sandboxes / tests).
  // cwd handling: soft by default. agent_id stays hard-filtered (matches
  // findByEntity + sub-brain isolation contract). strict_isolation:true
  // restores legacy hard cwd filter.
  const strict        = !!opts.strict_isolation;
  const filterCwd     = strict ? opts.cwd : null;
  const boostCwd      = opts.cwd || null;
  const cwdMatchBoost = typeof opts.cwd_match_boost === 'number' ? opts.cwd_match_boost : 1.20;
  // Forward principal opt to per-axis lookups; default-resolves to
  // TROTH_PRINCIPAL || 'partner' inside findByEntity / via semantic
  // axis path. Pass through opts.principal verbatim so callers can
  // explicitly opt out (principal:null) for cross-brain scans.
  const principalForward = opts.principal;

  const entities = extractEntities(prompt);
  // Map<id, { row, axis_hits: Set<axis>, score }>
  const candidates = new Map();

  function bump(row, axis, addend) {
    if (!row || !row.id) return;
    let c = candidates.get(row.id);
    if (!c) {
      c = { row, axis_hits: new Set(), score: 0 };
      candidates.set(row.id, c);
    }
    c.axis_hits.add(axis);
    c.score += addend;
  }

  // 1. Entity axis — for each extracted entity, FTS lookup.
  for (const ent of entities) {
    const rows = findByEntity(ent, {
      type: opts.type, agent_id: opts.agent_id, cwd: filterCwd,
      principal: principalForward, since: opts.since, limit: 30
    });
    for (const row of rows) {
      // Recency-weighted entity score so a fresh hit beats a stale one.
      const ageMs = Math.max(0, now - row.timestamp);
      const recency = Math.max(0, 1 - ageMs / TEMPORAL_DECAY_MS);
      bump(row, 'entity', weights.entity * (0.5 + 0.5 * recency));
    }
  }

  // 2. Semantic axis — full-prompt search.
  //
  // rewritten for prose-query coverage. Prior version used
  // raw `state.searchActions(prompt)` which is FTS5 with default AND
  // semantics — every prompt token had to appear in the row's
  // search_text. Lowercase multi-word prompts like
  // "principal_id substrate fragmentation" rarely had all tokens in
  // the same row even when many engrams covered the topic, so this
  // axis silently contributed zero and the bench reported 0%
  // substrate-resolved at the default 0.10 floor. Fix:
  //   (a) tokenize prompt → join with OR for FTS5 (wider candidate set)
  //   (b) score each candidate by Jaccard-style token overlap with
  //       the prompt → semantic weight is multiplied by overlap so
  //       a row that matched 1/N tokens contributes less than a row
  //       that matched N/N
  //   (c) when entities=[] (pure-prose prompt), redistribute the
  //       (currently unused) entity-axis weight into semantic so the
  //       fusion isn't dominated by an axis with no signal.
  //
  // Tokenization mirrors engram.js:tokenize (same lowercase + 3-char
  // floor) so semantic scoring here behaves like the engram pool's
  // lexicalScore — one canonical text-similarity primitive across
  // the substrate.
  const semPrincipal = (opts.principal === null)
    ? null
    : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  let promptTokens = [];
  if (prompt.trim()) {
    promptTokens = String(prompt).toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter(t => t.length >= 3);
  }
  // Redistribute entity weight to semantic when no entities extracted —
  // pure-prose prompts have no entity signal, so giving the entity
  // axis weight=0.40 (default preset) while semantic gets 0.15 is
  // exactly backwards. Without this, every axis bumps under-credit
  // the only axis that COULD score.
  const semanticWeight = (entities.length === 0)
    ? (weights.semantic || 0) + (weights.entity || 0)
    : (weights.semantic || 0);
  if (promptTokens.length) {
    try {
      // FTS5 OR query — quote each token to avoid operator collision
      // (terms like "OR" / "AND" / "NEAR" in a prompt would otherwise
      // be parsed as FTS5 operators).
      const orQuery = promptTokens
        .map(t => '"' + t.replace(/"/g, '') + '"')
        .join(' OR ');
      // limit=300 (vs 60) because state.searchActions sorts by
      // `timestamp DESC`, not by FTS5 BM25 relevance. A common token
      // ("substrate", "the") in a busy corpus produces many recent
      // single-token-match rows that crowd out older multi-token-match
      // rows where coverage is actually high. Wider candidate set
      // gives the coverage filter material to work with.
      const semHits = state.searchActions(orQuery, { limit: 300 }) || [];
      const promptSet = new Set(promptTokens);
      // Coverage floor: a single common English word ("nonsense",
      // "always", "thanks") in a noise prompt of 5 tokens scores
      // coverage=0.20 — noise leaking through the OR query.
      // 0.30 calibrated against two failure modes:
      //   noise reject: "qwertyuiop asdfghjkl xyzzy nonsense gibberish"
      //     → single common-word match coverage=0.20 < 0.30 → SKIP ✓
      //   real preserve: 3-token prompt with one rare-token match
      //     ("principal_id" found alone) coverage=0.33 > 0.30 → PASS ✓
      // Edge: 4-token prompt with 1 match (coverage 0.25) gets cut.
      // Acceptable tradeoff — 4-token prose is rare in this corpus
      // and tends to come with at least 2 matching tokens when on-topic.
      const MIN_COVERAGE = 0.30;
      for (const hit of semHits) {
        const row = state.getAction(hit.id);
        if (!row) continue;
        if (opts.type && row.type !== opts.type) continue;
        if (semPrincipal && row.principal_id !== semPrincipal) continue;
        if (opts.agent_id && row.agent_id !== opts.agent_id) continue;
        if (filterCwd && row.cwd !== filterCwd) continue;
        // Overlap = how many prompt tokens appear in the row's
        // search-relevant text (input + output JSON, lowercased).
        const rowText = (row.input || '') + ' ' + (row.output || '');
        const rowTokens = new Set(String(rowText).toLowerCase()
          .split(/[^a-z0-9_]+/i)
          .filter(t => t.length >= 3));
        let overlap = 0;
        for (const t of promptSet) if (rowTokens.has(t)) overlap++;
        if (!overlap) continue;
        const coverage = overlap / promptSet.size;       // 0..1
        if (coverage < MIN_COVERAGE) continue;
        // Pure-coverage scale (no baseline boost). Full-coverage row
        // gets full semantic weight; partial-coverage row scales down
        // proportionally. Combined with the multiAxisQuery
        // relevance_floor (0.10 default), noise that scrapes the
        // coverage threshold but adds no other axis signal drops out.
        bump(row, 'semantic', semanticWeight * coverage);
      }
    } catch (_) { /* FTS5 may misbehave on weird prompts; skip silently */ }
  }

  // 3. Temporal axis — recency boost added to all candidates already.
  for (const c of candidates.values()) {
    const ageMs = Math.max(0, now - c.row.timestamp);
    const recency = Math.max(0, 1 - ageMs / TEMPORAL_DECAY_MS);
    c.score += weights.temporal * recency;
    c.axis_hits.add('temporal');
  }

  // 4. Causal axis — for each candidate with a parent_id, bump the
  // parent if it's also a candidate (boosts causally-linked clusters).
  for (const c of candidates.values()) {
    const pid = c.row.parent_id;
    if (!pid) continue;
    const parent = candidates.get(pid);
    if (parent) {
      parent.score += weights.causal;
      parent.axis_hits.add('causal');
    }
  }

  // 5. cwd-match boost — apply AFTER axis fusion. Items recorded under
  // the same cwd as the current turn float slightly higher (default
  // ×1.20) without locking out cross-cwd memory.
  if (boostCwd) {
    for (const c of candidates.values()) {
      if (c.row && c.row.cwd === boostCwd) {
        c.score *= cwdMatchBoost;
        c.axis_hits.add('cwd_match');
      }
    }
  }
  // Materialize + rank. Drop entries below the relevance floor so
  // weak / noise hits never reach the prompt — the alternative was
  // "context-aware retrieval that dumps everything weakly-related",
  // which is the exact failure mode every caller without its own
  // inline floor (substrate-tools, slash executor, MCP server,
  // prefix providers) hit prior to this. Default 0.10 matches the
  // hand-tuned value already shipped in bin/troth-entity.js:344;
  // callers may override via opts.relevance_floor (set to 0 to
  // disable, e.g. for audit/diagnostics).
  const relevanceFloor = typeof opts.relevance_floor === 'number'
    ? opts.relevance_floor : 0.10;
  const ranked = Array.from(candidates.values())
    .map(c => ({
      row: c.row,
      score: c.score,
      axis_hits: Array.from(c.axis_hits)
    }))
    .filter(r => r.score >= relevanceFloor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

module.exports = {
  extractEntities,
  findByEntity,
  multiAxisQuery,
  isAcceptableEntity,
  // Defaults exposed for tests + tuning
  DEFAULT_WEIGHTS,
  TEMPORAL_DECAY_MS,
  GENERIC_REJECT
};
