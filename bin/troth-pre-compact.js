#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// PreCompact breadcrumb writer — called by ~/.claude/hooks/pre-compact-progress.sh
// just before Claude Code's native /compact summarize-and-drop fires.
//
// Deterministic only; no LLM-judgment (a hook can't make Claude think).
// What it does: record a single substrate engram marking the compaction
// event (branch, last sha, last commit msg, diff stat) so future
// sessions can correlate "what session shape preceded the current one"
// without re-trawling git log.
//
// Does NOT touch the project's progress.md — that file is Claude Code's
// state, not ours. Intelligent fact extraction is the /save skill the
// operator invokes BEFORE /compact when they want LLM-judged engrams.

'use strict';

const { execSync } = require('child_process');

const projectDir = process.env.CLAUDE_CWD || process.cwd();

function safe(cmd) {
  try { return execSync(cmd, { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}

const branch    = safe('git branch --show-current');
const lastSha   = safe('git rev-parse HEAD');
const lastMsg   = safe('git log -1 --pretty=%s');
const diffStat  = safe('git diff --shortstat HEAD');

try {
  const engram = require('../shared-core/engram.js');
  const agentId = require('../shared-core/agent-id.js').resolveAgentId();
  engram.recordEngram({
    agent_id:  agentId,
    cwd:       projectDir,
    statement: `session pre-compact: branch=${branch || '?'} last=${(lastSha || '').slice(0,7)} (${lastMsg || '?'}) diff=${diffStat || 'clean'}`,
    scope:     'internal:pre_compact_marker',
    source:    'troth-pre-compact hook',
    salience:  0.8,
    auto_verify: false,
  });
} catch (e) {
  process.stderr.write(`[troth-pre-compact] substrate engram skipped: ${e.message}\n`);
}
