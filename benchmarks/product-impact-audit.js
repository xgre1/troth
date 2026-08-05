#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// product-impact-audit — comprehensive measured-value bench over the
// substrate's L1. Pulls every queryable signal that could reflect
// "user session became better invisibly". No hand-waving, no
// guessing — every number comes from action_records SQL.
//
// Categories audited:
//   1. Substrate accumulation (state.db growth, types breakdown)
//   2. Compaction continuity (compact events + mind_snapshot pairing)
//   3. Edit quality (verified_edits via AST validation)
//   4. Loop prevention (loopguard fires, blocked retries)
//   5. Lesson surfacing (lessons consumed in subsequent sessions)
//   6. Cache effectiveness (cache hits/misses via tool patterns)
//   7. Drift detection (degradation_alerts written by substrate)
//   8. Errortax classification (tool errors caught + classified)
//   9. Precedent re-use (verified edits found by query)
//  10. Substrate feature usage (anchor suggestions, revisions, insights)

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(process.env.HOME || require('os').homedir(), '.troth', 'state.db');
const db = new Database(DB_PATH, { readonly: true });

const NOW = Date.now();
const WEEK = 7 * 24 * 60 * 60 * 1000;
const sinceWeek = NOW - WEEK;
const sinceMonth = NOW - 4 * WEEK;

const out = { generated_at: new Date().toISOString(), buckets: {} };

function q(sql, ...binds) { return db.prepare(sql).get(...binds); }
function qall(sql, ...binds) { return db.prepare(sql).all(...binds); }

// ── 1. Substrate accumulation ──
out.buckets.accumulation = {
  total_records: q('SELECT COUNT(*) AS n FROM action_records').n,
  unique_agents: q('SELECT COUNT(DISTINCT agent_id) AS n FROM action_records').n,
  by_type: qall('SELECT type, COUNT(*) AS n FROM action_records GROUP BY type ORDER BY n DESC'),
  records_last_7d: q('SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ?', sinceWeek).n,
  records_last_30d: q('SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ?', sinceMonth).n
};

// ── 2. Compaction continuity ──
// IMPORTANT: type='compact' is dual-purpose:
//   (a) trigger='load_eviction' — substrate working-set page evictions
//       (Pichay-style demand paging — these are FEATURES, not Claude
//       Code compactions)
//   (b) trigger from runtime.onBeforeCompact — Claude Code real compact
// Mind snapshots are written at PreCompact hook time AND at Stop hook
// time. Both contribute to continuity.
const realCompactSnapshots = q(
  "SELECT COUNT(*) AS n FROM action_records WHERE type='mind_snapshot' AND json_extract(input,'$.trigger') = 'pre_compact'"
).n;
const stopSnapshots = q(
  "SELECT COUNT(*) AS n FROM action_records WHERE type='mind_snapshot' AND json_extract(input,'$.trigger') = 'stop'"
).n;
const internalEvictions = q(
  "SELECT COUNT(*) AS n FROM action_records WHERE type='compact' AND json_extract(input,'$.trigger') = 'load_eviction'"
).n;
out.buckets.compaction_continuity = {
  real_claude_code_compactions: realCompactSnapshots,
  stop_triggered_snapshots: stopSnapshots,
  total_continuity_snapshots: realCompactSnapshots + stopSnapshots,
  internal_working_set_evictions: internalEvictions,
  mind_snapshots_total: q('SELECT COUNT(*) AS n FROM action_records WHERE type = ?', 'mind_snapshot').n,
  notes: 'pre_compact snapshots = real Claude Code compactions handled. stop snapshots = mind-state persisted at end of every assistant turn (continuity beyond just compact moments). load_eviction "compact" rows are substrate-internal page swaps, not Claude Code events.'
};

// ── 3. Edit quality (AST verification) ──
out.buckets.edit_quality = {
  total_edits: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'edit'").n,
  ast_verified_edits: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'edit' AND json_extract(verification, '$.ast.ok') = 1").n,
  ast_failed_edits: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'edit' AND json_extract(verification, '$.ast.ok') = 0").n,
  edits_last_7d: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'edit' AND timestamp >= ?", sinceWeek).n
};
const eq = out.buckets.edit_quality;
eq.ast_pass_rate = eq.total_edits ? eq.ast_verified_edits / eq.total_edits : 0;

// ── 4. Loop prevention ──
const loopFires = qall("SELECT id, cwd FROM action_records WHERE type = 'tool_call' AND json_extract(input, '$.tool_name') = 'loopguard.fire' LIMIT 100").length;
out.buckets.loop_prevention = {
  loopguard_fires_lifetime: loopFires,
  loopbreaker_hashes: q('SELECT COUNT(*) AS n FROM loopbreaker_hashes').n
};

// ── 5. Lesson surfacing ──
out.buckets.lesson_surfacing = {
  total_lessons: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'lesson'").n,
  lessons_last_30d: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'lesson' AND timestamp >= ?", sinceMonth).n,
  context_injections: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'context_injection'").n,
  precedent_hits_24h: q("SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ? AND type = 'decision' AND json_extract(input, '$.kind') = 'context_injection' AND CAST(json_extract(input, '$.precedent_count') AS INTEGER) > 0", NOW - 24 * 3600 * 1000).n
};

// ── 6. Cache effectiveness ──
const cachedRead = q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'tool_call' AND json_extract(input, '$.tool_name') = 'cached_read'").n;
const cachedGrep = q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'tool_call' AND json_extract(input, '$.tool_name') = 'cached_grep'").n;
out.buckets.cache_effectiveness = {
  cached_read_calls: cachedRead,
  cached_grep_calls: cachedGrep,
  total_cache_calls: cachedRead + cachedGrep,
  raw_read_calls: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'read'").n
};
const ce = out.buckets.cache_effectiveness;
ce.cache_vs_raw_ratio = ce.raw_read_calls ? ce.total_cache_calls / (ce.total_cache_calls + ce.raw_read_calls) : 0;

// ── 7. Drift detection ──
const driftAlerts = q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'degradation_alert'").n;
const driftLast7 = q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'degradation_alert' AND timestamp >= ?", sinceWeek).n;
out.buckets.drift_detection = {
  drift_alerts_lifetime: driftAlerts,
  drift_alerts_last_7d: driftLast7
};

// ── 8. Errortax classification ──
out.buckets.errortax = {
  total_errors_recorded: q("SELECT COUNT(*) AS n FROM action_records WHERE json_extract(verification, '$.error') IS NOT NULL").n,
  // top error categories from errortax classifier
  errortax_categories: qall("SELECT json_extract(input, '$.signals.error_class') AS cls, COUNT(*) AS n FROM action_records WHERE type = 'lesson' AND json_extract(input, '$.source') = 'errortax' GROUP BY cls ORDER BY n DESC LIMIT 5")
};

// ── 9. Precedent re-use (verified edits surfaced in new prompts) ──
out.buckets.precedent_reuse = {
  total_verified_precedents: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'edit' AND json_extract(verification, '$.ast.ok') = 1").n,
  context_injections_with_precedent: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'context_injection' AND CAST(json_extract(input, '$.precedent_count') AS INTEGER) > 0").n,
  injections_with_lessons: q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'context_injection' AND CAST(json_extract(input, '$.lesson_count') AS INTEGER) > 0").n
};

// ── 10. Substrate-as-mind feature usage ──
out.buckets.substrate_features = {
  anchor_suggestions:    q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'anchor_suggested'").n,
  revisions_proposed:    q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'revision_proposed'").n,
  revisions_resolved:    q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'revision_resolved'").n,
  insights_surfaced:     q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'insight_surfaced'").n,
  engram_feedback:       q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'engram_feedback'").n,
  mind_decisions:        q("SELECT COUNT(*) AS n FROM action_records WHERE type = 'decision' AND json_extract(input, '$.kind') = 'mind_decision'").n
};

// ── 11. Causal graph density ──
out.buckets.causal_graph = {
  edges_total: q('SELECT COUNT(*) AS n FROM action_record_edges').n,
  parent_id_coverage: q('SELECT SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS r FROM action_records').r || 0,
  edges_by_label: qall('SELECT label, COUNT(*) AS n FROM action_record_edges GROUP BY label ORDER BY n DESC')
};

// ── 12. Tool output archive (cache size) ──
out.buckets.tool_archive = {
  total_archived: q('SELECT COUNT(*) AS n FROM tool_output_archive').n,
  total_bytes_compressed: q('SELECT COALESCE(SUM(bytes_out), 0) AS n FROM tool_output_archive').n,
  total_bytes_raw: q('SELECT COALESCE(SUM(bytes_in), 0) AS n FROM tool_output_archive').n
};
const ta = out.buckets.tool_archive;
ta.compression_ratio = ta.total_bytes_raw ? ta.total_bytes_compressed / ta.total_bytes_raw : 0;
ta.bytes_saved = ta.total_bytes_raw - ta.total_bytes_compressed;

db.close();

console.log(JSON.stringify(out, null, 2));
