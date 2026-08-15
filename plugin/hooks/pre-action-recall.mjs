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

// Reading a MEMORY surface is a memory question wearing a file's clothes.
// The session-start directive covers prompts phrased as "do you remember",
// but nothing covered the moment the model decides to go read CLAUDE.md or a
// memory/*.md instead of asking the substrate — and that decision is where
// the cost lands (a field report burned ~100k tokens walking files while the
// answer sat one recall away; the same trap caught this assistant on
// 2026-08-10, grepping source to answer "have we built X").
//
// A steer alone was measured insufficient: 48 memory-file walks in seven
// days on a machine where recall was being auto-served every turn. So the
// FIRST walk of a session now asks — and the ask carries a taste of the
// answer, because the substrate acting beats the substrate advising: a
// cheap lexical search (~130ms, no embedder needed, safe on a fresh
// install) fetches the top memories for what the session is currently
// about, and the agent decides with them in view. Later walks in the same
// session get the plain steer — an agent deliberately working ON memory
// files must not be nagged on every read. Every failure falls open to the
// steer; memory-md-guard still owns the write side.
const _targetPath = String(input.file_path || input.path || input.notebook_path || '');
const _pattern    = String(input.pattern || input.query || '');
const MEMORY_SURFACE = /(^|\/)CLAUDE\.md$|\/\.claude\/.*memory\/.*\.md$|(^|\/)MEMORY\.md$|\/memory\/[^/]+\.md$/;
if (MEMORY_SURFACE.test(_targetPath) || /CLAUDE\.md|MEMORY\.md/.test(_pattern)) {
  const STEER =
    '[troth/memory-surface] This path is a MEMORY file. The substrate is the source of truth for ' +
    'what was decided, preferred, built or ruled out, and it holds far more than these files do. ' +
    'Call troth_recall (or mcp_call on troth-substrate) BEFORE reading or grepping here, and never ' +
    'answer "we never discussed that" from a file search alone. Reading the file is still fine ' +
    'once recall has been asked.';
  const emit = (decision, key, textValue) => {
    // Same PreToolUse shape as the prior-context emit below, and it EXITS:
    // falling through would print a second JSON object the host cannot parse.
    const out = { hookEventName: 'PreToolUse', permissionDecision: decision };
    out[key] = textValue;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n');
    process.exit(0);
  };

  let firstThisSession = false;
  try {
    const os = await import('node:os');
    const fsm = await import('node:fs');
    const marker = os.tmpdir() + '/troth-memask-' + String(session || 'nosession').replace(/[^a-zA-Z0-9-]/g, '') + '.flag';
    if (!fsm.existsSync(marker)) { fsm.writeFileSync(marker, String(Date.now())); firstThisSession = true; }
  } catch (_) { /* no marker road — stay on the steer */ }

  if (firstThisSession) {
    try {
      const state = require(pluginRoot + '/../shared-core/state.js');
      // What is this session trying to remember? The freshest captured intent
      // is the best cheap signal; the file's own name is the fallback. FTS5
      // rejects raw prose as a MATCH query (punctuation is syntax to it), so
      // the sentence becomes a handful of OR-joined word tokens — the same
      // tokenization recall's lexical arm uses.
      let raw = '';
      try {
        const row = state._dbForQuery().prepare(
          "SELECT json_extract(input,'$.goal') g FROM action_records " +
          "WHERE type='intent' AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1"
        ).get(Date.now() - 10 * 60 * 1000);
        raw = String((row && row.g) || '');
      } catch (_) {}
      if (!raw) raw = _targetPath.split('/').pop() || 'memory';
      const toks = [...new Set(raw.toLowerCase().split(/[^a-z0-9Ͱ-Ͽἀ-῿]+/)
        .filter((t) => t.length >= 4))].slice(0, 8);
      const query = toks.join(' OR ') || 'memory';

      // Typed at the SQL level: an untyped FTS top-k is dominated by read/
      // tool_call bookkeeping whose search text matches on file paths, and the
      // taste filter then starves. Commitments carry the decisions; lessons
      // carry the coaching.
      const rows = (state.searchActionsFull(query, { limit: 8, type: 'commitment' }) || [])
        .concat(state.searchActionsFull(query, { limit: 4, type: 'lesson' }) || []);
      const taste = [];
      for (const r of rows) {
        if (taste.length >= 3) break;
        if (r.audience && r.audience !== 'model_visible') continue;
        try {
          const o = typeof r.output === 'string' ? JSON.parse(r.output) : (r.output || {});
          const s = String(o.statement || o.text || '').replace(/\s+/g, ' ').trim();
          if (s.length > 20) taste.push('  • ' + s.slice(0, 140));
        } catch (_) {}
      }
      if (taste.length) {
        emit('ask', 'permissionDecisionReason',
          '[troth/memory-surface] The substrate already remembers — before walking this file, here is what it holds ' +
          'about the current work:\n' + taste.join('\n') + '\n' +
          'troth_recall returns the full, ranked answer. Native file reads on the memory surface are ' +
          'refused by the guard — ask the substrate; it holds more than the file does.');
      }
    } catch (_) { /* any failure falls open to the steer */ }
  }

  emit('allow', 'additionalContext', STEER);
}

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
// A surfaced strategy block earns a wider ceiling: its skeleton IS the
// payload and the standard budget beheaded it live (prior-edit lines eat
// chars before the DECISION block starts). Bounded either way — rent
// discipline holds, the shape survives whole.
const _cap = body.indexOf('DECISION — ') !== -1 ? 800 : MAX_CHARS;
if (body.length > _cap) body = body.slice(0, _cap - 12) + '\n…(truncated)';

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
