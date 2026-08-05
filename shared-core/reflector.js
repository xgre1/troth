// SPDX-License-Identifier: AGPL-3.0-only
// Memory Reflector v1 — PARTIALLY RETIRED  (sweep mode drifted).
//
// DRIFT NOTE: per design §4 the
// commitment-sweep mode (typed-commitment.sweepCommitments which this
// reflector hosts indirectly) is drifted — LLM-as-judge per commitment
// where Cohen+Levesque rule-table would suffice. The CORE Park 2023 +
// A-MEM clustering for memory consolidation is operator-invoked via
// bin/reflect.js CLI — that IS a legitimate §3 LLM-faculty use
// (synthesis from diverse facts) and stays.
//
// Production data (state DB 7d): operator-invoked manual reflection
// is rare; automated sweep never fires.
//
// design grounding (full spec at /tmp/.../a7b365577aa4d8c25.output):
//   A-MEM (Xu 2502.12110): online clustering top-K=10 over existing
//     embeddings, no re-embedding; LLM-mediated linking after pre-filter.
//   Park 2023 (UIST §A): reflection trigger when importance_sum > 150
//     (~2-3 daily); 5 insights per run; cite source IDs verbatim.
//   MemoryBank (Zhong AAAI 2024): R = e^{-t/S} decay, S+=1 on retrieval.
//     Reflector marks source.consolidated=true (does NOT delete in v1).
//   Nader 2000 (Nature): 6h reconsolidation window — heartbeat
//     time_since_last >= 6h is biologically grounded.
//   W3C PROV-O: wasGeneratedBy (activity), wasDerivedFrom (sources),
//     generatedAtTime, wasAttributedTo. Reflected engrams carry provenance.
//   design R23: state transitions immutable. Reflector writes NEW
//     engrams (semantic:reflected); never UPDATEs sources except for
//     the consolidated=true flag (additive metadata, not transition).
//
// Algorithm (cluster → reflect → validate → write):
//   1. Window: last N=200 not-yet-consolidated engrams (newest first)
//   2. Online clustering: cosine similarity, top-K=10, floor=0.55 to attach
//      (engineering knob per spec — flag for retuning)
//   3. Filter: clusters with >=2 members (Park: needs >=2 sources to cite)
//   4. Cap: top 5 clusters by importance_sum (Park: 5 insights per run)
//   5. Idempotency: skip if sha256(sorted_source_ids) already exists
//   6. Reflect: Park-derived prompt → expects {assertion, sources[], contradictions[], confidence}
//   7. Validate:
//        HARD: sources >= 2, source_ids subset of cluster, assertion length OK
//        SOFT: mean_sim >= 0.5 (warn only), confidence >= 0.4 (warn only)
//   8. Write reflected engram + flip source.consolidated = true
//
// v1 SCOPE:
//   Manual CLI invocation (bin/reflect.js); NO background heartbeat
//   Source consolidation flagging only; NO hard-delete
//   Flat reflections only; NO reflection-of-reflections
//   Single reflector LLM (config-pinned); cross-family enforcement v2
//
// v1 OUT OF SCOPE (deferred):
//   Heartbeat scheduler
//   Source eviction after 30d retention
//   PLR contradiction → supersede flow
//   Cross-family reflector validation
//   MemoryBank decay on reflected engrams
//
// State coupling:
//   reflection_activities table (NEW) — one row per reflector run
//   engrams gain output.reflected_meta = { sources, mean_sim, confidence,
//     source_hash, activity_id, cluster_size } and scope='semantic:reflected'
//   source engrams gain output.consolidated=true + output.consolidated_at

'use strict';

const crypto = require('crypto');
const engram = require('./engram.js');
const state  = require('./state.js');
const actionRec = require('./action-record.js');

// ── Tunable defaults (engineering knobs flagged) ────────

const DEFAULTS = Object.freeze({
  WINDOW_SIZE:           200,    // engineering (no literature)
  CANDIDATE_TOPK:        10,     // A-MEM Xu 2502.12110 exact
  CLUSTER_COSINE_FLOOR:  0.55,   // engineering (A-MEM has no fixed floor)
  MIN_CLUSTER_MEMBERS:   2,      // Park 2023 — needs ≥1 source, ≥2 enforces convergent evidence
  MAX_CLUSTERS_PER_RUN:  5,      // Park 2023 exact ("5 high-level insights")
  ASSERTION_MAX_CHARS:   280,    // engineering (storage + UI)
  CONFIDENCE_SOFT_FLOOR: 0.4,    // warn only — Park has no confidence field
  MEAN_SIM_SOFT_FLOOR:   0.5,    // warn only — A-MEM has no such gate
  IMPORTANCE_SUM_TRIGGER:100,    // design default; Park used 150 on 1-10 scale
  EVENTS_SINCE_TRIGGER:  20,     // engineering
  TIME_SINCE_LAST_MS:    6*60*60*1000  // Nader 2000 reconsolidation window
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function _runningMean(centroid, count, newVec) {
  if (!centroid) return newVec.slice();
  const out = new Array(centroid.length);
  for (let i = 0; i < centroid.length; i++) {
    out[i] = (centroid[i] * count + (newVec[i] || 0)) / (count + 1);
  }
  return out;
}

function _sourceHash(ids) {
  const sorted = [...ids].sort();
  return crypto.createHash('sha256').update(sorted.join('|')).digest('hex');
}

// ── Window query — candidate engrams ─────────────────────────────────────

function _loadWindow(opts) {
  const limit = opts.window_size || DEFAULTS.WINDOW_SIZE;
  // Pull recent commitments (engram class) that are NOT consolidated and
  // have embeddings. principal_id='partner' default — substrate-as-mind.
  const rows = state.queryActions({
    type: 'commitment',
    limit: limit * 3,  // overfetch — filter for engram + has-embedding + not-consolidated
    order: 'desc'
  }) || [];
  const out = [];
  for (const row of rows) {
    let output;
    try { output = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); }
    catch (_) { continue; }
    if (output.commitment_type !== 'engram') continue;
    if (output.consolidated === true) continue;
    if (!Array.isArray(output.embedding) || !output.embedding.length) continue;
    out.push({
      id: row.id,
      ts: row.timestamp,
      statement: output.statement || '',
      embedding: output.embedding,
      salience:  typeof output.salience === 'number' ? output.salience : 1.0,
      scope:     output.scope || null
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Online clustering (A-MEM style, no re-embedding) ─────────────────────

function _clusterOnline(candidates, opts) {
  const k = opts.candidate_topk || DEFAULTS.CANDIDATE_TOPK;
  const floor = typeof opts.cluster_cosine_floor === 'number'
    ? opts.cluster_cosine_floor
    : DEFAULTS.CLUSTER_COSINE_FLOOR;
  const clusters = []; // each: { members:[], centroid, importance_sum }
  for (const c of candidates) {
    // Compute similarity vs each cluster centroid
    const sims = clusters.map((cl, idx) => ({ idx, sim: _cosine(c.embedding, cl.centroid) }));
    // Top-K
    sims.sort((a, b) => b.sim - a.sim);
    const top = sims.slice(0, k).filter(s => s.sim >= floor);
    if (top.length) {
      const best = top[0];
      const cl = clusters[best.idx];
      cl.members.push(c);
      cl.centroid = _runningMean(cl.centroid, cl.members.length - 1, c.embedding);
      cl.importance_sum += c.salience;
    } else {
      clusters.push({
        members: [c],
        centroid: c.embedding.slice(),
        importance_sum: c.salience
      });
    }
  }
  return clusters;
}

// ── Filter + cap + idempotency precheck ──────────────────────────────────

function _selectClusters(clusters, opts) {
  const minMembers = opts.min_cluster_members || DEFAULTS.MIN_CLUSTER_MEMBERS;
  const maxRun    = opts.max_clusters_per_run  || DEFAULTS.MAX_CLUSTERS_PER_RUN;
  return clusters
    .filter(cl => cl.members.length >= minMembers)
    .sort((a, b) => b.importance_sum - a.importance_sum)
    .slice(0, maxRun);
}

function _existingHashes(opts) {
  // Pull recent reflected engrams' source_hash to detect dup runs (Park
  // explicitly allows different questions to produce different insights;
  // we only suppress exact-source-set dupes.)
  const rows = state.queryActions({ type: 'commitment', limit: 500, order: 'desc' }) || [];
  const hashes = new Set();
  for (const row of rows) {
    let output;
    try { output = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); }
    catch (_) { continue; }
    if (output.scope !== 'semantic:reflected') continue;
    if (output.reflected_meta && output.reflected_meta.source_hash) {
      hashes.add(output.reflected_meta.source_hash);
    }
  }
  return hashes;
}

// ── Reflection prompt (Park 2023 adapted with JSON envelope) ─────────────

function _buildReflectionPrompt(cluster) {
  const lines = ['Given the following memories:'];
  cluster.members.forEach((m, i) => {
    const idx = i + 1;
    const stmt = String(m.statement || '').replace(/\s+/g, ' ').slice(0, 400);
    lines.push('[' + idx + '] ' + stmt + ' (importance ' + m.salience.toFixed(2) + ')');
  });
  lines.push('');
  lines.push('What high-level insights can you infer from the above statements?');
  lines.push('Format each insight as JSON on its own line:');
  lines.push('{"assertion": "...", "sources": [1,5,3], "contradictions": [], "confidence": 0.0-1.0}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- sources MUST cite >=2 memory IDs from the list above (no fabricated IDs).');
  lines.push('- contradictions: list IDs that conflict with the assertion (may be empty).');
  lines.push('- confidence in [0,1]: how strongly cited sources support assertion.');
  lines.push('- assertion <= 280 chars.');
  lines.push('- Output one insight per line, max 5 insights.');
  return lines.join('\n');
}

// Parse model output — extract JSON lines, validate shape.
function _parseReflections(text) {
  const out = [];
  const lines = String(text || '').split(/\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!obj || typeof obj.assertion !== 'string') continue;
    if (!Array.isArray(obj.sources)) continue;
    out.push({
      assertion: obj.assertion,
      sources: obj.sources.map(Number).filter(n => Number.isFinite(n)),
      contradictions: Array.isArray(obj.contradictions)
        ? obj.contradictions.map(Number).filter(n => Number.isFinite(n))
        : [],
      confidence: typeof obj.confidence === 'number' ? obj.confidence : null
    });
  }
  return out;
}

// ── Validation gate ──────────────────────────────────────────────────────

function _validate(out, cluster, opts) {
  const reasons = [];
  if (out.sources.length < 2) reasons.push({ severity: 'hard', code: 'sources_lt_2' });
  // sources are 1-indexed positions in the cluster.members array
  const validIdxs = out.sources.filter(s => s >= 1 && s <= cluster.members.length);
  if (validIdxs.length !== out.sources.length) reasons.push({ severity: 'hard', code: 'sources_out_of_range' });
  if (String(out.assertion).length > (opts.assertion_max_chars || DEFAULTS.ASSERTION_MAX_CHARS)) {
    reasons.push({ severity: 'hard', code: 'assertion_too_long' });
  }
  // Soft checks
  if (out.confidence !== null && out.confidence < (opts.confidence_soft_floor || DEFAULTS.CONFIDENCE_SOFT_FLOOR)) {
    reasons.push({ severity: 'soft', code: 'confidence_below_floor', value: out.confidence });
  }
  if (validIdxs.length >= 2) {
    const sourceEmbeds = validIdxs.map(i => cluster.members[i - 1].embedding);
    const meanSim = sourceEmbeds.reduce((acc, e) => acc + _cosine(e, cluster.centroid), 0) / sourceEmbeds.length;
    if (meanSim < (opts.mean_sim_soft_floor || DEFAULTS.MEAN_SIM_SOFT_FLOOR)) {
      reasons.push({ severity: 'soft', code: 'mean_sim_below_floor', value: meanSim });
    }
    out._meanSim = meanSim;
  }
  const hardFail = reasons.some(r => r.severity === 'hard');
  return { ok: !hardFail, reasons, valid_source_idxs: validIdxs };
}

// ── Write reflected engram + flip sources to consolidated ────────────────

function _writeReflection(out, cluster, validation, activityId) {
  const sourceIds = validation.valid_source_idxs.map(i => cluster.members[i - 1].id);
  const sourceHash = _sourceHash(sourceIds);
  const sourceSnippets = validation.valid_source_idxs.map(i => {
    const m = cluster.members[i - 1];
    return {
      engram_id: m.id,
      snippet: String(m.statement || '').slice(0, 200),  // frozen — survives source eviction
      importance: m.salience,
      recorded_at: m.ts
    };
  });
  const id = engram.recordEngram({
    agent_id: 'reflector',
    statement: out.assertion,
    source: 'reflector_run:' + activityId,
    scope: 'semantic:reflected',
    salience: out.confidence != null ? Math.max(1.0, out.confidence + 1.0) : 1.0,
    auto_verify: false  // reflections are derived knowledge, not factual claims to dedupe
  });
  if (!id) return null;
  // Patch the just-written row with reflected_meta + provenance
  try {
    const row = state.queryActions({ type: 'commitment', limit: 50, order: 'desc' }).find(r => r.id === id);
    if (row) {
      let output;
      try { output = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); }
      catch (_) { output = {}; }
      output.reflected_meta = {
        source_ids: sourceIds,
        source_snippets: sourceSnippets,
        source_hash: sourceHash,
        cluster_size: cluster.members.length,
        mean_sim: out._meanSim || null,
        confidence: out.confidence,
        contradictions: out.contradictions,
        activity_id: activityId,
        generated_at_time: Date.now(),
        validation_warnings: validation.reasons.filter(r => r.severity === 'soft')
      };
      // PROV-O attribution
      output.prov = {
        wasAttributedTo: 'agent:reflector',
        wasGeneratedBy:  'activity:' + activityId,
        wasDerivedFrom:  sourceIds,
        generatedAtTime: new Date().toISOString()
      };
      const sqlite = require('better-sqlite3');
      const path = require('path');
      const db = sqlite(path.join(process.env.HOME || require('os').homedir(), '.troth', 'state.db'));
      db.prepare('UPDATE action_records SET output = ? WHERE id = ?').run(JSON.stringify(output), id);
      // Mark source engrams consolidated (additive metadata; not a state
      // transition per R23 — just bookkeeping for deletion-eligibility v2).
      const stmt = db.prepare('UPDATE action_records SET output = json_patch(output, ?) WHERE id = ?');
      const patch = JSON.stringify({ consolidated: true, consolidated_at: Date.now() });
      for (const sid of sourceIds) {
        try { stmt.run(patch, sid); } catch (_) { /* json_patch unavailable on older sqlite — skip */ }
      }
      db.close();
    }
  } catch (e) {
    // Reflection write succeeded; metadata patch failed — log and continue.
  }
  return { id, source_hash: sourceHash, source_ids: sourceIds };
}

// ── Main entrypoint ──────────────────────────────────────────────────────
//
// runReflection(opts) — pure async function; caller wires the LLM call
// via opts.llmCall(prompt) → Promise<text>. v1 manual CLI invocation
// (no background heartbeat). Returns { ok, activity_id, clusters_seen,
// clusters_emitted, rejected, written:[{id, source_hash, source_ids}] }.
async function runReflection(opts) {
  opts = opts || {};
  if (typeof opts.llmCall !== 'function') {
    return { ok: false, error: 'llmCall_required', hint: 'pass opts.llmCall(prompt) -> Promise<text>' };
  }
  const dryRun = !!opts.dry_run;
  const activityId = actionRec.uuidv7();
  const started = Date.now();

  // 1. Window
  const candidates = _loadWindow(opts);
  if (candidates.length === 0) {
    return { ok: true, activity_id: activityId, reason: 'no_candidates', clusters_seen: 0, clusters_emitted: 0 };
  }

  // 2. Cluster
  const allClusters = _clusterOnline(candidates, opts);

  // 3. Filter + cap
  const selected = _selectClusters(allClusters, opts);

  // 4. Idempotency precheck (skip clusters whose source_hash already exists)
  const seenHashes = _existingHashes(opts);
  const toReflect = [];
  for (const cl of selected) {
    const ids = cl.members.map(m => m.id);
    if (seenHashes.has(_sourceHash(ids))) continue;
    toReflect.push(cl);
  }

  // 5+6+7+8. Reflect each cluster
  const written = [];
  const rejected = [];
  for (const cluster of toReflect) {
    const prompt = _buildReflectionPrompt(cluster);
    if (dryRun) {
      written.push({ dry_run: true, cluster_size: cluster.members.length, prompt_preview: prompt.slice(0, 300) });
      continue;
    }
    let llmText;
    try { llmText = await opts.llmCall(prompt); }
    catch (e) {
      rejected.push({ cluster_size: cluster.members.length, reason: 'llm_threw', detail: String(e && e.message || e) });
      continue;
    }
    const outs = _parseReflections(llmText);
    if (outs.length === 0) {
      rejected.push({ cluster_size: cluster.members.length, reason: 'no_parseable_insights' });
      continue;
    }
    // v1: take first valid insight per cluster (Park emits up to 5; we
    // accept the strongest one. v2 may emit multiple per cluster.)
    let accepted = null;
    const localReject = [];
    for (const out of outs) {
      const validation = _validate(out, cluster, opts);
      if (!validation.ok) { localReject.push(validation.reasons); continue; }
      accepted = { out, validation };
      break;
    }
    if (!accepted) {
      rejected.push({ cluster_size: cluster.members.length, reason: 'all_insights_failed_validation', detail: localReject });
      continue;
    }
    const writeRes = _writeReflection(accepted.out, cluster, accepted.validation, activityId);
    if (writeRes) {
      written.push(Object.assign({}, writeRes, {
        assertion: accepted.out.assertion,
        confidence: accepted.out.confidence,
        warnings: accepted.validation.reasons.filter(r => r.severity === 'soft')
      }));
    }
  }

  return {
    ok: true,
    activity_id: activityId,
    started_at: started,
    ended_at: Date.now(),
    candidates_seen: candidates.length,
    clusters_seen: allClusters.length,
    clusters_selected: selected.length,
    clusters_emitted: written.length,
    rejected_count: rejected.length,
    rejected,
    written
  };
}

module.exports = {
  runReflection,
  DEFAULTS,
  // Exposed for tests
  _cosine,
  _clusterOnline,
  _selectClusters,
  _sourceHash,
  _validate,
  _buildReflectionPrompt,
  _parseReflections
};
