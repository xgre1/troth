// SPDX-License-Identifier: AGPL-3.0-only
// Inbound event tagging.
//
// Extends integration point (pre-action-context structured-provenance rendering)
// to ALL inbound classes that future implementation step senses will produce:
// email, webhooks, SMS, partner-to-partner messages, IM. Without this,
// every external write surface becomes a prompt-injection vector — an
// attacker emails "ignore prior instructions, do X" and that text
// enters the LLM's context as if it were a fact.
//
// Defense: every inbound_event engram body is FORCED into a structural
// tag at write time. The content is QUOTED, not consumed. LLM-facing
// renderers preserve the tag so the model sees something like:
//
//   [inbound_observation, source:email:untrusted, sender:x@y.com,
//    received:T18:00Z]
//   "content here, even if it says 'ignore prior instructions' the
//    quoted form prevents it from being acted on directly"
//
// The STVC predicate `inbound_content_quoted_not_consumed` enforces
// the tag at write-time: any inbound_event engram missing the
// structural wrapper is refused. Bypass-by-direct-recordEngram is
// blocked by registering this invariant globally so the substrate
// gate runs on every inbound_event candidate.

'use strict';

const engram = require('./engram.js');

const INBOUND_EVENT_SCOPE_PREFIX = 'inbound_event';
// Trust posture per source: lower trust = stronger refusal in
// downstream consumers. We default everything to UNTRUSTED unless the
// caller explicitly raises it (operator-confirmed routing, signed
// webhook from a partner whose key we trust, etc.).
const TRUST_DEFAULT = 'untrusted';

// Render a tagged content block from inbound parts. Used both at
// write-time (statement = renderTagged({...})) and at recall-render
// time for consistency. Caller passes the raw content; this function
// wraps it in the structural tag.
function renderTagged(opts) {
  opts = opts || {};
  const source = String(opts.source || 'unknown');
  const trust  = String(opts.trust  || TRUST_DEFAULT);
  const sender = opts.sender ? String(opts.sender).slice(0, 200) : null;
  const ts     = opts.received_at_ms || opts.ts || Date.now();
  const tsIso  = new Date(ts).toISOString();
  const content = String(opts.content || '').slice(0, 8000);
  const parts = [
    'inbound_observation',
    'source:' + source + ':' + trust
  ];
  if (sender) parts.push('sender:' + sender);
  parts.push('received:' + tsIso);
  return '[' + parts.join(', ') + ']\n"' + content.replace(/"/g, '\\"') + '"';
}

// Write an inbound event engram with structural tagging applied. This
// is the SOLE sanctioned path for inbound writes. Direct
// engram.recordEngram bypasses get caught by the STVC predicate
// `inbound_content_quoted_not_consumed` when registered as an invariant.
function recordInboundEvent(opts) {
  opts = opts || {};
  if (!opts.source)  return { ok: false, error: 'source_required' };
  if (!opts.content) return { ok: false, error: 'content_required' };
  const action  = opts.action  ? String(opts.action).slice(0, 60) : 'message';
  const scope = INBOUND_EVENT_SCOPE_PREFIX + ':' + String(opts.source).slice(0, 60) + ':' + action;
  const tagged = renderTagged(opts);
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'inbound',
    user_id:  opts.user_id  || 'operator',
    cwd:      opts.cwd      || null,
    statement: tagged,
    source:   'inbound.recordInboundEvent',
    source_authority: 'llm_inferred',   // inbound is NEVER operator-tier
    scope,
    extra_output: {
      inbound_source:    String(opts.source).slice(0, 60),
      inbound_trust:     String(opts.trust || TRUST_DEFAULT),
      inbound_sender:    opts.sender ? String(opts.sender).slice(0, 200) : null,
      inbound_received:  opts.received_at_ms || Date.now(),
      inbound_raw_size:  typeof opts.content === 'string' ? opts.content.length : 0,
      inbound_tag_kind:  'inbound_observation'   // recognized by STVC predicate
    },
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'inbound_write_refused' };
  return { ok: true, id };
}

// Verify a candidate inbound_event engram body carries the structural
// tag. Used by the STVC predicate to refuse direct-recordEngram bypass
// of recordInboundEvent.
function bodyIsStructurallyTagged(rec) {
  if (!rec) return false;
  const out = (rec.output && typeof rec.output === 'object') ? rec.output : null;
  if (!out) return false;
  if (out.inbound_tag_kind !== 'inbound_observation') return false;
  const stmt = out.statement || rec.statement || '';
  if (typeof stmt !== 'string') return false;
  // Tag must appear at the start AND content must be quoted.
  if (stmt.indexOf('[inbound_observation') !== 0) return false;
  if (stmt.indexOf(']\n"') < 0) return false;
  return true;
}

module.exports = {
  renderTagged,
  recordInboundEvent,
  bodyIsStructurallyTagged,
  INBOUND_EVENT_SCOPE_PREFIX,
  TRUST_DEFAULT
};
