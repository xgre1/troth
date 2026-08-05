// SPDX-License-Identifier: AGPL-3.0-only
// pre-action-context — substrate-native pre-action retrieval.
//
// Before any worldly tool runs (Read / Edit /
// Write / MultiEdit / Grep / Glob), the substrate fetches related prior
// action_records and merges a SHORT context summary into the tool result.
// The LLM gets "you've edited this file 4× recently; decided 2 weeks ago
// to use Zod here; operator asked about validation twice" alongside the
// raw file contents — never reaches for a tool blind.
//
// Why a NEW module, not a plugin hook clone:
//   plugin/hooks/post-action-recall.mjs is Claude-Code-only (PostToolUse
//   hook). The substrate-as-entity cli/voice daemon (bin/troth-entity.js)
//   dispatches tools through shared-core/tools/runner.js, not plugin hooks.
//   Intercepting at runner.js covers BOTH surfaces with one change.
//
// Why deterministic, no LLM call:
//   shared-core/anticipator.js retired  ("0 anticipation engrams
//   in 7 days production telemetry, operationally dead"). Lesson: substrate-
//   native means zero LLM calls in default substrate operations. Uses
//   FTS/queryActions only — same primitives post-action-recall.mjs uses.
//
// Why merge into result vs prepend as a separate message:
//   The orchestrator returns tool results as a single `content` string on
//   the tool message. Merging keeps the LLM seeing one coherent payload
//   per tool call. Caller can extract _prior_context from the result if
//   it wants to render the context separately.

'use strict';

const state = require('../state.js');
const engram = require('../engram.js');

const MAX_FILE_PRIORS    = 3;
const MAX_DECISION_HITS  = 2;
const MAX_DIALOGUE_HITS  = 2;
const MAX_SUMMARY_CHARS  = 600;

// Tools that get pre-action context. Excludes:
//   Bash (too noisy; tons of trivial shell calls)
//   substrate tools (engram_search/dialogue_search/update_identity/etc.
//     they ARE recall, no point recalling for them)
//   mcp_* (third-party, unpredictable)
const FILE_TOOLS   = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

function isInteresting(tool_name) {
  return FILE_TOOLS.has(tool_name) || SEARCH_TOOLS.has(tool_name);
}

// Pull recent prior edits to the same file. Reuses the post-action-recall
// SQL shape (json_extract on input.file_path) so behavior is consistent
// across surfaces. Filters to verified rows (ast.ok=1) to avoid surfacing
// edits that didn't parse — those are noise.
function _priorEditsToFile(cwd, file_path) {
  try {
    const d = state._dbForQuery && state._dbForQuery();
    if (!d) return [];
    const rows = d.prepare(`
      SELECT id, timestamp, session_id, input, verification
      FROM action_records
      WHERE type='edit' AND
            json_extract(input,'$.file_path') = ? AND
            (json_extract(verification,'$.ast.ok') = 1 OR verification IS NULL OR verification = '{}')
      ORDER BY timestamp DESC LIMIT ?
    `).all(String(file_path), MAX_FILE_PRIORS);
    return rows.map(r => {
      let inp = {};
      try { inp = typeof r.input === 'string' ? JSON.parse(r.input) : (r.input || {}); } catch (_) {}
      const days = Math.max(1, Math.round((Date.now() - r.timestamp) / (24 * 60 * 60 * 1000)));
      return { id: r.id, days_ago: days, format: inp.format || 'edit' };
    });
  } catch (_) { return []; }
}

// Pull decisions / commitments / identity facts whose statement mentions
// the target token (file basename or search pattern). Reuses engram
// substrate (already audience-filtered to model_visible by default).
function _priorMemoryMentioning(cwd, token, limit) {
  if (!token || String(token).length < 3) return [];
  const lc = String(token).toLowerCase();
  try {
    // Pull a moderate pool, then filter in JS. Cheap — listEngrams is
    // already bounded by audience+limit at SQL level.
    const pool = engram.listEngrams({ audience: 'model_visible', limit: 200 }) || [];
    const hits = [];
    for (const e of pool) {
      if (!e || !e.statement) continue;
      if (String(e.statement).toLowerCase().indexOf(lc) < 0) continue;
      hits.push(e);
      if (hits.length >= limit) break;
    }
    return hits;
  } catch (_) { return []; }
}

// Pull recent dialogue.turn rows where user OR assistant mentioned the
// token. Uses state.searchDialogueTurns if available, else falls back
// to queryActions + JS filter.
function _priorDialogueMentioning(cwd, token, limit) {
  if (!token || String(token).length < 3) return [];
  try {
    if (typeof state.searchDialogueTurns === 'function') {
      const rows = state.searchDialogueTurns({ query: String(token), limit: limit * 2 }) || [];
      const out = [];
      for (const r of rows) {
        if (!r || !r.id) continue;
        let inp = {}, outp = {};
        try { inp  = typeof r.input  === 'string' ? JSON.parse(r.input)  : (r.input  || {}); } catch (_) {}
        try { outp = typeof r.output === 'string' ? JSON.parse(r.output) : (r.output || {}); } catch (_) {}
        const userText = (inp && inp.args && inp.args.user_text) || '';
        const asstText = (outp && outp.assistant_text) || '';
        const snippet = (userText + ' / ' + asstText).replace(/\s+/g, ' ').trim();
        if (!snippet) continue;
        out.push({ id: r.id, ts: r.timestamp, snippet: snippet.slice(0, 120) });
        if (out.length >= limit) break;
      }
      return out;
    }
  } catch (_) {}
  return [];
}

// Public entry. Returns null if nothing surface-worthy was found, or
// { summary, refs } when the substrate has relevant prior context.
function gatherPriorContext(args) {
  args = args || {};
  const tool_name = args.tool_name;
  const toolArgs  = args.args || {};
  const cwd       = args.cwd || null;
  if (!isInteresting(tool_name)) return null;

  let token = null;
  let isFile = false;
  if (FILE_TOOLS.has(tool_name)) {
    token = toolArgs.file_path || toolArgs.path || null;
    isFile = true;
  } else if (SEARCH_TOOLS.has(tool_name)) {
    token = toolArgs.pattern || toolArgs.query || toolArgs.path || null;
  }
  if (!token) return null;

  // Last segment for file paths so dialogue/engram mentions match casual
  // references ("user.ts" vs full "/Users/.../src/user.ts"). Also try
  // without extension — humans often discuss "user" not "user.ts" in
  // decisions/identity ("we use Zod for user validation").
  const tokenBasename = isFile
    ? String(token).split(/[\\/]/).filter(Boolean).pop()
    : String(token);
  const tokenStem = isFile && tokenBasename
    ? tokenBasename.replace(/\.[a-z0-9]{1,8}$/i, '')
    : tokenBasename;

  const lines = [];
  const refs = [];

  if (isFile) {
    const priorEdits = _priorEditsToFile(cwd, token);
    if (priorEdits.length) {
      lines.push('prior edits to this file: ' + priorEdits.map(e =>
        e.days_ago + 'd ago (' + e.format + ', ' + e.id.slice(0, 8) + ')'
      ).join('; '));
      for (const e of priorEdits) refs.push(e.id);
    }
  }

  // Try basename first; if no hits, fall back to extension-stripped stem
  // (catches casual mentions like "user" vs "user.ts" in dialogue/decisions).
  let decisionHits = _priorMemoryMentioning(cwd, tokenBasename, MAX_DECISION_HITS);
  if (!decisionHits.length && tokenStem && tokenStem !== tokenBasename) {
    decisionHits = _priorMemoryMentioning(cwd, tokenStem, MAX_DECISION_HITS);
  }
  // L1/L2 SECURITY HARDENING  — integration point fix.
  //
  // Structured-provenance rendering. Before: prior facts surfaced as
  // bare prose (`prior decisions mentioning X: <raw statement>`). The
  // LLM consumed them as instruction. If any prior was poisoned by
  // adversarial input (integration point attempts that landed at regex_extracted),
  // the poison flowed straight into working context with no provenance
  // signal to weight it down.
  //
  // After: every fact is rendered with [tier, age, conf] brackets so
  // the language faculty sees explicit weighting and treats priors as
  // evidence, not as imperative. The LLM is trained to weight tagged
  // claims by their tags — surfacing the tier inline makes that work.
  //
  // Age is rounded ("today", "3d", "2w", "5mo") to keep rendering tight.
  function _fmtAge(ts) {
    if (!ts) return '?';
    const ms = Math.max(0, Date.now() - ts);
    const d  = ms / (24 * 60 * 60 * 1000);
    if (d < 1)  return 'today';
    if (d < 14) return Math.round(d) + 'd';
    if (d < 60) return Math.round(d / 7) + 'w';
    return Math.round(d / 30) + 'mo';
  }
  function _tag(e) {
    const tier = e.source_authority || 'regex_extracted';
    const conf = (typeof e.truth_score === 'number') ? e.truth_score.toFixed(2) : '1.00';
    return '[' + tier + ', ' + _fmtAge(e.ts) + ', conf ' + conf + ']';
  }

  if (decisionHits.length) {
    const decisions = decisionHits.filter(e =>
      e.scope && typeof e.scope === 'string' && e.scope.indexOf('decision:') === 0
    );
    const identity = decisionHits.filter(e => e.scope === 'identity');
    if (decisions.length) {
      lines.push('prior decisions mentioning ' + tokenBasename + ':');
      for (const d of decisions) {
        lines.push('  - ' + _tag(d) + ' ' + String(d.statement).slice(0, 140));
        refs.push(d.id);
      }
    }
    if (identity.length) {
      lines.push('identity facts touching ' + tokenBasename + ':');
      for (const d of identity) {
        lines.push('  - ' + _tag(d) + ' ' + String(d.statement).slice(0, 140));
        refs.push(d.id);
      }
    }
  }

  let dialogueHits = _priorDialogueMentioning(cwd, tokenBasename, MAX_DIALOGUE_HITS);
  if (!dialogueHits.length && tokenStem && tokenStem !== tokenBasename) {
    dialogueHits = _priorDialogueMentioning(cwd, tokenStem, MAX_DIALOGUE_HITS);
  }
  if (dialogueHits.length) {
    lines.push('recent dialogue mentioning ' + tokenBasename + ':');
    for (const d of dialogueHits) {
      // Dialogue rows don't carry source_authority — they're observations,
      // never authoritative. Tag explicitly so the LLM doesn't mistake
      // verbatim quotes for facts.
      lines.push('  - [dialogue_observation, ' + _fmtAge(d.ts) + '] "' +
        d.snippet.replace(/\s+/g, ' ').slice(0, 120) + '"');
      refs.push(d.id);
    }
  }

  if (!lines.length) return null;
  let summary = lines.join('\n');
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS - 12) + '\n…(truncated)';
  }
  return { summary, refs };
}

module.exports = {
  gatherPriorContext,
  // Test surface
  isInteresting,
  FILE_TOOLS,
  SEARCH_TOOLS
};
