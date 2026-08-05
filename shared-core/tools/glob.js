// SPDX-License-Identifier: AGPL-3.0-only
// Glob — file path matcher, canonical Claude Code shape.
//
// Input  (GlobInput): { pattern, path? }
// Output (GlobOutput): { durationMs, numFiles, filenames, truncated }
//
// Implements the common subset of glob syntax used by Claude Code's
// own Glob tool: `*` (anything except /), `**` (anything including /),
// `?` (single non-/ char), `[abc]` (character class), and literal
// segments. Patterns are matched against paths relative to the search
// root.
//
// Output is sorted by file mtime (most recently changed first) and
// capped at 100 entries, mirroring Claude's documented behavior. Files
// past the cap are dropped and `truncated:true` is set so the caller
// can paginate by narrowing the pattern.

const fs   = require('fs');
const path = require('path');

const MAX_RESULTS = 100;
const MAX_WALK    = 200000;  // hard ceiling on entries walked, regardless of cap

const schema = {
  type: 'function',
  function: {
    name: 'Glob',
    description: 'Match file paths against a glob pattern. Results are sorted by modification time (newest first) and capped at 100 files (truncated=true when the cap was hit). Defaults to the current working directory; pass path to scope the search.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/index.js"). Supports *, **, ?, [abc].' },
        path:    { type: 'string', description: 'Directory to search in. Defaults to the current working directory.' }
      },
      required: ['pattern']
    }
  }
};

// Translate a glob into a regex. Walks the pattern char-by-char so we
// can keep the glob-meta chars (`*`, `**`, `?`, `[...]`) distinct from
// regex-meta chars that need escaping (`.`, `+`, etc.). Path separator
// is forward-slash inside the regex; callers must normalize Windows
// backslashes upstream if they care.
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match zero or more path segments. The trailing slash is
        // consumed if present so "**/x" matches "x" at the root.
        if (pattern[i + 2] === '/') { re += '(?:.*?/)?'; i += 3; }
        else                        { re += '.*?';      i += 2; }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '[') {
      // Pass-through character class up to first ']'. Closing bracket
      // missing → treat literally to avoid throwing on bad patterns.
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; i += 1; }
      else         { re += pattern.slice(i, end + 1); i = end + 1; }
    } else if ('.+^$(){}|\\'.indexOf(c) >= 0) {
      // Regex metacharacters that aren't part of glob syntax.
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function shouldSkipDir(name) {
  // Mirror the standard ignore set so we don't blow the walk cap on
  // node_modules / .git etc. Claude's own Glob applies a similar
  // implicit ignore — making it explicit here keeps tests deterministic.
  return name === 'node_modules' || name === '.git' || name === '.svn' ||
         name === '.hg' || name === '.troth';
}

function walk(root, matches, regex, walkBudget) {
  // BFS via a queue of (absolute dir, relative prefix) entries.
  const queue = [{ dir: root, prefix: '' }];
  let visited = 0;
  while (queue.length) {
    const { dir, prefix } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (++visited > walkBudget) return { abortedByBudget: true };
      const name = ent.name;
      const rel  = prefix ? prefix + '/' + name : name;
      const abs  = path.join(dir, name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(name)) continue;
        queue.push({ dir: abs, prefix: rel });
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (regex.test(rel)) {
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch (_) {}
        matches.push({ abs, mtime });
      }
    }
  }
  return { abortedByBudget: false };
}

async function run(args, _ctx) {
  args = args || {};
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || !pattern) {
    return { error: 'bad_args', detail: 'pattern (string) is required' };
  }
  const searchRoot = args.path ? args.path : process.cwd();
  if (typeof searchRoot !== 'string') {
    return { error: 'bad_args', detail: 'path must be a string when provided' };
  }
  let stat;
  try { stat = fs.statSync(searchRoot); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { error: 'not_found', path: searchRoot };
    if (e && e.code === 'EACCES') return { error: 'permission_denied', path: searchRoot };
    return { error: 'stat_failed', path: searchRoot, detail: e && e.message || String(e) };
  }
  if (!stat.isDirectory()) return { error: 'not_a_directory', path: searchRoot };

  const t0 = Date.now();
  const regex = globToRegex(pattern);
  const matches = [];
  walk(searchRoot, matches, regex, MAX_WALK);

  matches.sort((a, b) => b.mtime - a.mtime);
  const truncated = matches.length > MAX_RESULTS;
  const kept = matches.slice(0, MAX_RESULTS);

  return {
    durationMs: Date.now() - t0,
    numFiles:   kept.length,
    filenames:  kept.map((m) => m.abs),
    truncated
  };
}

module.exports = { schema, run };
