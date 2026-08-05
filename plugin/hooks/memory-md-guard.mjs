#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Memory-MD Guard — blocks Edit/Write/MultiEdit on the claude user-memory
// surface (~/.claude/projects/*/memory/*.md and ~/.claude/CLAUDE.md).
// When troth is active the operator wants project rules persisted as
// substrate engrams (troth_engram_record), NOT as claude-side .md files
// that the substrate hooks cannot index, search, or version.
//
//   path under ~/.claude/projects/*/memory/*.md → block, redirect to engram
//   path is exactly ~/.claude/CLAUDE.md         → block, redirect to engram
//   any other path                              → allow (project README,
//                                                  CHANGELOG, docs/, project
//                                                  CLAUDE.md all stay legal)
//
// Scope: this guard matches file-writing tools. It is a guard rail against
// accidental edits, not a containment boundary. A shell command that redirects
// into the file is a known gap, still open, and catching it would mean parsing
// commands on the Bash matcher.

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readStdinJson, allow, block, log, recordAction } from './_lib.mjs';

const payload = await readStdinJson();
const session = payload.session_id || 'unknown';
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};
const target  = input.file_path || input.notebook_path || input.path || null;

if (!target) { allow(); }

// Compared with one separator. The prefixes were written with forward slashes
// and matched against a resolved path, which on Windows comes back with
// backslashes — so every comparison here was false and the guard let writes
// into the operator's own memory through. A guard that silently does nothing
// on a platform is worse than no guard, because the platform is not obvious
// from reading it.
const sep = (p) => String(p).replace(/\\/g, '/');
const abs = sep(resolve(target));
const home = sep(homedir());
const MEMORY_PREFIX = home + '/.claude/projects/';
const GLOBAL_CLAUDE_MD = home + '/.claude/CLAUDE.md';

// Windows paths are case-insensitive; the same file must not be reachable by
// spelling the drive or the user name differently.
const eq = (a, b) => (process.platform === 'win32')
  ? a.toLowerCase() === b.toLowerCase()
  : a === b;
const startsWith = (a, b) => (process.platform === 'win32')
  ? a.toLowerCase().startsWith(b.toLowerCase())
  : a.startsWith(b);

const isMemoryMd =
  startsWith(abs, MEMORY_PREFIX) && abs.includes('/memory/') && abs.endsWith('.md');
const isGlobalClaudeMd = eq(abs, GLOBAL_CLAUDE_MD);

if (!isMemoryMd && !isGlobalClaudeMd) { allow(); }

const reason =
  'This path is claude user-memory; troth routes project rules to the substrate instead.\n' +
  'Path: ' + abs + '\n' +
  'Persist it as a substrate engram instead:\n' +
  '  - If a troth_engram_record tool is in your tool list, call it directly:\n' +
  '      troth_engram_record({statement: "<one-sentence rule>"})\n' +
  '  - Otherwise (router-gateway installs expose only troth-router/bash/cache/hashline),\n' +
  '    route through the gateway:\n' +
  '      mcp_call({server: "troth-substrate", tool: "troth_engram_record", args: {statement: "<one-sentence rule>"}})\n' +
  'Engrams persist across sessions and are auto-mounted via session-start; .md memory files are not.';

log('PreToolUse.memory_md_guard', {
  session_id: session, tool, decision: 'block', reason: 'memory_md_write',
  metadata: { path: abs, kind: isGlobalClaudeMd ? 'global_claude_md' : 'memory_md' }
});
recordAction({
  type: 'decision',
  session_id: session, cwd: payload.cwd,
  input: { kind: 'memory_md_guard', tool, path: abs },
  output: { decision: 'block', reason: 'memory_md_write' }
});
block(reason);
