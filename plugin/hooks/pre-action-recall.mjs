#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// (plugin surface) — pre-action substrate cues.
//
// Mirrors what shared-core/tools/runner.js does for the entity daemon:
// before the LLM's tool runs, surface prior context (verified edits to
// the same file, decisions/identity mentioning the file basename or
// search pattern, recent dialogue mentions) as additionalContext.
//
// Why a hook (and not just runner.js): Claude Code's tool dispatch does
// NOT go through shared-core/tools/runner.js. The runner.js intercept
// covers the entity daemon (cli/voice surface). For Claude Code's
// Read/Edit/Grep/Write/Glob to get the same pre-action cueing, we need
// a PreToolUse hook that uses the same SQL/engram primitives.
//
// Deterministic, zero LLM calls (anticipator.js retired  for
// being LLM-driven — production engrams 0 in 7d). Reuses the existing
// post-action-recall.mjs file_path/search shapes so behavior is
// consistent before/after tool execution.
//
// Budget: ≤ 500 chars surfaced (matches post-action-recall — L2
// trigger-push budget from MemPalace research). Cap on records per
// kind: 2 prior edits, 2 decisions, 2 dialogue snippets.

import { createRequire } from 'node:module';
import { readStdinJson, allow, log } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let pac; // fail-open: bare marketplace clone has no node_modules
try { pac = require(pluginRoot + '/../shared-core/tools/pre-action-context.js'); } catch (_) { console.log('{}'); process.exit(0); }
const MAX_CHARS = 500;

const payload = await readStdinJson();
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const cwd     = payload.cwd || process.cwd();
const session = payload.session_id || null;

if (!session || !tool) { allow(); }
if (!pac.isInteresting(tool)) { allow(); }

let priorContext = null;
try {
  priorContext = pac.gatherPriorContext({
    tool_name: tool,
    args: input,
    cwd
  });
} catch (_) { /* never block tool execution on substrate read */ }

if (!priorContext || !priorContext.summary) { allow(); }

let body = '[troth/prior_context] Before this tool runs, substrate has:\n' +
           priorContext.summary;
if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS - 12) + '\n…(truncated)';

log('PreToolUse.recall', {
  session_id: session, tool,
  metadata: { refs: (priorContext.refs || []).length, bytes: body.length }
});

// Emit PreToolUse-shaped response directly (matches cache-probe.mjs
// pattern) — addContext defaults to UserPromptSubmit shape, but
// PreToolUse responses need permissionDecision='allow' + the same
// additionalContext field. Without the explicit shape, Claude Code
// may reject the additionalContext on certain CC versions.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    additionalContext: body
  }
}) + '\n');
