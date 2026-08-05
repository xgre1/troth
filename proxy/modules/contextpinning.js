// SPDX-License-Identifier: AGPL-3.0-only
// Context pinning — keep critical files always in context regardless of
// query relevance. User-configured via .troth.json:
//   { "pinnedContext": ["src/types.ts", "src/auth.ts"] }
//
// These files are added to every CodeLens query result so the agent always
// sees them, even if BM25 doesn't surface them.

const fs = require('fs');
const path = require('path');

function loadPinnedFiles(projectDir) {
  if (!projectDir) return [];
  try {
    const cfgPath = path.join(projectDir, '.troth.json');
    if (!fs.existsSync(cfgPath)) return [];
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const pinned = cfg.pinnedContext || [];
    if (!Array.isArray(pinned)) return [];
    return pinned.map(p => path.isAbsolute(p) ? p : path.join(projectDir, p))
                 .filter(p => fs.existsSync(p));
  } catch (e) { return []; }
}

function buildPinnedContext(projectDir, maxBytes) {
  maxBytes = maxBytes || 4000;
  const files = loadPinnedFiles(projectDir);
  if (!files.length) return null;
  const parts = ['## Pinned Context (always-included files from .troth.json)'];
  let totalBytes = 0;
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const rel = path.relative(projectDir || process.cwd(), f);
      const slice = content.length > maxBytes ? content.slice(0, maxBytes) + '\n...[truncated]' : content;
      const block = '\n### ' + rel + '\n```\n' + slice + '\n```';
      if (totalBytes + block.length > maxBytes * 3) break;
      parts.push(block);
      totalBytes += block.length;
    } catch (e) {}
  }
  return parts.length > 1 ? parts.join('\n') : null;
}

function getStats(projectDir) {
  const files = loadPinnedFiles(projectDir);
  return { count: files.length, files: files.slice(0, 10) };
}

module.exports = { loadPinnedFiles, buildPinnedContext, getStats };
