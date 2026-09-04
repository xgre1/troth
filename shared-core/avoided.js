// SPDX-License-Identifier: AGPL-3.0-only
// Negative-knowledge substrate.
//
// The agent's failures (critic blocks, loopbreaker fires, verification
// failures, user reverts) are first-class records here. At inference
// time we match incoming prompts/actions against fingerprints of past
// failures and surface a NEGATIVE PRECEDENT block — "you tried X
// before; it failed because Y; don't repeat".
//
// Schema (registered in action-record.js TYPES.avoided_path):
//   input.fingerprint:        sha256-truncated, deterministic across same-shape failures
//   input.reason_kind:        'critic_block' | 'loopbreaker' | 'verification_fail' |
//                             'user_revert' | 'timeout' | 'budget_exceeded'
//   input.attempted_action_id (opt): the original action that failed
//   input.lesson_id           (opt): cross-link to legacy session_lessons row
//   output.avoidance_text:    short human-readable explanation
//   output.suggest_instead    (opt): proposed alternative, surfaced when relevant
//   output.cost_avoided_estimate (opt): $ saved by skipping next time
//
// Writes are gated on TROTH_NEGATIVE_KNOWLEDGE=1 (default OFF); reads
// also gate on the same flag so off-by-default users don't pay extra
// injection bytes.

const crypto = require('crypto');
const actionRecord = require('./action-record');

// ── Fingerprint: deterministic, low-collision identifier for a failure ────
// fingerprint(reason_kind, signals[]) — signals are the most-stable shape
// markers (tool name, error class, file path basename). Lower-cased to
// dedupe casing differences. Truncated to 16 hex chars (~64 bits) — plenty
// for collision avoidance at the per-project scale.
function fingerprint(reason_kind, signals) {
  const norm = [reason_kind || 'unknown']
    .concat(Array.isArray(signals) ? signals : [signals])
    .filter(Boolean)
    .map(s => String(s).toLowerCase().trim())
    .join('|');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// ── Writer ────────────────────────────────────────────────────────────────
function recordAvoidance(state, opts) {
  if (!state || !opts || !opts.reason_kind || !opts.avoidance_text) return null;
  const fp = opts.fingerprint || fingerprint(opts.reason_kind, opts.signals || []);
  const rec = actionRecord.create({
    type: 'avoided_path',
    agent_id: opts.agent_id || 'troth-plugin',
    session_id: opts.session_id || null,
    cwd: opts.cwd || null,
    parent_id: opts.parent_id || opts.attempted_action_id || null,
    input: {
      fingerprint: fp,
      reason_kind: opts.reason_kind,
      attempted_action_id: opts.attempted_action_id || null,
      lesson_id: opts.lesson_id || null,
      critic_verdict_id: opts.critic_verdict_id || null
    },
    output: {
      avoidance_text: opts.avoidance_text,
      suggest_instead: opts.suggest_instead || null,
      cost_avoided_estimate: typeof opts.cost_avoided_estimate === 'number'
        ? opts.cost_avoided_estimate : null
    }
  });
  const v = actionRecord.validate(rec);
  if (!v.ok) return null;
  return state.recordAction(rec, actionRecord.toSearchText(rec));
}

// ── Reader: pull recent avoidances matching the current scope ─────────────
// Filters by cwd and recency (TTL). Default TTL: 14 days (per P16.5 plan).
// Optionally narrowed by fingerprint match against the prompt's signals.
//
// promptSignals: array of strings derived from the current prompt (tool
// names, file basenames, key tokens). When non-empty, we only return
// avoidances whose fingerprint intersects (cheap suffix-match on input.signals).
function getAvoidedPaths(state, opts) {
  if (!state) return [];
  opts = opts || {};
  const ttlMs = opts.ttl_ms || 14 * 24 * 60 * 60 * 1000;
  const since = Date.now() - ttlMs;
  const limit = Math.min(parseInt(opts.limit || 10), 50);

  const db = state._dbForQuery && state._dbForQuery();
  if (!db) return [];

  const where = ["type = 'avoided_path'", 'timestamp >= @since'];
  const bind  = { since };
  if (opts.cwd)        { where.push('cwd = @cwd');               bind.cwd = opts.cwd; }
  if (opts.session_id) { where.push('session_id = @session_id'); bind.session_id = opts.session_id; }

  const rows = db.prepare(`
    SELECT id, timestamp, type, agent_id, session_id, user_id, cwd,
           parent_id, context_hash, input, output, verification, outcome
    FROM action_records
    WHERE ${where.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT @lim
  `).all({ ...bind, lim: limit * 5 });

  const parsed = rows.map(actionRecord.fromRow).filter(r => !r.verification.expired);

  // Dedup by fingerprint (most-recent wins).
  const seen = new Set();
  const deduped = [];
  for (const r of parsed) {
    const fp = r.input && r.input.fingerprint;
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    deduped.push(r);
  }

  // Optional fingerprint-signal intersection: substring match on stored
  // text vs any prompt signal. Cheap; precision-tunable downstream.
  if (Array.isArray(opts.promptSignals) && opts.promptSignals.length) {
    const sigs = opts.promptSignals.map(s => String(s).toLowerCase());
    const filtered = deduped.filter(r => {
      const hay = (
        (r.output && r.output.avoidance_text || '') + ' ' +
        (r.output && r.output.suggest_instead || '') + ' ' +
        (r.input  && r.input.fingerprint      || '')
      ).toLowerCase();
      return sigs.some(s => hay.includes(s));
    });
    return filtered.slice(0, limit);
  }
  return deduped.slice(0, limit);
}

// ── Surface format: build the L1-injectable block ─────────────────────────
// Returns a string suitable for injector.mjs to push as additionalContext
// when TROTH_NEGATIVE_KNOWLEDGE=1. Capped at maxChars (default 200, the
// L1 trigger budget) — over-budget records are truncated with a footer
// hint.
function surfaceNegativePrecedent(records, opts) {
  opts = opts || {};
  const maxChars = opts.maxChars || 200;
  if (!Array.isArray(records) || records.length === 0) return '';
  const lines = [];
  for (const r of records) {
    const reason = (r.input && r.input.reason_kind) || 'unknown';
    const text = (r.output && r.output.avoidance_text) || '';
    const sug  = (r.output && r.output.suggest_instead) || '';
    let line = '  · [' + reason + '] ' + text;
    if (sug) line += ' → suggest: ' + sug;
    lines.push(line);
    if (lines.join('\n').length >= maxChars) break;
  }
  let body = '[troth/negative_precedent] Past failures matching this prompt:\n' +
             lines.join('\n');
  if (body.length > maxChars) {
    const suffix = '\n…(truncated)';
    body = body.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
  }
  return body;
}

module.exports = {
  fingerprint,
  recordAvoidance,
  getAvoidedPaths,
  surfaceNegativePrecedent
};
