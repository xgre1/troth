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

const WATCH_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.json', '.css', '.html', '.md', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.sql', '.sh'];

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function scanDirectory(dir, depth = 0) {
  if (depth > 4) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath, depth + 1);
      } else if (WATCH_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          fileHashes.set(fullPath, { hash: hashContent(content), size: content.length });
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function startWatching(dir) {
  try {
    fs.watch(dir, { recursive: true }, (_, filename) => {
      if (!filename) return;
      const fullPath = path.join(dir, filename);
      const ext = path.extname(filename).toLowerCase();
      if (!WATCH_EXTENSIONS.includes(ext)) return;
      if (filename.includes('node_modules')) return;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        fileHashes.set(fullPath, { hash: hashContent(content), size: content.length });
      } catch (_) {
        fileHashes.delete(fullPath);
      }
    });
  } catch (_) {}
}

// Public API: get current hash for a file path. Returns null if not tracked
// or unreadable. Hashes the file fresh if not in cache (for files outside
// the initially-scanned tree).
function getFileHash(filepath) {
  if (!filepath) return null;
  const cached = fileHashes.get(filepath);
  if (cached) return cached.hash;
  // Not in cache — try to read it now
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const hash = hashContent(content);
    fileHashes.set(filepath, { hash, size: content.length });
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
  if (dir) {
    scanDirectory(dir);
    startWatching(dir);
  }
}

// Increment elided counter (called by compressor when it elides a Read result)
function recordElision() { stats.elided++; }

module.exports = { getFileHash, hashString, recordElision, getStats, init };
