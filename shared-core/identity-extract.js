// SPDX-License-Identifier: AGPL-3.0-only
// identity-extract — populate the substrate's identity engram pool
// (agent_id='identity') from observed dialogue.
//
// The injector's identity block (plugin/hooks/injector.mjs P3.x) pulls
// commitment_type='engram' rows across all agent_ids to surface "user
// facts" each turn. Without anything in agent_id='identity', that
// foundational layer falls back to whatever happens to live in the
// operator's general session-memory pool — Property #4 of the dream
// paper ("memory as identity, always present") cannot fire distinctly
// because there's no dedicated identity surface.
//
// This module is the writer. It scans recent dialogue.turn records,
// extracts CONSERVATIVE candidate identity facts via pattern matching
// (no LLM, no NLI library), filters to facts repeated across ≥2
// distinct sessions, and writes them as engrams to agent_id='identity'.
//
// What we extract (high-precision patterns, low recall — we'd rather
// emit nothing than emit noise per Agent 4 audit findings):
//   1. Self-stated preferences: "I always X", "I prefer Y", "I never Z"
//   2. Self-stated workflow rules: "always do X before Y"
//   3. Explicit identity facts: "my name is", "my X is Y"
//   4. Tool / framework mentions repeated across sessions
//   5. Project context: "working on X", "building Y"
//
// What we EXPLICITLY DO NOT extract (Agent 4 negative findings):
//   LIWC personality inference (5% variance explained — noise)
//   Demographic persona stereotypes
//   Inferred personality from style (style ≠ psychology)
//   Single-mention claims (require ≥2 distinct sessions)
//
// All extraction is best-effort and idempotent. The substrate's
// fingerprint dedup at recordEngram prevents writing the same fact
// twice.

const dialogueMemory = require('./dialogue-memory.js');
const engram         = require('./engram.js');
const { resolveAgentId } = require('./agent-id.js');

// ── Patterns (conservative, high-precision) ─────────────────────────────

// Group 2 captures the predicate text (without the leading verb) so the
// emitted statement reads "user prefers X", "user never does X", etc.
// Boundaries: stop at sentence punctuation (.!?\n), at clause separators
// (,;:), or at the start of another self-clause ("and i ", "but i ",
// "so i ", "then i "). Without these splits, "I prefer X and I always Y"
// would be captured as a single 80-char predicate, losing the second
// fact entirely.
const SELF_PREFERENCE = /\bi (always|never|prefer|usually|hate|love|like|tend to|need to|want to) ([a-z0-9][^.!?\n,;:]{3,80}?)(?=[.!?\n,;:]|\s+(?:and|but|so|then|while|because)\s+i\b|$)/gi;

// "my X is Y" — capture both X and Y so we can shape the statement.
const SELF_DESCRIPTION = /\bmy ([a-z]{2,16}) (?:is|are) ([a-z0-9][^.!?\n]{2,60})/gi;

// "working on X" / "building X" / "developing X"
const PROJECT_CONTEXT = /\b(?:working on|building|developing|maintaining)\s+(?:the |a |an )?([a-z][a-z0-9_-]{2,40})\b/gi;

// TOOL_VOCABULARY pattern REMOVED entirely.
//
// The mere mention of a tool/framework name in dialogue does NOT mean
// the user "works with" it as a stable preference. Pattern was a noise
// generator: "Building react app" produced "user works with: react";
// "had to debug a jest crash" produced "user works with: jest" — same
// authority as operator's actual preferences. Production audit found
// 256+ duplicates of each. Wrong shape.
//
// Surviving patterns (SELF_PREFERENCE, SELF_DESCRIPTION, PROJECT_CONTEXT)
// only fire on OPERATOR'S EXPLICIT first-person statements ("I prefer",
// "my X is", "working on"). Those are operator's own words, so writes
// from this module now stamp source_authority='operator_confirmed' (see
// seedFromDialogue below) — not regex_extracted. Real operator signal,
// real authority.
//
// LLM-judged proactive identity capture goes through substrate-tools.
// update_identity (called by the partner during dialogue when LLM
// detects a save-worthy moment). That's the proactive path; this
// module is the deterministic backstop for explicit first-person
// statements that don't need LLM judgment.

// ── Extraction ──────────────────────────────────────────────────────────

// Normalize a candidate statement so dedup grouping treats trivial
// variations (whitespace, case, trailing punctuation) as the same fact.
function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

// Date bucket — used for "distinct sessions" check. We don't have a
// real session_id at the dialogue.turn level, so we proxy with
// day-of-year: two facts on different calendar days count as different
// sessions. Conservative — under-counts true session distinctness but
// never over-counts.
function dayBucket(ts) {
  if (!ts) return '0';
  return new Date(ts).toISOString().slice(0, 10);
}

// Extract candidate identity statements from a single user_text. Returns
// an array of { statement, source_pattern } objects. assistant_text is
// NOT scanned — we only extract things the USER said about themselves
// or their environment (per Agent 4 "speaker role confusion" warning).
function extractFromText(text) {
  const out = [];
  const t = String(text || '');
  if (!t || t.length < 6) return out;

  // SELF_PREFERENCE: "I always X" → "user always X"
  for (const m of t.matchAll(SELF_PREFERENCE)) {
    const verb = (m[1] || '').toLowerCase();
    const pred = (m[2] || '').trim().replace(/[.!?,;:]+$/, '');
    if (pred.length < 3) continue;
    out.push({
      statement: 'user ' + verb + ' ' + pred,
      source_pattern: 'self_preference'
    });
  }

  // SELF_DESCRIPTION: "my X is Y" → "user's X is Y"
  for (const m of t.matchAll(SELF_DESCRIPTION)) {
    const subject = (m[1] || '').toLowerCase();
    const value   = (m[2] || '').trim().replace(/[.!?,;:]+$/, '');
    if (value.length < 2) continue;
    // Reject ultra-generic subjects that produce noise.
    if (['way', 'idea', 'point', 'thing', 'guess', 'opinion'].includes(subject)) continue;
    out.push({
      statement: "user's " + subject + ' is ' + value,
      source_pattern: 'self_description'
    });
  }

  // PROJECT_CONTEXT: "working on X" → "user is working on X"
  for (const m of t.matchAll(PROJECT_CONTEXT)) {
    const project = (m[1] || '').toLowerCase().trim();
    if (project.length < 3) continue;
    // Reject pronouns / generic placeholders that capture-group might catch.
    if (['it', 'this', 'that', 'something', 'stuff'].includes(project)) continue;
    out.push({
      statement: 'user works on project: ' + project,
      source_pattern: 'project_context'
    });
  }

  return out;
}

// Group candidates by normalized statement, count distinct day buckets.
// Returns Map<key, {statement, source_pattern, count, sessions: Set, evidence: [{ts, snippet}]}>
function groupAndCount(candidates, turnTimestamps) {
  const groups = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const key = normalizeKey(c.statement);
    if (!key) continue;
    const ts = (turnTimestamps && turnTimestamps[i]) || Date.now();
    let g = groups.get(key);
    if (!g) {
      g = {
        statement: c.statement,
        source_pattern: c.source_pattern,
        count: 0,
        sessions: new Set(),
        evidence: []
      };
      groups.set(key, g);
    }
    g.count++;
    g.sessions.add(dayBucket(ts));
    if (g.evidence.length < 3) g.evidence.push({ ts, day: dayBucket(ts) });
  }
  return groups;
}

// Filter to stable facts: must appear across ≥minSessions distinct day
// buckets. Trace2Skill threshold is the reference (≥2 sessions). We use
// 2 by default — conservative enough to drop one-off comments without
// losing genuine recurring patterns.
function filterStable(groups, minSessions) {
  minSessions = typeof minSessions === 'number' && minSessions >= 1 ? minSessions : 2;
  const out = [];
  for (const g of groups.values()) {
    if (g.sessions.size >= minSessions) out.push(g);
  }
  // Sort by stability (more sessions first) so write order is meaningful.
  out.sort((a, b) => (b.sessions.size - a.sessions.size) || (b.count - a.count));
  return out;
}

// Pull recent dialogue, extract candidates, group, filter. Pure read
// path — no writes. Useful for previewing what would be seeded without
// touching the engram pool.
function previewExtract(opts) {
  opts = opts || {};
  // Identity facts cut across surfaces — what the user said in cli is
  // just as identity-relevant as what they said in voice. Default
  // reads from the unified partner brain (principal default applies);
  // pass source_agent_id explicitly to scope to one provenance pool
  // (operator audit / per-agent debugging).
  const agent_id = opts.source_agent_id || null;
  const cwd      = opts.cwd || null;
  const limit    = Math.max(10, Math.min(500, opts.limit || 200));
  const minSessions = typeof opts.min_sessions === 'number' ? opts.min_sessions : 2;

  const recentTurnsOpts = { cwd, limit };
  if (agent_id) recentTurnsOpts.agent_id = agent_id;
  const turns = dialogueMemory.recentTurns(recentTurnsOpts);
  const allCandidates = [];
  const candidateTimestamps = [];
  for (const t of turns) {
    const cands = extractFromText(t.user_text);
    for (const c of cands) {
      allCandidates.push(c);
      candidateTimestamps.push(t.ts);
    }
  }
  const groups = groupAndCount(allCandidates, candidateTimestamps);
  const stable = filterStable(groups, minSessions);
  return {
    turns_scanned: turns.length,
    candidates_total: allCandidates.length,
    distinct_groups: groups.size,
    stable_count: stable.length,
    stable
  };
}

// autonomous step — RETIRED.
//
// The auto-write path would scan dialogue with high-precision regex
// patterns and write survivors as operator_confirmed identity engrams.
// integration point (cryptographic operator-write binding) made the over-claim
// architecturally visible: regex pattern matching on operator's words
// is NOT operator's cryptographic seal. The  TOOL_VOCABULARY
// removal already retired the noisy half of this pipeline; the
// surviving SELF_PREFERENCE / SELF_DESCRIPTION / PROJECT_CONTEXT
// patterns suffer the same brittleness, just less obviously.
//
// Replacement: LLM-faculty proactive capture via substrate-tools.
// update_identity (writes at honest llm_inferred tier). Reflection-
// tick backfill is deferred (sealed cadence, LLM-faculty
// reviews accumulated dialogue, emits identity-capture intent engrams
// through the dispatcherer pipeline). Operator promotes select
// llm_inferred facts to operator_confirmed via signed CLI when
// reviewing.
//
// Helpers (extractFromText / groupAndCount / filterStable / previewExtract)
// are KEPT as pure inspection functions — callers can preview what
// regex would have surfaced for diagnostic / one-shot review without
// committing forged-tier writes. dry_run preview was the only use case
// that produced real value here.
function seedFromDialogue(opts) {
  opts = opts || {};
  const dryRun = !!opts.dry_run;
  const preview = previewExtract(opts);
  if (dryRun) return { ok: true, dry_run: true, ...preview, written: [], deprecated: true };
  return {
    ok: true,
    turns_scanned: preview.turns_scanned,
    stable_count:  preview.stable_count,
    written:       [],
    deprecated:    true,
    deprecation_reason: 'regex_pattern_extraction_is_not_operator_confirmation; use update_identity tool (llm_inferred) instead'
  };
}

module.exports = {
  extractFromText,
  groupAndCount,
  filterStable,
  previewExtract,
  seedFromDialogue,
  // Exposed for tests
  normalizeKey,
  dayBucket
};
