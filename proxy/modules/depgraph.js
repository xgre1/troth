// SPDX-License-Identifier: AGPL-3.0-only
// Dependency graph — extract project's actual import/require relationships.
//
// Different from CodeLens edges (which are CALL relationships): this is
// FILE-level imports. Used for: identifying entry points, finding orphans,
// detecting circular imports.

const fs = require('fs');
const path = require('path');

const IMPORT_PATTERNS = {
  '.js': [/require\(['"]([^'"]+)['"]\)/g, /import\s+.*?from\s+['"]([^'"]+)['"]/g, /import\s+['"]([^'"]+)['"]/g],
  '.ts': [/require\(['"]([^'"]+)['"]\)/g, /import\s+.*?from\s+['"]([^'"]+)['"]/g, /import\s+['"]([^'"]+)['"]/g],
  '.tsx': [/require\(['"]([^'"]+)['"]\)/g, /import\s+.*?from\s+['"]([^'"]+)['"]/g, /import\s+['"]([^'"]+)['"]/g],
  '.jsx': [/require\(['"]([^'"]+)['"]\)/g, /import\s+.*?from\s+['"]([^'"]+)['"]/g, /import\s+['"]([^'"]+)['"]/g],
  '.py': [/^\s*from\s+(\S+)\s+import/gm, /^\s*import\s+(\S+)/gm],
  '.go': [/^\s*import\s+"([^"]+)"/gm, /^\s*"([^"]+)"\s*$/gm],
  '.rs': [/use\s+([\w:]+)/g],
};

function extractImports(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const patterns = IMPORT_PATTERNS[ext];
  if (!patterns) return [];
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { return []; }
  const imports = new Set();
  for (const p of patterns) {
    let m;
    while ((m = p.exec(content)) !== null) {
      // A zero-length match never advances lastIndex on its own; without this
      // the loop spins forever and the process pins a core, deaf to SIGTERM.
      if (m.index === p.lastIndex) p.lastIndex++;
      imports.add(m[1]);
    }
  }
  return Array.from(imports);
}

// Build full graph for a directory (file -> [imports])
function buildGraph(dir, maxFiles) {
  maxFiles = maxFiles || 500;
  const graph = {};
  const visited = new Set();

  function walk(d, depth) {
    if (depth > 5 || visited.size >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (IMPORT_PATTERNS[path.extname(entry.name).toLowerCase()]) {
        if (visited.size >= maxFiles) return;
        visited.add(full);
        const imps = extractImports(full);
        if (imps.length) graph[path.relative(dir, full)] = imps;
      }
    }
  }
  walk(dir, 0);
  return graph;
}

// Find files no one imports (orphans) — candidate dead code
function findOrphans(graph) {
  const allFiles = new Set(Object.keys(graph));
  const importedFiles = new Set();
  for (const imports of Object.values(graph)) {
    for (const imp of imports) {
      // Try to match imports back to files (rough heuristic)
      for (const f of allFiles) {
        const stem = path.basename(f, path.extname(f));
        if (imp.endsWith(stem) || imp.endsWith(f)) importedFiles.add(f);
      }
    }
  }
  return Array.from(allFiles).filter(f => !importedFiles.has(f));
}

module.exports = { extractImports, buildGraph, findOrphans };
