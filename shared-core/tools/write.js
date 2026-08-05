// SPDX-License-Identifier: AGPL-3.0-only
// Write — file-content writer, canonical Claude Code shape.
//
// Output mirrors FileWriteOutput from sdk-tools.d.ts:
//   { type:'create'|'update', filePath, content, originalFile, structuredPatch[] }
//
// Durability path (industry best-practice, not Resilient Write's
// six-layer speculative scheme): write to a temp file in the SAME
// directory as the target so rename is an atomic move on the same
// filesystem, fsync to flush kernel buffers, re-read and SHA-256
// verify against the input bytes, then rename. If anything fails
// (no parent dir, EACCES, SHA mismatch), the target file is left
// untouched — never partially overwritten.
//
// AST gate: before the rename, content is run through
// shared-core/ast-validate.js. Syntax errors for JS/TS/JSX/TSX/PY/JSON
// abort the write with a structured `ast_invalid` error the model can
// recover from. Unsupported extensions pass through silently — false
// positives are the enemy.
//
// Structured patch: a minimal single-hunk patch is returned so the
// model (and downstream UI) can see what changed without doing a
// separate diff. For create we emit one all-additions hunk; for
// update one whole-file replacement hunk. A future revision can swap
// in a real LCS-based hunk extractor — the wire shape stays the same.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const astValidate = require('../ast-validate.js');

const MAX_BYTES_HARD_CAP = 50 * 1024 * 1024;  // refuse >50MB writes

const schema = {
  type: 'function',
  function: {
    name: 'Write',
    description: 'Write content to a file on the local filesystem. Creates the file if missing, replaces it if present. Writes are atomic (temp + fsync + SHA-256 verify + rename) so a failed write never leaves a partial file. JS/TS/Python/JSON content is parsed before commit — syntactically broken content is rejected with `ast_invalid` so you can fix and retry without a separate read turn.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write.' },
        content:   { type: 'string', description: 'The content to write to the file.' }
      },
      required: ['file_path', 'content']
    }
  }
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Single-hunk structured patch. Shape matches FileWriteOutput's
// structuredPatch entries: { oldStart, oldLines, newStart, newLines, lines }.
function buildStructuredPatch(originalFile, newContent) {
  const oldLines = originalFile === null ? [] : originalFile.split('\n');
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

async function run(args, _ctx) {
  args = args || {};
  const file_path = args.file_path;
  const content   = args.content;
  if (!file_path || typeof file_path !== 'string') {
    return { error: 'bad_args', detail: 'file_path is required' };
  }
  if (!path.isAbsolute(file_path)) {
    return { error: 'bad_args', detail: 'file_path must be absolute' };
  }
  if (typeof content !== 'string') {
    return { error: 'bad_args', detail: 'content must be a string' };
  }
  const inputBytes = Buffer.from(content, 'utf8');
  if (inputBytes.length > MAX_BYTES_HARD_CAP) {
    return { error: 'too_large', size_bytes: inputBytes.length, cap: MAX_BYTES_HARD_CAP };
  }

  // Read existing file (if any) so we can report originalFile and
  // distinguish create vs update.
  let originalFile = null;
  let exists = false;
  try {
    originalFile = fs.readFileSync(file_path, 'utf8');
    exists = true;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      if (e.code === 'EACCES') return { error: 'permission_denied', file_path };
      if (e.code === 'EISDIR') return { error: 'is_directory', file_path };
      return { error: 'read_existing_failed', file_path, detail: e && e.message || String(e) };
    }
  }

  // AST gate. Only fires for supported extensions; everything else
  // passes through. We never block on `skipped` results.
  const astCheck = astValidate.validate(file_path, content);
  if (astCheck && astCheck.ok === false) {
    return {
      error: 'ast_invalid',
      language: astCheck.language,
      file_path,
      errors:   astCheck.errors
    };
  }

  // Ensure parent directory exists. Mirror Claude Code's canonical Write
  // and the intent:fs:do write dispatcher (which already mkdir -p's): create
  // the parent tree if missing so a write into a not-yet-existing folder
  // succeeds in one step. Previously this returned 'parent_missing', which
  // stalled autonomous goals whose step had no shell tool to mkdir first
  // (the worker literally reported "Write doesn't create parent directories,
  // and I have no Bash" and filed an operator request instead of finishing).
  const parentDir = path.dirname(file_path);
  try { fs.mkdirSync(parentDir, { recursive: true }); }  // no-op if it already exists
  catch (e) {
    if (e && e.code === 'EACCES')  return { error: 'permission_denied', file_path };
    if (e && e.code === 'ENOTDIR') return { error: 'parent_not_dir', parent: parentDir };
    return { error: 'parent_mkdir_failed', parent: parentDir, detail: e && e.message || String(e) };
  }

  // Atomic write: temp file in parent dir → fsync → SHA verify → rename.
  // Temp name uses pid + random suffix to avoid collisions across
  // concurrent writers and to avoid stale-temp issues from earlier
  // crashed processes.
  const tempPath = path.join(
    parentDir,
    '.' + path.basename(file_path) + '.troth-' + process.pid + '-' +
      crypto.randomBytes(4).toString('hex') + '.tmp'
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o644);
    fs.writeSync(fd, inputBytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    if (e && e.code === 'EACCES') return { error: 'permission_denied', file_path };
    if (e && e.code === 'ENOSPC') return { error: 'no_space', file_path };
    return { error: 'temp_write_failed', file_path, detail: e && e.message || String(e) };
  }

  // SHA-256 verify: read the temp back and confirm it matches the
  // bytes we intended. Catches torn writes, encoding bugs, and the
  // (very rare) case where another process mutated the temp before
  // we got to rename.
  const expectedHash = sha256(inputBytes);
  let actualHash;
  try { actualHash = sha256(fs.readFileSync(tempPath)); }
  catch (e) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    return { error: 'temp_readback_failed', file_path, detail: e && e.message || String(e) };
  }
  if (actualHash !== expectedHash) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    return {
      error: 'sha_mismatch',
      file_path,
      expected: expectedHash,
      got:      actualHash
    };
  }

  // Atomic rename. Same filesystem, so this is a single inode swap.
  try { fs.renameSync(tempPath, file_path); }
  catch (e) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    if (e && e.code === 'EACCES') return { error: 'permission_denied', file_path };
    return { error: 'rename_failed', file_path, detail: e && e.message || String(e) };
  }

  return {
    type:           exists ? 'update' : 'create',
    filePath:       file_path,
    content,
    originalFile,
    structuredPatch: buildStructuredPatch(originalFile, content)
  };
}

module.exports = { schema, run };
