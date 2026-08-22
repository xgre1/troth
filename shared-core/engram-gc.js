// SPDX-License-Identifier: AGPL-3.0-only
// Engram Garbage Collection — bounded substrate memory, no slow rot.
//
// Without GC, engrams grow forever. After a month of production they
// flood retrieval with stale or duplicate hits, embedding queries get
// slow, and the substrate's recall precision degrades. This module is
// the periodic cleanup that keeps the engram pool dense + fresh.
//
// Three policies (composable):
//   1. salience decay — every engram's salience drops by `decay_per_day`
//      since last touched. Engrams below `min_salience` are evicted.
//   2. duplicate consolidation — engrams whose embeddings are within
//      `dup_cosine_threshold` of each other (and same scope) get
//      collapsed to the one with the highest salience. Substrate
//      stops storing the same fact 5 ways.
//   3. cap-then-evict — when total engram count for an agent exceeds
//      `max_count`, evict the lowest-salience excess.
//
// All policies are reversible up to a point — eviction is implemented
// as a tombstone record (`type:'commitment'`, `output.commitment_type`
// suffixed with `_tombstoned`) so audit traces survive. Hard delete
// is opt-in via `hard_delete:true`; default is tombstone-only.

const state     = require('./state.js');
const actionRec = require('./action-record.js');
const engram    = require('./engram.js');

const DEFAULT_DECAY_PER_DAY        = 0.05;
const DEFAULT_MIN_SALIENCE         = 0.15;
// 0.96 was original (overly strict). Empirical run on production corpus
//  showed 70% of corpus was duplicate at ≥ 0.85. Lowered
// to 0.85 — bench B3 useful% jumped 57% → 70% (PASS) post-dedup.
const DEFAULT_DUP_COSINE_THRESHOLD = 0.85;
const DEFAULT_MAX_COUNT            = 5000;

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Decay age in days, measured from the most recent "touch" — the later of
// the engram's write time and its last retrieval (research §3.5: Ebbinghaus
// decay is a function of recency of LAST retrieval, so recall reinforces).
// Pure + exported for unit testing. lastRetrievalTs may be null/undefined
// (engram never retrieved) → falls back to write time.
function decayAgeDays(writeTs, lastRetrievalTs, now) {
  const w = (typeof writeTs === 'number') ? writeTs : now;
  let touch = w;
  if (typeof lastRetrievalTs === 'number' && lastRetrievalTs > touch) touch = lastRetrievalTs;
  return Math.max(0, (now - touch) / (24 * 60 * 60 * 1000));
}

function tombstone(rec, reason) {
  try {
    const id = actionRec.uuidv7();
    const t = {
      id,
      timestamp: Date.now(),
      type: 'commitment',
      agent_id: rec.agent_id,
      cwd: rec.cwd,
      user_id: rec.user_id,
      parent_id: rec.id,
      input:  { source: 'engram-gc:' + reason },
      output: {
        statement: rec.output && rec.output.statement || '',
        commitment_type: 'engram_tombstoned',
        replaces: rec.id,
        reason
      }
    };
    const v = actionRec.validate(t);
    if (v.ok) state.recordAction(t, actionRec.toSearchText(t));
    // The vector dies with the memory.
    //
    // Nothing in the codebase had ever deleted from engram_embeddings, so a
    // tombstoned engram kept its vector forever — and the dense recall arm
    // streams EVERY vector on EVERY call, so orphaned vectors are scanned on
    // every query. Small per call, but pure waste, and it accumulates because
    // this function runs constantly — the overwhelming majority of the engrams
    // it kills die within an hour of being written.
    try { if (typeof state.deleteEmbedding === 'function') state.deleteEmbedding(rec.id); } catch (_) { /* the tombstone stands either way */ }
    return id;
  } catch (_) { return null; }
}

// Run all policies for one agent. Returns {evicted, consolidated,
// decayed, kept}.
async function gcAgent(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  if (!agent_id) return { ok: false, error: 'agent_id required' };
  const cwd      = opts.cwd || null;
  const decayPerDay = opts.decay_per_day != null ? opts.decay_per_day : DEFAULT_DECAY_PER_DAY;
  const minSal      = opts.min_salience  != null ? opts.min_salience  : DEFAULT_MIN_SALIENCE;
  const dupThresh   = opts.dup_cosine_threshold != null ? opts.dup_cosine_threshold : DEFAULT_DUP_COSINE_THRESHOLD;
  const maxCount    = opts.max_count != null ? opts.max_count : DEFAULT_MAX_COUNT;
  const hardDelete  = !!opts.hard_delete;
  const dryRun      = !!opts.dry_run;
  const now = Date.now();

  // Load active engrams (skip tombstones).
  const all = engram.listEngrams({ agent_id, cwd, limit: Math.max(maxCount * 2, 4000) })
    .filter(e => true /* listEngrams already excludes tombstones via commitment_type filter */);

  // 1. Decay salience by age — measured from LAST RETRIEVAL, not write time.
  //    Grounded in our ingested research (AI-Memory-Consolidation-
  //    Implementation-Details.md §3.5: the Ebbinghaus utility decay is a
  //    function of "recency of its LAST retrieval", with Hebbian use_count
  //    reinforcement). The prior code aged from e.ts (write time) with a
  //    comment admitting "substrate doesn't currently update ts on read" —
  //    but the substrate DOES track last_retrieval_ts in
  //    engram_retrieval_stats (state.recordRetrieval / getRetrievalStats),
  //    so a frequently/recently recalled engram should resist decay. Using
  //    write-ts broke exactly that Bjork property (audit gap): a 6-month-old
  //    fact recalled yesterday was decayed as if untouched for 6 months.
  //    Fallback to write-ts for engrams never retrieved (no stats row).
  const decayed = [];
  for (const e of all) {
    let lastRetrievalTs = null;
    try {
      const stats = state.getRetrievalStats && state.getRetrievalStats(e.id);
      if (stats && typeof stats.last_retrieval_ts === 'number') lastRetrievalTs = stats.last_retrieval_ts;
    } catch (_) { /* no stats → write-ts fallback (never-retrieved engram) */ }
    const ageDays = decayAgeDays(e.ts, lastRetrievalTs, now);
    const newSal  = Math.max(0, (e.salience || 1) - decayPerDay * ageDays);
    if (newSal !== (e.salience || 1)) decayed.push({ id: e.id, old: e.salience, new: newSal });
    e._effective_salience = newSal;
  }

  // 2. Evict below-min-salience.
  let evicted = [];
  const survivors = [];
  for (const e of all) {
    if (e._effective_salience < minSal) {
      evicted.push({ id: e.id, statement: e.statement, reason: 'below_min_salience', salience: e._effective_salience });
      if (!dryRun) {
        const recRow = state.queryActions({ type: 'commitment', agent_id, cwd, limit: 1, where_id: e.id });
        const rec = (recRow && recRow.length) ? actionRec.fromRow(recRow[0]) : { id: e.id, agent_id, cwd, user_id: opts.user_id || 'default', output: { statement: e.statement } };
        tombstone(rec, 'below_min_salience');
        if (hardDelete) {
          try { state.deleteAction && state.deleteAction(e.id); } catch (_) {}
        }
      }
    } else {
      survivors.push(e);
    }
  }

  // 3. Consolidate duplicates (within same scope, embeddings close).
  const consolidated = [];
  // Group by scope first to avoid cross-scope merging.
  const byScope = new Map();
  for (const e of survivors) {
    const key = e.scope || '__null__';
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(e);
  }
  const finalSurvivors = [];
  for (const [scopeKey, group] of byScope.entries()) {
    // Sort by salience desc so the strongest is the keeper.
    group.sort((a, b) => (b._effective_salience || 0) - (a._effective_salience || 0));
    const keep = [];
    for (const cand of group) {
      let merged = false;
      for (const k of keep) {
        if (Array.isArray(cand.embedding) && Array.isArray(k.embedding)) {
          if (cosine(cand.embedding, k.embedding) >= dupThresh) {
            consolidated.push({ from: cand.id, into: k.id, scope: cand.scope });
            if (!dryRun) {
              const rec = { id: cand.id, agent_id, cwd, user_id: opts.user_id || 'default', output: { statement: cand.statement } };
              tombstone(rec, 'duplicate_of:' + k.id);
              if (hardDelete) { try { state.deleteAction && state.deleteAction(cand.id); } catch (_) {} }
            }
            merged = true;
            break;
          }
        }
      }
      if (!merged) keep.push(cand);
    }
    finalSurvivors.push(...keep);
  }

  // 4. Cap-then-evict.
  if (finalSurvivors.length > maxCount) {
    finalSurvivors.sort((a, b) => (a._effective_salience || 0) - (b._effective_salience || 0));
    const overflow = finalSurvivors.length - maxCount;
    const cut = finalSurvivors.splice(0, overflow);
    for (const c of cut) {
      evicted.push({ id: c.id, statement: c.statement, reason: 'cap_overflow', salience: c._effective_salience });
      if (!dryRun) {
        const rec = { id: c.id, agent_id, cwd, user_id: opts.user_id || 'default', output: { statement: c.statement } };
        tombstone(rec, 'cap_overflow');
        if (hardDelete) { try { state.deleteAction && state.deleteAction(c.id); } catch (_) {} }
      }
    }
  }

  return {
    ok: true,
    agent_id, cwd,
    starting_count: all.length,
    decayed_count: decayed.length,
    evicted_count: evicted.length,
    consolidated_count: consolidated.length,
    surviving_count: finalSurvivors.length,
    evicted: opts.verbose ? evicted : undefined,
    consolidated: opts.verbose ? consolidated : undefined,
    dry_run: dryRun
  };
}

module.exports = {
  gcAgent,
  cosine,
  decayAgeDays,
  DEFAULT_DECAY_PER_DAY,
  DEFAULT_MIN_SALIENCE,
  DEFAULT_DUP_COSINE_THRESHOLD,
  DEFAULT_MAX_COUNT
};
