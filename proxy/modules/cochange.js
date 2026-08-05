// SPDX-License-Identifier: AGPL-3.0-only
// Co-change mining — files that change together in git history.
//
// Research [Predict]: 87% of commits touch multiple related units; 50% of
// co-changes precede architectural smells. Mining reveals semantic
// relationships that import graphs miss (e.g., README + config files).
//
// Used by injector to add "related files" hints when user mentions a file:
// "When you change auth.js, also consider auth.test.js, middleware/auth.js"

const { execFileSync } = require('child_process');
const { gitOk } = require('../../shared-core/git-ok.js');
const path = require('path');

const cache = new Map(); // filePath → [{ file, count }]
let lastIndexed = 0;
const REINDEX_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let projectDir = null;

function init(dir) {
  // Popup-free CLT gate (see shared-core/git-ok.js).
  if (!gitOk()) return;
  projectDir = dir;
  reindex();
}

function reindex() {
  if (!gitOk()) return;
  if (!projectDir) return;
  try {
    execFileSync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], { stdio: 'pipe', timeout: 1000 });
  } catch (e) { return; } // not a git repo

  try {
    // Get last 200 commits' file lists
    const log = execFileSync('git', ['-C', projectDir, 'log', '--name-only', '--pretty=format:---COMMIT---', '-200'],
      { stdio: 'pipe', timeout: 5000 }).toString();
    const commits = log.split('---COMMIT---').filter(c => c.trim());
    const newCache = new Map();

    for (const commit of commits) {
      const files = commit.split('\n').map(f => f.trim()).filter(f => f && !f.startsWith('---'));
      if (files.length < 2 || files.length > 50) continue; // skip mega-commits

      // For each pair, increment co-change count
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const a = files[i], b = files[j];
          if (!newCache.has(a)) newCache.set(a, new Map());
          if (!newCache.has(b)) newCache.set(b, new Map());
          newCache.get(a).set(b, (newCache.get(a).get(b) || 0) + 1);
          newCache.get(b).set(a, (newCache.get(b).get(a) || 0) + 1);
        }
      }
    }

    // Convert to sorted arrays per file
    cache.clear();
    for (const [file, partners] of newCache) {
      const sorted = Array.from(partners.entries())
        .filter(([, count]) => count >= 2)  // need 2+ co-changes to be meaningful
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file, count]) => ({ file, count }));
      if (sorted.length) cache.set(file, sorted);
    }
    lastIndexed = Date.now();
    console.log('[cochange] Indexed ' + cache.size + ' files with co-change relationships');
  } catch (e) {
    // git log failed — silent
  }
}

// Get top co-changing files for a given path (relative to project)
function getRelated(filePath) {
  if (!projectDir) return [];
  // Periodic reindex
  if (Date.now() - lastIndexed > REINDEX_INTERVAL_MS) reindex();
  // Try both absolute and relative paths
  const rel = path.relative(projectDir, filePath);
  return cache.get(rel) || cache.get(filePath) || [];
}

// Build hint block for injector — given recent files, list co-changing partners
function buildCoChangeHint(recentFiles) {
  if (!recentFiles || !recentFiles.length) return null;
  const seen = new Set();
  const hints = [];
  for (const fp of recentFiles.slice(0, 5)) {
    const related = getRelated(fp);
    for (const r of related) {
      if (seen.has(r.file)) continue;
      seen.add(r.file);
      hints.push('- ' + r.file + ' (changed together ' + r.count + 'x)');
      if (hints.length >= 8) break;
    }
    if (hints.length >= 8) break;
  }
  if (!hints.length) return null;
  return "## Co-Change Hints (files often modified with current files)\n" + hints.join('\n') +
    "\nConsider whether these need updates too.";
}

function getStats() {
  return { trackedFiles: cache.size, lastIndexed };
}

module.exports = { init, reindex, getRelated, buildCoChangeHint, getStats };
