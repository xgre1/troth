#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Faculty-Bash-Gate — the shell walls for the app's OWN claude_cli spawns.
//
// Why this exists: the claude_cli faculty runs `claude -p` under an isolated
// CLAUDE_CONFIG_DIR (~/.troth/claude-faculty-home) so the organ brings no
// second identity/memory — which ALSO means it loads none of the operator's
// ~/.claude wiring. connect_claude_code() installs troth-bash + the
// bash-steer hook into the OPERATOR's Claude Code, and none of that reaches
// this spawn: with --dangerously-skip-permissions its native Bash ran with
// no wall at all. Both AUDIT-2026-08-09 incidents (`cut` on a .env, raw
// sqlite3 against state.db) happened on exactly this surface.
//
// So the faculty home gets its own PreToolUse hook (subprocess-cli.js
// provisions settings.json pointing here), and the hook asks the SAME
// bash-safety.isCommandSafe the troth-bash MCP server asks — one wall,
// one test suite (TPW/TBS), two doors. No steering here: troth-bash is not
// mounted in this session (--strict-mcp-config keeps the faculty to the
// substrate server only), so the honest options are allow or refuse.
//
// STANDALONE ON PURPOSE: no ./_lib.mjs import (that loads better-sqlite3,
// ABI-locked to the bundled node). bash-safety.js + path-policy.js +
// web-allowlist.js are stdlib-only, so THIS hook runs on any node.
//
// FAIL-OPEN CONTRACT: the ONLY path that denies is "tool is exactly Bash
// AND bash-safety loaded AND its verdict is a refusal AND gating not opted
// out". Every error, malformed payload, or missing module → allow. A broken
// gate must never strand the partner's shell; the wall module itself is
// where refusal logic lives.
//
// Opt-out: env TROTH_FACULTY_BASH_GATE=0|false|off, or ~/.troth/config.json
// { "features": { "faculty_bash_gate": false } }. Default ON.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
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

  // Exact match only ("Bash" as a regex also hits "BashOutput"; gating
  // BashOutput/KillShell would strand background tasks).
  if ((payload.tool_name || '') !== 'Bash') allow();

  // Opt-outs: env wins, then config flag. Default ON.
  const env = String(process.env.TROTH_FACULTY_BASH_GATE || '').toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') allow();
  const cfg = readJson(join(homedir(), '.troth', 'config.json'));
  if (cfg && cfg.features && cfg.features.faculty_bash_gate === false) allow();

  const command = String((payload.tool_input && payload.tool_input.command) || '');
  if (!command.trim()) allow();

  // The wall itself. plugin/hooks/ → repo root → shared-core/tools/.
  const require = createRequire(import.meta.url);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const safety = require(join(root, 'shared-core', 'tools', 'bash-safety.js'));
  const verdict = safety.isCommandSafe(command, {});
  if (!verdict || verdict.allowed !== false) allow();

  out({
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: (() => {
        const what = String(verdict.detail || verdict.why || 'this command crosses a substrate wall');
        return 'REFUSED ' + (verdict.pattern || verdict.reason || 'wall') + ': ' +
          what + (/[.!?]$/.test(what) ? '' : '.') +
          ' This wall is policy, not a permission prompt; do not retry variants of the same ' +
          'command. Tell the operator exactly what was refused and why; they can run it ' +
          'themselves in their own shell if they truly want it.';
      })(),
    },
  });
} catch {
  // Any failure whatsoever: never block the partner's shell.
  try { allow(); } catch { process.exit(0); }
}
