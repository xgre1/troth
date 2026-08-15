// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const CodeStore = require('./store');
const { listFiles, parseFile, looksMinified } = require('./parser');
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
// Bounds on a single index pass. The desktop app points the indexer at the
// operator's entire home directory, which has no natural end; on this machine
// that is 1816 files and 119 MB. A truncated index weakens a hint, an unbounded
// one holds the port shut, so it is bounded and says so (stats.truncated).
// Yield on ELAPSED TIME, not on a count. Counting files assumes every file
// costs the same, and they do not: one file can carry hundreds of entities and
// each is a synchronous SQLite insert, so 'every 64 files' was still a second
// of held loop between breaths. This keeps the longest uninterrupted stretch
// bounded no matter what the project looks like.
const YIELD_EVERY_MS = 40;
let _lastYield = 0;
function breathe() {
  const now = Date.now();
  if (now - _lastYield < YIELD_EVERY_MS) return null;
  _lastYield = now;
  return new Promise((r) => setImmediate(r));
}
// 2000 was one directory away from biting: the operator's home holds 1816
// indexable files. Past the cap the walk stops at the SAME first N every boot,
// so the tail is not indexed late — it is never indexed — and stale-file
// deletion is skipped for good. The wall clock is the real bound; the count is
// only a backstop against a pathological tree.
const MAX_INDEX_FILES = parseInt(process.env.TROTH_CODELENS_MAX_FILES || '25000', 10);
const MAX_INDEX_MS    = parseInt(process.env.TROTH_CODELENS_MAX_MS    || '10000', 10);
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

// Async on purpose. A pass that runs to completion in one tick blocks the
// event loop, and a blocked loop cannot answer the port even after listen()
// has returned — the dashboard was unreachable for as long as the walk took
// whether the call sat before listen() or after it. Work is done in chunks
// with a yield between them, so a request that arrives mid-index is answered
// (with an empty repo map) instead of queued behind the filesystem.
async function initIndex(dir) {
  // A directory that holds projects is not one. The proxy hands this the
  // "project dir", which inside a .app bundle is substituted with the
  // operator's home — right for where state is kept, wrong for which codebase
  // this is. Taken literally it walked an entire home directory, browser
  // profiles and backups included, into a 201 MB index.
  const projectId = require('../../../shared-core/project-id.js');
  if (!projectId.isIndexableRoot(dir)) {
    baseDir = null;
    store = null;
    console.log('[CodeLens] Not a project directory, not indexing: ' + dir);
    return { skipped: true, reason: 'not_a_project_root', dir: dir };
  }
  baseDir = dir;

  // Persistent DB: ~/.troth/codelens/<project key>.db — keyed by identity so
  // the store survives the project moving, and so the reader in code-graph.js
  // and the edit hook look under the same name. projectStorePath also adopts
  // an index left under an older key, which is the difference between an
  // operator's first run on a new version being an upgrade and being a reset.
  var dbPath = ':memory:';
  try {
    dbPath = projectId.projectStorePath(dir, 'codelens/{key}.db');
    var adopted = projectId.lastAdoption();
    if (adopted && adopted.to === dbPath) {
      console.log('[CodeLens] carried the existing index over: ' +
        path.basename(adopted.from) + ' -> ' + path.basename(adopted.to));
    }
  } catch (e) {}
  store = new CodeStore(dbPath);


  const startMs = Date.now();
  // ── Decide first, work second ──
  // This used to parse every file it walked and only THEN hash the results to
  // find out which ones needed parsing. Reading and hashing a 623-file tree
  // costs 13ms; reading and parsing it costs 7125ms, and that was spent on
  // every boot even when nothing had changed. Content is held only for the
  // files that turn out to need it, so the peak footprint follows the diff and
  // not the size of the operator's disk.
  const newFiles = [];
  const changedFiles = [];
  const currentPaths = [];
  let unchangedCount = 0;
  let cosmeticOnlyCount = 0;

  const storedHashes = store.getAllFileHashes();
  const listing = listFiles(dir, { maxFiles: MAX_INDEX_FILES, maxMs: MAX_INDEX_MS });
  const budgetUntil = MAX_INDEX_MS ? Date.now() + MAX_INDEX_MS : 0;
  let overBudget = false;

  for (let i = 0; i < listing.files.length; i++) {
    // Yield to the loop every chunk. 32 files is ~0.4ms of hashing, far below
    // anything a person perceives, and it keeps every request answerable.
    { const y = breathe(); if (y) await y; }
    if (budgetUntil && Date.now() > budgetUntil) { overBudget = true; break; }

    const filePath = listing.files[i];
    let content;
    // Async read on purpose. readFileSync on a home directory can land on an
    // iCloud or Dropbox placeholder, where the 'read' is a synchronous network
    // download — not a 300ms stall, a hung proxy.
    try { content = await fsp.readFile(filePath, 'utf8'); } catch (e) { continue; }
    if (content.length > 500000) continue;
    // Shape check, not just name: a bundle without a .min suffix costs the same
    // five seconds and indexes to the same mangled letters.
    if (looksMinified(content)) continue;

    currentPaths.push(filePath);
    const currentHash = hashFile(content);
    fileHashes.set(filePath, currentHash);
    const storedHash = storedHashes.get(filePath);

    if (!storedHash) { newFiles.push({ filePath, content }); continue; }
    if (storedHash === currentHash) { unchangedCount++; continue; }

    // Hash changed — but check whether it is only comments and whitespace.
    const normHash = hashFileNormalized(content);
    const storedNormHash = store.getNormalizedHash ? store.getNormalizedHash(filePath) : null;
    if (storedNormHash && storedNormHash === normHash) {
      store.setFileHash(filePath, currentHash, normHash);
      cosmeticOnlyCount++;
      unchangedCount++;
      continue;
    }
    store.deleteByFile(filePath);
    changedFiles.push({ filePath, content });
  }
  const walk = {
    truncated: listing.truncated || overBudget,
    reason: listing.reason || (overBudget ? 'time limit (' + MAX_INDEX_MS + 'ms)' : null),
  };

  stats.files = currentPaths.length;
  stats.truncated = walk.truncated ? walk.reason : null;
  const deleted = walk.truncated ? 0 : store.deleteStaleFiles(currentPaths);

  // Parse ONLY what the diff says is worth parsing — and yield while doing it.
  // Chunking the scan alone was not enough: on a cold boot every file is new,
  // so this list is the whole project and parsing it in one pass held the loop
  // for seven seconds. The port was open and accepting the whole time, which
  // is worse than being closed — the request is taken and then not answered.
  const filesToIndex = [];
  {
    const pending = newFiles.concat(changedFiles);
    for (let i = 0; i < pending.length; i++) {
      { const y = breathe(); if (y) await y; }
      const f = pending[i];
      let parsed;
      try { parsed = parseFile(f.filePath, f.content); }
      catch (e) { parsed = { entities: [], edges: [] }; }
      filesToIndex.push({ filePath: f.filePath, content: f.content, entities: parsed.entities, edges: parsed.edges });
    }
  }

  // Build set of all file paths for import resolution
  const allFilePaths = new Set(currentPaths);

  // Both passes below run over the CHANGED set, which is empty on a warm boot
  // and everything on a cold one. They yield for the same reason the scan does.
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
  // Same reason as the parse above: on a cold boot this is the whole project.
  for (let _i = 0; _i < filesToIndex.length; _i++) {
    { const y = breathe(); if (y) await y; }
    const file = filesToIndex[_i];
    const entityIds = [];
    for (const entity of file.entities) {
      const id = store.addEntity(entity.type, entity.name, file.filePath, entity.signature, entity.line, entity.docstring || '');
      fileNameToId.set(entity.name + ':' + file.filePath, id);
      if (!nameToId.has(entity.name)) nameToId.set(entity.name, id);
      entityIds.push(id);
    }
    fileToEntityIds.set(file.filePath, entityIds);
    // The hash is NOT written here. It is the record that says "this file is
    // fully indexed", and edges are added in the pass below — writing it now
    // meant that anything cutting in between (a budget, a crash, a restart)
    // left the file marked done with no edges, and the next run believed the
    // hash and never looked at it again. Silent, permanent, invisible.
  }

  // Pass 2: Resolve and add edges (only for new/changed files)
  let edgeCount = 0;
  // Same reason as the parse above: on a cold boot this is the whole project.
  for (let _i = 0; _i < filesToIndex.length; _i++) {
    { const y = breathe(); if (y) await y; }
    const file = filesToIndex[_i];
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

  // NOW the hashes. A file is marked indexed only once its entities AND its
  // edges are in, so a run that is cut short leaves those files looking
  // unindexed — which is true — and the next run redoes them. The alternative,
  // marking them done in the entity pass, made an interrupted run look
  // finished forever.
  for (let _h = 0; _h < filesToIndex.length; _h++) {
    { const y = breathe(); if (y) await y; }
    const f = filesToIndex[_h];
    store.setFileHash(f.filePath, fileHashes.get(f.filePath), hashFileNormalized(f.content));
  }

  const storeStats = store.getStats();
  stats.entities = storeStats.entities;
  stats.edges = storeStats.edges;
  indexed = true;

  // Say it when the walk stopped early. Truncation freezes coverage at the
  // same prefix every boot and skips stale-file deletion, so the index quietly
  // drifts from the disk it describes. Losing a hint is acceptable; losing it
  // without saying so is not.
  if (stats.truncated) {
    console.log('[CodeLens] Stopped early — ' + stats.truncated +
      '. Files past that point are not indexed and deletions are not pruned. ' +
      'Raise TROTH_CODELENS_MAX_MS or TROTH_CODELENS_MAX_FILES, or point the ' +
      'project directory at something smaller.');
  }

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
  // top of the CPU list. The guard is the whole fix; one registration and
  // one shared debounce timer behave exactly as intended.
  //
  // Watcher shape is per-platform. macOS/Windows recursive fs.watch is a
  // single OS handle (FSEvents / ReadDirectoryChangesW) whatever the tree
  // size. Linux emulates recursive with one inotify watch PER SUBDIRECTORY
  // — node_modules and dot-dirs included, since the filter above runs
  // after registration — and WATCH_DIR is the operator's whole home when
  // the desktop app spawns the proxy, so it exhausts
  // fs.inotify.max_user_watches (ENOSPC) before the filter ever helps.
  // Linux gets non-recursive watches on just the directories that hold
  // indexed files (directories born later re-index only on restart).
  // Watch errors surface asynchronously on the FSWatcher — the try/catch
  // never sees them, and unhandled they become uncaughtExceptions, one per
  // failed inotify add — so the first error closes every watcher and
  // auto re-index stops for the session.
  const SOURCE_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py']);
  if (!initIndex._watching) initIndex._watching = new Set();
  if (initIndex._watching.has(dir)) return;
  if (initIndex._watchDead) return;
  initIndex._watching.add(dir);
  const registered = [];
  const onEvent = (event, filename) => {
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
  };
  const onError = (err) => {
    if (initIndex._watchDead) return; // ENOSPC fires once per failed inotify add — log once
    initIndex._watchDead = true;
    console.error('[CodeLens] watcher failed (' + ((err && err.code) || err) + ') — auto re-index disabled');
    for (const w of registered) { try { w.close(); } catch (e) {} }
    registered.length = 0;
  };
  const watchOne = (d, opts) => {
    const w = fs.watch(d, opts, onEvent);
    w.on('error', onError);
    registered.push(w);
  };
  const MAX_WATCHED_DIRS = 1024;
  try {
    if (process.platform === 'linux') {
      const dirs = new Set([dir]);
      for (const p of currentPaths) dirs.add(path.dirname(p));
      for (const d of dirs) {
        if (registered.length >= MAX_WATCHED_DIRS) break;
        try { watchOne(d, {}); } catch (e) {}
      }
      if (registered.length < dirs.size) {
        console.warn('[CodeLens] watching ' + registered.length + '/' + dirs.size + ' dirs (cap ' + MAX_WATCHED_DIRS + ') — changes in the rest won\'t auto re-index');
      }
    } else {
      watchOne(dir, { recursive: true });
    }
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
