// SPDX-License-Identifier: AGPL-3.0-only
// Syntax-only AST validator backed by tree-sitter.
//
// Used by the plugin's PreToolUse hook (ast-validate.mjs) to catch
// syntax errors in the content the model is about to Write or Edit
// BEFORE the disk write happens, so the agent gets an early correction
// chance instead of wasting a turn noticing the breakage after the fact.
//
// Intentionally scoped to syntax only — no semantic checks, no lints.
// A file that won't `parse` is strictly worse than one that merely fails
// a typecheck; we only surface the former so false-positive rate stays
// near zero.
//
// Languages:
//   JS / JSX / MJS / CJS → tree-sitter-javascript
//   TS / TSX             → tree-sitter-typescript
//   PY                   → tree-sitter-python
//   JSON / JSONC         → JSON.parse (faster + strict)
// Other extensions return { skipped: true, reason: 'unsupported' } so
// the caller passes them through untouched.

const path = require('path');

let _parsers = null;
let _loadAttempted = false;
function loadParsers() {
  if (_parsers) return _parsers;
  if (_loadAttempted) return null;
  _loadAttempted = true;
  try {
    const Parser = require('tree-sitter');
    const JS = require('tree-sitter-javascript');
    const TS = require('tree-sitter-typescript');
    const PY = require('tree-sitter-python');
    function make(lang) { const p = new Parser(); p.setLanguage(lang); return p; }
    _parsers = {
      js:  make(JS),
      ts:  make(TS.typescript),
      tsx: make(TS.tsx),
      py:  make(PY)
    };
    return _parsers;
  } catch (_) {
    // Native tree-sitter modules unavailable (e.g. Linux install without
    // Python/build tools). AST validation degrades gracefully — callers
    // treat each file as skipped rather than crashing.
    return null;
  }
}

function langFor(filePath) {
  const ext = (path.extname(filePath || '') || '').toLowerCase();
  switch (ext) {
    case '.js': case '.jsx': case '.mjs': case '.cjs': return 'js';
    case '.ts': return 'ts';
    case '.tsx': return 'tsx';
    case '.py': return 'py';
    case '.json': case '.jsonc': return 'json';
    default: return null;
  }
}

// Walk the tree looking for ERROR / MISSING nodes. Returns the first
// few errors with row/column + a snippet of the offending source.
function findSyntaxErrors(tree, source, max) {
  const errors = [];
  const lines = source.split('\n');
  const cap = max || 3;

  function visit(node) {
    if (errors.length >= cap) return;
    if (node.type === 'ERROR' || node.isMissing) {
      const { row, column } = node.startPosition;
      errors.push({
        line: row + 1,
        column: column + 1,
        kind: node.isMissing ? 'missing' : 'error',
        context: (lines[row] || '').slice(0, 200)
      });
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  }
  visit(tree.rootNode);
  return errors;
}

// Public entrypoint. Returns:
//   { ok: true }                                        — parse clean
//   { ok: false, language, errors: [{...}] }             — syntax errors
//   { skipped: true, reason: 'unsupported'|'empty' }     — caller should passthrough
function validate(filePath, content) {
  if (typeof content !== 'string' || !content.length) {
    return { skipped: true, reason: 'empty' };
  }
  const lang = langFor(filePath);
  if (!lang) return { skipped: true, reason: 'unsupported' };

  if (lang === 'json') {
    try {
      JSON.parse(content);
      return { ok: true, language: 'json' };
    } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      let line = 1, column = 1;
      if (m) {
        const pos = parseInt(m[1]);
        const prefix = content.slice(0, pos);
        line = (prefix.match(/\n/g) || []).length + 1;
        column = pos - prefix.lastIndexOf('\n');
      }
      return {
        ok: false,
        language: 'json',
        errors: [{ line, column, kind: 'error', message: e.message, context: '' }]
      };
    }
  }

  const parsers = loadParsers();
  if (!parsers) return { skipped: true, reason: 'parser_unavailable' };
  let tree;
  try {
    tree = parsers[lang].parse(content);
  } catch (e) {
    // Parser itself threw — give up rather than pretending we know.
    return { skipped: true, reason: 'parser_failed: ' + e.message };
  }

  const errors = findSyntaxErrors(tree, content, 3);
  if (!errors.length) return { ok: true, language: lang };
  return { ok: false, language: lang, errors };
}

// Helper: apply an Edit-style old_string → new_string replacement and
// return the resulting content, or null if the old_string isn't present.
function applyEdit(originalContent, oldStr, newStr, replaceAll) {
  if (typeof originalContent !== 'string') return null;
  if (typeof oldStr !== 'string') return null;
  if (!originalContent.includes(oldStr)) return null;
  if (replaceAll) return originalContent.split(oldStr).join(newStr || '');
  return originalContent.replace(oldStr, newStr || '');
}

function applyMultiEdit(originalContent, edits) {
  let content = originalContent;
  for (const e of edits || []) {
    const next = applyEdit(content, e.old_string, e.new_string, e.replace_all);
    if (next === null) return null; // abort; one of the edits doesn't apply
    content = next;
  }
  return content;
}

module.exports = {
  validate,
  applyEdit,
  applyMultiEdit,
  langFor
};
