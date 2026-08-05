// SPDX-License-Identifier: AGPL-3.0-only
// Predictive AST pre-fetching — warm CodeLens cache for likely-needed files.
//
// Research [Proxy][Local]: while LLM generates response, proxy asynchronously
// loads dependencies into local cache. Hides latency on the next turn.
//
// Strategy:
//   1. After each response with tool_use, identify file dependencies of
//      touched files (via co-change + import edges from CodeLens)
//   2. Async pre-warm those files' content in node fs cache + CodeLens query
//   3. Next turn that asks about them = instant
//
// This is fire-and-forget. Failures are silent.

const fs = require('fs');
const path = require('path');

let stats = { prefetched: 0, errors: 0 };

function prefetchFile(filePath) {
  // Just touch the file — Node's fs has its own cache via readFileSync
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 1024) return; // skip files > 1MB
    fs.readFileSync(filePath, 'utf8'); // warm OS page cache + Node fs cache
    stats.prefetched++;
  } catch (e) { stats.errors++; }
}

// Called after a response is processed. Looks at recent file touches and
// pre-fetches their co-change partners + import dependencies.
function predictAndPrefetch() {
  try {
    const codelens = require('./codelens');
    const cochange = require('./cochange');
    const recentFiles = codelens.getRecentFiles ? codelens.getRecentFiles() : [];
    if (!recentFiles.length) return;

    const toPrefetch = new Set();
    // Co-change partners
    for (const fp of recentFiles.slice(0, 3)) {
      const related = cochange.getRelated(fp);
      for (const r of related.slice(0, 3)) toPrefetch.add(r.file);
    }

    // Import dependencies via CodeLens store
    if (codelens._store) {
      try {
        for (const fp of recentFiles.slice(0, 3)) {
          const entities = codelens._store.getFileEntities(fp);
          for (const e of entities.slice(0, 5)) {
            // For each entity in the file, find files that reference it
            const edges = codelens._store.getEdges(e.id);
            for (const edge of edges.slice(0, 3)) {
              // Get the target entity's file
              const targetEntity = codelens._store.getEntity ? codelens._store.getEntity(edge.target_id) : null;
              if (targetEntity && targetEntity.file_path) {
                toPrefetch.add(targetEntity.file_path);
              }
            }
          }
        }
      } catch (e) {}
    }

    // Async fire — don't block
    setImmediate(function() {
      for (const fp of toPrefetch) {
        // Prefetch absolute paths only
        if (path.isAbsolute(fp)) prefetchFile(fp);
      }
    });
  } catch (e) {}
}

function getStats() { return stats; }

module.exports = { predictAndPrefetch, prefetchFile, getStats };
