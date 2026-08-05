// SPDX-License-Identifier: AGPL-3.0-only
// CodeLens parser — tree-sitter edition (v5.9).
//
// Replaces the previous regex-based parser, which had two structural
// problems that hollowed out the entire CodeLens pipeline:
//
//   1. The PascalCase-only call detector caught perhaps 5% of real call
//      edges. PageRank was therefore ranking on a graph populated almost
//      entirely by `imports` and `extends` edges, so the "top-K most
//      relevant entities" was really "top-K files with the most imports
//      pointing at them" — decorative, not informative.
//
//   2. The TypeScript / JSX / arrow-export / destructured-export world
//      was invisible. Modern frontend codebases were essentially empty
//      to CodeLens.
//
// The fix is the Aider approach: tree-sitter parsers per language plus
// hand-tuned `tags.scm` capture queries that pull out definitions
// (function / class / method / interface / type / enum / constant) and
// references (calls, instantiations, type usages). Aider's query files
// are MIT-licensed and copied verbatim into proxy/modules/codelens/queries/
// with attribution preserved in each file header.
//
// Languages supported in v5.9: JavaScript, JSX (via tree-sitter-javascript),
// TypeScript, TSX, Python. Adding more is purely additive.
//
// If tree-sitter parsing throws for any reason (corrupt grammar, syntax
// the parser can't recover from, missing query file), the file is silently
// skipped. We deliberately do not fall back to the old regex parser —
// having two code paths that produce different entity shapes was the
// root cause of half the bugs in the previous module.

const fs = require('fs');
const path = require('path');

// tree-sitter ships as native modules that need build tools at install
// time. They are listed in optionalDependencies, so a Linux user without
// Python+make may have a working `troth` install where CodeLens just
// skips the AST stage. PARSER_AVAILABLE drives that fallback.
let Parser, JavaScript, TypeScriptModule, Python;
let PARSER_AVAILABLE = false;
try {
  Parser = require('tree-sitter');
  JavaScript = require('tree-sitter-javascript');
  TypeScriptModule = require('tree-sitter-typescript');
  Python = require('tree-sitter-python');
  PARSER_AVAILABLE = true;
} catch (_) {
  // CodeLens AST stage disabled; callers see `parserAvailable() === false`
  // and treat indexing as a no-op for this run.
}

const QUERIES_DIR = path.join(__dirname, 'queries');

const QUERY_SOURCES = PARSER_AVAILABLE ? {
  javascript: fs.readFileSync(path.join(QUERIES_DIR, 'javascript-tags.scm'), 'utf8'),
  typescript: fs.readFileSync(path.join(QUERIES_DIR, 'typescript-tags.scm'), 'utf8'),
  python: fs.readFileSync(path.join(QUERIES_DIR, 'python-tags.scm'), 'utf8'),
} : {};

// LANGUAGES maps a normalised language key to its grammar plus the
// raw query source. The Query object itself is built lazily and cached
// per entry — constructing a Query is the slow part because it
// compiles the .scm into a tree-sitter automaton.
const LANGUAGES = PARSER_AVAILABLE ? {
  javascript: { language: JavaScript, querySrc: QUERY_SOURCES.javascript, query: null },
  typescript: { language: TypeScriptModule.typescript, querySrc: QUERY_SOURCES.typescript, query: null },
  tsx:        { language: TypeScriptModule.tsx,        querySrc: QUERY_SOURCES.typescript, query: null },
  python:     { language: Python, querySrc: QUERY_SOURCES.python, query: null },
} : {};

function parserAvailable() { return PARSER_AVAILABLE; }

// Map a file extension to the LANGUAGES key. JSX files are parsed by
// the plain JavaScript grammar — tree-sitter-javascript handles JSX
// natively without a separate grammar. .mjs / .cjs are JavaScript with
// different module conventions but identical syntax.
const EXT_TO_LANG = {
  '.js':  'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts':  'typescript',
  '.tsx': 'tsx',
  '.py':  'python',
};

const SUPPORTED_EXTS = Object.keys(EXT_TO_LANG);
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', 'target', '.idea', '.vscode',
  // Third-party bundles are somebody else's code and, minified, they index as
  // nothing but mangled single letters.
  'vendor', 'third_party', 'bower_components',
]);

// A bundle is not source. proxy/ui/vendor/d3.v7.min.js — 273 KB of minified
// third-party JavaScript — took 4960ms to parse, 73% of the entire index, in
// one uninterrupted stretch that no amount of chunking could break up, to
// produce entities named `a`, `b` and `t`. Named bundles are skipped by name;
// the rest are caught by shape, because minifiers do not agree on suffixes.
const BUNDLE_NAME = /\.(min|bundle|umd|iife)\.(js|mjs|cjs|ts)$/i;
function looksMinified(content) {
  if (content.length < 50000) return false;          // small enough not to matter
  const head = content.slice(0, 50000);
  const lines = head.split('\n').length;
  return (head.length / lines) > 300;                // ~no line breaks = generated
}

function getQuery(entry) {
  if (entry.query) return entry.query;
  try {
    entry.query = new Parser.Query(entry.language, entry.querySrc);
  } catch (e) {
    console.error('[CodeLens] Failed to compile query:', e.message);
    entry.query = null;
  }
  return entry.query;
}

// Each parsed file produces a list of entities and a list of edges,
// normalized to the shape the existing SQLite store expects so that
// store.js / ranker.js / mapper.js need zero changes.
//
// Entity types this parser emits:
//   function | method | class | interface | type | enum | constant
//   | module | import
//
// Edge relations this parser emits:
//   calls         — function call site (a -> b means "a calls b")
//   instantiates  — `new Foo()` (a -> b means "a instantiates b")
//   uses_type     — `: SomeType` annotation (a -> b means "a references b as a type")
//   imports       — module-level import edge
//   extends       — class inheritance
function parseFile(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const langKey = EXT_TO_LANG[ext];
  if (!langKey) return { entities: [], edges: [] };

  const entry = LANGUAGES[langKey];
  if (!entry) return { entities: [], edges: [] };

  const query = getQuery(entry);
  if (!query) return { entities: [], edges: [] };

  let parser;
  let tree;
  try {
    parser = new Parser();
    parser.setLanguage(entry.language);
    // node-tree-sitter's default internal buffer is too small for files
    // larger than ~32 KB and throws "Invalid argument" without that
    // explicit hint. The 1 MB buffer is generous enough for any source
    // file we'd realistically index (we already cap individual files
    // at 500 KB in scanDirectory).
    tree = parser.parse(content, undefined, { bufferSize: 1024 * 1024 });
  } catch (e) {
    return { entities: [], edges: [] };
  }

  const entities = [];
  const edges = [];

  let captures;
  try {
    captures = query.captures(tree.rootNode);
  } catch (e) {
    return { entities: [], edges: [] };
  }

  // First pass: collect all `name.definition.*` captures and pair them
  // with the surrounding `definition.*` node so we can record the line
  // range and signature snippet.
  const definitions = []; // { kind, name, line, signature, _nameStart }

  for (const cap of captures) {
    if (!cap.name.startsWith('name.definition.')) continue;
    const kind = cap.name.slice('name.definition.'.length);
    const nameNode = cap.node;
    const name = nameNode.text;
    if (!name) continue;
    const line = nameNode.startPosition.row + 1;
    definitions.push({ kind, name, line, signature: '', _nameStart: nameNode.startIndex });
  }

  // Second pass: attach the parent definition node text as the signature.
  // First line of the parent's text is the signature line.
  for (const cap of captures) {
    if (!cap.name.startsWith('definition.')) continue;
    const parentText = cap.node.text || '';
    const firstLine = parentText.split('\n')[0].trim().slice(0, 200);
    for (const def of definitions) {
      if (def.signature) continue;
      if (def._nameStart >= cap.node.startIndex && def._nameStart < cap.node.endIndex) {
        def.signature = firstLine;
        break;
      }
    }
  }

  // Extract docstrings: scan lines above each definition for JSDoc/comment blocks.
  // This is done in code because node-tree-sitter doesn't support #select-adjacent!
  // predicates that Aider's query files use for docstring capture.
  const lines = content.split('\n');
  for (const def of definitions) {
    let docstring = '';
    if (def.line > 1) {
      const docLines = [];
      let i = def.line - 2; // 0-indexed line above definition
      // Collect contiguous comment lines above the definition
      while (i >= 0 && i >= def.line - 20) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed.startsWith('*/') ||
            trimmed.startsWith('//') || trimmed.startsWith('#') ||
            trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
          docLines.unshift(trimmed);
          i--;
        } else if (trimmed === '') {
          // Allow one blank line between comment and definition
          if (docLines.length > 0) break;
          i--;
        } else {
          break;
        }
      }
      if (docLines.length > 0) {
        docstring = docLines.join('\n').replace(/^\/\*\*\s*/, '').replace(/\s*\*\/\s*$/, '').replace(/^\s*\*\s?/gm, '').replace(/^\/\/\s?/gm, '').replace(/^#\s?/gm, '').trim();
        if (docstring.length > 500) docstring = docstring.slice(0, 500);
      }
    }
    // Python docstrings: first string literal inside function body
    if (!docstring && langKey === 'python' && def.line <= lines.length) {
      for (let j = def.line; j < Math.min(def.line + 5, lines.length); j++) {
        const lt = lines[j].trim();
        if (lt.startsWith('"""') || lt.startsWith("'''")) {
          const quote = lt.slice(0, 3);
          if (lt.endsWith(quote) && lt.length > 6) {
            docstring = lt.slice(3, -3).trim();
          } else {
            const docParts = [lt.slice(3)];
            for (let k = j + 1; k < Math.min(j + 20, lines.length); k++) {
              if (lines[k].trim().endsWith(quote)) { docParts.push(lines[k].trim().slice(0, -3)); break; }
              docParts.push(lines[k].trim());
            }
            docstring = docParts.join(' ').trim();
          }
          if (docstring.length > 500) docstring = docstring.slice(0, 500);
          break;
        }
        if (lt && !lt.startsWith('#')) break;
      }
    }
    entities.push({
      type: def.kind,
      name: def.name,
      signature: def.signature || def.name,
      line: def.line,
      docstring: docstring || undefined,
    });
  }

  // Third pass: collect all `name.reference.*` captures and emit edges.
  // The "from" of a call edge is the enclosing definition (the smallest
  // function / method / class body whose byte range contains the call
  // site). The "to" is the called name.
  for (const cap of captures) {
    if (!cap.name.startsWith('name.reference.')) continue;
    const refKind = cap.name.slice('name.reference.'.length); // call | class | type
    const refName = cap.node.text;
    if (!refName) continue;

    let enclosing = null;
    let enclosingSize = Infinity;
    for (const otherCap of captures) {
      if (!otherCap.name.startsWith('definition.')) continue;
      const start = otherCap.node.startIndex;
      const end = otherCap.node.endIndex;
      if (cap.node.startIndex >= start && cap.node.endIndex <= end) {
        const size = end - start;
        if (size < enclosingSize) {
          enclosingSize = size;
          enclosing = otherCap;
        }
      }
    }

    let fromName = '__FILE__';
    if (enclosing) {
      for (const nd of definitions) {
        if (nd._nameStart >= enclosing.node.startIndex && nd._nameStart < enclosing.node.endIndex) {
          fromName = nd.name;
          break;
        }
      }
    }

    let relation = 'calls';
    if (refKind === 'class') relation = 'instantiates';
    else if (refKind === 'type') relation = 'uses_type';

    edges.push({ from: fromName, to: refName, relation });
  }

  // Fourth pass: import / extends edges. Tree-sitter could do this too
  // but the regex sweep is faster and we have battle-tested it across
  // five versions. The point of tree-sitter is the call graph, not
  // restating what `import x from "y"` means.
  if (langKey !== 'python') {
    const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))?\s*(?:,\s*\{([^}]+)\})?\s*from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRegex.exec(content)) !== null) {
      const named = (m[1] || '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const def = m[2] ? [m[2]] : [];
      const namespaced = (m[3] || '').split(',').map(s => s.trim()).filter(Boolean);
      const allNames = [...named, ...def, ...namespaced];
      const source = m[4];
      for (const name of allNames) {
        entities.push({ type: 'import', name, signature: `import { ${name} } from '${source}'`, line: 0 });
      }
      edges.push({ from: '__FILE__', to: source, relation: 'imports', importedNames: allNames });
    }

    const requireRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = requireRegex.exec(content)) !== null) {
      const names = (m[1] || m[2] || '').split(',').map(s => s.trim()).filter(Boolean);
      const source = m[3];
      for (const name of names) {
        entities.push({ type: 'import', name, signature: `require('${source}')`, line: 0 });
      }
      edges.push({ from: '__FILE__', to: source, relation: 'imports', importedNames: names });
    }

    const extendsRegex = /class\s+(\w+)\s+extends\s+(\w+)/g;
    while ((m = extendsRegex.exec(content)) !== null) {
      edges.push({ from: m[1], to: m[2], relation: 'extends' });
    }
  } else {
    const pyImport = /^\s*(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
    let m;
    while ((m = pyImport.exec(content)) !== null) {
      const source = m[1] || m[2].split(/[, ]/)[0];
      const names = m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of names) {
        entities.push({ type: 'import', name, signature: `from ${source} import ${name}`, line: 0 });
      }
      edges.push({ from: '__FILE__', to: source, relation: 'imports', importedNames: names });
    }
  }

  return { entities, edges };
}

// walkFiles(dir, onFile, opts) — visit every indexable file and hand its
// content to the caller WITHOUT parsing it.
//
// scanDirectory used to parse every file it touched, and initIndex then hashed
// the results to decide which ones actually needed parsing: the answer cost
// more than the question. Measured on a 623-file tree, reading and hashing is
// 13ms where reading and parsing is 7125ms, and that price was paid on every
// boot even when nothing had changed. Deciding is now separate from doing.
//
// opts.maxFiles / opts.maxMs bound the walk. The desktop app points this at the
// operator's whole home directory, where there is no natural limit at all; a
// truncated index degrades a hint, while an unbounded one holds the port shut.
// Returns { truncated, reason } so the caller can say so out loud.
function walkFiles(dir, onFile, opts) {
  opts = opts || {};
  const maxDepth = opts.maxDepth == null ? 5 : opts.maxDepth;
  const maxFiles = opts.maxFiles == null ? 20000 : opts.maxFiles;
  const maxMs = opts.maxMs == null ? 0 : opts.maxMs;
  const startedAt = Date.now();
  let seen = 0;
  let stop = null;

  function walk(currentDir, depth) {
    if (stop || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (stop) return;
      if (entry.name.startsWith('.')) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) { walk(fullPath, depth + 1); continue; }
      if (!SUPPORTED_EXTS.includes(path.extname(entry.name).toLowerCase())) continue;
      if (BUNDLE_NAME.test(entry.name)) continue;
      if (seen >= maxFiles) { stop = 'file limit (' + maxFiles + ')'; return; }
      if (maxMs && (Date.now() - startedAt) > maxMs) { stop = 'time limit (' + maxMs + 'ms)'; return; }
      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch (e) { continue; }
      if (content.length > 500000) continue;
      if (looksMinified(content)) continue;
      seen++;
      try { onFile(fullPath, content); } catch (e) { /* one bad file is not a failed index */ }
    }
  }
  walk(dir, 0);
  return { truncated: !!stop, reason: stop, files: seen };
}

// listFiles(dir, opts) — the paths only. No read, no parse.
//
// Separated from the work because the work has to be chunked: an index pass
// that runs to completion in one tick blocks the event loop, and a blocked loop
// cannot answer the port even after listen() has been called — moving the pass
// later in the file bought nothing until the pass itself learned to yield.
// Walking 13761 directories costs 0.4s; it is the reading and parsing that is
// expensive, and that now happens in chunks the caller paces.
function listFiles(dir, opts) {
  opts = opts || {};
  const maxDepth = opts.maxDepth == null ? 5 : opts.maxDepth;
  const maxFiles = opts.maxFiles == null ? 20000 : opts.maxFiles;
  const files = [];
  let stop = null;
  (function walk(currentDir, depth) {
    if (stop || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (stop) return;
      if (entry.name.startsWith('.')) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) { walk(fullPath, depth + 1); continue; }
      if (!SUPPORTED_EXTS.includes(path.extname(entry.name).toLowerCase())) continue;
      if (BUNDLE_NAME.test(entry.name)) continue;
      if (files.length >= maxFiles) { stop = 'file limit (' + maxFiles + ')'; return; }
      files.push(fullPath);
    }
  })(dir, 0);
  return { files, truncated: !!stop, reason: stop };
}

// Kept for callers that genuinely want everything parsed in one go.
function scanDirectory(dir, maxDepth = 5) {
  const results = [];
  walkFiles(dir, (filePath, content) => {
    const { entities, edges } = parseFile(filePath, content);
    results.push({ filePath, entities, edges, content });
  }, { maxDepth });
  return results;
}

// Lightweight syntax check used by the v5.10 edit-tool pre-flight
// validator. Parses `content` with the tree-sitter grammar matching
// `filePath`'s extension and returns {valid, error}. Unlike parseFile()
// this does NOT extract entities or edges — it only walks the parse
// tree looking for ERROR nodes (tree-sitter's marker for unrecoverable
// syntax errors). A clean parse means the code at least lexes and the
// grammar can build a tree, which is the bar for "won't immediately
// break on Write/Edit".
//
// Returns { valid: true } for files in unsupported languages — we
// don't want validation to false-positive on .md, .json, .css etc.
function validateSyntax(filePath, content) {
  if (typeof content !== 'string') {
    return { valid: false, error: 'content is not a string' };
  }
  if (content.length === 0) {
    // Empty files are syntactically valid in every supported language.
    return { valid: true };
  }
  const ext = path.extname(filePath || '').toLowerCase();
  const langKey = EXT_TO_LANG[ext];
  if (!langKey) return { valid: true }; // unsupported language → not our problem

  const entry = LANGUAGES[langKey];
  if (!entry) return { valid: true };

  let parser;
  let tree;
  try {
    parser = new Parser();
    parser.setLanguage(entry.language);
    tree = parser.parse(content, undefined, { bufferSize: 1024 * 1024 });
  } catch (e) {
    return { valid: false, error: 'parser threw: ' + (e.message || String(e)) };
  }

  // Walk the tree looking for ERROR or MISSING nodes. tree-sitter
  // returns a parse tree even for broken input — the markers are
  // what tell us something's wrong.
  const errors = [];
  function walk(node) {
    if (!node) return;
    if (node.isMissing) {
      errors.push({
        line: node.startPosition.row + 1,
        col: node.startPosition.column + 1,
        kind: 'missing',
        type: node.type,
      });
    } else if (node.type === 'ERROR' || node.hasError) {
      // Only push the deepest ERROR — bubbling up the tree we'd report
      // every parent node that contains an error, which is noise.
      if (node.type === 'ERROR') {
        errors.push({
          line: node.startPosition.row + 1,
          col: node.startPosition.column + 1,
          kind: 'syntax',
          snippet: (node.text || '').slice(0, 60),
        });
      }
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  walk(tree.rootNode);

  if (errors.length === 0) return { valid: true };

  // Format the first 3 errors as a single string for the proxy log
  // and the synthesized tool_result hint.
  const top = errors.slice(0, 3).map(function(e) {
    if (e.kind === 'missing') {
      return 'missing ' + e.type + ' at ' + e.line + ':' + e.col;
    }
    return 'syntax error at ' + e.line + ':' + e.col + (e.snippet ? ' near `' + e.snippet + '`' : '');
  }).join('; ');

  return { valid: false, error: top, errors: errors };
}

module.exports = { parseFile, scanDirectory, walkFiles, listFiles, looksMinified, validateSyntax };
