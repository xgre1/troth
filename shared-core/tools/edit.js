// SPDX-License-Identifier: AGPL-3.0-only
// Edit — adaptive multi-format edit tool, canonical Claude Code surface.
//
// Two dispatch paths, picked from the args shape:
//
//   1. HASHLINE MODE — args.edits is an array.
//      Each entry: { op:'replace'|'append'|'prepend', pos:'N#XY', end?:'N#XY',
//                    lines: string | string[] | null }.
//      Routed through shared-core/hashline.js applyEdits, which validates
//      every line tag against current file content before any edit lands.
//      Drift between read-time and edit-time fails the whole batch (safe).
//      This is troth's edge: content-addressed editing, immune to the
//      whitespace fragility documented for find-and-replace
//      (Aider unified-diff: GPT-4 Turbo 20% → 61%; Can Bölük hashline:
//      +61.6 pt on Grok Code Fast).
//
//   2. SEARCH-REPLACE MODE — args.old_string + args.new_string (Claude
//      canonical schema). Falls through 4 strategies via
//      shared-core/editmatch.js (exact → trim → collapse → anchor)
//      before declaring a miss. Honors replace_all when set.
//
// Both modes share a single write path that delegates to Write.run()
// same atomic temp+fsync+SHA-256+rename + AST gate as standalone
// writes. Edit therefore inherits "never leaves a torn file, never
// commits broken syntax" for free.
//
// Output: canonical FileEditOutput shape from sdk-tools.d.ts:
//   { filePath, oldString, newString, originalFile, structuredPatch[],
//     userModified, replaceAll, ... } — augmented with `mode` and
//   `strategy` so the caller can audit which path was taken.

const fs   = require('fs');
const path = require('path');

const hashline   = require('../hashline.js');
const editmatch  = require('../editmatch.js');
const writeTool  = require('./write.js');

const schema = {
  type: 'function',
  function: {
    name: 'Edit',
    description: 'Modify a file. Two modes: (1) HASHLINE — pass edits=[{op,pos,end?,lines}] referencing line tags from a prior Read with hashline=true; whitespace-immune and content-addressed, fails fast on file drift. (2) SEARCH-REPLACE — pass old_string + new_string (Claude canonical); cascades through fuzzy strategies (exact → trim → whitespace-collapse → anchor) so a near-miss old_string usually rescues itself instead of forcing a re-read. Both modes go through the same atomic write + AST gate as Write.',
    parameters: {
      type: 'object',
      properties: {
        file_path:   { type: 'string', description: 'Absolute path to the file to modify.' },
        old_string:  { type: 'string', description: 'Search-replace mode: the text to replace.' },
        new_string:  { type: 'string', description: 'Search-replace mode: the text to replace it with (must differ from old_string).' },
        replace_all: { type: 'boolean', description: 'Search-replace mode: replace every occurrence (default false).' },
        edits: {
          type: 'array',
          description: 'Hashline mode: array of {op,pos,end?,lines} edits referencing line tags from a Read(hashline=true) call.',
          items: { type: 'object' }
        }
      },
      required: ['file_path']
    }
  }
};

// Read a file; bubble structured errors that match Write/Read conventions.
function readFile(file_path) {
  try { return { ok: true, content: fs.readFileSync(file_path, 'utf8') }; }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: { error: 'not_found', file_path } };
    if (e && e.code === 'EACCES') return { ok: false, error: { error: 'permission_denied', file_path } };
    if (e && e.code === 'EISDIR') return { ok: false, error: { error: 'is_directory', file_path } };
    return { ok: false, error: { error: 'read_failed', file_path, detail: e && e.message || String(e) } };
  }
}

// Single-hunk structured patch for the canonical FileEditOutput.
// Same shape as Write's patch — minimal but conformant. A future
// revision can swap in LCS hunk extraction without changing callers.
function buildStructuredPatch(originalFile, newContent) {
  const oldLines = originalFile.split('\n');
  const newLines = newContent.split('\n');
  const lines = [];
  for (const l of oldLines) lines.push('-' + l);
  for (const l of newLines) lines.push('+' + l);
  return [{
    oldStart: oldLines.length ? 1 : 0,
    oldLines: oldLines.length,
    newStart: newLines.length ? 1 : 0,
    newLines: newLines.length,
    lines
  }];
}

// ── Mode A: hashline ───────────────────────────────────────────────────
async function runHashline(args) {
  const file_path = args.file_path;
  const r = readFile(file_path);
  if (!r.ok) return r.error;
  const original = r.content;

  const applied = hashline.applyEdits(original, args.edits);
  if (!applied.ok) {
    return {
      error: 'hashline_edits_failed',
      mode:  'hashline',
      file_path,
      errors: applied.errors || []
    };
  }

  const written = await writeTool.run({ file_path, content: applied.content }, {});
  if (written.error) return Object.assign({ mode: 'hashline' }, written);

  return {
    filePath:        file_path,
    mode:            'hashline',
    strategy:        'hashline_tag',
    oldString:       null,
    newString:       null,
    originalFile:    original,
    structuredPatch: buildStructuredPatch(original, applied.content),
    userModified:    false,
    replaceAll:      false,
    appliedEdits:    applied.applied || []
  };
}

// ── Mode B: search-replace with fuzzy cascade ──────────────────────────
async function runSearchReplace(args) {
  const file_path  = args.file_path;
  const old_string = args.old_string;
  const new_string = args.new_string;
  const replace_all = !!args.replace_all;

  if (typeof old_string !== 'string' || typeof new_string !== 'string') {
    return { error: 'bad_args', detail: 'old_string and new_string must be strings' };
  }
  if (old_string === new_string) {
    return { error: 'bad_args', detail: 'new_string must differ from old_string' };
  }

  const r = readFile(file_path);
  if (!r.ok) return r.error;
  const original = r.content;

  // Cascading strategies. exact first (cheapest + most common); fall
  // through to trim → collapse → anchor only if exact didn't find the
  // string. Each strategy returns the canonical substring that lives
  // in the file, so the actual replacement is on the rescued exact form.
  const strategies = [
    () => editmatch.exactMatch(original, old_string),
    () => editmatch.trimMatch(original, old_string),
    () => editmatch.collapseMatch(original, old_string),
    () => editmatch.anchorMatch(original, old_string)
  ];
  let match = null;
  for (const fn of strategies) {
    const m = fn();
    if (m) { match = m; break; }
  }
  if (!match) {
    return {
      error: 'old_string_not_found',
      mode:  'search_replace',
      file_path,
      hint:  'tried strategies: exact, trim, collapse, anchor'
    };
  }

  // Apply.
  let newContent;
  if (replace_all) {
    // We re-locate the rescued exact substring globally. Note: when
    // replace_all is set, we operate on the EXACT form from the file
    // (rescued), not the model's possibly-fuzzy original.
    newContent = original.split(match.exact).join(new_string);
  } else {
    const idx = original.indexOf(match.exact);
    newContent = original.slice(0, idx) + new_string + original.slice(idx + match.exact.length);
  }

  // Sanity: the no-op edit (old_string and new_string differ in the
  // model's view but happen to collapse to the same on-disk content
  // possible when old_string only differed in whitespace that
  // didn't actually exist) should not commit. Surfaces the model's
  // intent failure structurally.
  if (newContent === original) {
    return {
      error: 'no_change',
      mode:  'search_replace',
      file_path,
      strategy: match.strategy
    };
  }

  const written = await writeTool.run({ file_path, content: newContent }, {});
  if (written.error) return Object.assign({ mode: 'search_replace', strategy: match.strategy }, written);

  return {
    filePath:        file_path,
    mode:            'search_replace',
    strategy:        match.strategy,
    oldString:       old_string,
    newString:       new_string,
    originalFile:    original,
    structuredPatch: buildStructuredPatch(original, newContent),
    userModified:    false,
    replaceAll:      replace_all,
    rescuedFrom:     match.strategy === 'exact' ? null : match.exact
  };
}

// ── Public dispatcher ──────────────────────────────────────────────────
async function run(args, _ctx) {
  args = args || {};
  const file_path = args.file_path;
  if (!file_path || typeof file_path !== 'string') {
    return { error: 'bad_args', detail: 'file_path is required' };
  }
  if (!path.isAbsolute(file_path)) {
    return { error: 'bad_args', detail: 'file_path must be absolute' };
  }
  if (Array.isArray(args.edits)) {
    return runHashline(args);
  }
  if (typeof args.old_string === 'string') {
    return runSearchReplace(args);
  }
  return {
    error: 'bad_args',
    detail: 'pass either edits=[{op,pos,...}] (hashline mode) or old_string+new_string (search-replace mode)'
  };
}

module.exports = { schema, run };
