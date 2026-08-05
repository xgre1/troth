#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// troth-hashline — hash-anchored edit tool.
//
// Exposes two tools to the model:
//
//   hashline_read(file_path, start_line?, end_line?)
//       Read a file and return it decorated with LINE#TAG|content prefixes.
//       The agent then references lines by these tags when proposing edits,
//       which lets us reject stale edits if the file drifted since read.
//
//   hashline_edit(file_path, edits)
//       Apply one or more edits expressed in {op, pos, end?, lines}
//       format. Runs the batch through:
//         1. Hash validation (drift rejection)
//         2. AST parse check on the resulting content (syntactic safety)
//       Only commits if BOTH pass. Otherwise returns structured errors
//       so the agent can retry with a fresh hashline_read.
//
// Rationale / research: Can Bölük, "The Harness Problem" (Feb 2026).
// Grok Code Fast 1 went from 6.7% → 68.3% on a real-world editing
// benchmark purely by switching from apply_patch to hashline; 14 of 15
// other models tested improved by 5-14 pp. Output tokens drop ~20%.
// Combined with our existing AST pre-write validation, this becomes
// the highest-leverage single architectural lift from 2025-26 research.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const serverDir = fileURLToPath(new URL('.', import.meta.url));
const hashline    = require(serverDir + '../../../shared-core/hashline.js');
const astValidate = require(serverDir + '../../../shared-core/ast-validate.js');
const state       = require(serverDir + '../../../shared-core/state.js');

const TOOLS = [
  {
    name: 'hashline_read',
    description: 'Read a file annotated with LINE#TAG anchors for hash-anchored editing. Required before hashline_edit. Drift-safe: stale anchors are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute file path.' },
        start_line: { type: 'integer', description: '1-based start line (optional).' },
        end_line:   { type: 'integer', description: '1-based inclusive end line (optional).' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'hashline_edit',
    description: 'Apply LINE#TAG-anchored edits in one batch (op: replace/append/prepend). AST-validated for JS/TS/PY/JSON; whole batch rejected on any failure.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op:    { type: 'string', enum: ['replace', 'append', 'prepend'] },
              pos:   { type: 'string', description: 'LINE#TAG anchor, e.g. "42#VK".' },
              end:   { type: 'string', description: 'Optional range end (LINE#TAG).' },
              lines: { description: 'string | string[] | null (null = delete line).' }
            },
            required: ['op', 'pos']
          }
        }
      },
      required: ['file_path', 'edits']
    }
  }
];

function textReply(text) {
  return { content: [{ type: 'text', text }] };
}

function errorReply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError: true };
}

async function handleTool(name, args) {
  try {
    if (name === 'hashline_read') return await handleRead(args);
    if (name === 'hashline_edit') return await handleEdit(args);
    return errorReply({ error: 'unknown_tool', name });
  } catch (e) {
    return errorReply({ error: 'exception', message: String(e && e.message || e) });
  }
}

function handleRead(args) {
  const fp = args.file_path;
  if (!fp) return errorReply({ error: 'missing_file_path' });
  const abs = resolve(fp);
  if (!existsSync(abs)) return errorReply({ error: 'not_found', path: abs });

  let content;
  try { content = readFileSync(abs, 'utf8'); }
  catch (e) { return errorReply({ error: 'read_failed', message: String(e.message) }); }

  const { decorated } = hashline.encodeFile(content);
  let out = decorated;

  if (args.start_line || args.end_line) {
    const allLines = out.split('\n');
    const from = Math.max(1, parseInt(args.start_line || 1, 10)) - 1;
    const to   = Math.min(allLines.length, parseInt(args.end_line || allLines.length, 10));
    out = allLines.slice(from, to).join('\n');
  }

  // Log hook event so the dashboard can attribute reads to hashline
  // (counts toward the auto-tuner's telemetry on edit-format usage).
  try {
    state.recordHookEvent({
      event: 'mcp.hashline_read',
      tool: 'hashline_read',
      decision: 'allow',
      tokens_out: Math.ceil(out.length / 4),
      metadata: JSON.stringify({ file: abs, bytes: content.length, line_count: content.split('\n').length })
    });
  } catch (_) { /* telemetry never blocks */ }

  return textReply(out);
}

function handleEdit(args) {
  const fp = args.file_path;
  if (!fp) return errorReply({ error: 'missing_file_path' });
  const abs = resolve(fp);
  if (!existsSync(abs)) return errorReply({ error: 'not_found', path: abs });

  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return errorReply({ error: 'empty_edits' });
  }

  let content;
  try { content = readFileSync(abs, 'utf8'); }
  catch (e) { return errorReply({ error: 'read_failed', message: String(e.message) }); }

  // 1. Hash validation + apply
  const result = hashline.applyEdits(content, edits);
  if (!result.ok) {
    // Return the current (post-drift) decoration so the agent can retry
    // without re-calling hashline_read.
    const fresh = hashline.encodeFile(content).decorated;
    try {
      state.recordHookEvent({
        event: 'mcp.hashline_edit',
        tool: 'hashline_edit',
        decision: 'block',
        reason: 'hash_mismatch_or_bad_ref',
        metadata: JSON.stringify({ file: abs, errors: result.errors })
      });
    } catch (_) {}
    return errorReply({
      error: 'edit_rejected',
      errors: result.errors,
      hint: 'At least one LINE#TAG is stale or invalid. Re-read with the current content below and retry.',
      current: fresh
    });
  }

  // 2. AST parse check on the resulting content. Skipped for
  //    extensions the validator doesn't support (rust/go/md/...).
  const check = astValidate.validate(abs, result.content);
  if (!check.ok && !check.skipped) {
    try {
      state.recordHookEvent({
        event: 'mcp.hashline_edit',
        tool: 'hashline_edit',
        decision: 'block',
        reason: 'ast_parse_failed',
        metadata: JSON.stringify({ file: abs, errors: check.errors })
      });
    } catch (_) {}
    return errorReply({
      error: 'ast_parse_failed',
      errors: check.errors,
      hint: 'The proposed edits would leave the file in a syntactically invalid state. Review the error and submit a corrected batch.'
    });
  }

  // 3. Commit.
  try { writeFileSync(abs, result.content); }
  catch (e) { return errorReply({ error: 'write_failed', message: String(e.message) }); }

  try {
    state.recordHookEvent({
      event: 'mcp.hashline_edit',
      tool: 'hashline_edit',
      decision: 'allow',
      tokens_in: edits.reduce((a, e) => a + JSON.stringify(e).length, 0) / 4 | 0,
      metadata: JSON.stringify({
        file: abs,
        edit_count: edits.length,
        applied: result.applied,
        ast_ok: !!check.ok,
        ast_skipped: !!check.skipped
      })
    });
    state.recordSavings('hashline_edit_applied', edits.length, null, 'file=' + abs);
  } catch (_) {}

  return textReply(JSON.stringify({
    ok: true,
    file: abs,
    edit_count: edits.length,
    applied: result.applied,
    ast_ok: !!check.ok,
    ast_skipped: !!check.skipped
  }, null, 2));
}

// ── MCP stdio loop ──────────────────────────────────────────────────────
let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  inputBuffer += chunk;
  let idx;
  while ((idx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, idx);
    inputBuffer = inputBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    await handleUpstream(msg);
  }
});

async function handleUpstream(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  };
  const replyError = (err) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: String(err && err.message || err) }
    }) + '\n');
  };
  try {
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'troth-hashline', version: '1.0.0' }
      });
    } else if (msg.method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      reply(await handleTool(msg.params.name, msg.params.arguments || {}));
    } else if (msg.method === 'ping') {
      reply({});
    } else {
      reply({});
    }
  } catch (e) { replyError(e); }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
