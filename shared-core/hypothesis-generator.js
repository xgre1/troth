// SPDX-License-Identifier: AGPL-3.0-only
// hypothesis-generator — Spontaneous Activation Daemon (DMN)
// graduation from the substrate design work.
//
// What the paper says: the substrate's Default Mode Network analog
// runs during idle time. It executes random-walk queries across the
// FTS5 semantic indices and the causal-DAG atlas to detect unlinked
// but highly similar entities. It generates synthetic "internal
// thoughts" (hypotheses) about codebase architecture and user intent,
// verifies them against action_records before solidifying new edges.
//
// Pre-this-ship: deliberator + PSW gave us continuous background
// processing (the structural part of ), but no hypothesis
// generation (the SPONTANEOUS-THOUGHT part). This module closes
// that gap.
//
// Falsifiability spec from the paper:
//   Initialize agent on undocumented codebase
//   - 10 disjointed bugs across 5 sessions in isolated modules
//   - 24h idle
//   On return, agent has autonomously generated NEW topological
//     edge linking the root cause of the bugs
//
// Adapted to our scope: scan recent action_records (last N), find
// disconnected pairs whose searchable content has high Jaccard
// overlap, write a hypothesis decision record proposing the link.
// The decision record carries kind='hypothesis' so the deliberator
// /insight-surfacer can pick it up.
//
// What we DO:
//   1. extractTokens(rec) — pull bag-of-tokens from a record's
//      input/output (lowercase, stop-word filtered, length ≥ 4)
//   2. jaccard(a, b) — set similarity 0..1
//   3. findHypotheses({state, agent_id, cwd, since, threshold}) —
//      pull recent records, compute pairwise Jaccard, surface
//      disconnected (no shared parent_id chain) high-similarity
//      pairs as hypothesis candidates
//   4. recordHypothesis({state, candidate, agent_id, cwd}) — write
//      a `decision` record with kind='hypothesis' linking the pair
//
// What we DO NOT do:
//   Use real embeddings. The paper's prototype scope is "vector
//     cosine similarity sweeps" but Jaccard over tokens is a cheap
//     deterministic substitute that needs no embedding host.
//   Verify the hypothesis with an LLM call. The paper mentions
//     "fast cheap verification call" — we leave that to a future
//     iteration; our hypothesis records carry confidence so a
//     downstream consumer can decide whether to act on them.

const STOP_WORDS = new Set([
  'the','a','an','is','are','to','of','in','and','or','for','on','at',
  'with','by','from','that','this','it','as','be','have','has','had',
  'do','does','did','not','no','yes','can','will','would','should',
  'could','may','might','must','shall','here','there','when','where',
  'who','what','why','how','which','if','then','else','also','very',
  'just','only','some','many','more','most','less','few','any','all',
  'each','every','both','either','neither','same','other','such','than'
]);

const DEFAULT_LOOKBACK = 100;
const DEFAULT_SIMILARITY_THRESHOLD = 0.50;
const DEFAULT_MAX_HYPOTHESES_PER_SCAN = 10;

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function flattenStrings(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      if (v.length < 800) out.push(v);
    } else if (typeof v === 'object' && v !== null) {
      flattenStrings(v, out);
    }
  }
}

function extractTokens(rec) {
  const parts = [];
  if (rec) {
    const inp = (typeof rec.input === 'string') ? safeJson(rec.input) : rec.input;
    const out = (typeof rec.output === 'string') ? safeJson(rec.output) : rec.output;
    flattenStrings(inp, parts);
    flattenStrings(out, parts);
  }
  const text = parts.join(' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const tokens = new Set();
  for (const t of text.split(/\s+/)) {
    if (!t || t.length < 4 || STOP_WORDS.has(t)) continue;
    tokens.add(t);
  }
  return tokens;
}

function jaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Find disconnected high-similarity pairs in recent records.
// "Disconnected" = neither record is in the parent_id chain of the
// other (substrate hasn't already linked them).
function findHypotheses(opts) {
  opts = opts || {};
  const state = opts.state;
  const agent_id = opts.agent_id;
  const cwd = opts.cwd || null;
  const since = typeof opts.since === 'number' ? opts.since : 0;
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_SIMILARITY_THRESHOLD;
  const limit = Math.min(opts.lookback || DEFAULT_LOOKBACK, 500);
  const cap = opts.max || DEFAULT_MAX_HYPOTHESES_PER_SCAN;

  if (!state || !agent_id) return [];

  const rows = state.queryActions({
    type: opts.type, agent_id, cwd, since, limit, order: 'desc'
  }) || [];
  if (rows.length < 2) return [];

  const tokenized = rows.map(r => ({ row: r, tokens: extractTokens(r) }));
  const candidates = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const a = tokenized[i];
      const b = tokenized[j];
      // Skip already-connected pairs (one is parent of the other).
      if (a.row.parent_id === b.row.id || b.row.parent_id === a.row.id) continue;
      const sim = jaccard(a.tokens, b.tokens);
      if (sim < threshold) continue;
      candidates.push({
        a_id: a.row.id, b_id: b.row.id,
        similarity: sim,
        a_type: a.row.type, b_type: b.row.type
      });
    }
  }
  candidates.sort((x, y) => y.similarity - x.similarity);
  return candidates.slice(0, cap);
}

// Persist a hypothesis as a decision record. Uses input.kind =
// 'hypothesis' so consumers (deliberator, insight-surfacer) can
// route it.
function recordHypothesis(opts) {
  opts = opts || {};
  const state = opts.state;
  const candidate = opts.candidate;
  if (!state || !candidate || !candidate.a_id || !candidate.b_id) return null;
  const ar = require('./action-record.js');
  const rec = {
    id: ar.uuidv7(),
    timestamp: Date.now(),
    type: 'decision',
    agent_id: opts.agent_id || 'troth-deliberator',
    cwd: opts.cwd || null,
    user_id: opts.user_id || 'default',
    input: {
      kind: 'hypothesis',
      signals: {
        a_id: candidate.a_id,
        b_id: candidate.b_id,
        similarity: candidate.similarity,
        a_type: candidate.a_type,
        b_type: candidate.b_type
      }
    },
    output: {
      decision: 'hypothesized_link',
      reason: 'high_token_jaccard_disconnected_pair',
      confidence: candidate.similarity
    }
  };
  const v = ar.validate(rec);
  if (!v.ok) return null;
  state.recordAction(rec, ar.toSearchText(rec));
  return rec.id;
}

module.exports = {
  extractTokens,
  jaccard,
  findHypotheses,
  recordHypothesis,
  DEFAULT_LOOKBACK,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_MAX_HYPOTHESES_PER_SCAN
};
