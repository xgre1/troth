// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CodeStore = require('./store');
const { scanDirectory } = require('./parser');
const { personalizedPageRank } = require('./ranker');
const { buildRepoMap } = require('./mapper');

let store = null;
let baseDir = null;
let fileHashes = new Map();
let indexed = false;

// Track recently touched files for predictive context loading.
// When the agent edits file A, boost A's dependencies in the next query.
const recentFiles = [];
const MAX_RECENT = 10;
let stats = { files: 0, entities: 0, edges: 0, queries: 0, avgQueryMs: 0 };

function hashFile(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// AST-diff approximation: hash content with comments + whitespace normalized.
// If two files differ only in comments/whitespace, this hash will match,
// allowing the indexer to skip re-parsing entirely.
function hashFileNormalized(content) {
  // Strip line comments, block comments, multiple whitespace
  const normalized = content
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments /* ... */
    .replace(/\/\/[^\n]*/g, '')             // line comments
    .replace(/#[^\n]*/g, '')                 // shell/python comments
    .replace(/\s+/g, ' ')                    // collapse all whitespace
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// Simple keyword extraction — no deps
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','have','has','had','do','does',
  'did','will','would','could','should','may','might','can','need','to','of','in',
  'for','on','with','at','by','from','as','into','through','during','before','after',
  'between','out','off','over','under','again','then','here','there','when','where',
  'why','how','all','each','more','most','other','some','no','not','only','own','so',
  'than','too','very','just','now','and','but','or','if','this','that','these','those',
  'it','its','i','me','my','we','our','you','your','he','him','his','she','her','they',
  'them','their','what','which','who','make','like','use','file','code','want','please',
  'help','create','build','write','add','fix','update','get','set','let','const','var',
]);

function extractKeywords(text) {
  return text.toLowerCase().split(/[^a-zA-Z0-9_]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 10);
}

function extractPrompt(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    const msgs = data.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        const content = msgs[i].content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join(' ');
      }
    }
  } catch (e) {}
  return '';
}

// Resolve relative import path to absolute file path
function resolveImportPath(importSource, fromFilePath, allFilePaths) {
  if (!importSource.startsWith('.')) return null; // Skip node_modules imports

  const fromDir = path.dirname(fromFilePath);
  let resolved = path.resolve(fromDir, importSource);

  // Try with common extensions
  const extensions = ['', '.js', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (allFilePaths.has(candidate)) return candidate;
  }
  return null;
}

function initIndex(dir) {
  baseDir = dir;

  // Persistent DB: ~/.troth/codelens/<hash>.db
  var dbPath = ':memory:';
  try {
    var HOME = process.env.HOME || require('os').homedir();
    var dirHash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12);
    var dbDir = path.join(HOME, '.troth', 'codelens');
    dbPath = path.join(dbDir, dirHash + '.db');
  } catch (e) {}
  store = new CodeStore(dbPath);

  const startMs = Date.now();
  const files = scanDirectory(dir);
  stats.files = files.length;

  // ── Incremental update ──
  // Compare file hashes against stored DB to find new/changed/deleted files
  const storedHashes = store.getAllFileHashes();
  const currentPaths = files.map(f => f.filePath);
  const deleted = store.deleteStaleFiles(currentPaths);

  var newFiles = [];
  var changedFiles = [];
  var unchangedCount = 0;

  var cosmeticOnlyCount = 0;
  for (const file of files) {
    const currentHash = hashFile(file.content);
    fileHashes.set(file.filePath, currentHash);
    const storedHash = storedHashes.get(file.filePath);

    if (!storedHash) {
      newFiles.push(file);
    } else if (storedHash !== currentHash) {
      // Hash changed — but check if it's only cosmetic (comments/whitespace)
      const normHash = hashFileNormalized(file.content);
      const storedNormHash = store.getNormalizedHash ? store.getNormalizedHash(file.filePath) : null;
      if (storedNormHash && storedNormHash === normHash) {
        // Cosmetic change only — update stored raw hash, skip re-index
        store.setFileHash(file.filePath, currentHash, normHash);
        cosmeticOnlyCount++;
        unchangedCount++;
      } else {
        store.deleteByFile(file.filePath);
        changedFiles.push(file);
      }
    } else {
      unchangedCount++;
    }
  }

  var filesToIndex = newFiles.concat(changedFiles);

  // Build set of all file paths for import resolution
  const allFilePaths = new Set(files.map(f => f.filePath));

  // Pass 1: Add entities for new/changed files, build name→ID maps
  const nameToId = new Map();
  const fileNameToId = new Map();
  const fileToEntityIds = new Map();

  // First, load existing entity names from unchanged files (for edge resolution)
  if (unchangedCount > 0) {
    try {
      var existingEntities = store.db.prepare('SELECT id, name, file_path FROM entities').all();
      for (var ei = 0; ei < existingEntities.length; ei++) {
        var ee = existingEntities[ei];
        fileNameToId.set(ee.name + ':' + ee.file_path, ee.id);
        if (!nameToId.has(ee.name)) nameToId.set(ee.name, ee.id);
        var feIds = fileToEntityIds.get(ee.file_path) || [];
        feIds.push(ee.id);
        fileToEntityIds.set(ee.file_path, feIds);
      }
    } catch (e) {}
  }

  // Add entities for files that need indexing
  for (const file of filesToIndex) {
    const entityIds = [];
    for (const entity of file.entities) {
      const id = store.addEntity(entity.type, entity.name, file.filePath, entity.signature, entity.line, entity.docstring || '');
      fileNameToId.set(entity.name + ':' + file.filePath, id);
      if (!nameToId.has(entity.name)) nameToId.set(entity.name, id);
      entityIds.push(id);
    }
    fileToEntityIds.set(file.filePath, entityIds);
    store.setFileHash(file.filePath, fileHashes.get(file.filePath), hashFileNormalized(file.content));
  }

  // Pass 2: Resolve and add edges (only for new/changed files)
  let edgeCount = 0;
  for (const file of filesToIndex) {
    for (const edge of file.edges) {
      let fromId, toId;

      // Resolve 'from'
      if (edge.from === '__FILE__') {
        // File-level edge — use first entity in this file
        const fileEntities = fileToEntityIds.get(file.filePath);
        fromId = fileEntities && fileEntities.length > 0 ? fileEntities[0] : null;
      } else {
        fromId = fileNameToId.get(edge.from + ':' + file.filePath) || nameToId.get(edge.from);
      }

      // Resolve 'to'
      if (edge.relation === 'imports') {
        // Import edge: resolve path, then find entity in target file
        const targetPath = resolveImportPath(edge.to, file.filePath, allFilePaths);
        if (targetPath) {
          const targetEntities = fileToEntityIds.get(targetPath);
          if (targetEntities && targetEntities.length > 0) {
            // Link to each imported name if specified
            if (edge.importedNames) {
              for (const name of edge.importedNames) {
                const targetId = fileNameToId.get(name + ':' + targetPath) || nameToId.get(name);
                if (fromId && targetId && fromId !== targetId) {
                  store.addEdge(fromId, targetId, 'imports');
                  edgeCount++;
                }
              }
            } else {
              toId = targetEntities[0];
            }
          }
        }
      } else if (edge.relation === 'calls') {
        // Call edge: find by name globally
        toId = nameToId.get(edge.to);
      } else if (edge.relation === 'extends') {
        toId = nameToId.get(edge.to);
      }

      if (fromId && toId && fromId !== toId) {
        store.addEdge(fromId, toId, edge.relation);
        edgeCount++;
      }
    }
  }

  const storeStats = store.getStats();
  stats.entities = storeStats.entities;
  stats.edges = storeStats.edges;
  indexed = true;

  const elapsed = Date.now() - startMs;
  if (filesToIndex.length > 0 || deleted > 0) {
    var cosmeticTag = cosmeticOnlyCount > 0 ? ` (${cosmeticOnlyCount} cosmetic-only)` : '';
    console.log(`[CodeLens] Indexed ${newFiles.length} new, ${changedFiles.length} changed, ${deleted} deleted, ${unchangedCount} unchanged${cosmeticTag} — ${stats.entities} entities, ${stats.edges} edges in ${elapsed}ms`);
  } else {
    console.log(`[CodeLens] ${unchangedCount} files unchanged, ${stats.entities} entities (${elapsed}ms — persistent cache hit)`);
  }

  // Watch for changes. Debounced at 15 seconds (up from 2) so bursts of
  // file writes during tool-heavy agent loops don't trigger a re-index
  // storm. Filters the watched events down to source files only —
  // node_modules, dotfiles, and anything whose extension is not in the
  // CodeLens SUPPORTED_EXTS set (see parser.js) are skipped. Previously
  // every .log / .json / .md / .db write would also fire a debounce
  // reset, which kept the router busy on CPU during heavy sessions.
  //
  // REGISTERED ONCE PER DIRECTORY. The debounce calls initIndex again, and
  // initIndex used to end here, so every re-index added ANOTHER recursive
  // watcher on the same tree. After an afternoon the proxy held hundreds of
  // them, one file write woke all of them, and the machine re-indexed on a
  // loop: 208 runs, every one reporting "81 files unchanged" after ~5s of
  // hashing, which is a laptop that never idles: fans audible, proxy at the
  // top of the CPU list. The guard is the whole fix;
  // one watcher and one shared debounce timer behave exactly as intended.
  const SOURCE_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py']);
  if (!initIndex._watching) initIndex._watching = new Set();
  if (initIndex._watching.has(dir)) return;
  try {
    fs.watch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules')) return;
      if (filename.startsWith('.')) return;
      const ext = path.extname(filename).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) return;
      clearTimeout(initIndex._timer);
      initIndex._timer = setTimeout(() => {
        console.log('[CodeLens] Incremental re-index...');
        initIndex(dir);
      }, 15000);
    });
    initIndex._watching.add(dir);
  } catch (e) {}
}

function queryContext(bodyStr) {
  if (!indexed || !store) return '';

  const startMs = Date.now();
  const prompt = extractPrompt(bodyStr);
  if (!prompt) return '';

  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return '';

  const searchQuery = keywords.join(' OR ');
  const seeds = store.search(searchQuery);
  if (seeds.length === 0) return '';

  const seedIds = seeds.map(s => s.rowid);

  // Predictive context: boost recently touched files
  // When the agent edited file A, its dependencies should be in context
  if (recentFiles.length > 0 && store) {
    for (var ri = 0; ri < Math.min(recentFiles.length, 5); ri++) {
      var recentEntities = store.getFileEntities(recentFiles[ri]);
      for (var re = 0; re < recentEntities.length; re++) {
        if (seedIds.indexOf(recentEntities[re].id) === -1) {
          seedIds.push(recentEntities[re].id);
        }
      }
    }
  }

  const expanded = store.traverse(seedIds, 2);

  const allEdges = [];
  for (const entity of expanded) {
    const edges = store.getEdges(entity.id);
    allEdges.push(...edges.map(e => ({ source_id: e.source_id, target_id: e.target_id })));
  }

  const ranked = personalizedPageRank(expanded, allEdges, seedIds);
  // Pass HOT files (recently touched) + store reference so mapper can tier
  // as HOT/WARM/COLD AND inline caller/callee info for HOT functions.
  const { map, tokens, hotFiles, warmFiles } = buildRepoMap(ranked, baseDir, recentFiles, store);

  const elapsed = Date.now() - startMs;
  stats.queries++;
  stats.avgQueryMs = Math.round((stats.avgQueryMs * (stats.queries - 1) + elapsed) / stats.queries);

  if (map && map.length > 30) {
    console.log(`[CodeLens] Query: "${keywords.slice(0,5).join(', ')}" → ${seeds.length} seeds, HOT:${hotFiles||0} WARM:${warmFiles||0}, ${tokens} tokens in ${elapsed}ms`);
  }

  return map;
}

function getStats() { return { ...stats, indexed }; }

// Record that a file was recently touched (Read/Write/Edit).
// Called by the critic/hotcache when tool calls are detected.
function recordFileTouched(filePath) {
  if (!filePath) return;
  // Remove if already in list, add to front
  var idx = recentFiles.indexOf(filePath);
  if (idx >= 0) recentFiles.splice(idx, 1);
  recentFiles.unshift(filePath);
  if (recentFiles.length > MAX_RECENT) recentFiles.pop();
}

function getArchitectureOverview() {
  if (!store) return null;
  return store.getArchitectureOverview();
}

function getRecentFiles() { return recentFiles.slice(); }

module.exports = { initIndex, queryContext, getArchitectureOverview, recordFileTouched, getRecentFiles, getStats, extractKeywords, get _store() { return store; } };
