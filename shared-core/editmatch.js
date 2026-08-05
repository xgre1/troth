// SPDX-License-Identifier: AGPL-3.0-only
// Fuzzy old_string → actual file content matcher.
//
// The #1 cause of wasted Edit turns (per plan research, Morph paper) is
// the model emitting an old_string that's CLOSE but not exact: trailing
// whitespace, a semicolon removed, inconsistent indentation. The built-in
// Edit tool rejects with "string not found" and we burn a full turn on
// re-read + re-edit. This module rescues those cases pre-flight: given
// the real file content + the proposed old_string, return the exact
// substring that lives in the file, or null if nothing close enough.
//
// Four strategies, cheapest → most expensive, short-circuit on first hit:
//   1. exact     — content.includes(old_string)
//   2. trim      — trim each line, match joined form, re-project
//   3. collapse  — collapse runs of whitespace in both sides, re-project
//   4. anchor    — pick the longest unique line in old_string, locate it
//                   in content, then expand by the same line count

function exactMatch(content, oldStr) {
  return content.includes(oldStr) ? { exact: oldStr, strategy: 'exact' } : null;
}

function trimMatch(content, oldStr) {
  const normOld = oldStr.split('\n').map(l => l.trim()).join('\n').trim();
  if (!normOld) return null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (let j = i; j < lines.length; j++) {
      const slice = lines.slice(i, j + 1).map(l => l.trim()).join('\n').trim();
      if (slice === normOld) {
        return {
          exact: lines.slice(i, j + 1).join('\n'),
          strategy: 'trim',
          line_start: i + 1,
          line_end: j + 1
        };
      }
      if (slice.length > normOld.length * 1.5) break; // pruning — we overshot
    }
  }
  return null;
}

function collapseMatch(content, oldStr) {
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  const normOld = collapse(oldStr);
  if (!normOld) return null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let joined = '';
    for (let j = i; j < lines.length; j++) {
      joined += (joined ? '\n' : '') + lines[j];
      if (collapse(joined) === normOld) {
        return {
          exact: joined,
          strategy: 'collapse',
          line_start: i + 1,
          line_end: j + 1
        };
      }
      if (collapse(joined).length > normOld.length * 1.5) break;
    }
  }
  return null;
}

function anchorMatch(content, oldStr) {
  const oldLines = oldStr.split('\n');
  if (oldLines.length < 2) return null;

  // Pick the longest non-whitespace line — most likely unique.
  const ranked = oldLines
    .map((l, idx) => ({ line: l.trim(), idx, len: l.trim().length }))
    .filter(x => x.len >= 10)
    .sort((a, b) => b.len - a.len);
  if (!ranked.length) return null;

  const contentLines = content.split('\n');
  for (const candidate of ranked.slice(0, 3)) {
    const matches = [];
    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].includes(candidate.line)) matches.push(i);
    }
    if (matches.length !== 1) continue; // not unique enough
    const anchor = matches[0];
    const startLine = anchor - candidate.idx;
    const endLine = startLine + oldLines.length - 1;
    if (startLine < 0 || endLine >= contentLines.length) continue;
    return {
      exact: contentLines.slice(startLine, endLine + 1).join('\n'),
      strategy: 'anchor',
      line_start: startLine + 1,
      line_end: endLine + 1,
      anchor_on: candidate.line
    };
  }
  return null;
}

// Public entrypoint. Returns null if no match found, otherwise:
//   { exact, strategy, line_start?, line_end?, anchor_on? }
function findMatch(content, oldStr) {
  if (typeof content !== 'string' || typeof oldStr !== 'string' || !oldStr) return null;
  return (
    exactMatch(content, oldStr) ||
    trimMatch(content, oldStr) ||
    collapseMatch(content, oldStr) ||
    anchorMatch(content, oldStr)
  );
}

module.exports = {
  findMatch,
  exactMatch,
  trimMatch,
  collapseMatch,
  anchorMatch
};
