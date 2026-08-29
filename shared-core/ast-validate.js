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
const spawnPurpose = require('./tools/spawn-purpose.js');

let _parsers = null;
let _loadAttempted = false;
function loadParsers() {
  if (_parsers) return _parsers;
  if (_loadAttempted) return null;
  _loadAttempted = true;
  // A runtime whose ABI drifted from these native bindings can die at parse
  // time rather than throw at require time — and a death inside the serving
  // process takes the hands with it. One child spawn buys the answer safely:
  // if the child cannot require and parse, this host has no validator and
  // every caller sees an honest skip.
  try {
    spawnPurpose.execFileSync('parser-probe', process.execPath, ['-e',
      'const P=require("tree-sitter");const L=require("tree-sitter-javascript");' +
      'const p=new P();p.setLanguage(L);const t=p.parse("let x=1;");' +
      'process.exit(t&&t.rootNode&&!t.rootNode.hasError?0:1);'
    ], { timeout: 10000, cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  } catch (_) { return null; }
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

// Parse a whole file, at any size.
//
// tree-sitter's Node binding refuses a string argument longer than 32,768
// bytes and throws "Invalid argument". Every caller here treats a throw as a
// skip, so the four largest files in this tree — the proxy at 307 KB, the
// state layer at 159 KB, the background worker at 85 KB and the substrate MCP
// server at 80 KB — would be written without ever being parsed, and a stray
// brace could reach disk with the validator reporting nothing. That is the
// failure mode a silent skip always has: it reads exactly like a pass.
//
// Measured on the boundary: 32,723 bytes parses, 32,779 throws. The binding's
// documented form for large input is a callback that returns the next chunk,
// and it has no such limit — 308 KB parses in 28 ms. Below the limit both
// forms were compared over 52 cases across javascript, typescript, tsx and
// python, clean and broken: identical results, identical timings to within
// noise. So there is one path rather than a fast path and a boundary.
const PARSE_CHUNK = 4096;
function parseWhole(parser, source) {
  return parser.parse((index) =>
    index < source.length ? source.slice(index, index + PARSE_CHUNK) : null);
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
    tree = parseWhole(parsers[lang], content);
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
  langFor,
  available: () => !!loadParsers()
};
