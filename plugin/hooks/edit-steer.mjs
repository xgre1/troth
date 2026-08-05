#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Edit-Steer — routes edits of EXISTING files through the troth-hashline MCP
// tool, the sibling of bash-steer.mjs.
//
// Why: the built-in Edit/Write tools go through the permission system. Our own
// verifyfirst hook answers `ask` (reason unread_edit) whenever the target
// exists but was not read this session, so the operator eats a yes/no prompt
// mid-flow — the exact thing the operator has ruled out (a standing no-approval-prompts rule). troth-hashline executes as an approved MCP tool: anchored
// LINE#TAG edits, AST-validated, drift-safe, and archived to the substrate.
//
// Scope is deliberately NARROW. Only edits to files that ALREADY exist are
// steered, because that is the only case that prompts. Creating a new file with
// Write never hits verifyfirst's exists-branch, so it stays on the fast path
// and this hook keeps out of the way.
//
// Opt-out: env TROTH_EDIT_STEER=0|false|off, or ~/.troth/config.json
// { "features": { "edit_steer": false } }. Default ON.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function out(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }
function allow() { out({}); }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data); } catch { return {}; }
}

try {
  const payload = await readStdin();

  // Exact match only, mirroring bash-steer: the hooks.json matcher is a regex
  // and must never strand a neighbouring tool.
  const tool = payload.tool_name || '';
  if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') allow();

  // Opt-outs: env wins, then config flag. Default ON.
  const env = String(process.env.TROTH_EDIT_STEER || '').toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') allow();
  const cfg = readJson(join(homedir(), '.troth', 'config.json'));
  if (cfg && cfg.features && cfg.features.edit_steer === false) allow();

  // Only EXISTING targets prompt, so only those are steered. No path, or a
  // brand-new file: leave it alone.
  const target = (payload.tool_input && payload.tool_input.file_path) || '';
  if (!target || !existsSync(target)) allow();

  // troth-hashline must be verifiably wired in THIS session, else fail open —
  // steering to an absent tool would strand every edit.
  const specOf = (p) => {
    const j = readJson(p);
    const s = j && j.mcpServers && j.mcpServers['troth-hashline'];
    return (s && typeof s === 'object') ? s : null;
  };
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  const spec =
    specOf(join(homedir(), '.claude.json')) ||
    (pluginRoot ? specOf(join(pluginRoot, '.mcp.json')) : null) ||
    (payload.cwd ? specOf(join(payload.cwd, '.mcp.json')) : null);
  if (!spec) allow();

  // Wired is not enough: it must be SPAWNABLE (same reasoning as bash-steer).
  const missing = (s) => {
    if (typeof s !== 'string') return false;
    const p = s.startsWith('~/') ? join(homedir(), s.slice(2)) : s;
    return p.startsWith('/') && !existsSync(p);
  };
  if (missing(spec.command)) allow();
  if (Array.isArray(spec.args) && missing(spec.args[0])) allow();

  out({
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'troth routes edits of existing files through troth-hashline. Call hashline_read ' +
        '(file_path, optional start_line/end_line) to get LINE#TAG anchors, then hashline_edit ' +
        '(file_path, edits[{op, pos, lines}]) to apply them. It runs without approval prompts, ' +
        'is AST-validated for JS/TS/PY/JSON, and rejects stale anchors instead of clobbering. ' +
        'Whole-file rewrites and new files: use troth-bash run with a quoted heredoc. ' +
        '(Operator opt-out: TROTH_EDIT_STEER=0.)',
    },
  });
} catch {
  // Any failure whatsoever: never block the operator's edit.
  try { allow(); } catch { process.exit(0); }
}
