#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// output-sandbox — PostToolUse hook that archives heavy tool outputs into
// the shared SQLite/FTS5 store so the agent can later recall them via the
// troth-archive MCP without re-running the command.
//
// Scope reality check (per research & GH issue #32105):
//   - updatedMCPToolOutput on this hook MUTATES the response for MCP tools.
//   - For built-in Read/Grep/Glob, hooks cannot rewrite output yet, so we
//     archive-only; the agent sees the raw response but the archive makes
//     future drill-down cheap via archive_search / archive_excerpt.
//
// Heuristic: only archive if the response is larger than 4KB. Smaller
// outputs are cheap and archival would just add noise.

import { readStdinJson, allow, log, state, recordAction } from './_lib.mjs';

const ARCHIVE_MIN_BYTES = 4000;
const SUMMARY_MAX_CHARS = 800;

function extractResponseText(payload) {
  // tool_response shape varies by tool. Try the common paths.
  const r = payload.tool_response;
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.output === 'string') return r.output;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    return r.content
      .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
      .map(c => c.text || '')
      .join('\n');
  }
  // Fallback: stringify.
  try { return JSON.stringify(r); } catch { return ''; }
}

function makeSummary(tool, raw) {
  const lines = raw.split('\n');
  const head = lines.slice(0, 10).join('\n');
  const tail = lines.length > 20 ? '\n…\n' + lines.slice(-5).join('\n') : '';
  const preview = (head + tail).slice(0, SUMMARY_MAX_CHARS);
  return '[' + tool + ' output archived — ' + raw.length + ' chars, ' + lines.length + ' lines]\n' + preview;
}

function isMcpTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith('mcp__');
}

const payload = await readStdinJson();
const tool = payload.tool_name || '';
const session = payload.session_id || null;
const raw = extractResponseText(payload);
const bytes = Buffer.byteLength(raw || '', 'utf8');

if (bytes < ARCHIVE_MIN_BYTES) { allow(); }

let archiveId = null;
let summary = '';
try {
  summary = makeSummary(tool, raw);
  archiveId = state.archiveToolOutput(session, tool, raw, summary);
  state.recordSavings('output_archive', bytes, session, tool + ' → archive_id=' + archiveId);
} catch (e) {
  // Never let archival failure break the turn.
  process.stderr.write('[troth/output-sandbox] archive failed: ' + e.message + '\n');
  allow();
}

log('PostToolUse.output-sandbox', {
  session_id: session,
  tool,
  reason: 'archived',
  tokens_in: Math.round(bytes / 3.3),
  metadata: { archive_id: archiveId, bytes }
});
recordAction({
  type: 'tool_call',
  session_id: session, cwd: payload.cwd,
  input: { tool_name: tool, args: payload.tool_input || {} },
  output: {
    status: 'archived',
    bytes,
    compressed: true,
    archive_id: archiveId
  }
});

// For MCP tools, we CAN rewrite the output that reaches the model.
// Returning updatedMCPToolOutput replaces what the agent sees with our
// summary — real context savings. For built-in tools this field is a
// no-op per the plugin docs, but we still return it harmlessly so the
// hook code path is uniform.
if (isMcpTool(tool)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: summary + '\n\n[troth: full output archived as archive_id=' + archiveId + '. Retrieve it with mcp_call({server:"troth-memory", tool:"archive_excerpt", args:{archive_id:"' + archiveId + '", start_line:1, end_line:200}}), or archive_search to find it by keyword.]'
    }
  }));
  process.exit(0);
}

// Built-in tool path: archive only, emit nothing.
allow();
