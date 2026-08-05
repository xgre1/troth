// SPDX-License-Identifier: AGPL-3.0-only
// Mind Q-DECISION-PATTERNS — heuristic decision detection.
//
// Pure-function detector: scans a user prompt (and optionally the prior
// assistant turn for proposal context) and returns a structured decision
// candidate when the language matches one of three tiers, else null.
//
// Tiers (precision over recall):
//   T1 LOCK     — explicit lock markers ("P1:", "Decision:", "Locked:")
//                 Highest confidence. Summary is the text after the marker.
//   T2 COMMIT   — short user commit phrases ("ok do it", "πάμε με X",
//                 "let's go with X"). Summary derived from prior assistant
//                 turn if available, else from the user prompt itself.
//   T3 REJECT   — negative decisions ("won't use X", "rejected because Y").
//                 Stricter to avoid catching error strings like "Request
//                 rejected (429)". Summary frames as a rejection.
//
// What this module does NOT do:
//   - I/O (callers thread in transcript text + project list).
//   - Project resolution past a tiny vote (caller can override with cwd).
//   - Dedup across turns (callers compare by recent_summaries set).
//
// (Q-DECISION-PATTERNS, deferred from v0.1).

'use strict';

// ── Tier 1: lock markers ────────────────────────────────────────────────
// "P1:", "Q5.", "Q-DECISION:", "Decision:", "Locked:", "DECIDED:"
// Anchored at start of a line OR after whitespace; followed by content.
const LOCK_RE = /(?:^|\n)\s*((?:[PQ]-?\d+|decision|decided|locked|locking)\s*[:.]\s*[^\n]{8,300})/i;

// ── Tier 2: explicit commit phrases ─────────────────────────────────────
// Anchored short messages OR mid-sentence "let's go with" / "going with".
// Greek: "πάμε", "πάμε με", "κάνε το", "προχώρα", "ναι".
const COMMIT_SHORT_RE = /^(?:ok[,\s]+)?(?:do it|go|go ahead|proceed|ship it|just do it|make it so|πάμε|πάμε[!.]?$|κάνε το|προχώρα|προχώρησε|ναι κάνε|ναι πάμε)\s*[!.\s]*$/i;
const COMMIT_PHRASE_RE = /\b(?:let'?s go with|let'?s do|going with|i(?:'?ll| will) (?:go with|use|implement)|chose to|choosing to|will use|πάμε με|αποφάσισα να|θα πάμε με|λοκάρω)\s+([^.!?\n]{6,200})/i;

// ── Tier 3: rejections ──────────────────────────────────────────────────
// Stricter — must be followed by a noun phrase or context, NOT by punct/digits.
// Excludes "Request rejected (429)", "rejected with status", etc.
const REJECT_RE = /\b(?:reject(?:ed|ing)?|won'?t (?:use|do|go with|ship)|drop(?:ping|ped)?|abandon(?:ing|ed)?|not going with|απορρίπτω|απέρριψα|δεν πάμε με)\s+(?!\(|\d|with status|by|http)([a-zA-Zα-ωΑ-Ω][^.!?\n]{4,200})/i;

// ── Noise filter ────────────────────────────────────────────────────────
// Avoid false positives from system reminders, tool outputs, slash
// commands, error strings.
const NOISE_PREFIX_RE   = /^[\s]*[<\/]/;
const NOISE_CONTENT_RE  = /(API Error|429|rate[- ]?limit|Request (?:rejected|failed)|stack ?trace|exit ?code|err(?:no|or)\s*[:=])/i;

// "because X" / "γιατί X" — extract rationale tail when present.
const RATIONALE_RE = /\b(?:because|since|so that|reason[:\s]+|γιατί|επειδή|με σκοπό)\s+([^.!?\n]{6,200})/i;

function trimSummary(s, max = 240) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractRationale(text) {
  if (!text) return '';
  const m = text.match(RATIONALE_RE);
  return m ? trimSummary(m[1], 200) : '';
}

// Pull the last paragraph or last decision-shaped sentence from the prior
// assistant turn — the proposal the user just committed to / rejected.
// Caller passes plain text; we never read files here.
function summarizeProposal(priorAssistantText) {
  if (!priorAssistantText) return '';
  const lines = String(priorAssistantText).split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  // Prefer the last line that looks like a recommendation, fall back to
  // the last non-trivial line.
  const recRe = /\b(recommend|propose|suggest|use|go with|ship|implement|approach|option)\b/i;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    if (recRe.test(lines[i]) && lines[i].length >= 20 && lines[i].length <= 320) {
      return trimSummary(lines[i]);
    }
  }
  // Fall back to last non-trivial line.
  return trimSummary(lines[lines.length - 1]);
}

// Resolve a project_id from the available context.
//   1. If exactly one active project, use it (cheapest case).
//   2. Otherwise vote on which project's name (lowercased) appears in
//      the user prompt + prior assistant turn.
//   3. Final fallback: null (caller decides whether to skip or default).
function pickProject(projects, prompt, priorAssistantText) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  if (projects.length === 1) return projects[0].id;
  const haystack = ((prompt || '') + '\n' + (priorAssistantText || '')).toLowerCase();
  let best = null, bestN = 0;
  for (const p of projects) {
    if (!p || !p.id) continue;
    const needle = String(p.name || p.id).toLowerCase();
    if (needle.length < 3) continue;
    let n = 0, idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
    if (n > bestN) { best = p; bestN = n; }
  }
  return best ? best.id : null;
}

// Main entry. Returns null when nothing to capture.
//
//   detectDecision({ prompt, prior_assistant, projects, recent_summaries })
//
//   prompt            — user's latest message (string)
//   prior_assistant   — text of the most recent assistant turn (optional)
//   projects          — array of {id, name} from latest mind state
//   recent_summaries  — Set<string> of normalized summaries to dedup against
//
//   → { project_id, summary, rationale, kind, confidence } | null
function detectDecision(opts) {
  opts = opts || {};
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) return null;
  if (prompt.length < 4 || prompt.length > 4000) return null;
  if (NOISE_PREFIX_RE.test(prompt)) return null;
  if (NOISE_CONTENT_RE.test(prompt)) return null;

  const priorAssistant = opts.prior_assistant || '';
  const projects = opts.projects || [];
  const recent   = opts.recent_summaries instanceof Set ? opts.recent_summaries : new Set();

  let summary = '', rationale = '', kind = '', confidence = 0;

  // T1 — lock markers (highest confidence)
  const lockM = prompt.match(LOCK_RE);
  if (lockM) {
    summary = trimSummary(lockM[1]);
    rationale = extractRationale(prompt);
    kind = 'lock';
    confidence = 0.95;
  } else {
    // T3 — rejections (run before T2; rejection language can co-exist
    // with commit phrasing and we want the negative framing to win).
    const rejM = prompt.match(REJECT_RE);
    if (rejM) {
      summary = 'Rejected: ' + trimSummary(rejM[1]);
      rationale = extractRationale(prompt);
      kind = 'reject';
      confidence = 0.75;
    } else {
      // T2 — explicit commit
      const shortM = COMMIT_SHORT_RE.test(prompt);
      const phraseM = prompt.match(COMMIT_PHRASE_RE);
      if (shortM) {
        const proposal = summarizeProposal(priorAssistant);
        if (!proposal) return null; // commit-without-context is too noisy
        summary = 'Committed: ' + proposal;
        rationale = '';
        kind = 'commit';
        confidence = 0.65;
      } else if (phraseM) {
        summary = 'Committed: ' + trimSummary(phraseM[1]);
        rationale = extractRationale(prompt);
        kind = 'commit';
        confidence = 0.7;
      } else {
        return null;
      }
    }
  }

  if (!summary) return null;
  const norm = summary.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
  if (recent.has(norm)) return null;

  return {
    project_id: pickProject(projects, prompt, priorAssistant),
    summary,
    rationale,
    kind,
    confidence
  };
}

module.exports = {
  detectDecision,
  // Exposed for tests and tuning experiments.
  _internal: {
    LOCK_RE, COMMIT_SHORT_RE, COMMIT_PHRASE_RE, REJECT_RE,
    NOISE_PREFIX_RE, NOISE_CONTENT_RE, RATIONALE_RE,
    pickProject, summarizeProposal, extractRationale
  }
};
