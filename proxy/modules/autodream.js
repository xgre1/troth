// SPDX-License-Identifier: AGPL-3.0-only
// AutoDream — background memory consolidation for reflexion + trajectory stores.
//
// Research [Enterprise AI Memory Architecture, ]: agents that write to
// memory but never prune or consolidate accumulate stale/contradictory
// entries. Over time this degrades retrieval precision — the most relevant
// lesson gets drowned by near-duplicates.
//
// Four phases (modeled on the AutoDream paper):
//   1. Orient    — count rows, find near-duplicates via normalized-text hash
//   2. Gather    — (no-op here; signals are already persisted by reflexion.js)
//   3. Consolidate — merge near-duplicates, carry highest used_count forward
//   4. Prune     — Hebbian decay: score = age_days / (used_count + 1);
//                  drop rows above MAX_ROWS, lowest-score first
//
// Runs opportunistically every 6 hours (configurable) and on explicit trigger.

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var HOME = process.env.HOME || require('os').homedir();
var DB_DIR = path.join(HOME, '.troth');
var projectKey = crypto.createHash('sha256')
  .update(process.env.GF_WATCH_DIR || process.cwd())
  .digest('hex').slice(0, 12);
var REFLEXION_DB = path.join(DB_DIR, 'reflexion-' + projectKey + '.db');

var MAX_ROWS = 200;
var INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
var DUPLICATE_SIMILARITY = 0.85; // Jaccard on word-sets
var DAY_MS = 24 * 60 * 60 * 1000;

var state = {
  lastRun: 0,
  runs: 0,
  merged: 0,
  pruned: 0,
  errors: 0,
  timerHandle: null
};

function normalizeText(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Lightweight stemmer: strip common English suffixes so "mismatch" and
// "mismatches" map to the same token. Good enough for near-duplicate detection.
function stem(w) {
  if (w.length < 4) return w;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function wordSet(t) {
  var words = normalizeText(t).split(' ').filter(Boolean);
  var set = Object.create(null);
  for (var i = 0; i < words.length; i++) set[stem(words[i])] = 1;
  return set;
}

function jaccard(a, b) {
  var keysA = Object.keys(a), keysB = Object.keys(b);
  if (!keysA.length && !keysB.length) return 1;
  var inter = 0;
  for (var i = 0; i < keysA.length; i++) if (b[keysA[i]]) inter++;
  var union = keysA.length + keysB.length - inter;
  return union === 0 ? 0 : inter / union;
}

// Phase 1+3: find near-duplicate reflections and merge them.
// Returns number of rows merged away.
function consolidateReflexion(db) {
  var rows = db.prepare('SELECT id, reflection, used_count, ts FROM reflections ORDER BY ts DESC').all();
  if (rows.length < 2) return 0;

  // Precompute word-sets once
  var sets = rows.map(function(r) { return wordSet(r.reflection); });
  var merged = 0;
  var keep = new Array(rows.length).fill(true);
  var absorbInto = {}; // id → id of survivor

  for (var i = 0; i < rows.length; i++) {
    if (!keep[i]) continue;
    for (var j = i + 1; j < rows.length; j++) {
      if (!keep[j]) continue;
      var sim = jaccard(sets[i], sets[j]);
      if (sim >= DUPLICATE_SIMILARITY) {
        // Keep the one with higher used_count; if tied, keep newer (rows sorted by ts DESC so j is older)
        var survivor = rows[i], absorbed = rows[j];
        if (absorbed.used_count > survivor.used_count) { survivor = rows[j]; absorbed = rows[i]; }
        keep[rows.indexOf(absorbed)] = false;
        absorbInto[absorbed.id] = survivor.id;
        merged++;
      }
    }
  }

  if (merged > 0) {
    var tx = db.transaction(function() {
      for (var absorbedId in absorbInto) {
        var survivorId = absorbInto[absorbedId];
        db.prepare('UPDATE reflections SET used_count = used_count + (SELECT used_count FROM reflections WHERE id = ?) WHERE id = ?').run(absorbedId, survivorId);
        db.prepare('DELETE FROM reflections WHERE id = ?').run(absorbedId);
      }
    });
    tx();
  }
  return merged;
}

// Phase 4: Hebbian decay prune. Drops lowest-score rows until total ≤ MAX_ROWS.
// score = age_days / (used_count + 1) — LOWER is "worth keeping".
// Also drops any row with score > 60 (≈ unused for 60 days with used_count=0).
function pruneReflexion(db) {
  var now = Date.now();
  var rows = db.prepare('SELECT id, used_count, ts FROM reflections').all();
  if (!rows.length) return 0;

  var scored = rows.map(function(r) {
    var ageDays = (now - r.ts) / DAY_MS;
    var score = ageDays / ((r.used_count || 0) + 1);
    return { id: r.id, score: score };
  });
  scored.sort(function(a, b) { return b.score - a.score; }); // highest score (worst) first

  var pruned = 0;
  var toDelete = [];

  // Unconditional: drop any row with score > 60 (stale AND unused)
  for (var i = 0; i < scored.length; i++) {
    if (scored[i].score > 60) toDelete.push(scored[i].id);
  }

  // Cap: if still above MAX_ROWS, drop worst-scored until under cap
  var remaining = rows.length - toDelete.length;
  var idx = 0;
  while (remaining > MAX_ROWS && idx < scored.length) {
    if (toDelete.indexOf(scored[idx].id) === -1) {
      toDelete.push(scored[idx].id);
      remaining--;
    }
    idx++;
  }

  if (toDelete.length) {
    var tx = db.transaction(function() {
      var stmt = db.prepare('DELETE FROM reflections WHERE id = ?');
      for (var k = 0; k < toDelete.length; k++) { stmt.run(toDelete[k]); pruned++; }
    });
    tx();
  }
  return pruned;
}

function consolidate() {
  state.runs++;
  state.lastRun = Date.now();
  if (!fs.existsSync(REFLEXION_DB)) return { merged: 0, pruned: 0, skipped: 'no-db' };

  var Database;
  try { Database = require('better-sqlite3'); } catch (e) { state.errors++; return { error: 'better-sqlite3 missing' }; }

  var db;
  try {
    db = new Database(REFLEXION_DB);
    db.pragma('journal_mode = WAL');
    var merged = consolidateReflexion(db);
    var pruned = pruneReflexion(db);
    db.close();
    state.merged += merged;
    state.pruned += pruned;
    if (merged + pruned > 0) {
      console.log('[autodream] Consolidation: merged=' + merged + ' pruned=' + pruned);
    }
    return { merged: merged, pruned: pruned };
  } catch (e) {
    state.errors++;
    try { if (db) db.close(); } catch (_) {}
    return { error: e.message };
  }
}

function scheduleBackground(intervalMs) {
  if (state.timerHandle) return;
  var ms = intervalMs || INTERVAL_MS;
  // Run once on startup after a short delay so proxy init isn't blocked
  setTimeout(function() { try { consolidate(); } catch (e) {} }, 60 * 1000);
  state.timerHandle = setInterval(function() { try { consolidate(); } catch (e) {} }, ms);
  if (state.timerHandle.unref) state.timerHandle.unref();
}

function stopBackground() {
  if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
}

function getStats() {
  return {
    module: 'autodream',
    lastRun: state.lastRun,
    lastRunAgo: state.lastRun ? Math.round((Date.now() - state.lastRun) / 1000) : null,
    runs: state.runs,
    mergedTotal: state.merged,
    prunedTotal: state.pruned,
    errors: state.errors,
    maxRows: MAX_ROWS,
    intervalHours: INTERVAL_MS / (60 * 60 * 1000),
    scheduled: !!state.timerHandle
  };
}

module.exports = {
  consolidate: consolidate,
  scheduleBackground: scheduleBackground,
  stopBackground: stopBackground,
  getStats: getStats,
  // exposed for tests
  _jaccard: jaccard,
  _wordSet: wordSet,
  _consolidateReflexion: consolidateReflexion,
  _pruneReflexion: pruneReflexion,
  MAX_ROWS: MAX_ROWS,
  DUPLICATE_SIMILARITY: DUPLICATE_SIMILARITY
};
