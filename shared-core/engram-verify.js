// SPDX-License-Identifier: AGPL-3.0-only
// engram-verify — TMMA-inspired write-time quality control for the
// engram pool.
//
// Pre-Phase-E: every engram write landed in the substrate as
// commitment_type='engram' with no integrity check. As Phase F's
// identity-extract task seeds dialogue-derived facts AND the existing
// pipelines (auto-engram, lessons → engram conversion) accumulate
// writes, the pool can drift toward:
//   - Stale duplicates (same fact written 5x with no consolidation)
//   - Silent contradictions ("user prefers X" + "user hates X" both
//     active, retrieval surfaces both, the LLM is confused)
//   - Low-trust drips that pollute Property #4 identity injection
//
// TMMA (Truth-Maintained Memory Agent, NeurIPS 2025 workshop) addresses
// this with a write-time verifier: every new fact is checked against
// the existing pool for duplication / contradiction, assigned a
// truth_score (0..1) and a tier (working / summarized / archival /
// flagged). The injector can then promote high-truth-score / archival
// facts and demote / hide flagged ones.
//
// This module is the verifier. Pure JS, no LLM, no embedding network
// call — Jaccard token overlap + simple negation detection. Conservative
// by design: better to miss a real contradiction than to wrongly flag
// a novel fact as a duplicate.
//
// Wiring: engram.recordEngram(opts) accepts opts.auto_verify=true to
// invoke this module before persisting; result populates output.
// truth_score + output.tier on the persisted record. Default off
// (backwards-compatible — existing callers see no behavioral change).

const TIERS = Object.freeze({
  WORKING:    'working',     // just-written, trusted, recent
  SUMMARIZED: 'summarized',  // consolidated from multiple mentions
  ARCHIVAL:   'archival',    // long-lived, frequently retrieved
  FLAGGED:    'flagged'      // contradicts existing or low-trust
});

// ── Token / negation primitives ─────────────────────────────────────────

// STOP_WORDS — common low-content tokens dropped before Jaccard scoring.
// IMPORTANT: 'not' / 'never' / 'no' are NOT here — they carry the
// semantic polarity the verifier needs to detect contradictions.
// Stripping them would cause "user prefers X" + "user does not prefer X"
// to look like near-duplicates instead of contradictions.
const STOP_WORDS = new Set([
  'the','a','an','is','are','to','of','in','and','or','for','on','at',
  'with','by','from','that','this','it','as','i','you','we','they','my',
  'your','our','be','have','has','had','do','does','did',
  'yes','user','users','user\'s'
]);

const NEGATION_TOKENS = new Set([
  'not','never','no','don\'t','doesn\'t','isn\'t','aren\'t','wasn\'t',
  'weren\'t','won\'t','wouldn\'t','can\'t','cannot','dislike','dislikes',
  'hate','hates','avoid','avoids','reject','rejects','refuse','refuses'
]);

// Polarity-flip antonyms for write-time contradiction detection.
//  cleanup:
//   - Earlier table had `'hates':'prefers'` AFTER `'hates':'loves'` so the
//     duplicate key silently overrode love/hate detection. Each key now
//     appears exactly once.
//   - prefer↔avoid (not prefer↔hate): "user prefers terse" vs "user hates
//     terse" is two different polarity scales conflated.
//   - Added verbosity / size / quality antonym families so identity-scope
//     contradictions like "prefers terse" vs "prefers verbose" trip the
//     verifier (operator-confirmed production bug: 39× wrong "claude"
//     facts coexisted with 258× "qwen" facts because the verifier never
//     caught antonyms of size/style adjectives).
const NEGATION_OPPOSITES = Object.freeze({
  // Affect
  'love':    'hate',   'hate':    'love',
  'loves':   'hates',  'hates':   'loves',
  // Preference (one canonical antonym per token — avoid conflicts)
  'like':    'dislike','dislike': 'like',
  'likes':   'dislikes','dislikes':'likes',
  'prefer':  'avoid',  'avoid':   'prefer',
  'prefers': 'avoids', 'avoids':  'prefers',
  // Frequency
  'always':  'never',  'never':   'always',
  // Usage
  'use':     'shun',   'shun':    'use',
  'uses':    'shuns',  'shuns':   'uses',
  // Capability state
  'enable':  'disable','disable': 'enable',
  'enables': 'disables','disables':'enables',
  // Binary state
  'on':      'off',    'off':     'on',
  // Verbosity / size / pace (covers style preferences in identity scope)
  'terse':   'verbose','verbose': 'terse',
  'brief':   'lengthy','lengthy': 'brief',
  'concise': 'wordy',  'wordy':   'concise',
  'short':   'long',   'long':    'short',
  'fast':    'slow',   'slow':    'fast',
  'quiet':   'loud',   'loud':    'quiet',
  // Quality
  'good':    'bad',    'bad':     'good',
  // Permission
  'allow':   'forbid', 'forbid':  'allow',
  'allows':  'forbids','forbids': 'allows'
});

function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Detects whether two statements are semantically negated relative to
// each other. Two channels:
//   1. Direct negation token in one but not the other (asymmetric)
//   2. Opposite-pair verb in one matches the other's complement
function isNegated(tokensA, tokensB) {
  const negA = anyOverlap(tokensA, NEGATION_TOKENS);
  const negB = anyOverlap(tokensB, NEGATION_TOKENS);
  if (negA !== negB) return true;          // exactly one contains negation
  for (const t of tokensA) {
    const opp = NEGATION_OPPOSITES[t];
    if (opp && tokensB.has(opp)) return true;
  }
  return false;
}

function anyOverlap(tokens, set) {
  for (const t of tokens) if (set.has(t)) return true;
  return false;
}

// ── Verifier ────────────────────────────────────────────────────────────

const DEFAULT_DUP_THRESHOLD     = 0.70;  // Jaccard ≥ this → "near-duplicate"
const DEFAULT_RELATED_THRESHOLD = 0.40;  // Jaccard ≥ this → "related, not duplicate"

// Verify a candidate statement against an existing-engram pool. The
// pool is passed in (caller fetches via engram.listEngrams) so this
// stays a pure function — testable, no I/O. Returns:
//   { ok, truth_score, tier, contradiction_refs, duplicate_of, reason }
function verifyStatement(opts) {
  opts = opts || {};
  const statement = String(opts.statement || '').trim();
  const existing  = Array.isArray(opts.existing) ? opts.existing : [];
  const dupT      = typeof opts.dup_threshold      === 'number' ? opts.dup_threshold      : DEFAULT_DUP_THRESHOLD;
  const relT      = typeof opts.related_threshold === 'number' ? opts.related_threshold : DEFAULT_RELATED_THRESHOLD;

  if (!statement) {
    return { ok: false, reason: 'empty_statement' };
  }

  const candTokens = tokenize(statement);
  if (candTokens.size < 2) {
    // Statement too short to verify meaningfully — accept as working
    // tier with full trust (the caller probably knows what they're
    // doing if they're writing a 1-token engram).
    return {
      ok: true, truth_score: 1.0, tier: TIERS.WORKING,
      contradiction_refs: [], duplicate_of: null,
      reason: 'too_short_to_verify'
    };
  }

  let bestDup     = null;     // {id, score, statement}
  let contradicts = [];       // [{id, score, statement}]
  let relatedHits = 0;

  for (const e of existing) {
    if (!e || !e.statement) continue;
    if (e.id === opts.self_id) continue;  // never compare to self
    const exTokens = tokenize(e.statement);
    const score = jaccard(candTokens, exTokens);
    if (score < relT) continue;
    relatedHits++;
    const negated = isNegated(candTokens, exTokens);
    if (score >= dupT) {
      if (negated) {
        contradicts.push({ id: e.id, score, statement: e.statement });
      } else {
        if (!bestDup || score > bestDup.score) {
          bestDup = { id: e.id, score, statement: e.statement };
        }
      }
    } else if (negated) {
      // Related-but-negated mid-overlap — treat as soft contradiction
      // worth flagging to the operator.
      contradicts.push({ id: e.id, score, statement: e.statement });
    }
  }

  // Tier + truth score assignment.
  if (contradicts.length > 0) {
    return {
      ok: true,
      truth_score: 0.30,
      tier: TIERS.FLAGGED,
      contradiction_refs: contradicts.map(c => c.id),
      duplicate_of: null,
      reason: 'contradicts_existing',
      detail: { contradicts: contradicts.slice(0, 3) }
    };
  }
  if (bestDup) {
    // Near-duplicate without negation — caller likely wants to bump
    // existing salience rather than write a redundant copy. Verifier
    // returns SUMMARIZED tier + duplicate_of; engram.recordEngram can
    // honor this hint or write anyway with a warning.
    return {
      ok: true,
      truth_score: 0.95,
      tier: TIERS.SUMMARIZED,
      contradiction_refs: [],
      duplicate_of: bestDup.id,
      reason: 'near_duplicate_of_existing',
      detail: { duplicate: bestDup }
    };
  }
  // Novel fact — full trust, working tier.
  return {
    ok: true,
    truth_score: 1.0,
    tier: TIERS.WORKING,
    contradiction_refs: [],
    duplicate_of: null,
    reason: relatedHits > 0 ? 'novel_with_related_context' : 'fully_novel'
  };
}

module.exports = {
  verifyStatement,
  tokenize,
  jaccard,
  isNegated,
  TIERS,
  DEFAULT_DUP_THRESHOLD,
  DEFAULT_RELATED_THRESHOLD
};
