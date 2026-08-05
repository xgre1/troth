// SPDX-License-Identifier: AGPL-3.0-only
// KnowledgeAtlas — portable, shareable per-domain knowledge export/import.
//
// An Atlas is an NDJSON bundle of ActionRecords + a small header. It lets
// a user move their accumulated AI knowledge between machines, share
// repo-specific patterns with a team, or bootstrap a new user from a
// public Atlas so they have day-one frontier performance without months
// of accumulation.
//
// Format (one JSON object per line):
//
//   {"__atlas":{"version":"0.1","created_at":...,"count":...,"filter":...}}
//   {"id":"...","type":"...","timestamp":...,"input":{...},...}
//   {"id":"...","type":"...","timestamp":...,"input":{...},...}
//   ...
//
// First line is always the header (keyed on __atlas). Subsequent lines are
// ActionRecords in the canonical schema.
//
// Import is idempotent by default: records whose id already exists in the
// local substrate are skipped. Callers can opt into overwrite or fail-
// on-conflict modes.
//
// This module is pure data — no I/O beyond the in-memory string. Callers
// write/read files themselves. See the substrate design notes
// "Layer 4 — KnowledgeAtlas" and the substrate design notes E1.

const actionRecord = require('./action-record');

const ATLAS_VERSION = '0.1';

// ── Export ────────────────────────────────────────────────────────────────

// Pull a filtered set of ActionRecords from the substrate and serialize as
// NDJSON. Filter shape mirrors state.queryActions + an extra `record_types`
// whitelist for exports that want only certain types (e.g., "just the
// lessons" atlas, "just the successful edits" atlas).
function exportAtlas(state, opts) {
  opts = opts || {};
  const filter = opts.filter || {};
  // Raised ceiling so a full-mind export doesn't re-clamp. With no explicit
  // opts.limit (e.g. the CLI `troth atlas export`) this defaults to 1M rows;
  // an explicit caller limit is still honored but capped at 1M. The per-query
  // forExport flag below is what actually lifts the queryActions 1000 clamp.
  const limit  = Math.min(parseInt(opts.limit || 1000000), 1000000);

  // Pull matching rows. If filter.record_types provided, expand into
  // multiple queryActions calls and merge.
  //
  // The DEFAULT export carries the MIND, not the raw audit trail. When the
  // caller pins neither filter.record_types nor filter.type, export only the
  // mind-bearing types and deliberately SKIP the high-volume audit noise
  // ('tool_call','read','search','edit','compact'): that telemetry would bloat
  // a full-mind bundle manyfold and the receiving substrate re-derives it
  // anyway. An explicit filter.record_types / filter.type OVERRIDES this
  // default and can still export any type (e.g. `troth atlas export --type edit`).
  const DEFAULT_EXPORT_TYPES = [
    'commitment', 'decision', 'lesson', 'compiled_procedure',
    'intent', 'avoided_path', 'mind_snapshot'
  ];
  const types = Array.isArray(filter.record_types) && filter.record_types.length
    ? filter.record_types
    : (filter.type ? [filter.type] : DEFAULT_EXPORT_TYPES);

  const seen = new Set();
  const rows = [];
  for (const t of types) {
    const q = {
      type:       t || filter.type,
      agent_id:   filter.agent_id,
      session_id: filter.session_id,
      cwd:        filter.cwd,
      since:      filter.since,
      until:      filter.until,
      limit,
      // Deliberate full-substrate export: bypass the queryActions 1000-row
      // recall clamp so the WHOLE mind is pulled, not just the recent window.
      forExport:  true
    };
    const part = (state.queryActions ? state.queryActions(q) : []) || [];
    for (const r of part) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
    if (rows.length >= limit) break;
  }

  // Walk parent_id chains and pull in any ancestor rows that aren't
  // already in the export. Without this, filtering by type_records like
  // ['edit','read','decision'] strands children whose parent is, say,
  // a type='compact' or type='lesson' record — the receiving substrate
  // then rejects them via the FOREIGN KEY constraint on parent_id and
  // we silently lose ~10% of bundles. Caught live during conformance D
  // (30/338 records failed import). Solution: include parents
  // transitively, capped at limit so a long chain can't blow the bundle.
  if (state.getAction && state.queryActions) {
    const haveById = new Set(rows.map(r => r.id));
    const queue = [];
    for (const r of rows) if (r.parent_id && !haveById.has(r.parent_id)) queue.push(r.parent_id);
    // Parents are MANDATORY for FK integrity on import — never bound this
    // walk by `limit`. The cap there is for filtered content; if a chain
    // has more ancestors than `limit` we still need them so the bundle
    // is loadable. A ceiling of 100k matches the queryActions cap and
    // prevents truly pathological loops.
    let walked = 0;
    while (queue.length && walked < 100000) {
      const pid = queue.shift();
      if (haveById.has(pid)) continue;
      let parentRow = null;
      try { parentRow = state.getAction(pid); } catch (_) {}
      if (!parentRow) continue;
      haveById.add(parentRow.id);
      rows.push(parentRow);
      walked += 1;
      if (parentRow.parent_id && !haveById.has(parentRow.parent_id)) queue.push(parentRow.parent_id);
    }
  }

  // Import needs parents before children (FOREIGN KEY). Timestamps can
  // collide on fast successive writes, so we topologically sort: primary
  // order is (timestamp, id), then a fix-up pass promotes any record
  // whose parent hasn't been emitted yet. Ids are UUIDv7 so (timestamp,
  // id) is already close to correct, but parent_id can reference a
  // record with an equal or lower timestamp + different id.
  rows.sort((a, b) => {
    const ta = a.timestamp || 0, tb = b.timestamp || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
  // Topological fix-up for intra-millisecond collisions.
  const rowById = new Map(rows.map(r => [r.id, r]));
  const emitted = new Set();
  const ordered = [];
  const visit = (r, stack) => {
    if (!r || emitted.has(r.id)) return;
    if (stack.has(r.id)) return; // cycle guard (shouldn't happen)
    stack.add(r.id);
    if (r.parent_id && rowById.has(r.parent_id) && !emitted.has(r.parent_id)) {
      visit(rowById.get(r.parent_id), stack);
    }
    stack.delete(r.id);
    emitted.add(r.id);
    ordered.push(r);
  };
  for (const r of rows) visit(r, new Set());
  rows.length = 0;
  for (const r of ordered) rows.push(r);

  const header = {
    __atlas: {
      version:    ATLAS_VERSION,
      created_at: Date.now(),
      count:      rows.length,
      filter:     filter,
      source:     opts.source || 'troth-substrate'
    }
  };

  const lines = [JSON.stringify(header)];
  for (const row of rows) {
    const rec = actionRecord.fromRow(row);
    lines.push(JSON.stringify(rec));
  }
  return {
    content: lines.join('\n') + '\n',
    count:   rows.length,
    header:  header.__atlas
  };
}

// ── Import ────────────────────────────────────────────────────────────────

// Parse NDJSON bundle and merge into local substrate. Returns counts for
// imported / skipped / failed. Conflict policy governs what happens when
// the same id already exists:
//   - 'skip'      (default) — leave the local record; count as skipped
//   - 'overwrite' — replace local with imported (same id; new timestamp)
//   - 'fail'      — stop on first collision, return partial result
function importAtlas(state, content, opts) {
  opts = opts || {};
  const conflict = opts.conflict || 'skip';
  if (!content || typeof content !== 'string') {
    return { imported: 0, skipped: 0, failed: 0, errors: [{ kind: 'empty_content' }] };
  }

  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) {
    return { imported: 0, skipped: 0, failed: 0, errors: [{ kind: 'no_lines' }] };
  }

  // First line should be the header. Tolerate headerless atlases for
  // forward-compat with hand-authored bundles — just skip header checking.
  let startIdx = 0;
  let header = null;
  try {
    const maybeHeader = JSON.parse(lines[0]);
    if (maybeHeader && maybeHeader.__atlas) {
      header = maybeHeader.__atlas;
      startIdx = 1;
      if (header.version && !isVersionCompatible(header.version)) {
        return {
          imported: 0, skipped: 0, failed: 0,
          errors: [{ kind: 'incompatible_version', got: header.version, supported: ATLAS_VERSION }]
        };
      }
    }
  } catch (_) { /* not a header — treat line 0 as a record */ }

  const result = { imported: 0, skipped: 0, failed: 0, errors: [], header };

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let rec;
    try { rec = JSON.parse(line); }
    catch (e) { result.failed++; result.errors.push({ kind: 'parse', line: i, msg: e.message }); continue; }

    const validation = actionRecord.validate(rec);
    if (!validation.ok) {
      result.failed++;
      result.errors.push({ kind: 'invalid_record', line: i, errors: validation.errors });
      continue;
    }

    const existing = state.getAction(rec.id);
    if (existing) {
      if (conflict === 'fail') {
        result.errors.push({ kind: 'conflict', line: i, id: rec.id });
        return result;
      }
      if (conflict === 'skip') {
        result.skipped++;
        continue;
      }
      // 'overwrite' — SQLite has INSERT OR REPLACE semantics via the
      // state.recordAction path, but our schema uses plain INSERT which
      // will fail on PK collision. Fall back to explicit delete-then-
      // insert to keep the semantics honest.
      try {
        const db = state._dbForQuery && state._dbForQuery();
        if (db) db.prepare('DELETE FROM action_records WHERE id = ?').run(rec.id);
      } catch (_) { /* best-effort */ }
    }

    try {
      const id = state.recordAction(rec, actionRecord.toSearchText(rec));
      if (id) result.imported++;
      else { result.failed++; result.errors.push({ kind: 'write_failed', line: i, id: rec.id }); }
    } catch (e) {
      result.failed++;
      result.errors.push({ kind: 'write_error', line: i, id: rec.id, msg: e.message });
    }
  }

  return result;
}

// ── Versioning ────────────────────────────────────────────────────────────

function isVersionCompatible(version) {
  // v0.1 reader supports only v0.1 atlases. Bump the policy once v0.2 ships.
  if (typeof version !== 'string') return false;
  return version === '0.1' || version.startsWith('0.1.');
}

// ── Sanity ────────────────────────────────────────────────────────────────

// Quick validation of a bundle WITHOUT importing. Useful for UI previews
// and CI checks. Returns { ok, header, records_seen, errors }.
function inspectAtlas(content) {
  if (!content || typeof content !== 'string') {
    return { ok: false, errors: [{ kind: 'empty' }] };
  }
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { ok: false, errors: [{ kind: 'no_lines' }] };

  let header = null;
  let startIdx = 0;
  try {
    const h = JSON.parse(lines[0]);
    if (h && h.__atlas) { header = h.__atlas; startIdx = 1; }
  } catch (_) { /* headerless */ }

  let recordsSeen = 0;
  const errors = [];
  for (let i = startIdx; i < lines.length; i++) {
    try {
      const rec = JSON.parse(lines[i]);
      const v = actionRecord.validate(rec);
      if (v.ok) recordsSeen++;
      else errors.push({ line: i, kind: 'invalid_record' });
    } catch (e) {
      errors.push({ line: i, kind: 'parse', msg: e.message });
    }
  }
  return { ok: errors.length === 0, header, records_seen: recordsSeen, errors };
}

module.exports = {
  ATLAS_VERSION,
  exportAtlas,
  importAtlas,
  inspectAtlas,
  isVersionCompatible
};
