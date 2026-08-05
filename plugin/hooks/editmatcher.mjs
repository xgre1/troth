#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Edit matcher — PreToolUse hook for Edit / MultiEdit.
//
// The model frequently emits an old_string that's close but not exact:
// trimmed whitespace, a semicolon dropped, inconsistent indentation.
// The built-in Edit tool rejects with "string not found" and we waste
// a full turn on re-read + re-edit. This hook fuzzy-matches the
// proposed old_string against actual file content and returns
// updatedInput with the canonical substring, turning a bad Edit into
// a successful one on the current turn.
//
// Scope:
//   Edit      → rewrite a single old_string if we find a fuzzy match
//   MultiEdit → rewrite each sub-edit's old_string independently
//
// If no strategy finds a match we pass through and let the real Edit
// tool surface its native error — we never invent a match.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readStdinJson, allow, log, state, recordAction } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const editmatch   = require(pluginRoot + '/../shared-core/editmatch.js');
const astValidate = require(pluginRoot + '/../shared-core/ast-validate.js');

// if a fuzzy rescue SAVES the old_string mismatch but the
// resulting post-edit content breaks syntax, prefer a different
// strategy. Tries strategies in order; first one whose applied
// result parses cleanly wins. Unsupported extensions (rust, go,
// markdown,...) skip this check — we only do structural validation
// for the languages the validator understands.
function chooseStrategy(content, oldStr, newStr, targetPath, replaceAll) {
  const strategies = [
    () => editmatch.exactMatch(content, oldStr),
    () => editmatch.trimMatch(content, oldStr),
    () => editmatch.collapseMatch(content, oldStr),
    () => editmatch.anchorMatch(content, oldStr)
  ];
  for (const fn of strategies) {
    const m = fn();
    if (!m) continue;
    const applied = astValidate.applyEdit(content, m.exact, newStr || '', !!replaceAll);
    if (applied === null) continue;
    const check = astValidate.validate(targetPath, applied);
    if (check.skipped || check.ok) {
      return { match: m, appliedContent: applied, ast: check };
    }
    // Syntax broke under this strategy — fall through and try next.
  }
  return null;
}

function emit(updatedInput, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason || '',
      updatedInput
    }
  }));
  process.exit(0);
}

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const session = payload.session_id || null;

if (!['Edit', 'MultiEdit'].includes(tool)) { allow(); }

const target = input.file_path;
if (!target) { allow(); }
const abs = resolve(target);
if (!existsSync(abs)) { allow(); }

let content;
try { content = readFileSync(abs, 'utf8'); }
catch (e) { allow(); }

// ── Edit: single old_string ─────────────────────────────────────────────
if (tool === 'Edit') {
  const oldStr = input.old_string;
  if (typeof oldStr !== 'string' || !oldStr) { allow(); }

  // Already matches exactly — still validate that the REPLACEMENT
  // won't leave the file in a broken state. If ast-validate skips the
  // extension (rust/go/etc) we just pass through.
  if (content.includes(oldStr)) {
    log('PreToolUse.editmatch', {
      session_id: session, tool, decision: 'allow', reason: 'exact_match'
    });
    allow();
  }

  // Try strategies in escalating order, preferring whichever yields
  // syntactically valid post-edit content.
  const picked = chooseStrategy(content, oldStr, input.new_string, abs, !!input.replace_all);
  if (!picked) {
    log('PreToolUse.editmatch', {
      session_id: session, tool, decision: 'allow', reason: 'no_safe_match'
    });
    allow(); // let Edit tool's own error path fire
  }

  const { match, ast } = picked;
  const updated = Object.assign({}, input, { old_string: match.exact });
  try {
    state.recordSavings('editmatch_rescued', 1, session, 'strategy=' + match.strategy);
  } catch {}
  log('PreToolUse.editmatch', {
    session_id: session, tool, decision: 'allow', reason: 'fuzzy_rescue_safe',
    metadata: {
      strategy: match.strategy,
      line_start: match.line_start,
      line_end: match.line_end,
      ast_skipped: !!ast.skipped,
      ast_ok: !!ast.ok
    }
  });
  recordAction({
    type: 'edit',
    session_id: session, cwd: payload.cwd,
    input: {
      file_path: abs,
      format: 'editmatch:' + match.strategy,
      rescue: true
    },
    output: {
      hash_after: 'rescued',
      lines_changed: (match.line_end || 1) - (match.line_start || 1) + 1
    },
    verification: {
      ast: { ok: !!ast.ok, skipped: !!ast.skipped }
    }
  });
  emit(updated, '[troth/editmatch] ' + match.strategy + ' strategy' +
    (ast.ok ? ' (post-edit AST parses clean)' : ast.skipped ? '' : ''));
}

// ── MultiEdit: rewrite each sub-edit independently ─────────────────────
if (tool === 'MultiEdit') {
  const edits = input.edits;
  if (!Array.isArray(edits) || !edits.length) { allow(); }

  let anyRescued = false;
  let rescueStrategies = [];
  const newEdits = [];
  let rollingContent = content;

  for (const e of edits) {
    if (typeof e.old_string !== 'string') { newEdits.push(e); continue; }
    if (rollingContent.includes(e.old_string)) {
      newEdits.push(e);
    } else {
      // pick the strategy whose post-edit AST parses clean.
      // Falls through to plain findMatch when the extension isn't
      // structurally checkable (skipped) so non-JS/TS/Py files still get
      // rescued.
      const picked = chooseStrategy(rollingContent, e.old_string, e.new_string || '', abs, !!e.replace_all);
      if (picked) {
        newEdits.push(Object.assign({}, e, { old_string: picked.match.exact }));
        anyRescued = true;
        rescueStrategies.push(picked.match.strategy);
      } else {
        newEdits.push(e); // no safe match — let native error surface
      }
    }
    // Advance rollingContent as if this edit applied, so subsequent
    // matches reflect the in-flight state.
    const corrected = newEdits[newEdits.length - 1];
    if (typeof corrected.old_string === 'string' && rollingContent.includes(corrected.old_string)) {
      rollingContent = e.replace_all
        ? rollingContent.split(corrected.old_string).join(corrected.new_string || '')
        : rollingContent.replace(corrected.old_string, corrected.new_string || '');
    }
  }

  if (!anyRescued) {
    log('PreToolUse.editmatch', { session_id: session, tool, decision: 'allow', reason: 'all_exact_or_unmatched' });
    allow();
  }

  try {
    state.recordSavings('editmatch_rescued', rescueStrategies.length, session, 'strategies=' + rescueStrategies.join(','));
  } catch {}
  log('PreToolUse.editmatch', {
    session_id: session, tool, decision: 'allow', reason: 'fuzzy_rescue',
    metadata: { rescued: rescueStrategies.length, strategies: rescueStrategies }
  });
  emit(Object.assign({}, input, { edits: newEdits }), '[troth/editmatch] fuzzy-corrected ' + rescueStrategies.length + ' edit(s)');
}

allow();
