// SPDX-License-Identifier: AGPL-3.0-only
// Typed Commitment projector + status writers + drift sweeper —
//
//
// Tracks promises/claims the partner (or user) has made so the partner
// can detect drift: a commitment was made, time has passed, the world
// may have moved on. Without this, the partner forgets it ever said it
// would do something, or worse, keeps acting on a stale commitment that
// the operator already retracted.
//
// Substrate storage:
//   engram type='commitment', commitment_type='engram', scope='commitment'
//   output: { statement, claim, deadline?, source_engram_id?, ... }
//
// Status markers (R23 append-only, same pattern as goal-status.js):
//   scope='system:commitment-fulfilled'   parent_id=<commitment_id>
//   scope='system:commitment-retracted'   parent_id=<commitment_id>
//   scope='system:commitment-drifted'     parent_id=<commitment_id>
//
// Typed Commitment shape (design 2.2):
//   { id, claim, deadline, status, source_engram_id, ts }
//
// Status enum:
//   'active'    — no marker yet
//   'fulfilled' — partner/user evidence shows claim was honored
//   'retracted' — operator explicitly withdrew the commitment
//   'drifted'   — sweeper LLM judged the commitment stale or contradicted
//                 by subsequent evidence (Cohen+Levesque 1990
//                 "irrelevance" path — intention dropped not because
//                 achieved but because no longer applicable)
//
// Sweeper algorithm (sweepCommitments):
//   1. Pull open commitments older than MIN_AGE_FOR_SWEEP (default 1h)
//      so we don't judge things still in active flight.
//   2. Cap at MAX_BATCH (default 10) per sweep to bound LLM cost.
//   3. For each, fetch nearby evidence: recent engrams sharing
//      topic-overlap tokens with the claim text (cheap topic match).
//   4. Build a structured judge prompt: "Given this claim made at T0
//      and the evidence since, classify as fulfilled/retracted/active/
//      drifted." Cross-family critic rule if opts.critic_family supplied.
//   5. Parse JSON verdict per commitment; write status marker.
//   6. Idempotency: skip commitments judged within last RE_JUDGE_MS
//      (default 12h) to avoid re-querying LLM on the same item every
//      heartbeat.
//
// design grounding:
//   - Searle Speech Acts (1969): commissive acts (commitments) bind
//     speaker to future action. Tracking fulfillment is foundational.
//   - Cohen + Levesque 1990 "Intention is Choice with Commitment":
//     intentions persist until (a) achieved, (b) impossible, or (c)
//     irrelevant. Three exit conditions map to fulfilled/abandoned/
//     drifted.
//   - W3C PROV-O — Activity wasGeneratedBy / wasAttributedTo: every
//     status marker carries provenance back to source commitment +
//     judge identity.
//   - design R23 immutability — markers never UPDATE; always INSERT.
//   - MT-Bench (Zheng arXiv 2306.05685): self-enhancement bias when
//     model judges its own output. sweepCommitments enforces
//     cross-family critic when caller passes opts.judge_family +
//     opts.critic_family different.

'use strict';

const engram     = require('./engram.js');
const state      = require('./state.js');
const llmFamily  = require('./tools/llm-family.js');

const MIN_AGE_FOR_SWEEP_MS = 60 * 60 * 1000;      // 1h: don't judge in-flight
const RE_JUDGE_MS          = 12 * 60 * 60 * 1000; // 12h: re-judge cooldown
const MAX_BATCH_DEFAULT    = 10;
const TOPIC_TOKEN_LIMIT    = 5;
const EVIDENCE_LIMIT       = 10;
const COMMITMENT_SCOPE     = 'commitment';
const FULFILLED_SCOPE      = 'system:commitment-fulfilled';
const RETRACTED_SCOPE      = 'system:commitment-retracted';
const DRIFTED_SCOPE        = 'system:commitment-drifted';
const STOP_WORDS = new Set([
  'the','a','an','of','to','for','and','or','is','are','was','were','be','been',
  'in','on','at','by','with','from','as','this','that','these','those','it','its',
  'will','would','should','can','may','might','i','we','you','they','he','she'
]);

// ---- Status marker writers (R23 append-only) -------------------------

function _writeMarker(commitmentId, scope, statement, opts) {
  if (!commitmentId) throw new Error('typed-commitment: commitment_id required');
  return engram.recordEngram({
    agent_id:  opts && opts.agent_id || 'l4-coordinator',
    cwd:       opts && opts.cwd || null,
    user_id:   opts && opts.user_id || null,
    statement,
    salience:  1,
    scope,
    parent_id: commitmentId,
    source:    opts && opts.source || 'l4:commitment-sweeper',
    audience:  'substrate_internal',
    memory_class: 'operational'
  });
}

function markFulfilled(commitmentId, evidence, opts) {
  return _writeMarker(commitmentId, FULFILLED_SCOPE,
    'COMMITMENT FULFILLED: ' + (evidence || commitmentId).toString().slice(0, 200), opts);
}

function markRetracted(commitmentId, reason, opts) {
  return _writeMarker(commitmentId, RETRACTED_SCOPE,
    'COMMITMENT RETRACTED: ' + (reason || commitmentId).toString().slice(0, 200), opts);
}

function markDrifted(commitmentId, judgeNote, opts) {
  return _writeMarker(commitmentId, DRIFTED_SCOPE,
    'COMMITMENT DRIFTED: ' + (judgeNote || commitmentId).toString().slice(0, 200), opts);
}

// Returns the most recent status marker for a commitment, or null.
function _statusMarkerFor(commitmentId) {
  if (!commitmentId) return null;
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: commitmentId, limit: 50 }) || [];
    let best = null;
    for (const r of rows) {
      let out; try { out = JSON.parse(r.output); } catch (_) { continue; }
      const sc = out && out.scope;
      if (sc === FULFILLED_SCOPE || sc === RETRACTED_SCOPE || sc === DRIFTED_SCOPE) {
        if (!best || r.timestamp > best.timestamp) best = { row: r, out };
      }
    }
    return best;
  } catch (_) { return null; }
}

function statusFor(commitmentId) {
  const m = _statusMarkerFor(commitmentId);
  if (!m) return 'active';
  if (m.out.scope === FULFILLED_SCOPE) return 'fulfilled';
  if (m.out.scope === RETRACTED_SCOPE) return 'retracted';
  if (m.out.scope === DRIFTED_SCOPE)   return 'drifted';
  return 'active';
}

// ---- Projector --------------------------------------------------------

function _projectOne(row) {
  if (!row || !row.id) return null;
  const out = row.output || {};
  return {
    id:                row.id,
    claim:             out.claim || out.statement || row.statement || '',
    deadline:          typeof out.deadline === 'string' ? out.deadline : null,
    status:            statusFor(row.id),
    source_engram_id:  out.source_engram_id || row.parent_id || null,
    ts:                row.timestamp || null
  };
}

// List commitments. opts.status filters projection-side.
function listCommitments(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(500, opts.limit || 50));
  const rows = engram.listEngrams({
    scope: COMMITMENT_SCOPE,
    limit: limit * 4,
    audience: 'all'
  }) || [];
  const out = [];
  for (const row of rows) {
    const c = _projectOne(row);
    if (!c) continue;
    if (opts.status && c.status !== opts.status) continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

function getCommitment(commitmentId) {
  if (!commitmentId) return null;
  const rows = engram.listEngrams({ scope: COMMITMENT_SCOPE, limit: 500, audience: 'all' }) || [];
  for (const row of rows) {
    if (row.id === commitmentId) return _projectOne(row);
  }
  return null;
}

// ---- Drift sweeper ----------------------------------------------------

function _tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function _topicTokens(text) {
  const counts = {};
  for (const t of _tokenize(text)) {
    if (t.length < 4 || STOP_WORDS.has(t)) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, TOPIC_TOKEN_LIMIT);
}

function _gatherEvidence(commitment) {
  const tokens = _topicTokens(commitment.claim);
  if (!tokens.length) return [];
  const since = commitment.ts || 0;
  const rows = engram.listEngrams({ limit: 200, audience: 'all' }) || [];
  const ev = [];
  for (const row of rows) {
    if (!row.timestamp || row.timestamp <= since) continue;  // only post-commitment
    const stmt = (row.output && row.output.statement) || row.statement || '';
    const stTokens = new Set(_tokenize(stmt).filter(t => t.length >= 4));
    let overlap = 0;
    for (const t of tokens) if (stTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    ev.push({ ts: row.timestamp, statement: stmt.slice(0, 200), overlap });
    if (ev.length >= EVIDENCE_LIMIT) break;
  }
  return ev.sort((a, b) => b.overlap - a.overlap);
}

function _judgePrompt(commitment, evidence) {
  const lines = [];
  lines.push('Classify the status of this commitment.');
  lines.push('');
  lines.push('Commitment:');
  lines.push('  claim: ' + commitment.claim);
  if (commitment.deadline) lines.push('  deadline: ' + commitment.deadline);
  lines.push('  made_at: ' + new Date(commitment.ts).toISOString());
  lines.push('');
  if (evidence.length) {
    lines.push('Evidence since (most relevant first):');
    evidence.forEach((e, i) => {
      lines.push('  [' + (i + 1) + '] ' + new Date(e.ts).toISOString() + ' — ' + e.statement);
    });
  } else {
    lines.push('Evidence since: NONE (no related activity found in substrate)');
  }
  lines.push('');
  lines.push('Output ONE line of strict JSON:');
  lines.push('{"verdict":"fulfilled|retracted|active|drifted","why":"<=120 chars","confidence":0-1}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- fulfilled: explicit evidence the claim was honored');
  lines.push('- retracted: explicit evidence the operator/partner withdrew the claim');
  lines.push('- active: no clear evidence of either, but the claim is still plausibly in flight');
  lines.push('- drifted: world has moved on (subsequent goals contradict, deadline passed without action, topic abandoned)');
  return lines.join('\n');
}

function _parseVerdict(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj.verdict !== 'string') continue;
      const v = obj.verdict.toLowerCase();
      if (!['fulfilled','retracted','active','drifted'].includes(v)) continue;
      return {
        verdict:    v,
        why:        typeof obj.why === 'string' ? obj.why.slice(0, 120) : null,
        confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : null
      };
    } catch (_) { /* try next */ }
  }
  return null;
}

// Sweep open commitments. Returns { judged: [...], skipped: [...] }.
// Pure-ish: state writes happen via markFulfilled/Retracted/Drifted.
//   opts.llmCall(prompt) → Promise<text>     (required)
//   opts.judge_family    — model family of the judge (for cross-family check)
//   opts.critic_family   — required different family (defense)
//   opts.max_batch       — default 10
//   opts.min_age_ms      — default 1h (skip too-new commitments)
//   opts.re_judge_ms     — default 12h (skip recently-judged)
//   opts.now             — override Date.now() for tests
async function sweepCommitments(opts) {
  opts = opts || {};
  if (typeof opts.llmCall !== 'function') {
    return { ok: false, error: 'llmCall_required' };
  }
  if (opts.judge_family && opts.critic_family &&
      !llmFamily.isCrossFamily(opts.judge_family, opts.critic_family)) {
    return { ok: false, error: 'same_family_judge_critic',
             detail: 'MT-Bench self-enhancement bias — judge and critic must be different families' };
  }
  const now = opts.now || Date.now();
  const minAge   = typeof opts.min_age_ms  === 'number' ? opts.min_age_ms  : MIN_AGE_FOR_SWEEP_MS;
  const reJudge  = typeof opts.re_judge_ms === 'number' ? opts.re_judge_ms : RE_JUDGE_MS;
  const maxBatch = Math.max(1, Math.min(50, opts.max_batch || MAX_BATCH_DEFAULT));

  const all = listCommitments({ status: 'active', limit: 200 });
  const judged = [];
  const skipped = [];

  for (const c of all) {
    if (judged.length >= maxBatch) break;
    if ((now - (c.ts || 0)) < minAge) {
      skipped.push({ id: c.id, reason: 'too_new', age_ms: now - (c.ts || 0) });
      continue;
    }
    // Re-judge cooldown: check if a marker (any kind) was written
    // recently. A judge that flipped 'active' wouldn't write a marker
    // at all in v1 — we skip "we already looked and decided active"
    // by querying recent judge-loop records on the commitment. For
    // strict idempotency, we'd need an l4_commitment_judgments ledger;
    // v1 relies on the marker write being the only evidence and just
    // skips if a marker was written within reJudge ms (already-decided).
    const marker = _statusMarkerFor(c.id);
    if (marker && (now - marker.row.timestamp) < reJudge && marker.out.scope !== DRIFTED_SCOPE) {
      // 'drifted' is allowed to re-judge in case the world changes
      // again; fulfilled/retracted are terminal-ish.
      skipped.push({ id: c.id, reason: 'recent_marker' });
      continue;
    }

    const evidence = _gatherEvidence(c);
    const prompt   = _judgePrompt(c, evidence);
    let raw;
    try { raw = await opts.llmCall(prompt); }
    catch (e) {
      skipped.push({ id: c.id, reason: 'llm_threw', detail: String(e && e.message || e) });
      continue;
    }
    const verdict = _parseVerdict(raw);
    if (!verdict) {
      skipped.push({ id: c.id, reason: 'unparseable_verdict' });
      continue;
    }

    let markerId = null;
    if (verdict.verdict === 'fulfilled') {
      markerId = markFulfilled(c.id, verdict.why || 'judged fulfilled', { source: 'l4:commitment-sweeper' });
    } else if (verdict.verdict === 'retracted') {
      markerId = markRetracted(c.id, verdict.why || 'judged retracted', { source: 'l4:commitment-sweeper' });
    } else if (verdict.verdict === 'drifted') {
      markerId = markDrifted(c.id, verdict.why || 'judged drifted', { source: 'l4:commitment-sweeper' });
    }
    // 'active' writes no marker — commitment stays open, next sweep will
    // re-judge after reJudge cooldown elapses for fulfilled/retracted only
    // (active never writes a marker so falls through naturally next time).
    judged.push({
      id: c.id,
      verdict: verdict.verdict,
      why: verdict.why,
      confidence: verdict.confidence,
      marker_id: markerId,
      evidence_count: evidence.length
    });
  }

  return { ok: true, judged, skipped, batch_size: judged.length, total_open: all.length };
}

module.exports = {
  // projector
  listCommitments,
  getCommitment,
  statusFor,
  // writers
  markFulfilled,
  markRetracted,
  markDrifted,
  // sweeper
  sweepCommitments,
  // constants + internals (tests)
  COMMITMENT_SCOPE,
  FULFILLED_SCOPE,
  RETRACTED_SCOPE,
  DRIFTED_SCOPE,
  MIN_AGE_FOR_SWEEP_MS,
  RE_JUDGE_MS,
  _projectOne,
  _topicTokens,
  _judgePrompt,
  _parseVerdict,
  _statusMarkerFor
};
