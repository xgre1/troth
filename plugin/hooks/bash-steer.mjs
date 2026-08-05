#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Bash-Steer — routes ALL shell through the troth-bash MCP tool.
//
// Why: Claude Code's model defaults to the built-in Bash tool. Built-in Bash
// goes through the permission system (per-command approve prompts for anything
// outside the user's allow rules), while troth-bash executes as an approved
// MCP tool, keeps a persistent cwd, compresses >4KB output, and archives the
// raw output to SQLite for substrate recall. Without steering, sessions
// fragment: some commands land in troth (remembered), some in built-in Bash
// (unrecorded) + the user eats yes/no prompts. This hook denies built-in Bash
// with a redirect reason; the model then re-issues the same command via
// troth-bash (deny→reason→retry is the same proven mechanic as
// memory-md-guard: the reason string is surfaced to the model verbatim).
//
// STANDALONE ON PURPOSE: no ./_lib.mjs import. _lib loads shared-core/state.js
// → native better-sqlite3, which is ABI-locked to the bundled node. This hook
// must keep steering (or cleanly fail OPEN) on ANY node in ANY topology, so it
// uses only node stdlib and never touches the DB.
//
// FAIL-OPEN CONTRACT: the ONLY path that denies is "tool is exactly Bash AND
// troth-bash is verifiably wired in this session AND steering not opted out".
// Every error, malformed payload, or unknown topology → allow. A broken steer
// hook must never lock a user out of shell entirely.
//
// troth-bash availability probes (any hit = wired):
//   1. ~/.claude.json            mcpServers["troth-bash"]   (app "Connect" wiring)
//   2. $CLAUDE_PLUGIN_ROOT/.mcp.json  mcpServers["troth-bash"]  (full/dev plugin;
//      the app-bundled plugin ships this EMPTY, so probe 1 carries app installs)
//   3. <cwd>/.mcp.json           mcpServers["troth-bash"]   (project-scope wiring)
//
// Opt-out: env TROTH_BASH_STEER=0|false|off, or ~/.troth/config.json
// { "features": { "bash_steer": false } }. Default ON.

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

  // Exact match only. The hooks.json matcher is a regex ("Bash" also hits
  // "BashOutput"); steering BashOutput/KillShell would strand background tasks.
  if ((payload.tool_name || '') !== 'Bash') allow();

  // Opt-outs: env wins, then config flag. Default ON.
  const env = String(process.env.TROTH_BASH_STEER || '').toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') allow();
  const cfg = readJson(join(homedir(), '.troth', 'config.json'));
  if (cfg && cfg.features && cfg.features.bash_steer === false) allow();

  // troth-bash must be verifiably wired in THIS session, else fail open.
  const specOf = (p) => {
    const j = readJson(p);
    const s = j && j.mcpServers && j.mcpServers['troth-bash'];
    return (s && typeof s === 'object') ? s : null;
  };
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  const spec =
    specOf(join(homedir(), '.claude.json')) ||
    (pluginRoot ? specOf(join(pluginRoot, '.mcp.json')) : null) ||
    (payload.cwd ? specOf(join(payload.cwd, '.mcp.json')) : null);
  if (!spec) allow();

  // Wired is not enough — troth-bash must be SPAWNABLE, else steering to a dead
  // tool strands the shell. An ABSOLUTE command or
  // server-script arg that no longer exists (app moved/uninstalled, bundled
  // node gone) means it cannot start, so fail OPEN. A bare 'node' command
  // resolves via PATH, and THIS hook already runs under node, so the runtime
  // is reachable by definition — nothing to check on that arm. Round-2 nits:
  // hand-edited configs use ~/ too (hosts don't shell-expand, so a ~ path is
  // dead-as-written for the HOST — but check the expanded form: if even that
  // is missing, the wire is certainly dead), and only the SCRIPT (args[0])
  // decides spawnability — a missing path in a later flag arg must not
  // silently disable steering on a healthy wire.
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
        'troth routes shell through the troth-bash MCP tool. Re-run this exact command with ' +
        "the troth-bash 'run' tool (args: command, optional cwd / timeout_ms / acknowledge_danger). " +
        'It executes without approval prompts, keeps a persistent cwd across calls, and archives ' +
        'output to the substrate for recall. For long tasks: nohup <cmd> > <log> 2>&1 & via run, ' +
        'then read the log. (Operator opt-out: TROTH_BASH_STEER=0.)',
    },
  });
} catch {
  // Any failure whatsoever: never block the user's shell.
  try { allow(); } catch { process.exit(0); }
}
