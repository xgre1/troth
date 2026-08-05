#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// P13.2 — OMEGA-style reactive memory surfacing.
//
// After the agent completes a Read / Grep / Glob / Edit / Write / Bash,
// look for prior verified ActionRecords that touched the same file or
// the same query. If we find any, surface them as additionalContext —
// reactive push, not proactive. This replaces the per-turn precedent
// block in the injector (P13.1 removed that), giving the model the
// information only when it's actually relevant to the action just
// taken. Cap the surfaced text at 500 chars to stay within the L2
// trigger-budget recommended by the MemPalace spatial-stack research.
//
// Source patterns: OMEGA's 95.4% LongMemEval result is driven by this
// exact mechanic — PostToolUse hook → vector+FTS5 search → push only
// records that match the current action.

import { createRequire } from 'node:module';
import { readStdinJson, allow, addContext, log } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let query; // fail-open: bare marketplace clone has no node_modules
try { query = require(pluginRoot + '/../shared-core/query.js'); } catch (_) { console.log('{}'); process.exit(0); }
let state; // fail-open: bare marketplace clone has no node_modules
try { state = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
const MAX_CHARS = 500;        // L2 trigger-push budget
const MAX_RECORDS = 3;         // Cap how many prior records we surface

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const cwd     = payload.cwd || process.cwd();
const session = payload.session_id || null;

if (!session || !tool) { allow(); }

// Decide what to look for based on the tool. For file-touching tools,
// match on file_path. For searches, match on the query string. Skip
// anything where we don't have a useful identifier.
let target = null;
if (/^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
  target = { kind: 'file', path: input.file_path };
} else if (/^(Grep|Glob)$/.test(tool)) {
  target = { kind: 'search', query: input.pattern || input.query || input.path };
}
if (!target || (target.kind === 'file' && !target.path) ||
    (target.kind === 'search' && !target.query)) { allow(); }

let surfaced = [];
try {
  if (target.kind === 'file') {
    // Find prior verified edits to this same file.
    const c = state._dbForQuery && state._dbForQuery();
    if (c) {
      const rows = c.prepare(
        `SELECT id, timestamp, session_id, type, input, verification
         FROM action_records
         WHERE type='edit' AND cwd = ? AND
               json_extract(input,'$.file_path') = ? AND
               json_extract(verification,'$.ast.ok') = 1 AND
               session_id != ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(cwd, target.path, session, MAX_RECORDS);
      surfaced = rows.map(r => {
        const inp = r.input ? (typeof r.input === 'string' ? JSON.parse(r.input) : r.input) : {};
        const ts = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        return '  · ' + ts + ' · session=' + (r.session_id || '?').slice(0, 8) +
               ' · format=' + (inp.format || '?') + ' (id ' + r.id.slice(0, 8) + ')';
      });
    }
  } else if (target.kind === 'search') {
    // Find prior search records with the same query string.
    const c = state._dbForQuery && state._dbForQuery();
    if (c) {
      const rows = c.prepare(
        `SELECT id, timestamp, session_id, input, output
         FROM action_records
         WHERE type='search' AND cwd = ? AND
               json_extract(input,'$.query') = ? AND
               session_id != ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(cwd, String(target.query), session, MAX_RECORDS);
      surfaced = rows.map(r => {
        const out = r.output ? (typeof r.output === 'string' ? JSON.parse(r.output) : r.output) : {};
        const ts = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        return '  · ' + ts + ' · ' + (out.result_count || 0) + ' hits (id ' + r.id.slice(0, 8) + ')';
      });
    }
  }
} catch (e) { /* never break the hook */ }

// (P16 Tier 2 intent → edit edge creation moved to mark-edit.mjs to
// eliminate the cross-hook race: post-action-recall and mark-edit fire
// in parallel within the same PostToolUse matcher entry, so this hook
// could not reliably read the just-written edit row. Edge creation now
// lives where the row is written.)

if (!surfaced.length) { allow(); }

let body;
if (target.kind === 'file') {
  body = '[troth/recall] Prior verified edits to this file in other sessions:\n' +
         surfaced.join('\n') +
         '\nCall troth_fetch_action({id}) on any id above to load the full record.';
} else {
  body = '[troth/recall] Prior identical searches in this project:\n' +
         surfaced.join('\n') +
         '\nResults are cached; call troth_fetch_action({id}) for prior result paths.';
}

if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS - 12) + '\n…(truncated)';

log('PostToolUse.recall', {
  session_id: session, tool,
  metadata: { kind: target.kind, surfaced: surfaced.length, bytes: body.length }
});

addContext(body);
