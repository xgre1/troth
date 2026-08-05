// SPDX-License-Identifier: AGPL-3.0-only
// Diff utilities — minimal patch generation between strings.
//
// Used for: presenting "what changed" summaries, audit logs, and as a
// helper for morph + validator when explaining edits.

// Compute a simple line-based diff: { added: [...], removed: [...], unchanged: count }
function lineDiff(before, after) {
  const beforeLines = (before || '').split('\n');
  const afterLines = (after || '').split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  const added = afterLines.filter(l => !beforeSet.has(l));
  const removed = beforeLines.filter(l => !afterSet.has(l));
  const unchanged = beforeLines.filter(l => afterSet.has(l)).length;

  return { added, removed, unchanged };
}

// Format a unified diff (basic 3-line context)
function unifiedDiff(before, after, fileName) {
  const beforeLines = (before || '').split('\n');
  const afterLines = (after || '').split('\n');
  if (before === after) return '';

  const out = [];
  if (fileName) {
    out.push('--- ' + fileName + ' (before)');
    out.push('+++ ' + fileName + ' (after)');
  }

  // Simple line-by-line diff (not LCS, but good enough for small edits)
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      // skip unchanged in compact mode
      continue;
    }
    if (b !== undefined) out.push('-' + b);
    if (a !== undefined) out.push('+' + a);
  }
  return out.join('\n');
}

// Estimate change magnitude (used by critic to decide review depth)
function changeMagnitude(before, after) {
  const d = lineDiff(before, after);
  return {
    addedLines: d.added.length,
    removedLines: d.removed.length,
    netChange: d.added.length - d.removed.length,
    changeRatio: d.unchanged > 0 ? (d.added.length + d.removed.length) / d.unchanged : 1,
  };
}

module.exports = { lineDiff, unifiedDiff, changeMagnitude };
