// SPDX-License-Identifier: AGPL-3.0-only
// Grep — ripgrep wrapper, canonical Claude Code shape.
//
// Input  (GrepInput from sdk-tools.d.ts):
//   { pattern, path?, glob?, output_mode?, "-A"?, "-B"?, "-C"?,
//     context?, "-n"?, "-i"?, type?, head_limit?, offset?, multiline? }
//
// Output (GrepOutput):
//   { mode?, numFiles, filenames, content?, numLines?, numMatches?,
//     appliedLimit?, appliedOffset? }
//
// We shell out to `rg` (ripgrep) — every Mac dev box has it (troth's
// CodeLens already depends on tree-sitter; ripgrep is a similar
// expectation). If rg is absent, the tool returns a structured
// `not_available` error so callers can fall back to substrate search
// instead of throwing.
//
// head_limit + offset are applied CLIENT-side after rg returns: ripgrep
// has no native --offset, and piping through head loses exit-code
// fidelity. Soft cap keeps the cost of "did I limit?" cheap because rg
// stops streaming once we close stdin (via kill on excess).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_HEAD_LIMIT = 250;
const DEFAULT_OUTPUT_MODE = 'files_with_matches';

// ripgrep is usually on PATH, but on dev boxes that rely on a shell
// alias (notably macOS where Claude Code ships rg in vendor/ but does
// NOT add it to PATH), spawn('rg', ...) fails with ENOENT even though
// the user can type `rg` interactively. Probe a small list of known
// install locations at first call and cache the result.
const RG_CANDIDATES = [
  'rg',  // user's PATH
  '/opt/homebrew/bin/rg',
  '/usr/local/bin/rg',
  '/usr/bin/rg',
  '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg',
  '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x86_64-darwin/rg',
  '/usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x86_64-darwin/rg'
];

let _rgPath = null;  // null = unresolved; false = confirmed missing; string = path
function resolveRg() {
  if (_rgPath !== null) return _rgPath;
  for (const cand of RG_CANDIDATES) {
    if (cand === 'rg') continue;  // PATH lookup happens in spawn; treat absolute paths first
    try { if (fs.statSync(cand).isFile()) { _rgPath = cand; return cand; } }
    catch (_) { /* not present, try next */ }
  }
  // Fall through to plain 'rg' — spawn will surface ENOENT if user
  // truly has no ripgrep anywhere reachable.
  _rgPath = 'rg';
  return 'rg';
}

const schema = {
  type: 'function',
  function: {
    name: 'Grep',
    description: 'Search file contents with ripgrep. Defaults to files_with_matches output; pass output_mode="content" for matching lines with optional -A/-B/-C context, or "count" for per-file match counts. head_limit defaults to 250 (0 = unlimited). multiline=true enables `.` matching newlines (rg -U --multiline-dotall).',
    parameters: {
      type: 'object',
      properties: {
        pattern:     { type: 'string', description: 'Regular expression pattern.' },
        path:        { type: 'string', description: 'File or directory to search (rg PATH). Defaults to current working directory.' },
        glob:        { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js").' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        '-A':        { type: 'integer', description: 'Lines of trailing context (content mode only).' },
        '-B':        { type: 'integer', description: 'Lines of leading context.' },
        '-C':        { type: 'integer', description: 'Lines of context (both sides). Alias.' },
        context:     { type: 'integer', description: 'Same as -C.' },
        '-n':        { type: 'boolean', description: 'Show line numbers (content mode). Defaults to true.' },
        '-i':        { type: 'boolean', description: 'Case insensitive.' },
        type:        { type: 'string', description: 'rg --type filter (js, py, rust, ...).' },
        head_limit:  { type: 'integer', description: 'Cap entries (default 250, 0 = unlimited).' },
        offset:      { type: 'integer', description: 'Skip first N entries before applying head_limit.' },
        multiline:   { type: 'boolean', description: 'Enable rg -U --multiline-dotall.' }
      },
      required: ['pattern']
    }
  }
};

function buildArgs(input) {
  const mode = input.output_mode || DEFAULT_OUTPUT_MODE;
  const args = [];

  switch (mode) {
    case 'files_with_matches': args.push('-l'); break;
    case 'count':              args.push('-c'); break;
    case 'content':            /* default — no flag */ break;
    default: return { error: 'bad_args', detail: 'unknown output_mode: ' + mode };
  }

  if (mode === 'content') {
    const lineNumbers = input['-n'];
    // -n defaults to true per Claude spec; null/undefined → include.
    if (lineNumbers !== false) args.push('-n');
    const before = input['-B'];
    const after  = input['-A'];
    const both   = input['-C'] != null ? input['-C'] : input.context;
    if (both != null)   args.push('-C', String(both));
    if (before != null) args.push('-B', String(before));
    if (after != null)  args.push('-A', String(after));
  }

  if (input['-i']) args.push('-i');
  if (input.type)  args.push('--type', String(input.type));
  if (input.glob)  args.push('--glob', String(input.glob));
  if (input.multiline) { args.push('-U', '--multiline-dotall'); }

  // Hard-disable colour (rg auto-detects TTY) so our parse is stable.
  args.push('--color=never');
  args.push(String(input.pattern));
  if (input.path) args.push(String(input.path));

  return { args, mode };
}

function applyLimits(lines, offset, head_limit) {
  const start = Math.max(0, offset | 0);
  const sliced = lines.slice(start);
  const cap = head_limit === 0 ? sliced.length : (head_limit > 0 ? head_limit : DEFAULT_HEAD_LIMIT);
  const limited = sliced.slice(0, cap);
  return { entries: limited, appliedOffset: start, appliedLimit: cap, truncated: sliced.length > cap };
}


// ── plain-grep fallback ─────────────────────────────────────────────────────
// A virgin Mac ships no ripgrep at all (macOS has never bundled it), so on a
// customer machine the partner's file search died at first use with
// not_available. troth-cache already degrades to
// system grep; this is the same courtesy for the primary tool. Coverage is
// the common calls — pattern/path/-i/-n/context/glob across the three output
// modes. rg-only powers (--type filters, multiline) stay rg-only and keep the
// honest error, because faking them with BRE grep would return wrong results
// rather than no results.
function runPlainGrep(input, mode) {
  if (input.type || input.multiline) {
    return { error: 'not_available', detail: 'ripgrep (rg) not installed, and --type/multiline need it. Install ripgrep for full search.' };
  }
  const args = ['-rE'];
  if (input['-i']) args.push('-i');
  const ctx = input['-C'] != null ? input['-C'] : input.context;
  if (mode === 'files_with_matches') args.push('-l');
  else if (mode === 'count') args.push('-c');
  else {
    if (input['-n'] !== false) args.push('-n');
    if (input['-A'] != null) args.push('-A', String(input['-A']));
    if (input['-B'] != null) args.push('-B', String(input['-B']));
    if (ctx != null) args.push('-C', String(ctx));
  }
  if (input.glob) args.push('--include=' + input.glob);
  args.push('--exclude-dir=node_modules', '--exclude-dir=.git');
  args.push('--', input.pattern, input.path || '.');
  return new Promise((resolve) => {
    let child;
    try { child = spawn('grep', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: 'not_available', detail: 'neither ripgrep nor grep is available' }); }
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => resolve({ error: 'not_available', detail: 'neither ripgrep nor grep is available' }));
    child.on('close', (code) => {
      if (code > 1) return resolve({ error: 'grep_error', detail: stderr.trim() || 'grep failed' });
      const allLines = stdout.split('\n').filter((l) => l.length > 0);
      const lim = applyLimits(allLines, input.offset, input.head_limit);
      if (mode === 'files_with_matches') {
        return resolve({ mode, engine: 'grep', numFiles: lim.entries.length, filenames: lim.entries,
          appliedOffset: lim.appliedOffset, appliedLimit: lim.appliedLimit, truncated: lim.truncated });
      }
      if (mode === 'count') {
        return resolve({ mode, engine: 'grep', counts: lim.entries,
          appliedOffset: lim.appliedOffset, appliedLimit: lim.appliedLimit, truncated: lim.truncated });
      }
      return resolve({ mode, engine: 'grep', numLines: lim.entries.length, content: lim.entries.join('\n'),
        appliedOffset: lim.appliedOffset, appliedLimit: lim.appliedLimit, truncated: lim.truncated });
    });
  });
}

async function run(args, _ctx) {
  args = args || {};
  if (typeof args.pattern !== 'string' || !args.pattern) {
    return { error: 'bad_args', detail: 'pattern (string) is required' };
  }
  const built = buildArgs(args);
  if (built.error) return built;
  const rgArgs = built.args;
  const mode   = built.mode;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveRg(), rgArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ error: 'spawn_failed', detail: e && e.message || String(e) });
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        // No rg anywhere: degrade to system grep instead of a dead tool.
        return resolve(runPlainGrep(args, mode));
      }
      resolve({ error: 'spawn_failed', detail: e && e.message || String(e) });
    });

    child.on('close', (code) => {
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) {
        return resolve({ error: 'rg_error', detail: stderr.trim() || 'unknown ripgrep error' });
      }
      const allLines = stdout.split('\n').filter((l) => l.length > 0);

      if (mode === 'files_with_matches') {
        const { entries, appliedOffset, appliedLimit } = applyLimits(allLines, args.offset, args.head_limit);
        return resolve({
          mode,
          numFiles:      entries.length,
          filenames:     entries,
          appliedOffset,
          appliedLimit
        });
      }

      if (mode === 'count') {
        // Each line is "path:N". Sort by N desc.
        const parsed = allLines.map((l) => {
          const idx = l.lastIndexOf(':');
          return idx < 0 ? null : { file: l.slice(0, idx), count: parseInt(l.slice(idx + 1), 10) };
        }).filter((x) => x && !isNaN(x.count));
        const { entries, appliedOffset, appliedLimit } = applyLimits(parsed, args.offset, args.head_limit);
        return resolve({
          mode,
          numFiles:      entries.length,
          filenames:     entries.map((e) => e.file),
          counts:        entries.map((e) => e.count),
          numMatches:    entries.reduce((s, e) => s + e.count, 0),
          appliedOffset,
          appliedLimit
        });
      }

      // mode === 'content'
      const { entries, appliedOffset, appliedLimit } = applyLimits(allLines, args.offset, args.head_limit);
      // Count distinct files in the content emission.
      const fileSet = new Set();
      for (const ln of entries) {
        // rg content lines look like "path:line:content" (with -n) or
        // "path:content" (without). Extract path = everything up to
        // the first ':'.
        const idx = ln.indexOf(':');
        if (idx > 0) fileSet.add(ln.slice(0, idx));
      }
      return resolve({
        mode,
        numFiles:    fileSet.size,
        filenames:   Array.from(fileSet),
        content:     entries.join('\n'),
        numLines:    entries.length,
        appliedOffset,
        appliedLimit
      });
    });
  });
}

module.exports = { schema, run };
