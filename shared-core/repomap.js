// SPDX-License-Identifier: AGPL-3.0-only
// Lightweight repo mapper — compressed skeleton of a project's files,
// ranked by "likely importance" so the injected context points the model
// at the right areas without dumping the whole tree.
//
// Heavy-lifting (PageRank, import graph, symbol-level ranking) remains
// the job of the existing codebase-memory MCP. This module is the
// cheap additive — runs in a UserPromptSubmit hook in <50ms against
// cwd, returns an ≤800-char list the model can use as a map of the
// territory without paying 20K tokens for a full tree dump.
//
// Inspiration: Aider's repo map (AI Coding Agent Knowledge Graph
// Research §3) minus the tree-sitter parse step.

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '.turbo', '.cache', 'coverage', '__pycache__', '.pytest_cache',
  'target', 'venv', '.venv', '.tmp-plugin-state', '.tmp-sandbox-state'
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'Pipfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum'
]);

// File type weights — higher = more likely to appear near the top of
// the map. Tuned so product code beats tests beats docs beats configs.
const EXT_WEIGHT = {
  '.ts': 10, '.tsx': 10, '.mts': 10, '.cts': 10,
  '.js': 9,  '.jsx': 9,  '.mjs': 9,  '.cjs': 9,
  '.py': 10, '.rs': 10, '.go': 10, '.java': 10, '.kt': 10,
  '.rb': 8, '.php': 8, '.cs': 8, '.swift': 8,
  '.vue': 9, '.svelte': 9,
  '.sql': 7, '.graphql': 7, '.proto': 7,
  '.md': 2, '.mdx': 2,
  '.json': 3, '.yaml': 2, '.yml': 2, '.toml': 2,
  '.sh': 4, '.bash': 4, '.zsh': 4,
  '.html': 5, '.css': 4, '.scss': 4
};

function extWeight(file) {
  const ext = path.extname(file).toLowerCase();
  return EXT_WEIGHT[ext] || 1;
}

function walk(dir, depth, maxDepth, collector) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.troth' && entry.name !== '.claude') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (IGNORE_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1, maxDepth, collector);
    } else if (entry.isFile()) {
      collector.push(full);
    }
  }
}

// Score = base extension weight × depth penalty × keyword boost.
function scoreFile(relPath, keywords) {
  const ext = path.extname(relPath).toLowerCase();
  let s = EXT_WEIGHT[ext] || 1;

  // Depth penalty — files closer to root generally matter more.
  const depth = relPath.split(path.sep).length;
  s /= Math.max(1, depth * 0.7);

  // Convention boosts / penalties.
  const lower = relPath.toLowerCase();
  if (/\bsrc\//.test(lower)) s *= 1.4;
  if (/\bindex\./i.test(lower)) s *= 1.25;
  if (/\b(main|server|app|index)\.(ts|js|tsx|jsx|py|rs|go)$/i.test(lower)) s *= 1.5;
  if (/\bREADME\.(md|mdx)$/i.test(relPath)) s *= 1.3;
  if (/\b(test|spec|__tests__|test_)/i.test(lower)) s *= 0.7;
  if (/\bnode_modules|vendor|dist|build\b/.test(lower)) s *= 0.2;

  // Keyword boost — the "chat boost" half of the Aider trick. Files
  // whose path or name matches a user-prompt keyword float to the
  // top regardless of their baseline rank.
  for (const kw of keywords || []) {
    if (!kw || kw.length < 3) continue;
    if (lower.includes(kw.toLowerCase())) s *= 10;
  }
  return s;
}

// Extract the 3-6 most "content-ish" keywords from the user prompt.
// Cheap heuristic: drop stop words, keep >=4-char alphanum tokens.
const STOP = new Set([
  'the','and','for','with','this','that','what','where','when','why',
  'how','which','from','into','have','been','some','them','they','their',
  'make','does','do','did','will','just','like','about','tell','you',
  'please','give','need','want','should','could','would','find','show'
]);
function extractKeywords(prompt, max) {
  const tokens = (prompt || '').toLowerCase().match(/\b[a-z0-9_][a-z0-9_-]{2,}\b/g) || [];
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (STOP.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= (max || 6)) break;
  }
  return out;
}

// Public entrypoint. Returns a string ≤ maxChars to inject into the
// UserPromptSubmit additionalContext, or null if no useful map exists.
function buildMap(cwd, prompt, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 25;
  const maxDepth = opts.maxDepth || 5;
  const maxChars = opts.maxChars || 800;

  if (!cwd || !fs.existsSync(cwd)) return null;

  const keywords = extractKeywords(prompt, 6);
  const files = [];
  walk(cwd, 0, maxDepth, files);
  if (!files.length) return null;

  const scored = files
    .map(f => ({ path: path.relative(cwd, f), score: scoreFile(path.relative(cwd, f), keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  const header = keywords.length
    ? '[troth/repomap] Top files relevant to: ' + keywords.join(', ')
    : '[troth/repomap] Top files in this project';
  const lines = [header];
  for (const entry of scored) {
    const line = '  ' + entry.path;
    if ((lines.join('\n').length + line.length) > maxChars) break;
    lines.push(line);
  }
  return lines.join('\n');
}

// ── Import-graph PageRank  ───────────────────────────────────────
//
// Replaces 's ext×depth×keyword heuristic for medium/large repos
// where the call graph actually signals "what matters" better than
// filesystem conventions. Regex-based import extraction (JS/TS ESM +
// CJS require + Python) — not as precise as tree-sitter but 10× faster
// and good enough for ranking. Tree-sitter path is reserved for the
// codebase-memory MCP's deeper analysis.

const IMPORT_REGEXES = [
  // ESM:  import X from "./foo"; import { X } from "./foo"; import "./foo";
  /\bimport\s+(?:[\w\s,*${}]+\s+from\s+)?["']([^"']+)["']/g,
  // dynamic:  import("./foo")
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  // CJS:  require("./foo")
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  // Python:  from foo.bar import X  /  import foo.bar
  /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm
];

function extractImports(sourceText) {
  const hits = new Set();
  for (const re of IMPORT_REGEXES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sourceText)) !== null) {
      const ref = m[1] || m[2];
      if (ref) hits.add(ref);
    }
  }
  return [...hits];
}

// Resolve an import reference to an absolute file path within the repo.
// Drops node_modules / package names (unresolved). Handles relative and
// index.* conventions.
function resolveImport(fromFile, ref, cwd, allFiles) {
  if (!ref) return null;
  if (/^[./]/.test(ref)) {
    // Relative — resolve against fromFile's dir.
    const base = path.dirname(fromFile);
    const candidate = path.resolve(base, ref);
    const candidates = [
      candidate,
      candidate + '.js', candidate + '.jsx', candidate + '.ts', candidate + '.tsx',
      candidate + '.mjs', candidate + '.cjs', candidate + '.py',
      path.join(candidate, 'index.js'), path.join(candidate, 'index.ts'),
      path.join(candidate, 'index.jsx'), path.join(candidate, 'index.tsx'),
      path.join(candidate, '__init__.py')
    ];
    for (const c of candidates) {
      if (allFiles.has(c)) return c;
    }
    return null;
  }
  // Python bare module — try repo-local resolution (e.g. "mypkg.utils").
  if (/^[a-z_][\w.]*$/i.test(ref)) {
    const parts = ref.split('.');
    const candidates = [
      path.join(cwd, parts.join('/') + '.py'),
      path.join(cwd, parts.join('/'), '__init__.py')
    ];
    for (const c of candidates) if (allFiles.has(c)) return c;
    return null;
  }
  // Bare specifier (node_modules / package) — skip.
  return null;
}

function buildImportGraph(cwd, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 800;

  const absFiles = [];
  walk(cwd, 0, opts.maxDepth || 6, absFiles);
  const fileSet = new Set(absFiles);
  if (!absFiles.length) return { nodes: [], adj: new Map() };

  // Parse up to maxFiles; for huge monorepos bail early on cost grounds.
  const pool = absFiles.slice(0, maxFiles);
  const adj = new Map(); // file → Set<file>
  for (const f of pool) adj.set(f, new Set());

  for (const f of pool) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); }
    catch (e) { continue; }
    if (text.length > 500000) continue; // skip huge files
    const refs = extractImports(text);
    for (const r of refs) {
      const target = resolveImport(f, r, cwd, fileSet);
      if (target && adj.has(target)) adj.get(f).add(target);
    }
  }
  return { nodes: pool, adj };
}

// Power-iteration PageRank. Uses personalization vector for "chat boost":
// files whose path matches a keyword start with higher initial rank and
// the random-jump lands there disproportionately. 30 iterations is
// enough to converge on graphs up to ~10K nodes.
function pagerank(graph, opts) {
  opts = opts || {};
  const damping = opts.damping || 0.85;
  const iterations = opts.iterations || 30;
  const personalization = opts.personalization || null; // Map<node, weight>

  const N = graph.nodes.length;
  if (!N) return new Map();

  // Outgoing edge count; 0 → dangling node (distributes to everyone).
  const outCount = new Map();
  for (const n of graph.nodes) outCount.set(n, graph.adj.get(n).size);

  // Incoming adjacency for the update step.
  const inAdj = new Map();
  for (const n of graph.nodes) inAdj.set(n, []);
  for (const n of graph.nodes) {
    for (const t of graph.adj.get(n)) {
      if (inAdj.has(t)) inAdj.get(t).push(n);
    }
  }

  // Personalization weights — normalize so they sum to 1.
  let pers = null;
  if (personalization && personalization.size) {
    pers = new Map();
    let sum = 0;
    for (const [n, w] of personalization) { sum += w; }
    for (const [n, w] of personalization) { pers.set(n, w / sum); }
  }
  const teleport = (n) => pers ? (pers.get(n) || 0) : (1 / N);

  // Initial rank uniform.
  let rank = new Map();
  for (const n of graph.nodes) rank.set(n, 1 / N);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map();
    // Dangling mass — distributed per teleport vector.
    let dangling = 0;
    for (const n of graph.nodes) {
      if (outCount.get(n) === 0) dangling += rank.get(n);
    }
    for (const n of graph.nodes) {
      let incoming = 0;
      for (const src of inAdj.get(n)) {
        incoming += rank.get(src) / outCount.get(src);
      }
      const value = (1 - damping) * teleport(n) +
                    damping * (incoming + dangling * teleport(n));
      next.set(n, value);
    }
    rank = next;
  }
  return rank;
}

// Public entrypoint: PageRank-driven map.
function buildPagerankMap(cwd, prompt, opts) {
  opts = opts || {};
  const maxChars = opts.maxChars || 800;
  const maxFiles = opts.maxFilesOut || 18;
  const maxDepth = opts.maxDepth || 6;

  if (!cwd || !fs.existsSync(cwd)) return null;

  const keywords = extractKeywords(prompt, 6);
  const graph = buildImportGraph(cwd, { maxDepth, maxFiles: 800 });
  if (!graph.nodes.length) return null;

  // Personalization — nodes whose path contains a keyword get weight 10,
  // else 1. Mirrors the "10× chat boost" from the Aider paper but through
  // the stationary distribution instead of a post-hoc multiplier.
  const pers = new Map();
  for (const n of graph.nodes) {
    const rel = path.relative(cwd, n).toLowerCase();
    let w = 1;
    for (const kw of keywords) {
      if (kw.length >= 3 && rel.includes(kw.toLowerCase())) { w = 10; break; }
    }
    pers.set(n, w);
  }

  const rank = pagerank(graph, { personalization: pers });
  const ranked = graph.nodes
    .map(n => ({ path: path.relative(cwd, n), score: rank.get(n) || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  const header = keywords.length
    ? '[troth/repomap:pagerank] Ranked by import-graph centrality + chat boost: ' + keywords.join(', ')
    : '[troth/repomap:pagerank] Ranked by import-graph centrality';
  const lines = [header];
  for (const entry of ranked) {
    const line = '  ' + entry.path;
    if ((lines.join('\n').length + line.length) > maxChars) break;
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  extractKeywords,
  scoreFile,
  buildMap,             // lightweight
  buildPagerankMap,     // real PageRank
  extractImports,
  resolveImport,
  buildImportGraph,
  pagerank,
  EXT_WEIGHT
};
