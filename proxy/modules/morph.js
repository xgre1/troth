// SPDX-License-Identifier: AGPL-3.0-only
// Morph Fast Apply — deterministic search-and-replace engine.
//
// Research [Plan]: 10K tok/s, 98% apply accuracy. 60% of human interventions
// caused by failed apply, not bad reasoning. Idea: LLM emits intent (which
// region to change + new content), apply layer parses and writes WITHOUT
// asking LLM to handle exact char-level matching.
//
// Our implementation: helper that takes (filePath, hint, newContent) and
// applies via robust matching. Used as a recovery path when validator's
// fuzzy match fails. The agent calls Edit normally; if old_string mismatches,
// validator triggers fuzzy match (4 strategies); if THAT fails, we offer
// morphApply as last resort.

const fs = require('fs');
const path = require('path');

let stats = { applied: 0, failed: 0, savedLines: 0 };

// Apply an "intent-based" edit:
//   - filePath: target file (must exist)
//   - region: { startLine?, endLine?, anchor?, function?, class? } locator
//   - newContent: replacement text
// Returns: { ok, newFileContent, applied } or { ok: false, error }
function morphApply(filePath, region, newContent) {
  if (!filePath || typeof newContent !== 'string') {
    stats.failed++;
    return { ok: false, error: 'morphApply requires filePath and newContent' };
  }
  if (!fs.existsSync(filePath)) {
    stats.failed++;
    return { ok: false, error: 'file does not exist: ' + filePath };
  }
  let original;
  try { original = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { stats.failed++; return { ok: false, error: 'cannot read: ' + e.message }; }

  const lines = original.split('\n');

  // Strategy 1: explicit line range
  if (typeof region.startLine === 'number' && typeof region.endLine === 'number') {
    const sl = Math.max(0, region.startLine - 1);
    const el = Math.min(lines.length, region.endLine);
    if (sl >= el) { stats.failed++; return { ok: false, error: 'invalid line range' }; }
    const before = lines.slice(0, sl);
    const after = lines.slice(el);
    const newLines = newContent.split('\n');
    const replaced = before.concat(newLines).concat(after).join('\n');
    stats.applied++;
    stats.savedLines += (el - sl);
    return { ok: true, newFileContent: replaced, applied: { startLine: sl + 1, endLine: el, replacedLines: el - sl } };
  }

  // Strategy 2: anchor text (find first occurrence, replace surrounding block)
  if (region.anchor && typeof region.anchor === 'string') {
    const anchorIdx = original.indexOf(region.anchor);
    if (anchorIdx < 0) { stats.failed++; return { ok: false, error: 'anchor not found: ' + region.anchor.slice(0, 60) }; }
    const linesBeforeAnchor = original.slice(0, anchorIdx).split('\n').length - 1;
    const anchorLines = region.anchor.split('\n').length;
    const before = lines.slice(0, linesBeforeAnchor);
    const after = lines.slice(linesBeforeAnchor + anchorLines);
    const newLines = newContent.split('\n');
    const replaced = before.concat(newLines).concat(after).join('\n');
    stats.applied++;
    stats.savedLines += anchorLines;
    return { ok: true, newFileContent: replaced, applied: { anchorLine: linesBeforeAnchor + 1, anchorLines: anchorLines } };
  }

  // Strategy 3: function/class identifier (find by name, replace its block)
  if (region.function || region.class) {
    const ident = region.function || region.class;
    const declRegex = new RegExp('(?:function|class|const|let|var|def|fn)\\s+' + ident + '\\b');
    const declIdx = lines.findIndex(l => declRegex.test(l));
    if (declIdx < 0) { stats.failed++; return { ok: false, error: 'function/class not found: ' + ident }; }
    // Find end of block by tracking braces (heuristic; works for most C-family + Python via dedent)
    let endIdx = declIdx;
    let braceDepth = 0;
    let started = false;
    for (let i = declIdx; i < lines.length; i++) {
      const l = lines[i];
      for (const ch of l) {
        if (ch === '{') { braceDepth++; started = true; }
        else if (ch === '}') { braceDepth--; if (started && braceDepth === 0) { endIdx = i; break; } }
      }
      if (started && braceDepth === 0) { endIdx = i; break; }
      // Python: detect dedent below decl
      if (region.function && i > declIdx && /^\S/.test(l) && l.trim().length) { endIdx = i - 1; break; }
    }
    if (endIdx === declIdx && !started) { stats.failed++; return { ok: false, error: 'could not detect block end for ' + ident }; }
    const before = lines.slice(0, declIdx);
    const after = lines.slice(endIdx + 1);
    const newLines = newContent.split('\n');
    const replaced = before.concat(newLines).concat(after).join('\n');
    stats.applied++;
    stats.savedLines += (endIdx - declIdx + 1);
    return { ok: true, newFileContent: replaced, applied: { function: ident, fromLine: declIdx + 1, toLine: endIdx + 1 } };
  }

  stats.failed++;
  return { ok: false, error: 'no region specified (need startLine+endLine, anchor, or function/class)' };
}

function getStats() { return stats; }

module.exports = { morphApply, getStats };
