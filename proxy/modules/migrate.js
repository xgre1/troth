// SPDX-License-Identifier: AGPL-3.0-only
// Migration runner — version SQLite schemas and apply migrations on startup.
//
// Each module DB (reflexion, trajectory) gets a `_meta` table tracking
// schema version. New migrations run automatically. Idempotent.

const Database = require('better-sqlite3');

const MIGRATIONS = {
  // Future schema changes live here per-DB
  reflexion: [
    // Migration 0: baseline (already created in module init)
    // Migration 1: future placeholder
  ],
  trajectories: [],
};

function ensureMeta(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function getVersion(db) {
  ensureMeta(db);
  try {
    const row = db.prepare('SELECT value FROM _meta WHERE key = ?').get('schema_version');
    return row ? parseInt(row.value) : 0;
  } catch (e) { return 0; }
}

function setVersion(db, version) {
  db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)').run('schema_version', String(version));
}

function migrate(dbPath, dbName) {
  const migrations = MIGRATIONS[dbName] || [];
  if (!migrations.length) return { applied: 0 };
  let db;
  try { db = new Database(dbPath); } catch (e) { return { error: e.message }; }
  const current = getVersion(db);
  let applied = 0;
  for (let i = current; i < migrations.length; i++) {
    try {
      migrations[i](db);
      setVersion(db, i + 1);
      applied++;
    } catch (e) {
      db.close();
      return { applied, error: 'migration ' + (i + 1) + ' failed: ' + e.message };
    }
  }
  db.close();
  return { applied, totalSchemaVersion: current + applied };
}

module.exports = { migrate, getVersion, MIGRATIONS };
