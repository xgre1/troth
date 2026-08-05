// SPDX-License-Identifier: AGPL-3.0-only
// Substrate-side procedure matcher + plan builder.
//
// Phase C `taskProcedureCompile` detects recurring tool-call sequences
// and persists them as `compiled_procedure` ActionRecords. P15 injector
// surfaces a compact one-line hint to the LLM when prompt verbs overlap
// trigger keywords. This module makes the substrate itself a usable
// matcher: takes a prompt + ctx, scores it against the
// `compiled_procedure` pool, returns the best match (or null) and a
// best-effort filled replay plan.
//
// What we DO:
//   1. matchProcedure({prompt, agent_id, cwd, min_confidence}) — reads
//      `compiled_procedure` rows for ctx, scores each by trigger
//      overlap + occurrence count + status, returns best above
//      min_confidence (or null with reason).
//   2. buildReplayPlan({procedure, prompt}) — extracts heuristic args
//      from prompt (file paths, flags), fills the empty template
//      slots best-effort, returns {steps, parameter_slots_filled,
//      missing_args, extracted}.
//
// What we DO NOT do:
//   - Execute the plan. True zero-LLM tool execution requires either
//     a proxy-side synthetic Anthropic-API tool_use stream OR a host-
//     channel out-of-band tool dispatch — neither exists yet, and both
//     are multi-session architectural work, not a single small slice.
//     This module is the matching brain; the execution channel is the
//     next ship. See the CHANGELOG and
//     HONEST-LIMITS.md for the architectural ceiling.
//   - Sanity-check args or refuse "unsafe" tools. The caller (LLM via
//     MCP, or future substrate-side executor) is responsible.

const state = require('./state.js');

const DEFAULT_MIN_CONFIDENCE = 0.50;
const DEFAULT_LIMIT = 50;

// Status weights — `approved` (operator confirmed the procedure is
// good for replay) gets a meaningful boost so it outranks freshly-
// detected patterns. `deprecated` is skipped entirely.
const STATUS_BOOST = { approved: 0.30, detected: 0.0, deprecated: -1.0 };

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function tokenizePrompt(prompt) {
  return new Set(
    String(prompt || '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3)
  );
}

// Score components:
//   overlap = hits / max(triggers.length, prompt_tokens.size, 1)  → 0..1
//   status_boost = +0.30 (approved) | 0 (detected) | -1.0 (deprecated)
//   occurrence_score = log10(1 + occurrences) / 10, capped at 0.20
// Final = clamp(overlap + status + occurrence, 0..1).
function scoreProcedure(row, promptTokens) {
  const out = safeJson(row.output) || {};
  const inp = safeJson(row.input) || {};
  if (out.status === 'deprecated') return null;
  const triggers = Array.isArray(out.trigger_keywords) ? out.trigger_keywords : [];
  if (!triggers.length || !promptTokens.size) return null;
  let hits = 0;
  const matchedTriggers = [];
  for (const t of triggers) {
    const lower = String(t).toLowerCase();
    if (promptTokens.has(lower)) {
      hits++;
      matchedTriggers.push(lower);
    }
  }
  if (!hits) return null;
  const overlap = hits / Math.max(triggers.length, promptTokens.size, 1);
  const statusBoost = STATUS_BOOST[out.status] != null ? STATUS_BOOST[out.status] : 0;
  const occurrences = (typeof inp.occurrences === 'number') ? inp.occurrences : 1;
  const occurrenceScore = Math.min(0.20, Math.log10(1 + occurrences) / 10);
  const score = Math.max(0, Math.min(1, overlap + statusBoost + occurrenceScore));
  return {
    procedure: row,
    procedure_id: row.id,
    score,
    hits,
    overlap,
    status_boost: statusBoost,
    occurrence_score: occurrenceScore,
    triggers_matched: matchedTriggers
  };
}

function matchProcedure(opts) {
  opts = opts || {};
  const prompt = opts.prompt;
  const agent_id = opts.agent_id || null;
  const cwd = opts.cwd || null;
  const minConfidence = typeof opts.min_confidence === 'number' ? opts.min_confidence : DEFAULT_MIN_CONFIDENCE;
  const limit = Math.max(10, Math.min(200, opts.limit || DEFAULT_LIMIT));

  if (!prompt) {
    return { ok: false, reason: 'missing_prompt', match: null };
  }

  // agent_id is OPTIONAL — when omitted, we search across all agents
  // for compiled_procedure records in this cwd. The MCP caller
  // typically doesn't know which agent owns the procedures (a common
  // setup writes them under 'claude-code', not the caller's default
  // 'mcp-substrate'); omitting agent_id lets the matcher find the
  // records regardless of which agent wrote them.
  const stateMod = opts.state || state;
  const queryArgs = { type: 'compiled_procedure', cwd, limit, order: 'desc' };
  if (agent_id) queryArgs.agent_id = agent_id;
  const rows = stateMod.queryActions(queryArgs) || [];
  if (!rows.length) return { ok: true, match: null, reason: 'no_procedures' };

  const promptTokens = tokenizePrompt(prompt);
  const scored = [];
  for (const row of rows) {
    const s = scoreProcedure(row, promptTokens);
    if (s) scored.push(s);
  }
  if (!scored.length) return { ok: true, match: null, reason: 'no_overlap' };
  scored.sort((a, b) => (b.score - a.score) || (b.hits - a.hits));
  const top = scored[0];
  if (top.score < minConfidence) {
    return { ok: true, match: null, reason: 'below_confidence', best_score: top.score };
  }
  return { ok: true, match: top };
}

// File-path / flag extraction heuristics. Best-effort; nothing fancy.
const FILE_PATH = /[\w./-]+\.[\w]{1,6}\b/g;
const FLAG_LIKE = /(?:^|\s)(--?[a-z][\w-]*)/gi;

function extractArgsFromPrompt(prompt) {
  const text = String(prompt || '');
  const pathMatches = text.match(FILE_PATH) || [];
  const paths = Array.from(new Set(pathMatches.map(p => p.trim())));
  const flags = [];
  let m;
  while ((m = FLAG_LIKE.exec(text)) !== null) {
    if (!flags.includes(m[1])) flags.push(m[1]);
  }
  return { paths, flags };
}

// For each step in the template, attempt to fill `args` from extracted
// prompt context. Read/Edit/Write/MultiEdit get the first available
// path (cursor advances per step). Grep/Glob/Bash declare missing args
// because their arguments are too varied to infer without the LLM.
// The caller decides what to do with `missing_args` — usually surface
// to the LLM to finalize.
function buildReplayPlan(opts) {
  opts = opts || {};
  const procedure = opts.procedure;
  const prompt = opts.prompt;
  if (!procedure || !prompt) return { ok: false, reason: 'missing_procedure_or_prompt' };

  const out = safeJson(procedure.output) || {};
  const inp = safeJson(procedure.input) || {};
  const template = Array.isArray(out.template) ? out.template : [];
  if (!template.length) {
    return {
      ok: true,
      procedure_id: procedure.id,
      procedure_signature: inp.pattern_signature || '',
      steps: [],
      parameter_slots_filled: 0,
      missing_args: 0,
      extracted: { paths: [], flags: [] }
    };
  }

  const extracted = extractArgsFromPrompt(prompt);
  let pathCursor = 0;
  let filled = 0;
  let missing = 0;

  const steps = template.map((step, i) => {
    const toolName = step.tool || step.tool_name || '<unknown>';
    const filledStep = {
      step_index: i,
      tool: toolName,
      args: Object.assign({}, step.args || {}),
      source: 'template'
    };
    const lower = String(toolName).toLowerCase();
    if (lower === 'read' || lower === 'edit' || lower === 'write' || lower === 'multiedit') {
      if (extracted.paths[pathCursor]) {
        filledStep.args.file_path = extracted.paths[pathCursor];
        filledStep.source = 'prompt_extraction';
        pathCursor++;
        filled++;
      } else {
        filledStep.missing = ['file_path'];
        missing++;
      }
    } else if (lower === 'grep' || lower === 'glob') {
      filledStep.missing = ['pattern'];
      missing++;
    } else if (lower === 'bash') {
      filledStep.missing = ['command'];
      missing++;
    }
    return filledStep;
  });

  return {
    ok: true,
    procedure_id: procedure.id,
    procedure_signature: inp.pattern_signature || '',
    steps,
    parameter_slots_filled: filled,
    missing_args: missing,
    extracted
  };
}

module.exports = {
  matchProcedure,
  buildReplayPlan,
  scoreProcedure,
  tokenizePrompt,
  extractArgsFromPrompt,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_LIMIT,
  STATUS_BOOST
};
