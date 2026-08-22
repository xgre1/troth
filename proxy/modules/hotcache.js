// SPDX-License-Identifier: AGPL-3.0-only
// Hotcache — tracks file content hashes for cross-turn deduplication.
//
// Used by compressor.js to detect when a Read tool_result references a file
// that hasn't changed since the model already saw it earlier in the
// conversation. Those duplicate Read results can be elided to save tokens.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fileHashes = new Map();
let stats = { hits: 0, misses: 0, elided: 0 };
let watchers = [];
let watching = false;
let watchedDirs = new Set();
let recursiveMode = false;

const WATCH_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.json', '.css', '.html', '.md', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.sql', '.sh'];

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// The initial walk reads every matching file's CONTENT, so running it
// synchronously at proxy module scope leaves nothing listening until the walk
// ends — on a large home directory (the desktop app points WATCH_DIR there)
// that is minutes of dead dashboard inside fs::ReadDir. Same port-gating
// disease the CodeLens index already cured; same cure — the walk yields to the
// event loop every ~40ms, and the same caps: without them one directory of
// hundred-MB .json files blocks a whole slice and starves every request. Files
// over
// 512KB are skipped outright — CodeLens draws its own line at 500KB — and
// the walk stops at a total-bytes/files budget, announced when it bites.
// Everything skipped hashes fresh on first lookup; the cache loses a
// shortcut, never an answer.
const MAX_SCAN_FILE_BYTES  = 512 * 1024;
const MAX_SCAN_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_SCAN_FILES       = 20000;

function scanDirectoryAsync(dir, done) {
  const queue = [{ dir: dir, depth: 0 }];
  let files = 0, bytes = 0, capped = null;
  function step() {
    const deadline = Date.now() + 40;
    while (queue.length && !capped && Date.now() < deadline) {
      const item = queue.shift();
      if (item.depth > 4) continue;
      let entries = [];
      try { entries = fs.readdirSync(item.dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (capped) break;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(item.dir, entry.name);
        if (entry.isDirectory()) {
          queue.push({ dir: fullPath, depth: item.depth + 1 });
          continue;
        }
        if (!WATCH_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
        let st;
        try { st = fs.statSync(fullPath); } catch (_) { continue; }
        if (st.size > MAX_SCAN_FILE_BYTES) continue;
        if (files >= MAX_SCAN_FILES) { capped = MAX_SCAN_FILES + ' files'; break; }
        if (bytes + st.size > MAX_SCAN_TOTAL_BYTES) { capped = Math.round(MAX_SCAN_TOTAL_BYTES / 1048576) + 'MB'; break; }
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          fileHashes.set(fullPath, { hash: hashContent(content), size: content.length });
          files++; bytes += content.length;
        } catch (_) {}
      }
    }
    if (queue.length && !capped) { setImmediate(step); return; }
    if (capped) {
      console.log('[hotcache] scan stopped at ' + capped + ' — ' + files + ' files pre-hashed, the rest hash fresh on first lookup');
    }
    if (done) done();
  }
  setImmediate(step);
}

// Watcher lifecycle. macOS/Windows recursive fs.watch is a single OS
// handle (FSEvents / ReadDirectoryChangesW) regardless of tree size. On
// Linux it is emulated with one inotify watch PER SUBDIRECTORY —
// node_modules and dot-dirs included, since the event filter runs after
// registration — so a large tree (and WATCH_DIR is the whole home when
// the desktop app spawns us) exhausts fs.inotify.max_user_watches
// (ENOSPC). Linux therefore watches only the pruned directories the
// initial scan visited, non-recursively. Watcher errors arrive
// asynchronously on the FSWatcher (a try/catch around fs.watch never
// sees them; with no 'error' listener each becomes an uncaughtException),
// so the first error tears everything down and disables the cache:
// getFileHash then hashes fresh from disk on every call.
const MAX_WATCHED_DIRS = 1024;

function handleFileEvent(dir, filename) {
  if (!filename) return;
  const fullPath = path.join(dir, filename);
  const ext = path.extname(filename).toLowerCase();
  if (!WATCH_EXTENSIONS.includes(ext)) return;
  if (fullPath.includes('node_modules')) return;
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    fileHashes.set(fullPath, { hash: hashContent(content), size: content.length });
  } catch (_) {
    fileHashes.delete(fullPath);
  }
}

function onWatchError(err) {
  if (!watching) return; // ENOSPC fires once per failed inotify add — log once
  console.error('[hotcache] watcher failed (' + ((err && err.code) || err) + ') — hash cache disabled, hashing fresh from disk');
  stopWatching();
}

function stopWatching() {
  watching = false;
  for (const w of watchers) { try { w.close(); } catch (_) {} }
  watchers = [];
  watchedDirs.clear();
  fileHashes.clear();
}

function watchOne(dir, opts) {
  const w = fs.watch(dir, opts, (_, filename) => handleFileEvent(dir, filename));
  w.on('error', onWatchError);
  watchers.push(w);
}

function startWatching(dir) {
  try {
    if (process.platform === 'linux') {
      const dirs = new Set([dir]);
      for (const p of fileHashes.keys()) dirs.add(path.dirname(p));
      for (const d of dirs) {
        if (watchedDirs.size >= MAX_WATCHED_DIRS) break;
        try { watchOne(d, {}); watchedDirs.add(d); } catch (_) {}
      }
      if (watchedDirs.size < dirs.size) {
        console.warn('[hotcache] watching ' + watchedDirs.size + '/' + dirs.size + ' dirs (cap ' + MAX_WATCHED_DIRS + ') — files elsewhere hash fresh per lookup');
      }
      for (const p of Array.from(fileHashes.keys())) {
        if (!watchedDirs.has(path.dirname(p))) fileHashes.delete(p);
      }
    } else {
      watchOne(dir, { recursive: true });
      recursiveMode = true;
    }
    watching = watchers.length > 0;
  } catch (_) {
    stopWatching();
  }
}

// Public API: get current hash for a file path. Returns null if
// unreadable. Serves from the watch-backed cache only while the watcher
// is healthy AND the file's directory is actually watched; anything else
// is hashed fresh from disk so a dead watcher can never serve stale.
function getFileHash(filepath) {
  if (!filepath) return null;
  if (watching) {
    const cached = fileHashes.get(filepath);
    if (cached) return cached.hash;
  }
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const hash = hashContent(content);
    if (watching && (recursiveMode || watchedDirs.has(path.dirname(filepath)))) {
      fileHashes.set(filepath, { hash, size: content.length });
    }
    return hash;
  } catch (_) {
    return null;
  }
}

// Hash arbitrary content (used by compressor to fingerprint Read tool_results)
function hashString(s) {
  return hashContent(s);
}

function getStats() {
  return { ...stats, trackedFiles: fileHashes.size };
}

function init(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  // A whole home (or root) tree is not a project: pre-hashing it walks
  // cloud-backed mounts whose every readdir can block on network, for a
  // cache that fills itself lazily on first lookup anyway. Watch-only on
  // the recursive platforms; on Linux the per-directory watcher needs the
  // scanned list, so watching stays off there and every lookup reads
  // fresh — a shortcut lost, never an answer.
  const home = require('os').homedir();
  if (resolved === home || resolved === path.parse(resolved).root) {
    if (process.platform !== 'linux') startWatching(resolved);
    return;
  }
  if (process.platform === 'linux') {
    // Per-directory watches are derived from the scanned file list, so the
    // watcher can only start after the walk; changes landing mid-walk stay
    // invisible until then, and getFileHash's fresh-read fallback covers it.
    scanDirectoryAsync(dir, () => startWatching(dir));
  } else {
    // Recursive watch is a single OS handle with no list to derive — start
    // it BEFORE the walk so a file that changes mid-walk still fires an
    // event and can never be pinned at its pre-change hash.
    startWatching(dir);
    scanDirectoryAsync(dir, null);
  }
}

// Increment elided counter (called by compressor when it elides a Read result)
function recordElision() { stats.elided++; }

module.exports = { getFileHash, hashString, recordElision, getStats, init };
