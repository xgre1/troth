// SPDX-License-Identifier: AGPL-3.0-only
// The troth block for a project's AGENTS.md.
//
// AGENTS.md is the cross-tool instruction file — by 2026 it is read natively
// at session start by essentially every coding agent (Claude Code, Codex,
// Cursor, Copilot, Gemini CLI, Windsurf, Devin, Aider and more), which makes
// it the one place a contract reaches agents that carry none of troth's
// hooks. On those agents the tool listing is otherwise troth's entire
// introduction.
//
// Two disciplines, both load-bearing:
//
//   The text is FIXED and hand-written. The measured finding on agent
//   instruction files is blunt: short, curated text helps; generated bulk
//   measurably hurts (worse task success, more cost). So this is a template,
//   never per-project generated prose, and it stays a contract, not a manual
//   — the tools document themselves in the MCP listing.
//
//   Writing into a file that belongs to the operator's repository happens
//   only as a deliberate operator act — the `troth agents` command or a
//   consented step of the init wizard. troth never plants it silently; the
//   same principle that keeps .troth/project.json operator-written. The
//   markers make the block updatable in place and cleanly deletable.

'use strict';

const fs = require('fs');
const path = require('path');

const BEGIN = '<!-- BEGIN troth contract (managed by `troth agents`; delete freely) -->';
const END   = '<!-- END troth contract -->';

function contractBlock() {
  return [
    BEGIN,
    '## troth — persistent memory on this machine',
    '',
    'The operator runs troth: a local substrate that remembers decisions,',
    'preferences and prior work across sessions and across tools.',
    '',
    '- For any memory question ("do you remember / what did we decide / have',
    '  we built X?"), call the `troth_recall` MCP tool BEFORE reading',
    '  CLAUDE.md or memory/*.md or grepping for answers — the substrate holds',
    '  more than any file here, and file search alone yields false',
    '  "we never discussed that" answers.',
    '- Context blocks marked `[troth/...]` are substrate ground truth.',
    '- Prefer troth tools when listed: `cached_read`/`cached_grep` for reads,',
    '  `hashline_read` + `hashline_edit` for edits, `run` for shell.',
    END
  ].join('\n');
}

/**
 * Write or refresh the contract block in <dir>/AGENTS.md.
 * Creates the file when absent; replaces only what sits between the markers;
 * everything the operator wrote stays byte-identical.
 * Returns { action: 'created'|'updated'|'unchanged'|'appended', file }.
 */
function applyToDir(dir) {
  const file = path.join(dir, 'AGENTS.md');
  const block = contractBlock();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, block + '\n');
    return { action: 'created', file };
  }
  const src = fs.readFileSync(file, 'utf8');
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b !== -1 && e !== -1 && e > b) {
    const next = src.slice(0, b) + block + src.slice(e + END.length);
    if (next === src) return { action: 'unchanged', file };
    fs.writeFileSync(file, next);
    return { action: 'updated', file };
  }
  fs.writeFileSync(file, src.replace(/\n*$/, '\n\n') + block + '\n');
  return { action: 'appended', file };
}

module.exports = { contractBlock, applyToDir, BEGIN, END };
