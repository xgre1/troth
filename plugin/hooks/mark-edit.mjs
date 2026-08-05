#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// mark-edit — PostToolUse for Edit/Write/MultiEdit/NotebookEdit. Writes
// a `type: 'edit'` ActionRecord to the substrate so cross-session
// precedent queries (query.getVerifiedActions) have data to surface.
//
// Before this hook existed, only hashline_edit produced edit records.
// Default tool sessions left Layer 1 empty, which made Layer 2's
// precedent injection inert (see the substrate design notes).
//
// Shape the substrate expects (action-record.js → TYPES.edit):
//   input:  { file_path, format, hash_before? }
//   output: { hash_after, lines_changed? }
//   verification: { ast: { ok, skipped, errors? } }

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readStdinJson, allow, log, recordAction, featureEnabled } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const verification = require(pluginRoot + '/../shared-core/verification.js');

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const session = payload.session_id || null;

// Only the file-editing tools; everything else passes through untouched.
const FORMAT = {
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'multiedit',
  NotebookEdit: 'notebook_edit'
};
const format = FORMAT[tool];
if (!format) { allow(); }

const target = input.file_path || input.notebook_path;
if (!target) { allow(); }

const abs = resolve(target);

// The tool has already run by the time PostToolUse fires, so read the
// current file state to compute the "after" hash and run AST verification.
let content = null;
let hashAfter = null;
try {
  if (existsSync(abs)) {
    content = readFileSync(abs, 'utf8');
    hashAfter = createHash('sha256').update(content).digest('hex');
  }
} catch (e) {
  // Filesystem blip — record the attempt with a skipped verification
  // rather than dropping the event entirely. The write DID happen from
  // the agent's perspective.
  log('PostToolUse.mark-edit', {
    session_id: session, tool,
    metadata: { path: abs, error: e.message }
  });
  recordAction({
    type: 'edit',
    session_id: session, cwd: payload.cwd,
    input:  { file_path: abs, format },
    output: { hash_after: null, read_error: e.message },
    verification: { ast: { ok: null, skipped: true } }
  });
  allow();
}

// hash_before is only available when the tool reported it (Edit/MultiEdit
// echo pre-image hashes on some backends; not guaranteed). Best-effort.
const resp = payload.tool_response || {};
const hashBefore = resp.hash_before || null;
const linesChanged = resp.lines_changed || null;

// AST verification is the single strongest "did we break the file" signal
// we already implement. skipped for unsupported languages (rust, go, md,
// plain text) — which is correct; we don't want false positives.
let astResult = { ok: null, skipped: true };
if (content !== null) {
  try { astResult = verification.verifyAST(abs, content); }
  catch (e) { astResult = { ok: false, skipped: false, errors: [{ kind: 'verify_error', message: e.message }] }; }
}

log('PostToolUse.mark-edit', {
  session_id: session, tool,
  metadata: {
    path: abs,
    ast_ok: astResult.ok,
    ast_skipped: !!astResult.skipped
  }
});

// codelens entity attachment — bridges substrate edits to the
// code-graph. Out-of-process from the proxy, so we open the per-project
// codelens SQLite directly. Path mirrors codelens/index.js:91-99: a sha256
// hash of the watch dir, first 12 chars. Best-effort: missing DB or read
// error degrades to no-op rather than failing the edit record.
let codelensEntityIds = null;
let codelensSymbols = null;
try {
  const homeDir = process.env.HOME || (await import('node:os')).homedir();
  const watchDir = process.env.GF_WATCH_DIR || payload.cwd || process.cwd();
  const dirHash = createHash('sha256').update(watchDir).digest('hex').slice(0, 12);
  const clDbPath = `${homeDir}/.troth/codelens/${dirHash}.db`;
  if (existsSync(clDbPath)) {
    const Database = require('better-sqlite3');
    const cldb = new Database(clDbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = cldb.prepare(
        'SELECT id, name, type FROM entities WHERE file_path = ? LIMIT 50'
      ).all(abs);
      if (rows.length) {
        codelensEntityIds = rows.map(r => r.id);
        codelensSymbols = rows.slice(0, 8).map(r => `${r.type}:${r.name}`);
      }
    } finally { cldb.close(); }
  }
} catch (e) {
  // Codelens index missing or unreadable — substrate edit still records.
}

const editId = recordAction({
  type: 'edit',
  session_id: session, cwd: payload.cwd,
  input:  { file_path: abs, format, hash_before: hashBefore },
  output: {
    hash_after: hashAfter,
    lines_changed: linesChanged,
    codelens_entity_ids: codelensEntityIds,
    codelens_symbols: codelensSymbols
  },
  verification: { ast: astResult }
});

// ── P16 Tier 2: link this edit back to its driving intent ─────────────────
// Co-locating the edge creation here (instead of in post-action-recall.mjs)
// eliminates the cross-hook race: that hook fires in parallel with this one,
// so it would query for the just-written edit row before recordAction had
// committed it. Here we own the row id directly.
//
// Gated on TROTH_CAPTURE_INTENT=1 — same flag as intent-capture.
if (editId && featureEnabled('capture_intent')) {
  try {
    const state = require(pluginRoot + '/../shared-core/state.js');
    const cwd = payload.cwd || process.cwd();
    const c = state._dbForQuery && state._dbForQuery();
    if (c) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      const basename = abs.split('/').pop();
      // Strict same-session join is the happy path; cwd+window fallback
      // covers the case where CC splits a single user prompt across
      // session_ids (UserPromptSubmit on one, PostToolUse on another).
      let intents = c.prepare(
        `SELECT id, input FROM action_records
         WHERE type='intent' AND session_id = ? AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT 5`
      ).all(session, cutoff);
      if (!intents.length) {
        intents = c.prepare(
          `SELECT id, input FROM action_records
           WHERE type='intent' AND cwd = ? AND timestamp >= ?
           ORDER BY timestamp DESC LIMIT 5`
        ).all(cwd, cutoff);
      }
      let matched = null;
      for (const r of intents) {
        const inp = typeof r.input === 'string' ? JSON.parse(r.input) : r.input;
        const haystack = ((inp.goal || '') + ' ' + (inp.acceptance_criteria || '')).toLowerCase();
        if (haystack.includes(abs.toLowerCase()) ||
            haystack.includes(basename.toLowerCase())) {
          matched = r; break;
        }
      }
      // Fallback: when intent-extract couldn't capture the implicit file
      // (e.g. user said "Add a test" without specifying test/all.test.js),
      // there's no path/basename match — but if exactly ONE intent exists
      // in this session+cwd window, it's almost certainly the driver of
      // this edit. Strict-session bound keeps false-positive risk low.
      if (!matched && intents.length === 1) matched = intents[0];
      if (matched) {
        state.recordEdge({
          from_id: matched.id, to_id: editId,
          label: 'produces_edit', weight: 0.7
        });
        // satisfies edge only if AST verification passed (skipped counts
        // as "not failing" per the same convention as the recall hook).
        if (astResult && astResult.ok === true) {
          state.recordEdge({
            from_id: editId, to_id: matched.id,
            label: 'satisfies', weight: 1.0
          });
        }
      }
    }
  } catch (e) {
    process.stderr.write('[troth intent-edge] ' + e.message + '\n');
  }
}

allow();
