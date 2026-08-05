// SPDX-License-Identifier: AGPL-3.0-only
// procedure-compiler — Phase C of the partner-agent design map.
//
// Closes the "skills compiled into behavior" gap from the core design note
// (Property #3 + #5). Today, every recurring workflow ("run tests, then
// commit, then push") goes through the LLM each time, even though the
// substrate has watched the agent execute the same sequence dozens of
// times. The pre-LLM dispatcher (dispatch.js) can route around the LLM
// when a known procedure matches — but only if the substrate has
// COMPILED procedures to match against. Pre-Phase-C: no procedure type
// existed; the dispatcher had nothing to match.
//
// This module is the detector + compiler. Pure JS. No LLM, no
// embeddings, no external library:
//   1. detectPatterns({agent_id, cwd, since}) — scans recent tool_call
//      action_records grouped by session_id, finds n-grams (length 2-4)
//      of tool_name sequences that recur across ≥2 distinct sessions
//      (Trace2Skill threshold — the only concrete reference point in
//      published skill-compilation literature per Agent 3 audit).
//   2. compileProcedure(pattern) — emits a template ActionRecord with
//      pattern_signature, template (sequence of {tool, args}), status.
//   3. recordProcedures({agent_id, cwd}) — full pipeline: detect,
//      filter against existing compiled_procedure rows (no duplicates),
//      persist survivors. Returns {ok, written, detected, deduped}.
//
// What we DO NOT do here: execute the procedure. Execution is the
// dispatcher's responsibility (dispatch.js, future work). This
// module is detection + persistence only — the substrate accumulates a
// library of skills, surfacing decisions stay where they belong.

const actionRec = require('./action-record.js');
const state     = require('./state.js');

const DEFAULT_NGRAM_MIN = 2;
const DEFAULT_NGRAM_MAX = 4;
const DEFAULT_MIN_SESSIONS = 2;     // Trace2Skill (arXiv:2603.25158)
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

// ── Helpers ─────────────────────────────────────────────────────────────

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function toolNameOf(row) {
  const inp = safeJson(row.input) || {};
  return inp.tool_name || null;
}

// dialogue.turn / background_worker.* events are NOT skill candidates —
// they are substrate bookkeeping, not user-driven workflow steps. Filter
// them out so n-gram detection focuses on real tool calls.
function isSkillCandidateTool(name) {
  if (!name) return false;
  if (name === 'dialogue.turn') return false;
  if (name.startsWith('background_worker.')) return false;
  if (name.startsWith('insight-')) return false;
  return true;
}

function signatureFor(seq) {
  return seq.join(' → ');
}

// ── Detection ───────────────────────────────────────────────────────────

// Pull recent tool_call rows scoped to agent/cwd, group by session_id,
// emit per-session ordered tool_name arrays. Filters non-skill tools.
function pullSessionStreams(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  if (!agent_id) return new Map();
  const cwd      = opts.cwd || null;
  const since    = typeof opts.since === 'number' ? opts.since : Date.now() - DEFAULT_LOOKBACK_MS;
  const limit    = Math.max(50, Math.min(2000, opts.limit || 1000));

  const rows = state.queryActions({
    type: 'tool_call', agent_id, cwd, since, limit, order: 'asc'
  }) || [];

  const bySession = new Map();
  for (const row of rows) {
    const name = toolNameOf(row);
    if (!isSkillCandidateTool(name)) continue;
    const sid = row.session_id || ('null:' + (row.cwd || '')); // group cwd-only rows
    let arr = bySession.get(sid);
    if (!arr) { arr = []; bySession.set(sid, arr); }
    arr.push({ name, ts: row.timestamp, id: row.id });
  }
  return bySession;
}

// Generate n-grams of tool names from one ordered session stream.
// Returns array of {seq: [...names], start_ts, end_ts}.
function ngramsFromStream(stream, nMin, nMax) {
  const out = [];
  if (!Array.isArray(stream) || stream.length < nMin) return out;
  for (let n = nMin; n <= nMax; n++) {
    for (let i = 0; i + n <= stream.length; i++) {
      const window = stream.slice(i, i + n);
      out.push({
        seq: window.map(w => w.name),
        start_ts: window[0].ts,
        end_ts: window[window.length - 1].ts
      });
    }
  }
  return out;
}

// Detect recurring tool-call n-grams across sessions. Returns array of
// {signature, seq, occurrences, sessions, first_seen_ts, last_seen_ts}
// sorted by occurrence count desc.
function detectPatterns(opts) {
  opts = opts || {};
  const minSessions = typeof opts.min_sessions === 'number' ? opts.min_sessions : DEFAULT_MIN_SESSIONS;
  const nMin        = typeof opts.ngram_min === 'number' ? opts.ngram_min : DEFAULT_NGRAM_MIN;
  const nMax        = typeof opts.ngram_max === 'number' ? opts.ngram_max : DEFAULT_NGRAM_MAX;

  const streams = pullSessionStreams(opts);
  if (!streams.size) return [];

  // Map<signature, { seq, occurrences, sessions: Set, first_seen_ts, last_seen_ts }>
  const candidates = new Map();
  for (const [sid, stream] of streams) {
    const grams = ngramsFromStream(stream, nMin, nMax);
    for (const g of grams) {
      const sig = signatureFor(g.seq);
      let c = candidates.get(sig);
      if (!c) {
        c = {
          signature: sig,
          seq: g.seq.slice(),
          occurrences: 0,
          sessions: new Set(),
          first_seen_ts: g.start_ts,
          last_seen_ts:  g.end_ts
        };
        candidates.set(sig, c);
      }
      c.occurrences++;
      c.sessions.add(sid);
      if (g.start_ts < c.first_seen_ts) c.first_seen_ts = g.start_ts;
      if (g.end_ts   > c.last_seen_ts)  c.last_seen_ts  = g.end_ts;
    }
  }

  const stable = [];
  for (const c of candidates.values()) {
    if (c.sessions.size >= minSessions) {
      stable.push({
        signature: c.signature,
        seq: c.seq,
        occurrences: c.occurrences,
        sessions: Array.from(c.sessions),
        first_seen_ts: c.first_seen_ts,
        last_seen_ts:  c.last_seen_ts
      });
    }
  }
  stable.sort((a, b) =>
    (b.occurrences - a.occurrences) ||
    (b.sessions.length - a.sessions.length) ||
    (b.last_seen_ts - a.last_seen_ts));
  return stable;
}

// ── Compilation ─────────────────────────────────────────────────────────

// Turn a detected pattern into a compiled_procedure ActionRecord shape.
// First-pass template: tool_name sequence with empty args slots. The
// dispatcher will fill arg slots from prompt context at
// replay time. Trigger keywords are derived heuristically from tool
// names (a humanized verb form per tool).
function compileProcedure(pattern, opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  if (!agent_id || !pattern || !Array.isArray(pattern.seq) || !pattern.seq.length) {
    return null;
  }
  const template = pattern.seq.map(toolName => ({
    tool: toolName,
    args: {}   // placeholder — dispatcher fills at replay
  }));
  const triggerKeywords = deriveTriggers(pattern.seq);
  const name = pattern.seq.join('+').toLowerCase().replace(/[^a-z0-9+]/g, '');
  const id = actionRec.uuidv7();
  const rec = {
    id,
    timestamp: Date.now(),
    type: 'compiled_procedure',
    agent_id,
    cwd: opts.cwd || null,
    user_id: opts.user_id || 'default',
    parent_id: null,
    input: {
      pattern_signature: pattern.signature,
      occurrences: pattern.occurrences,
      detected_in_sessions: pattern.sessions || [],
      sample_window_ms: typeof opts.sample_window_ms === 'number' ? opts.sample_window_ms : DEFAULT_LOOKBACK_MS
    },
    output: {
      template,
      status: 'detected',  // detected → approved → deprecated
      name,
      trigger_keywords: triggerKeywords,
      parameter_slots: [],   // populated when args extraction lands
      first_seen_ts: pattern.first_seen_ts,
      last_seen_ts:  pattern.last_seen_ts
    }
  };
  return rec;
}

// Heuristic keyword derivation from tool names. Conservative — emits
// at most 4 short verbs per pattern. Real keyword surfacing will lean
// on dispatcher prompt-classification at replay time.
function deriveTriggers(seq) {
  if (!Array.isArray(seq)) return [];
  const out = new Set();
  for (const name of seq) {
    const lower = String(name || '').toLowerCase();
    if (lower.includes('bash')) { out.add('run'); out.add('execute'); }
    if (lower.includes('edit')) { out.add('edit'); out.add('modify'); }
    if (lower.includes('write')) { out.add('write'); out.add('create'); }
    if (lower.includes('read')) { out.add('read'); out.add('open'); }
    if (lower.includes('grep')) { out.add('search'); out.add('find'); }
    if (lower.includes('glob')) { out.add('list'); out.add('find'); }
    if (lower.includes('test')) { out.add('test'); }
    if (lower.includes('commit')) { out.add('commit'); }
    if (lower.includes('push')) { out.add('push'); }
  }
  return Array.from(out).slice(0, 8);
}

// ── Persistence ─────────────────────────────────────────────────────────

// Fetch existing compiled_procedure signatures for this agent so we
// don't re-record the same pattern on every detector run.
function existingSignatures(agent_id, cwd) {
  if (!agent_id) return new Set();
  const rows = state.queryActions({
    type: 'compiled_procedure',
    agent_id, cwd: cwd || null,
    limit: 500, order: 'desc'
  }) || [];
  const out = new Set();
  for (const row of rows) {
    const inp = safeJson(row.input) || {};
    if (inp.pattern_signature) out.add(inp.pattern_signature);
  }
  return out;
}

// Full pipeline: detect → filter against existing → compile → persist.
function recordProcedures(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  if (!agent_id) return { ok: false, reason: 'missing_agent_id' };

  const detected = detectPatterns(opts);
  const known = existingSignatures(agent_id, opts.cwd);
  const fresh = detected.filter(p => !known.has(p.signature));

  const written = [];
  for (const pattern of fresh) {
    const rec = compileProcedure(pattern, opts);
    if (!rec) continue;
    const v = actionRec.validate(rec);
    if (!v.ok) continue;
    state.recordAction(rec, actionRec.toSearchText(rec));
    written.push(rec.id);
  }

  return {
    ok: true,
    detected_count: detected.length,
    deduped_count: fresh.length,
    written: written
  };
}

module.exports = {
  detectPatterns,
  compileProcedure,
  recordProcedures,
  pullSessionStreams,
  ngramsFromStream,
  signatureFor,
  isSkillCandidateTool,
  // Defaults exposed for tests + tuning
  DEFAULT_NGRAM_MIN,
  DEFAULT_NGRAM_MAX,
  DEFAULT_MIN_SESSIONS,
  DEFAULT_LOOKBACK_MS
};
