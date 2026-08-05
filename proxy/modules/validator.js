// SPDX-License-Identifier: AGPL-3.0-only
// Edit-tool pre-flight validator (v5.10).
//
// When Gemini emits a `Write` or `Edit` tool call, the proxy intercepts
// it BEFORE returning the response to Claude Code, validates it against
// the actual filesystem and against tree-sitter's grammar, and either
// lets it through or signals to the upstream caller that the tool call
// is broken so a retry can be issued.
//
// Importantly, this module never mutates the assistant message. The
// "fake messages" anti-pattern from the old verifier.js / guardian.js
// (appending "SYNTAX ERRORS:" or "GUARDIAN WARNING" text into the
// model's response content array) corrupted what Claude Code displayed
// and broke the fiction that the assistant said what was being shown.
// v5.10 instead returns a structured validation result, and the
// router uses that result to issue a fresh upstream request with the
// failure surfaced as a synthesized tool_result — exactly the same
// shape Gemini would normally see if Claude Code had executed the
// tool and gotten an error back.
//
// Why this is the highest-leverage intervention in the roadmap:
// per Aider's published benchmarks, the same model on the same prompt
// scores 20% with naive SEARCH/REPLACE and 61% with tolerant diff
// matching — a 3x lift purely from how the edit tool handles
// imperfect model output. Per Particula's meta-analysis, error
// recovery and rollback in the edit pipeline is worth +5–15 points on
// SWE-bench. Per the Grok Code Fast result, edit-tool format alone
// took the SAME model from 6.7% to 68.3% (10x). The literature is
// unanimous that this category dominates everything else.
//
// What this module validates today (v5.10 first cut):
//   - Write: file_path absolute, parent dir exists, content parses
//     cleanly with tree-sitter (for supported languages).
//   - Edit: file_path exists and is readable, old_string is present
//     in the file, old_string is unique when replace_all is false.
//
// What this module deliberately does NOT validate today:
//   - Import resolution (would need a per-language resolver)
//   - Cross-file impact (out of scope for proxy-layer validation)
//   - Type checking (would need tsc/mypy/etc, too slow synchronously)
//   - Tree-sitter parse of the post-edit file content (we only check
//     the new_string in isolation, not stitched into the file context;
//     this is a v5.10.1 follow-up if false-positives become a problem)
//
// Closest-match suggestions for failed Edit old_string lookups are
// also a v5.10.1 follow-up (Aider's tolerant matching strategy).
// First cut: report exact-match failure with line numbers.

const fs = require('fs');
const path = require('path');
const { validateSyntax } = require('./codelens/parser');

const TOOLS_THAT_NEED_VALIDATION = new Set(['Write', 'write', 'Edit', 'edit']);

// ── Fuzzy edit matching ──
// When exact old_string match fails, try progressively looser strategies.
// Based on Cursor's cascading match approach.

function normalizeWhitespace(str) {
  return str.replace(/[ \t]+$/gm, '').replace(/\r\n/g, '\n');
}

function normalizeIndentation(str) {
  return str.split('\n').map(function(line) { return line.trimStart(); }).join('\n');
}

function fuzzyMatchOldString(fileContent, oldString) {
  // Strategy 1: Normalize trailing whitespace + line endings
  var normFile = normalizeWhitespace(fileContent);
  var normOld = normalizeWhitespace(oldString);
  if (normFile.includes(normOld)) {
    // Find the actual text in the original file
    var normIdx = normFile.indexOf(normOld);
    // Map back to original: count chars up to normIdx in original
    var fileLines = fileContent.split('\n');
    var normLines = normFile.split('\n');
    var oldLines = normOld.split('\n');

    // Find the starting line number
    var startLine = -1;
    var normFileLines = normFile.split('\n');
    for (var i = 0; i <= normFileLines.length - oldLines.length; i++) {
      var match = true;
      for (var j = 0; j < oldLines.length; j++) {
        if (normFileLines[i + j] !== oldLines[j]) { match = false; break; }
      }
      if (match) { startLine = i; break; }
    }

    if (startLine >= 0) {
      return fileLines.slice(startLine, startLine + oldLines.length).join('\n');
    }
  }

  // Strategy 2: Ignore leading whitespace entirely (indentation-insensitive)
  var indentFile = normalizeIndentation(fileContent);
  var indentOld = normalizeIndentation(oldString);
  if (indentFile.includes(indentOld)) {
    var indentFileLines = indentFile.split('\n');
    var indentOldLines = indentOld.split('\n');
    var origLines = fileContent.split('\n');

    for (var si = 0; si <= indentFileLines.length - indentOldLines.length; si++) {
      var isMatch = true;
      for (var sj = 0; sj < indentOldLines.length; sj++) {
        if (indentFileLines[si + sj] !== indentOldLines[sj]) { isMatch = false; break; }
      }
      if (isMatch) {
        return origLines.slice(si, si + indentOldLines.length).join('\n');
      }
    }
  }

  // Strategy 3: Token-level fuzzy match (handles minor textual drift)
  // Tokenize both strings into words+punctuation, then sliding-window match
  // allowing up to 10% mismatched tokens.
  var fileTokens = fileContent.match(/\S+|\n/g) || [];
  var oldTokens = oldString.match(/\S+|\n/g) || [];
  if (oldTokens.length >= 4 && oldTokens.length <= 200) {
    var maxMismatch = Math.max(1, Math.floor(oldTokens.length * 0.10));
    for (var fi = 0; fi <= fileTokens.length - oldTokens.length; fi++) {
      var mismatches = 0;
      for (var fj = 0; fj < oldTokens.length; fj++) {
        if (fileTokens[fi + fj] !== oldTokens[fj]) {
          mismatches++;
          if (mismatches > maxMismatch) break;
        }
      }
      if (mismatches <= maxMismatch) {
        // Found approximate match — return the corresponding chars from original
        var matched = fileTokens.slice(fi, fi + oldTokens.length).join(' ');
        // Search for this in the original to get the actual span
        var idx = fileContent.indexOf(fileTokens[fi]);
        if (idx >= 0) {
          // Find end of last token
          var lastToken = fileTokens[fi + oldTokens.length - 1];
          var lastIdx = fileContent.indexOf(lastToken, idx + 1);
          if (lastIdx > idx) {
            return fileContent.slice(idx, lastIdx + lastToken.length);
          }
        }
        return matched;
      }
    }
  }

  // Strategy 4: AST-anchored search (find by enclosing function/class identifier)
  // If oldString contains a function/class name pattern, search file for that
  // identifier and try matching nearby content.
  var anchorMatch = oldString.match(/(?:function|class|const|let|var|def)\s+(\w+)/);
  if (anchorMatch && anchorMatch[1] && anchorMatch[1].length > 3) {
    var anchorName = anchorMatch[1];
    var anchorRegex = new RegExp('(?:function|class|const|let|var|def)\\s+' + anchorName + '\\b');
    var anchorIdx = fileContent.search(anchorRegex);
    if (anchorIdx >= 0) {
      // Try to extract a similar-length chunk starting at the anchor
      var oldLineCount = oldString.split('\n').length;
      var fileLinesArr = fileContent.split('\n');
      // Find which line the anchor is on
      var anchorLine = fileContent.slice(0, anchorIdx).split('\n').length - 1;
      if (anchorLine >= 0 && anchorLine + oldLineCount <= fileLinesArr.length) {
        var candidate = fileLinesArr.slice(anchorLine, anchorLine + oldLineCount).join('\n');
        // Verify some overlap with original oldString
        var candTokens = (candidate.match(/\w+/g) || []).slice(0, 20);
        var origTokens = (oldString.match(/\w+/g) || []).slice(0, 20);
        var overlap = candTokens.filter(function(t) { return origTokens.indexOf(t) >= 0; }).length;
        if (overlap >= Math.min(5, origTokens.length * 0.4)) {
          return candidate;
        }
      }
    }
  }

  return null; // No fuzzy match found
}

// Find the N closest matching lines for error hints
function findClosestLines(fileContent, oldString, n) {
  var scored = scoredClosestLines(fileContent, oldString);
  return scored.slice(0, n).map(function(s) {
    return '  Line ' + s.line + ': ' + s.text.slice(0, 120);
  });
}

// Same scoring as findClosestLines but returns the raw {line, text, score}
// objects so callers (e.g. morph wire-up) can use precise line numbers.
function scoredClosestLines(fileContent, oldString) {
  var oldFirstLine = oldString.split('\n')[0].trim();
  if (!oldFirstLine || oldFirstLine.length < 5) return [];

  var fileLines = fileContent.split('\n');
  var scored = [];

  for (var i = 0; i < fileLines.length; i++) {
    var line = fileLines[i].trim();
    if (!line) continue;
    var matches = 0;
    var shorter = Math.min(line.length, oldFirstLine.length);
    for (var c = 0; c < shorter; c++) {
      if (line[c] === oldFirstLine[c]) matches++;
    }
    var score = matches / Math.max(line.length, oldFirstLine.length);
    if (score > 0.5) scored.push({ line: i + 1, text: fileLines[i], score: score });
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  return scored;
}

function isValidatable(toolName) {
  return TOOLS_THAT_NEED_VALIDATION.has(toolName);
}

// ────────────────────────────────────────────────────────────────────
// Read-before-write tracking
// ────────────────────────────────────────────────────────────────────
// Tracks which files have been Read in the current session. Edits without
// a prior Read are flagged — the model is editing from memory, which is
// the #1 cause of old_string mismatches.

var filesReadThisSession = new Set();
var SESSION_RESET_MS = 30 * 60 * 1000; // 30 min idle = new session
var lastActivityTs = Date.now();

function recordFileRead(filePath) {
  if (!filePath) return;
  if (Date.now() - lastActivityTs > SESSION_RESET_MS) filesReadThisSession.clear();
  lastActivityTs = Date.now();
  try { filesReadThisSession.add(path.normalize(filePath)); } catch (e) {}
}

function wasFileRead(filePath) {
  if (!filePath) return true; // can't track — assume yes
  try { return filesReadThisSession.has(path.normalize(filePath)); } catch (e) { return true; }
}

// Scan a request body for Read tool_uses by the assistant and record them
function trackReadsFromHistory(bodyStr) {
  try {
    var data = JSON.parse(bodyStr);
    if (!Array.isArray(data.messages)) return;
    for (var i = 0; i < data.messages.length; i++) {
      if (data.messages[i].role !== 'assistant') continue;
      var c = data.messages[i].content;
      if (!Array.isArray(c)) continue;
      for (var j = 0; j < c.length; j++) {
        if (c[j] && c[j].type === 'tool_use' && (c[j].name === 'Read' || c[j].name === 'read')) {
          var fp = (c[j].input || {}).file_path || (c[j].input || {}).path;
          if (fp) recordFileRead(fp);
        }
      }
    }
  } catch (e) {}
}

// Validate a single Write tool call. Returns:
//   { valid: true }  on success
//   { valid: false, error: <reason>, hint: <recovery suggestion> }  on failure
function validateWrite(input) {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Write input is not an object', hint: 'Pass file_path and content as a JSON object.' };
  }
  const filePath = input.file_path || input.path;
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'Write missing file_path', hint: 'Provide an absolute file_path string.' };
  }
  if (!path.isAbsolute(filePath)) {
    return {
      valid: false,
      error: 'Write file_path is not absolute: ' + filePath,
      hint: 'Claude Code requires absolute file paths. Use the full path starting with /.',
    };
  }

  const content = input.content;
  if (typeof content !== 'string') {
    return { valid: false, error: 'Write content is not a string', hint: 'Pass content as a string.' };
  }

  // Parent directory must exist. We deliberately do NOT auto-create it
  // here — that's a side effect, and the proxy should be read-only at
  // the validation stage. The agent can issue a Bash call to mkdir.
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    return {
      valid: false,
      error: 'Write parent directory does not exist: ' + parentDir,
      hint: 'Create the parent directory first with `mkdir -p ' + parentDir + '` then retry.',
    };
  }

  // Syntax check the content for supported languages. validateSyntax
  // returns {valid: true} for unsupported extensions so this is safe
  // to call on .md / .json / .css etc.
  const syntax = validateSyntax(filePath, content);
  if (!syntax.valid) {
    return {
      valid: false,
      error: 'Write content has syntax errors: ' + syntax.error,
      hint: 'Fix the syntax errors in the content before writing. ' +
            'tree-sitter parsed the content and found unrecoverable errors at the locations above.',
    };
  }

  return { valid: true };
}

// Validate a single Edit tool call.
function validateEdit(input) {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Edit input is not an object', hint: 'Pass file_path, old_string, new_string as a JSON object.' };
  }
  const filePath = input.file_path || input.path;
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'Edit missing file_path', hint: 'Provide an absolute file_path string.' };
  }
  if (!path.isAbsolute(filePath)) {
    return {
      valid: false,
      error: 'Edit file_path is not absolute: ' + filePath,
      hint: 'Claude Code requires absolute file paths. Use the full path starting with /.',
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      error: 'Edit target file does not exist: ' + filePath,
      hint: 'The file you tried to edit was not found. Verify the path with Glob or Read first, ' +
            'or use Write if you intended to create a new file.',
    };
  }

  // Read-before-write constraint: editing a file you haven't Read this session
  // is the #1 cause of old_string mismatches. Warn (don't block — the file may
  // have been read in a prior proxy session and we lost state).
  if (!wasFileRead(filePath)) {
    // Soft warning — the read tracker resets after restarts and across sessions
    // so blocking would be too aggressive. Just log it for visibility.
    console.log('[validator] Edit on un-Read file: ' + filePath + ' (recommend Read first)');
  }

  const oldString = input.old_string;
  const newString = input.new_string;
  if (typeof oldString !== 'string') {
    return { valid: false, error: 'Edit missing old_string', hint: 'Pass old_string as a string.' };
  }
  if (typeof newString !== 'string') {
    return { valid: false, error: 'Edit missing new_string', hint: 'Pass new_string as a string.' };
  }
  if (oldString === newString) {
    return {
      valid: false,
      error: 'Edit old_string and new_string are identical',
      hint: 'The replacement is a no-op. Either you sent the wrong values or this edit is unnecessary.',
    };
  }

  // Read the file and check that old_string actually appears in it.
  let fileContent;
  try {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return {
      valid: false,
      error: 'Edit could not read target file: ' + (e.message || String(e)),
      hint: 'The file exists but is unreadable. Check permissions or whether it is a regular file.',
    };
  }

  if (!fileContent.includes(oldString)) {
    // ── Cascading fuzzy match (Cursor-style) ──
    // Instead of hard-failing, try progressively looser matching:
    // 1. Whitespace-normalized match (trim trailing, normalize indentation)
    // 2. Line-content match (ignore leading whitespace entirely)
    // If a fuzzy match succeeds, AUTO-CORRECT the old_string so the edit
    // works on first try. The model's intent was correct, just the
    // whitespace/indentation was wrong.

    var corrected = fuzzyMatchOldString(fileContent, oldString);
    if (corrected) {
      // Auto-correct: replace the old_string with what's actually in the file
      input.old_string = corrected;
      console.log('[validator] Edit fuzzy-matched old_string (' + oldString.length + ' chars → corrected)');
    } else {
      // Last-resort recovery via morph: if a high-similarity location exists
      // (>0.7 score) and oldString is multi-line, try replacing that exact
      // line range. This rescues cases where comments/whitespace drifted
      // enough that all 4 fuzzy strategies miss but the structural location
      // is still discoverable.
      var morphRescued = false;
      try {
        var oldLines = oldString.split('\n');
        var scored = scoredClosestLines(fileContent, oldString);
        if (scored.length && scored[0].score >= 0.7 && oldLines.length >= 1) {
          var morph = require('./morph');
          var startLine = scored[0].line;
          var endLine   = startLine + oldLines.length - 1;
          var fileLines = fileContent.split('\n');
          if (endLine <= fileLines.length) {
            // Pull out the actual lines at that range — this becomes the
            // new old_string the agent's Edit will consume successfully.
            var actualOld = fileLines.slice(startLine - 1, endLine).join('\n');
            // Sanity: morphApply must validate the region is replaceable.
            var probe = morph.morphApply(filePath, { startLine: startLine, endLine: endLine }, actualOld);
            if (probe.ok) {
              input.old_string = actualOld;
              morphRescued = true;
              console.log('[validator] Edit morph-rescued at lines ' + startLine + '-' + endLine + ' (similarity ' + scored[0].score.toFixed(2) + ')');
            }
          }
        }
      } catch (_) { /* morph optional — fall through to error path */ }

      if (!morphRescued) {
        // Find the closest lines to help the model recover
        var closestLines = findClosestLines(fileContent, oldString, 3);
        var hintExtra = closestLines.length
          ? ' The closest matching lines in the file are:\n' + closestLines.join('\n')
          : '';
        return {
          valid: false,
          error: 'Edit old_string is not present in ' + filePath,
          hint: 'The exact text you provided as old_string does not appear in the file. ' +
                'Read the file first to see the current contents, then retry with the exact ' +
                'characters that are actually there (including whitespace and indentation).' + hintExtra,
        };
      }
    }
  }

  // When replace_all is false (the default), Claude Code requires
  // old_string to be UNIQUE in the file — otherwise the edit is
  // ambiguous. Catch this before Claude Code does so the agent can
  // recover in the same turn.
  const replaceAll = input.replace_all === true;
  if (!replaceAll) {
    const idx1 = fileContent.indexOf(oldString);
    const idx2 = fileContent.indexOf(oldString, idx1 + 1);
    if (idx2 !== -1) {
      return {
        valid: false,
        error: 'Edit old_string appears more than once in ' + filePath + ' (and replace_all is false)',
        hint: 'Make old_string longer by including unique surrounding context (the line above and below ' +
              'are usually enough), or set replace_all=true if you actually want to replace every occurrence.',
      };
    }
  }

  // Speculative edit validation: apply the edit in memory and
  // syntax-check the RESULT. Catches cases where old_string is
  // found but the replacement creates invalid syntax.
  var currentOldString = input.old_string; // may have been corrected by fuzzy match
  if (fileContent && currentOldString && input.new_string !== undefined) {
    var editedContent = replaceAll
      ? fileContent.split(currentOldString).join(input.new_string)
      : fileContent.replace(currentOldString, input.new_string);
    var postSyntax = validateSyntax(filePath, editedContent);
    if (!postSyntax.valid) {
      return {
        valid: false,
        error: 'Edit would create syntax errors: ' + postSyntax.error,
        hint: 'The edit itself is syntactically valid, but after applying it the file would have errors. ' +
              'Check that your new_string maintains proper brackets, quotes, and indentation.',
      };
    }
  }

  return { valid: true };
}

// Dispatch to the right validator based on tool name. Returns a
// pass-through {valid: true} for any tool name we don't validate.
function validateToolUse(toolUse) {
  if (!toolUse || !toolUse.name) return { valid: true };
  const name = toolUse.name;
  if (!isValidatable(name)) return { valid: true };

  if (name === 'Write' || name === 'write') return validateWrite(toolUse.input || {});
  if (name === 'Edit' || name === 'edit') return validateEdit(toolUse.input || {});
  return { valid: true };
}

// Walk an Anthropic-format response body and return the FIRST tool_use
// block whose validation fails. Returns null if everything validates.
//
// We only check the first failure per response because the retry path
// will re-call upstream with the failure surfaced — Gemini will then
// emit a fresh attempt and we re-validate the new response. Reporting
// every failure at once would over-constrain the model.
function findFirstInvalidToolUse(responseStr) {
  let data;
  try { data = JSON.parse(responseStr); }
  catch (e) { return null; }

  if (!data.content || !Array.isArray(data.content)) return null;

  for (const block of data.content) {
    if (block.type !== 'tool_use') continue;
    if (!isValidatable(block.name)) continue;
    const result = validateToolUse(block);
    if (!result.valid) {
      return {
        toolUse: block,
        error: result.error,
        hint: result.hint,
      };
    }
  }

  return null;
}

module.exports = {
  validateToolUse,
  validateWrite,
  validateEdit,
  findFirstInvalidToolUse,
  isValidatable,
  trackReadsFromHistory,
  recordFileRead,
  wasFileRead,
};
