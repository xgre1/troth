// SPDX-License-Identifier: AGPL-3.0-only
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class CodeStore {
  constructor(dbPath) {
    // File-based SQLite for persistent codebase memory.
    // Falls back to in-memory if path not writable.
    var target = dbPath || ':memory:';
    try {
      if (target !== ':memory:') {
        var dir = path.dirname(target);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(target);
      this.persistent = (target !== ':memory:');
      if (this.persistent) console.log('[CodeLens] Persistent store:', target);
    } catch (e) {
      console.log('[CodeLens] Could not open', target, '— using in-memory');
      this.db = new Database(':memory:');
      this.persistent = false;
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createTables();
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        signature TEXT,
        line_number INTEGER,
        content TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_file ON entities(file_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS code_index USING fts5(
        name,
        signature,
        file_path,
        content,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_indexed INTEGER NOT NULL,
        normalized_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary TEXT NOT NULL,
        context TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    // Migration: add normalized_hash column if not exists (for AST-diff)
    try {
      this.db.exec("ALTER TABLE file_hashes ADD COLUMN normalized_hash TEXT");
    } catch (e) { /* column already exists */ }

    this._insertEntity = this.db.prepare(
      'INSERT INTO entities (type, name, file_path, signature, line_number, content) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._insertEdge = this.db.prepare(
      'INSERT INTO edges (source_id, target_id, relation_type) VALUES (?, ?, ?)'
    );
    this._insertFTS = this.db.prepare(
      'INSERT INTO code_index (rowid, name, signature, file_path, content) VALUES (?, ?, ?, ?, ?)'
    );
    this._searchBM25 = this.db.prepare(
      "SELECT rowid, name, signature, file_path, bm25(code_index) as score FROM code_index WHERE code_index MATCH ? ORDER BY score LIMIT 15"
    );
  }

  addEntity(type, name, filePath, signature, lineNumber, content) {
    const result = this._insertEntity.run(type, name, filePath, signature || '', lineNumber || 0, content || '');
    const id = result.lastInsertRowid;
    this._insertFTS.run(id, name, signature || '', filePath, content || '');
    return Number(id);
  }

  addEdge(sourceId, targetId, relationType) {
    this._insertEdge.run(sourceId, targetId, relationType);
  }

  search(query) {
    try {
      const terms = query.split(/\s+/).filter(t => t.length > 2);
      if (terms.length === 0) return [];
      const ftsQuery = terms.join(' OR ');
      return this._searchBM25.all(ftsQuery);
    } catch (e) {
      return [];
    }
  }

  traverse(seedIds, maxDepth) {
    if (!maxDepth) maxDepth = 3;
    if (seedIds.length === 0) return [];
    const placeholders = seedIds.map(function() { return '?'; }).join(',');
    const stmt = this.db.prepare(
      'WITH RECURSIVE graph(id, depth) AS (' +
      '  SELECT id, 0 FROM entities WHERE id IN (' + placeholders + ')' +
      '  UNION' +
      '  SELECT e.target_id, g.depth + 1 FROM edges e JOIN graph g ON e.source_id = g.id WHERE g.depth < ?' +
      '  UNION' +
      '  SELECT e.source_id, g.depth + 1 FROM edges e JOIN graph g ON e.target_id = g.id WHERE g.depth < ?' +
      ') SELECT DISTINCT ent.*, graph.depth FROM graph JOIN entities ent ON ent.id = graph.id ORDER BY graph.depth ASC'
    );
    return stmt.all.apply(stmt, seedIds.concat([maxDepth, maxDepth]));
  }

  getEntity(id) {
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  }

  getFileEntities(filePath) {
    return this.db.prepare('SELECT * FROM entities WHERE file_path = ?').all(filePath);
  }

  getEdges(entityId) {
    return this.db.prepare(
      'SELECT e.*, ent.name as target_name, ent.file_path as target_file FROM edges e JOIN entities ent ON ent.id = e.target_id WHERE e.source_id = ?'
    ).all(entityId);
  }

  getEntity(entityId) {
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
  }

  // Get callers of an entity (incoming edges)
  getCallers(entityId) {
    return this.db.prepare(
      'SELECT e.*, ent.name as source_name, ent.file_path as source_file, ent.signature as source_sig FROM edges e JOIN entities ent ON ent.id = e.source_id WHERE e.target_id = ? AND e.relation = ?'
    ).all(entityId, 'CALLS');
  }

  // Get callees (outgoing CALLS)
  getCallees(entityId) {
    return this.db.prepare(
      'SELECT e.*, ent.name as target_name, ent.file_path as target_file, ent.signature as target_sig FROM edges e JOIN entities ent ON ent.id = e.target_id WHERE e.source_id = ? AND e.relation = ?'
    ).all(entityId, 'CALLS');
  }

  // ── Incremental update methods ──

  deleteByFile(filePath) {
    var entityIds = this.db.prepare('SELECT id FROM entities WHERE file_path = ?').all(filePath);
    if (entityIds.length) {
      var ids = entityIds.map(function(r) { return r.id; });
      // Delete one by one to avoid prepare/apply issues with variable args
      var delFts = this.db.prepare('DELETE FROM code_index WHERE rowid = ?');
      for (var di = 0; di < ids.length; di++) {
        try { delFts.run(ids[di]); } catch (e) {}
      }
    }
    this.db.prepare('DELETE FROM entities WHERE file_path = ?').run(filePath);
  }

  getFileHash(filePath) {
    var row = this.db.prepare('SELECT hash FROM file_hashes WHERE file_path = ?').get(filePath);
    return row ? row.hash : null;
  }

  setFileHash(filePath, hash, normalizedHash) {
    this.db.prepare('INSERT OR REPLACE INTO file_hashes (file_path, hash, last_indexed, normalized_hash) VALUES (?, ?, ?, ?)').run(filePath, hash, Date.now(), normalizedHash || null);
  }

  getNormalizedHash(filePath) {
    try {
      var row = this.db.prepare('SELECT normalized_hash FROM file_hashes WHERE file_path = ?').get(filePath);
      return row ? row.normalized_hash : null;
    } catch (e) { return null; }
  }

  getAllFileHashes() {
    var rows = this.db.prepare('SELECT file_path, hash FROM file_hashes').all();
    var map = new Map();
    for (var i = 0; i < rows.length; i++) map.set(rows[i].file_path, rows[i].hash);
    return map;
  }

  deleteStaleFiles(existingPaths) {
    var storedPaths = this.db.prepare('SELECT file_path FROM file_hashes').all().map(function(r) { return r.file_path; });
    var existing = new Set(existingPaths);
    var deleted = 0;
    for (var i = 0; i < storedPaths.length; i++) {
      if (!existing.has(storedPaths[i])) {
        this.deleteByFile(storedPaths[i]);
        this.db.prepare('DELETE FROM file_hashes WHERE file_path = ?').run(storedPaths[i]);
        deleted++;
      }
    }
    return deleted;
  }

  // ── Architecture overview ──

  getArchitectureOverview() {
    var entityCount = this.db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
    var edgeCount = this.db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
    if (entityCount === 0) return null;

    var topFiles = this.db.prepare(
      'SELECT file_path, COUNT(*) as cnt FROM entities GROUP BY file_path ORDER BY cnt DESC LIMIT 10'
    ).all();

    var typeDist = this.db.prepare(
      'SELECT type, COUNT(*) as cnt FROM entities GROUP BY type ORDER BY cnt DESC'
    ).all();

    var hubs = this.db.prepare(
      "SELECT e.name, e.type, e.file_path, COUNT(ed.id) as connections " +
      "FROM entities e LEFT JOIN edges ed ON ed.source_id = e.id OR ed.target_id = e.id " +
      "WHERE e.type != 'import' GROUP BY e.id ORDER BY connections DESC LIMIT 10"
    ).all();

    var parts = [];
    parts.push('## Project Architecture Overview');
    parts.push(entityCount + ' entities, ' + edgeCount + ' relationships');
    parts.push('');
    parts.push('Structure: ' + typeDist.map(function(t) { return t.cnt + ' ' + t.type + 's'; }).join(', '));
    parts.push('');
    parts.push('Core files:');
    for (var i = 0; i < topFiles.length; i++) {
      parts.push('  ' + topFiles[i].file_path + ' (' + topFiles[i].cnt + ' entities)');
    }
    if (hubs.length) {
      parts.push('');
      parts.push('Key entities:');
      for (var j = 0; j < Math.min(hubs.length, 7); j++) {
        parts.push('  ' + hubs[j].type + ' ' + hubs[j].name + ' (' + hubs[j].connections + ' connections) — ' + hubs[j].file_path);
      }
    }
    return parts.join('\n');
  }

  // ── Architecture Decision Records ──

  addDecision(summary, context) {
    this.db.prepare('INSERT INTO decisions (summary, context, created_at) VALUES (?, ?, ?)').run(summary, context || '', Date.now());
  }

  getDecisions(limit) {
    return this.db.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(limit || 20);
  }

  getDecisionsSummary() {
    var decisions = this.getDecisions(10);
    if (!decisions.length) {
      // ADR hint: prompt agent to record decisions when none exist yet
      return "## Architecture Decisions (no prior decisions logged)\n" +
        "When you make a non-obvious technical choice (database, framework, pattern), " +
        "state it explicitly in your response with the format: \"I chose X because Y\". " +
        "This will be auto-captured for future sessions.";
    }
    var parts = ['## Prior Architectural Decisions (from past sessions)'];
    for (var i = 0; i < decisions.length; i++) {
      parts.push('- ' + decisions[i].summary);
    }
    parts.push('Reference these when making consistent choices. Log new decisions explicitly.');
    return parts.join('\n');
  }

  getStats() {
    var entities = this.db.prepare('SELECT COUNT(*) as count FROM entities').get();
    var edges = this.db.prepare('SELECT COUNT(*) as count FROM edges').get();
    return { entities: entities.count, edges: edges.count };
  }

  clear() {
    this.db.exec('DELETE FROM edges; DELETE FROM entities; DELETE FROM code_index; DELETE FROM file_hashes;');
  }
}

module.exports = CodeStore;
