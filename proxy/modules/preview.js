// SPDX-License-Identifier: AGPL-3.0-only
// File preview — short, structured summaries of files for context injection.
//
// Used when a file is too big to include but the agent needs to know its
// shape. Returns: first line, line count, top symbols, last modified.

const fs = require('fs');
const path = require('path');

function previewFile(filePath, maxBytes) {
  maxBytes = maxBytes || 600;
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const firstNonEmpty = lines.find(l => l.trim()) || '';
    // Find top-level symbols heuristically
    const symbols = [];
    for (const line of lines) {
      const m = line.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|fn|interface|type)\s+(\w+)/);
      if (m) symbols.push(m[1]);
      if (symbols.length >= 10) break;
    }
    return {
      path: filePath,
      sizeBytes: stat.size,
      lines: lines.length,
      modifiedTs: stat.mtimeMs,
      firstLine: firstNonEmpty.slice(0, 120),
      topSymbols: symbols,
      ext: path.extname(filePath),
    };
  } catch (e) { return null; }
}

function formatPreviewBlock(filePath) {
  const p = previewFile(filePath);
  if (!p) return null;
  return '`' + path.basename(filePath) + '` — ' + p.lines + ' lines, ' +
    (p.topSymbols.length ? p.topSymbols.slice(0, 5).join(', ') : 'no top-level symbols');
}

module.exports = { previewFile, formatPreviewBlock };
