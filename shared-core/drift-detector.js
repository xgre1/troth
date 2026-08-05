// SPDX-License-Identifier: AGPL-3.0-only
// drift-detector — G3.
//
// Substrate self-knowledge. The dream's Property #6: "the substrate
// notices when its own output is degrading — drifting from active
// commitments, going sycophantic, losing voice. Without this, the
// substrate is no better than current agents."
//
// Mechanism: identity-vectors.scoreAgainstIdentity already computes the
// alignment of any text against a set of identity directions (anchors
// and refusals). This module wraps it with caching, threshold logic,
// and L1 alert recording so the dashboard / next-turn loop can react.
//
// Semantics:
//   - Anchor direction: a unit vector pointing toward "this commitment
//     is honored". A reply that EMBODIES the anchor scores positively;
//     one that contradicts it scores near zero or negative. We flag
//     when an anchor alignment falls BELOW `anchor_threshold` (default 0).
//   - Refusal direction: a unit vector pointing toward "this refusal is
//     respected" (i.e., declining the forbidden action). A reply that
//     respects it scores positively; one that drifts toward the
//     forbidden behavior scores low or negative. We flag when alignment
//     drops below `refusal_threshold` (default 0) OR when the reply
//     aligns positively with what the refusal forbids (caller-derivable).
//
// Direction vectors are expensive (one embedding call per contrastive
// prompt). We cache by a signature of the input commitment set so a
// stable identity computes once, not per-reply. TTL forces periodic
// recompute to pick up commitment additions / revisions.

const idv    = require('./identity-vectors.js');
const state  = require('./state.js');
const ar     = require('./action-record.js');
const cfg    = require('./transport-config.js');

const DEFAULT_TTL_MS            = 30 * 60 * 1000;   // 30 min cache
const DEFAULT_ANCHOR_THRESHOLD  = 0;                // alignment must be >= 0 (neutral or positive)
const DEFAULT_REFUSAL_THRESHOLD = 0;                // same — must not actively pull toward refused behavior

// Sycophancy regex floor — fast deterministic check that runs alongside
// embedding alignment. Pure embedding similarity against generic
// anchored/unanchored MoD vectors smooths over obvious caves like
// "You're absolutely right!" because the centroid math collapses
// the semantic distance to specific-anchor honoring vs violating.
// Until per-anchor LLM-generated contrastive sets are wired (a future
// enhancement: identity-vectors.computeIdentityDirections accepts
// commitment-specific positives/negatives), this regex set catches
// the universal sycophancy signature that no honoring reply contains.
const SYCOPHANCY_PATTERNS = [
  /\byou(?:'?re|\s+are)\s+(?:absolutely\s+|completely\s+|totally\s+|definitely\s+)?right\b/i,
  /\b(?:great|excellent|fantastic|brilliant|perfect)\s+(?:point|question|idea|suggestion|insight)\b/i,
  /\bi\s+(?:was|am)\s+(?:wrong|mistaken|incorrect)\b/i,
  /\bi\s+(?:apologize|am\s+sorry)\s+for\s+(?:my|the|that)\b/i,
  /\bi'?ll\s+(?:switch|change|use|go\s+with|defer\s+to|follow)\s+(?:to\s+)?(?:whatever|your|the\s+approach\s+you|the\s+method\s+you|your\s+(?:preferred|recommended|suggested))/i,
  /\b(?:sure(?:\s+thing)?|of\s+course|absolutely|definitely)[!,.]\s+(?:i'?ll|let'?s)\b/i,
  /\byou\s+(?:know|are)\s+best\b/i,
  /\bi\s+(?:agree|defer)\s+(?:completely|entirely|to\s+your\s+judgment|without\s+question)\b/i,
  /\b(?:yes|okay|ok),?\s+(?:definitely|absolutely|sure)[,.!]/i,
  /\bi'?ll\s+(?:go\s+with|do|follow)\s+whatever\s+you\s+say\b/i,
  /\bno\s+need\s+to\s+(?:defend|argue|push\s+back)\b/i,
  /\bthanks?\s+for\s+(?:the\s+)?correction\b/i,
  /\bthat'?s\s+a\s+(?:much\s+)?better\s+approach\s+than\s+(?:what\s+i\s+was|mine|my)\b/i
];

function matchSycophancyPatterns(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (let i = 0; i < SYCOPHANCY_PATTERNS.length; i++) {
    if (SYCOPHANCY_PATTERNS[i].test(text)) hits.push(i);
  }
  return hits;
}

const _directionCache = new Map();   // signature → { directions, cached_at }

function signatureOfCommitments(commitments) {
  if (!Array.isArray(commitments)) return 'empty';
  const ids = [];
  for (const c of commitments) {
    if (!c || typeof c !== 'object') continue;
    const id = c.id || c.statement;
    if (id) ids.push(String(id));
  }
  ids.sort();
  return ids.join('|');
}

// Compute (or return cached) identity directions for a commitment set.
// Caller passes commitments as an array of `{id, commitment_type, statement}`
// rows — same shape used everywhere else in the substrate.
async function ensureDirections(opts) {
  opts = opts || {};
  const commitments = Array.isArray(opts.commitments) ? opts.commitments : [];
  const ttlMs = typeof opts.ttl_ms === 'number' ? opts.ttl_ms : DEFAULT_TTL_MS;
  const sig = signatureOfCommitments(commitments);
  const cached = _directionCache.get(sig);
  if (cached && (Date.now() - cached.cached_at) < ttlMs) return cached.directions;
  const refusals = [];
  const anchors  = [];
  for (const c of commitments) {
    if (!c || !c.statement) continue;
    if (c.commitment_type === 'refusal') refusals.push(c.statement);
    else if (c.commitment_type === 'anchor') anchors.push(c.statement);
  }
  if (!refusals.length && !anchors.length) return [];
  const directions = await idv.computeIdentityDirections({
    refusals, anchors,
    host: opts.host || cfg.embeddingHost()
  });
  _directionCache.set(sig, { directions, cached_at: Date.now() });
  return directions;
}

// Score a reply text against the active commitment set. Returns a
// structured verdict the caller can act on (record alert, prepend
// drift notice, surface to dashboard).
//
// Two parallel signals:
//   1. Embedding alignment vs identity directions (semantic, requires
//      embedding host). Catches subtle drift; misses obvious sycophancy
//      because generic anchored/unanchored MoD vectors smooth over the
//      specific-anchor honoring vs violating distinction.
//   2. Sycophancy regex floor (deterministic, no I/O). Catches universal
//      cave phrasings ("You're absolutely right!", "I'll switch to
//      whatever you say") that no honoring reply contains. Operates
//      without commitments — regardless of identity, these phrasings
//      indicate the substrate caved.
//
// degraded = (any embedding violation) OR (any sycophancy match).
async function scoreReply(text, opts) {
  opts = opts || {};
  if (typeof text !== 'string' || !text.trim()) {
    return { degraded: false, reason: 'empty_text', anchor_violations: [], refusal_violations: [], all_scores: [], sycophancy_matches: [] };
  }
  // Sycophancy regex — runs first, cheap, no commitments needed.
  const sycHits = matchSycophancyPatterns(text);

  let scores = [];
  let anchorViolations = [];
  let refusalViolations = [];
  if (opts.skip_embedding !== true) {
    const directions = await ensureDirections(opts);
    if (directions.length) {
      scores = await idv.scoreAgainstIdentity(text, directions, { host: opts.host || cfg.embeddingHost() });
      const anchorThreshold  = typeof opts.anchor_threshold  === 'number' ? opts.anchor_threshold  : DEFAULT_ANCHOR_THRESHOLD;
      const refusalThreshold = typeof opts.refusal_threshold === 'number' ? opts.refusal_threshold : DEFAULT_REFUSAL_THRESHOLD;
      for (const s of scores) {
        if (s.kind === 'anchor'  && s.alignment < anchorThreshold)  anchorViolations.push(s);
        if (s.kind === 'refusal' && s.alignment < refusalThreshold) refusalViolations.push(s);
      }
    }
  }

  const degraded = sycHits.length > 0 || anchorViolations.length > 0 || refusalViolations.length > 0;
  return {
    degraded,
    anchor_violations:   anchorViolations,
    refusal_violations:  refusalViolations,
    sycophancy_matches:  sycHits,
    all_scores:          scores,
    signals: [
      sycHits.length          ? 'sycophancy_regex(' + sycHits.length + ')' : null,
      anchorViolations.length ? 'anchor_violation('  + anchorViolations.length  + ')' : null,
      refusalViolations.length ? 'refusal_violation(' + refusalViolations.length + ')' : null
    ].filter(Boolean)
  };
}

// Persist a drift alert to L1 so the dashboard SSE stream surfaces it.
// Uses type='decision' (substrate decided this reply degraded) which
// fits action-record's existing schema and is queryable by the SSE
// poller without schema changes.
function recordDriftAlert(opts) {
  opts = opts || {};
  if (!opts.agent_id) return null;
  const id = ar.uuidv7();
  const rec = {
    id, timestamp: Date.now(),
    type: 'decision',
    agent_id: opts.agent_id,
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || 'default',
    parent_id: opts.parent_id || null,
    input: {
      kind: 'degradation_alert',
      signals: {
        anchor_violation_count:  (opts.anchor_violations  || []).length,
        refusal_violation_count: (opts.refusal_violations || []).length
      }
    },
    output: {
      decision: 'flagged_degraded',
      reason: opts.reason || 'reply_alignment_dropped_below_threshold',
      reply_excerpt: String(opts.reply_text || '').slice(0, 240),
      anchor_violations:  opts.anchor_violations  || [],
      refusal_violations: opts.refusal_violations || [],
      confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.7
    }
  };
  const v = ar.validate(rec);
  if (!v.ok) return null;
  state.recordAction(rec, ar.toSearchText(rec));
  return id;
}

// Compose a self-correction notice the substrate can prepend to its
// next-turn system prefix. Returns null when no drift to surface.
// This is the optional G3 step from the plan: "substrate prepends
// 'I notice my reply may be drifting from [commitment]' to next turn".
function composeSelfCorrectionNotice(verdict) {
  if (!verdict || !verdict.degraded) return null;
  const lines = [];
  lines.push('SELF-NOTICE: my prior reply may have drifted from active identity.');
  if (verdict.sycophancy_matches && verdict.sycophancy_matches.length) {
    lines.push('Detected sycophantic phrasing — caved to the user without new evidence.');
  }
  if (verdict.anchor_violations && verdict.anchor_violations.length) {
    lines.push('Anchors I appeared to weaken:');
    for (const v of verdict.anchor_violations.slice(0, 3)) {
      lines.push('  - "' + (v.source || v.label) + '" (alignment ' + v.alignment.toFixed(3) + ')');
    }
  }
  if (verdict.refusal_violations && verdict.refusal_violations.length) {
    lines.push('Refusals I appeared to weaken:');
    for (const v of verdict.refusal_violations.slice(0, 3)) {
      lines.push('  - "' + (v.source || v.label) + '" (alignment ' + v.alignment.toFixed(3) + ')');
    }
  }
  lines.push('Re-anchor to these in the next reply. Do not silently drift further.');
  return lines.join('\n');
}

// Wipes the cached directions; called by tests and by commitment-update
// flows when the commitment signature changes.
function clearCache() { _directionCache.clear(); }

module.exports = {
  ensureDirections,
  scoreReply,
  recordDriftAlert,
  composeSelfCorrectionNotice,
  signatureOfCommitments,
  matchSycophancyPatterns,
  clearCache,
  SYCOPHANCY_PATTERNS,
  DEFAULT_TTL_MS,
  DEFAULT_ANCHOR_THRESHOLD,
  DEFAULT_REFUSAL_THRESHOLD
};
