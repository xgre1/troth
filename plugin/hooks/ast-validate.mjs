#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// AST validator (PreToolUse) — parse the content the model is ABOUT to
// write/edit and refuse if it breaks syntax. Converts a "write broken
// file → re-read → re-edit → fix" 3-turn retry into a single silent
// correction on the current turn.
//
// Scope:
//   Write      → parse input.content directly
//   Edit       → read file, apply old_string→new_string, parse result
//   MultiEdit  → same, sequential edits
//   NotebookEdit → skipped (ipynb is not code until rendered)
//   Other tools → skipped silently
//
// Unsupported extensions (anything beyond JS/TS/JSX/TSX/MJS/CJS/PY/JSON)
// are passed through untouched — false-positive rate is the enemy.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readStdinJson, allow, ask, log, recordAction } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const astValidate = require(pluginRoot + '/../shared-core/ast-validate.js');

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const session = payload.session_id || null;

if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) { allow(); }

const target = input.file_path || input.notebook_path;
if (!target) { allow(); }

const abs = resolve(target);
let contentToCheck = null;

try {
  if (tool === 'Write') {
    contentToCheck = typeof input.content === 'string' ? input.content : '';
  } else if (tool === 'Edit') {
    if (!existsSync(abs)) { allow(); }
    const original = readFileSync(abs, 'utf8');
    contentToCheck = astValidate.applyEdit(
      original, input.old_string, input.new_string, !!input.replace_all
    );
  } else if (tool === 'MultiEdit') {
    if (!existsSync(abs)) { allow(); }
    const original = readFileSync(abs, 'utf8');
    contentToCheck = astValidate.applyMultiEdit(original, input.edits || []);
  }
} catch (e) {
  // Filesystem or application error — don't block the edit; let the
  // real tool surface its own error message.
  log('PreToolUse.ast-validate', {
    session_id: session, tool, decision: 'allow', reason: 'apply_error',
    metadata: { error: e.message }
  });
  allow();
}

// applyEdit returns null when old_string isn't found — that's the real
// tool's problem to report (it'll error with "string not found"). No
// need to duplicate that error here.
if (contentToCheck === null || contentToCheck === undefined) { allow(); }

const result = astValidate.validate(abs, contentToCheck);

if (result.skipped) {
  log('PreToolUse.ast-validate', {
    session_id: session, tool, decision: 'allow', reason: 'skipped_' + result.reason,
    metadata: { path: abs }
  });
  recordAction({
    type: 'decision',
    session_id: session, cwd: payload.cwd,
    input: { kind: 'ast_validate', tool, path: abs },
    output: { decision: 'allow', reason: 'skipped_' + result.reason }
  });
  allow();
}

if (result.ok) {
  log('PreToolUse.ast-validate', {
    session_id: session, tool, decision: 'allow', reason: 'syntax_ok',
    metadata: { path: abs, language: result.language }
  });
  recordAction({
    type: 'decision',
    session_id: session, cwd: payload.cwd,
    input: { kind: 'ast_validate', tool, path: abs, language: result.language },
    output: { decision: 'allow', reason: 'syntax_ok' },
    verification: { ast: { ok: true, skipped: false } }
  });
  allow();
}

// Syntax broken — compose a precise error + ask for correction.
const errs = (result.errors || []).slice(0, 3).map(e => {
  const loc = 'line ' + e.line + ':' + e.column;
  const ctx = e.context ? ' near ' + JSON.stringify(e.context.trim().slice(0, 120)) : '';
  const tag = e.kind === 'missing' ? 'missing node' : 'parse error';
  const msg = e.message ? ' (' + e.message + ')' : '';
  return '  • ' + tag + ' at ' + loc + msg + ctx;
}).join('\n');

log('PreToolUse.ast-validate', {
  session_id: session, tool, decision: 'ask', reason: 'syntax_error',
  metadata: { path: abs, language: result.language, error_count: result.errors.length }
});
recordAction({
  type: 'decision',
  session_id: session, cwd: payload.cwd,
  input: { kind: 'ast_validate', tool, path: abs, language: result.language },
  output: { decision: 'ask', reason: 'syntax_error', error_count: result.errors.length },
  verification: { ast: { ok: false, skipped: false, errors: (result.errors || []).slice(0, 3).map(e => ({ ...e, kind: 'parse_error' })) } }
});

ask(
  '[troth/ast-validate] The ' + tool + ' you are about to perform on ' + abs +
  ' would leave the file with a syntax error (' + result.language + '):\n' +
  errs + '\n' +
  'Re-issue the ' + tool + ' with a corrected payload. Typical causes: unmatched braces/parens, ' +
  'a mid-statement truncation, or an old_string that includes a line you did not intend to replace.'
);
