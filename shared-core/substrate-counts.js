// SPDX-License-Identifier: AGPL-3.0-only
// The substrate's counts, as the dashboard and the app read them.
'use strict';

const fs = require('fs');
const path = require('path');

const COMMITMENT_HONEST_WHERE =
  " type='commitment'" +
  " AND COALESCE(json_extract(output,'$.commitment_type'),'') != 'engram_tombstoned'" +
  " AND COALESCE(json_extract(output,'$.scope'),'') NOT LIKE 'test:%'" +
  " AND COALESCE(json_extract(input,'$.source'),'') NOT LIKE 'test%'" +
  " AND agent_id NOT LIKE 'pe6%' AND agent_id NOT LIKE 'pe7%' AND agent_id NOT LIKE 'pe8%'" +
  " AND agent_id NOT LIKE 'bench%' AND agent_id NOT LIKE 'test%'";

function counts() {
  const state = require('./state.js');
  const ar = require('./action-record.js');
  const out = { total: 0, by_type: {} };
  const db = state._dbForQuery && state._dbForQuery();
  if (db) {
    // One pass over the type index instead of one count per type.
    const rows = db.prepare('SELECT type, COUNT(*) AS n FROM action_records GROUP BY type').all();
    for (const t of ar.ALL_TYPES) out.by_type[t] = 0;
    for (const r of rows) { out.by_type[r.type] = r.n; out.total += r.n; }
  } else {
    out.total = state.countActions({});
    for (const t of ar.ALL_TYPES) out.by_type[t] = state.countActions({ type: t });
  }
  try {
    if (db) {
      out.by_type_raw_commitment = out.by_type.commitment;
      out.by_type.commitment = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE' + COMMITMENT_HONEST_WHERE).get().n;
      const h24 = Date.now() - 24 * 3600 * 1000;
      out.last_24h = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ?').get(h24).n;
      out.knowledge = db.prepare(
        "SELECT COUNT(*) AS n FROM action_records WHERE json_extract(output,'$.scope') LIKE 'docs:%'" +
        " AND json_extract(output,'$.scope') NOT LIKE 'docs:chats%'").get().n;
      const d7 = Date.now() - 7 * 24 * 3600 * 1000;
      out.commitments_7d = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ? AND' + COMMITMENT_HONEST_WHERE).get(d7).n;
      try {
        const dbp = path.join(require('./troth-home.js').trothDir(), 'state.db');
        out.db_bytes = fs.statSync(dbp).size;
      } catch (_) {}
      out.parent_id_coverage = db.prepare("SELECT SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS r FROM action_records").get().r || 0;
      out.precedent_hits_24h = db.prepare("SELECT COUNT(*) AS n FROM action_records WHERE timestamp >= ? AND type='decision' AND json_extract(input,'$.kind')='context_injection' AND CAST(json_extract(input,'$.precedent_count') AS INTEGER) > 0").get(h24).n;
      out.verified_edits = db.prepare("SELECT COUNT(*) AS n FROM action_records WHERE type='edit' AND json_extract(verification,'$.ast.ok') = 1").get().n;
      out.compacts_lifetime = db.prepare("SELECT COUNT(*) AS n FROM action_records WHERE type='compact'").get().n;
      try {
        const RECALLABLE_WHERE = " memory_class IN ('episodic','semantic','identity','procedural') AND (audience IS NULL OR audience='model_visible')";
        const recallable = db.prepare('SELECT COUNT(*) AS n FROM action_records WHERE' + RECALLABLE_WHERE).get().n;
        const embedded = db.prepare('SELECT COUNT(*) AS n FROM engram_embeddings e JOIN action_records a ON a.id = e.engram_id WHERE' + RECALLABLE_WHERE.replace(/memory_class/g, 'a.memory_class').replace(/audience/g, 'a.audience')).get().n;
        out.embedding_coverage = { embedded, recallable, ratio: recallable ? embedded / recallable : 1 };
      } catch (_) {}
    }
  } catch (_) { /* the plain counts still serve */ }
  return out;
}

module.exports = { counts, COMMITMENT_HONEST_WHERE };
