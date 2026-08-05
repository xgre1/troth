// SPDX-License-Identifier: AGPL-3.0-only
// Read — file-content reader, canonical Claude Code shape.
//
// Output is the discriminated union FileReadOutput from
// `@anthropic-ai/claude-code/sdk-tools.d.ts`:
//
//   { type:'text', file:{filePath, content, numLines, startLine, totalLines} }
//   { type:'image', file:{base64, type:'image/...', originalSize, dimensions?} }
//   { type:'pdf',   file:{filePath, ...} }
//   { type:'notebook', file:{filePath, cells[]} }
//
// We implement the text branch fully. image/pdf/notebook return
// {type:'unsupported', file:{filePath, kind}} for now — substrate-level
// rendering of those is a separate concern from the core tool.
//
// troth extension (opt-in): args.hashline:true rewrites the content
// into the hashline wire format ("1#AB|line one\n2#CD|line two\n…") via
// shared-core/hashline.js. This is the recommended mode when the model
// plans to call Edit by hashline tag — every line gets a stable hash
// anchor so subsequent edits reference lines unambiguously, avoiding
// the find-and-replace whitespace fragility documented by Can Bölük
// (+61.6 pt lift on Grok Code Fast) and by Aider's unified-diff
// benchmark (GPT-4 Turbo 20% → 61% just by switching edit format).
//
// Errors are returned as a structured payload — never thrown — so the
// agent loop can slot them into the tool_result message and the model
// can recover (try a different path, ask the user, etc.).

const fs   = require('fs');
const path = require('path');

const hashline = require('../hashline.js');

const DEFAULT_LIMIT      = 2000;
const MAX_LINE_LENGTH    = 2000;
const MAX_BYTES_HARD_CAP = 50 * 1024 * 1024;  // refuse >50MB files outright

const IMAGE_EXT    = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const PDF_EXT      = new Set(['.pdf']);
const NOTEBOOK_EXT = new Set(['.ipynb']);

const schema = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read the contents of a file from the local filesystem. Returns content with line numbers (cat -n format) so follow-up Edit calls can reference exact lines. Caps at 2000 lines per call — paginate via offset/limit for larger files. Opt-in: set hashline=true to receive content as line-tagged hashline format ("1#AB|...") which Edit by tag can reliably modify without string-match fragility.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        offset:    { type: 'integer', description: '1-indexed line number to start reading from. Only provide if the file is too large to read at once.', minimum: 1 },
        limit:     { type: 'integer', description: 'Max lines to read. Defaults to 2000.', minimum: 1, maximum: 2000 },
        pages:     { type: 'string',  description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). PDF only.' },
        hashline:  { type: 'boolean', description: 'troth extension. When true, content is returned in hashline wire format ("1#AB|...") for tag-anchored editing.' }
      },
      required: ['file_path']
    }
  }
};

function formatLineNumbered(lines, startLine) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + '…(truncated)';
    }
    out.push((startLine + i) + '\t' + line);
  }
  return out.join('\n');
}

function detectKind(file_path) {
  const ext = path.extname(file_path).toLowerCase();
  if (IMAGE_EXT.has(ext))    return 'image';
  if (PDF_EXT.has(ext))      return 'pdf';
  if (NOTEBOOK_EXT.has(ext)) return 'notebook';
  return 'text';
}

async function run(args, _ctx) {
  args = args || {};
  const file_path = args.file_path;
  if (!file_path || typeof file_path !== 'string') {
    return { error: 'bad_args', detail: 'file_path is required' };
  }
  if (!path.isAbsolute(file_path)) {
    return { error: 'bad_args', detail: 'file_path must be absolute' };
  }
  const offset = Math.max(1, parseInt(args.offset || 1));
  const limit  = Math.max(1, Math.min(DEFAULT_LIMIT, parseInt(args.limit || DEFAULT_LIMIT)));
  let stat;
  try { stat = fs.statSync(file_path); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { error: 'not_found', file_path };
    if (e && e.code === 'EACCES') return { error: 'permission_denied', file_path };
    return { error: 'stat_failed', file_path, detail: e && e.message || String(e) };
  }
  if (stat.isDirectory()) return { error: 'is_directory', file_path };
  if (stat.size > MAX_BYTES_HARD_CAP) {
    return { error: 'too_large', file_path, size_bytes: stat.size, cap: MAX_BYTES_HARD_CAP };
  }

  const kind = detectKind(file_path);
  if (kind !== 'text') {
    // image/pdf/notebook — declare unsupported for now so the model
    // doesn't try to embed binary data through this path. A future
    // version can add the canonical type:'image'|'pdf'|'notebook'
    // branches with base64 / page-extracted / cell-projected payloads.
    return { type: 'unsupported', file: { filePath: file_path, kind } };
  }

  let raw;
  try { raw = fs.readFileSync(file_path, 'utf8'); }
  catch (e) {
    if (e && e.code === 'EACCES') return { error: 'permission_denied', file_path };
    return { error: 'read_failed', file_path, detail: e && e.message || String(e) };
  }
  const allLines = raw.split('\n');
  const totalLines = allLines.length;
  const startIdx = Math.min(offset - 1, totalLines);
  const endIdx   = Math.min(startIdx + limit, totalLines);
  const slice    = allLines.slice(startIdx, endIdx);

  let content;
  if (args.hashline === true) {
    // Hashline mode: feed the SLICE through encodeFile so tags line up
    // with our local line numbering. Tags are computed against each
    // line's normalized content, so the tags remain stable even when
    // the caller paginates. The model can then reference any line by
    // its "N#XY" anchor in a follow-up Edit call.
    const decorated = hashline.encodeFile(slice.join('\n')).decorated;
    // encodeFile numbers from 1 in the slice; rewrite to use the
    // absolute file line numbers so the model's Edit references stay
    // valid against the on-disk file.
    if (offset === 1) {
      content = decorated;
    } else {
      content = decorated.split('\n').map((ln, i) => {
        // Each decorated line starts with "<localN>#<TAG>|".
        const sep = ln.indexOf('|');
        if (sep < 0) return ln;
        const headBar = ln.slice(0, sep);
        const tail    = ln.slice(sep);
        const hash    = headBar.indexOf('#');
        if (hash < 0) return ln;
        const tag = headBar.slice(hash + 1);
        return (offset + i) + '#' + tag + tail;
      }).join('\n');
    }
  } else {
    content = formatLineNumbered(slice, offset);
  }

  return {
    type: 'text',
    file: {
      filePath:   file_path,
      content,
      numLines:   slice.length,
      startLine:  offset,
      totalLines
    }
  };
}

module.exports = { schema, run };
