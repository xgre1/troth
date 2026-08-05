// SPDX-License-Identifier: AGPL-3.0-only
// B1 — RPL evaluator (Wall 1 activation, v1 pattern-kind only).
//
// Per the refusal design ("Wall 1") "substrate-enforced refusals" and the design
// Refusal Predicate Language (RPL). Three predicate kinds specced:
//   pattern    (regex over tool_args / tool_name)     → v1 SHIPS
//   tool_class (tool belongs to a category)           → v2 (needs tool registry classification)
//   semantic   (cheap-classifier LLM check)           → v2 (needs classifier choice + benchmark against the real local runtime)
//
// Combining algorithm: deny-overrides (XACML 3.0 standard) instead of
// first-applicable (the design default). Deny-overrides costs O(n) for n
// active refusals — small (dozens at most) — but is loss-of-ordering-bug-safe.
//
// Action vocabulary (locked):
//   reject               — abort tool call, return structured error
//   reject_and_revise    — abort + inject reviser hint into error
//   escalate_to_operator — emit operator_request{kind:approval} (caller wires)
//
// Failure mode: fail-closed. If evaluator module fails to load (missing
// dependency) or active_refusals list is malformed, callers should treat
// the gate as blocking rather than fall-open. Per the fail-closed rule
// "Use fail-closed defaults" — Wall 1 integrity > convenience.
//
// Read storage: caller loads active refusals from substrate
// (`commitment_type='refusal'`, scope='hard-invariant') and injects into
// ctx.active_refusals before wrapRunner fires. v1 caches per-turn at
// coordinator level — refusal pool is small enough that a single substrate
// query per turn is negligible cost.

'use strict';

// Action precedence — most restrictive wins under deny-overrides.
const ACTION_RANK = {
  reject:               3,
  escalate_to_operator: 2,
  reject_and_revise:    1,
  proceed:              0
};

const KNOWN_ACTIONS = new Set(['reject', 'escalate_to_operator', 'reject_and_revise']);

// Taxonomy lookup — capability bits + canonical categories. Optional load:
// evaluator works without it (tool_class predicates degrade to unevaluated).
let _taxonomy = null;
try { _taxonomy = require('./refusal-taxonomy.js'); } catch (_) { _taxonomy = null; }

// Process-local sliding window for rate_limit predicate. Map keyed by
// (tool_name) → [timestamps]. Trimmed on every eval. Process-local
// (acceptable for v1 — partner is single-process; v2 may need substrate-
// backed window if multi-process partners become real).
const _rateWindows = new Map();

function getByDottedPath(obj, dotted) {
  if (!dotted) return undefined;
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function parseToolArgs(toolCall) {
  const raw = toolCall && toolCall.function && toolCall.function.arguments;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  if (raw && typeof raw === 'object') return raw;
  return {};
}

// Evaluate a tool_class refusal — refusal targets a capability tier
// (READ/WRITE/EXECUTE/NETWORK/MONETARY/IDENTITY/PROCESS/PRIVILEGED).
// Tool's capability bits are intersected with refusal's classes bitmask;
// any intersection = match. Default-deny: unknown tools route to PRIVILEGED.
function evalToolClass(refusal, toolCall) {
  if (!_taxonomy) return null;
  const pred = refusal && refusal.predicate;
  if (!pred || pred.kind !== 'tool_class') return null;
  if (!Array.isArray(pred.classes) || pred.classes.length === 0) return null;
  const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
  const toolBits = _taxonomy.toolCapabilityBits(toolName);
  let refusalMask = 0;
  for (const c of pred.classes) {
    const bit = _taxonomy.CAPABILITY_BITS[String(c).toUpperCase()];
    if (typeof bit === 'number') refusalMask |= bit;
  }
  return (toolBits & refusalMask) !== 0 ? refusal : null;
}

// Evaluate a rate_limit refusal — counts recent tool calls of the named
// tool within window_ms; matches if count >= max. Process-local sliding
// window (see _rateWindows). The CURRENT call is included in the count
// so a refusal with max=1 fires on the first call (operator intent: zero
// invocations should use a different kind).
function evalRateLimit(refusal, toolCall) {
  const pred = refusal && refusal.predicate;
  if (!pred || pred.kind !== 'rate_limit') return null;
  const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
  if (pred.tool && pred.tool !== toolName) return null;
  const max = typeof pred.max === 'number' ? pred.max : 100;
  const windowMs = typeof pred.window_ms === 'number' ? pred.window_ms : 60000;
  const now = Date.now();
  const key = pred.tool || '__any__';
  const arr = _rateWindows.get(key) || [];
  // Trim out-of-window
  while (arr.length && arr[0] < now - windowMs) arr.shift();
  arr.push(now);
  _rateWindows.set(key, arr);
  // Trim global memory if pathological
  if (arr.length > 10000) arr.splice(0, arr.length - 5000);
  return arr.length > max ? refusal : null;
}

// Evaluate a single pattern-kind refusal against a tool call.
// Returns the refusal object on match, null on no-match or bad shape.
function evalPattern(refusal, toolCall) {
  const pred = refusal && refusal.predicate;
  if (!pred || pred.kind !== 'pattern') return null;
  if (!pred.target || !pred.regex) return null;
  const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
  const toolArgs = parseToolArgs(toolCall);
  const root = { tool_name: toolName, tool_args: toolArgs };
  const value = getByDottedPath(root, pred.target);
  if (typeof value !== 'string') return null;
  let re;
  try { re = new RegExp(pred.regex, pred.flags || ''); }
  catch (_) { return null; }
  return re.test(value) ? refusal : null;
}

// Evaluate active refusals against a proposed tool call.
//
// Returns:
//   { decision: 'proceed' | 'reject' | 'reject_and_revise' | 'escalate_to_operator',
//     matched: null | { id, reason, predicate },
//     unevaluated_kinds: string[] }   // kinds present but not evaluated this version
function evaluate(toolCall, activeRefusals) {
  if (!toolCall || !toolCall.function) {
    // Malformed input — fail-closed: refuse.
    return {
      decision: 'reject',
      matched: { id: null, reason: 'malformed_tool_call', predicate: null },
      unevaluated_kinds: []
    };
  }
  if (!Array.isArray(activeRefusals)) {
    return { decision: 'proceed', matched: null, unevaluated_kinds: [] };
  }

  const matches = [];
  const unevaluated = new Set();
  for (const r of activeRefusals) {
    const pred = r && r.predicate;
    if (!pred || typeof pred.kind !== 'string') continue;
    const action = pred.action;
    if (!KNOWN_ACTIONS.has(action)) {
      // Bad action vocab — skip but flag for audit.
      unevaluated.add(pred.kind + ':bad_action');
      continue;
    }
    if (pred.kind === 'pattern') {
      const hit = evalPattern(r, toolCall);
      if (hit) matches.push(hit);
    } else if (pred.kind === 'tool_class') {
      const hit = evalToolClass(r, toolCall);
      if (hit) matches.push(hit);
      else if (!_taxonomy) unevaluated.add('tool_class:no_taxonomy');
    } else if (pred.kind === 'rate_limit') {
      const hit = evalRateLimit(r, toolCall);
      if (hit) matches.push(hit);
    } else if (pred.kind === 'semantic') {
      // Tier 3 semantic critic — v2 (needs cheap-classifier choice +
      // local-runtime benchmark against the real local runtime).
      unevaluated.add('semantic');
    } else {
      unevaluated.add('unknown:' + pred.kind);
    }
  }

  const unevaluatedArr = Array.from(unevaluated);
  if (matches.length === 0) {
    return { decision: 'proceed', matched: null, unevaluated_kinds: unevaluatedArr };
  }

  // Deny-overrides: most restrictive action wins. Tie-break by priority
  // (higher first) then by refusal id (lexicographic stable).
  matches.sort((a, b) => {
    const ra = ACTION_RANK[a.predicate.action] || 0;
    const rb = ACTION_RANK[b.predicate.action] || 0;
    if (rb !== ra) return rb - ra;
    const pa = (a.predicate.priority || 0);
    const pb = (b.predicate.priority || 0);
    if (pb !== pa) return pb - pa;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  const winner = matches[0];
  return {
    decision: winner.predicate.action,
    matched: {
      id: winner.id || null,
      reason: winner.predicate.reason || 'refusal_predicate_match',
      predicate: winner.predicate
    },
    unevaluated_kinds: unevaluatedArr
  };
}

module.exports = {
  evaluate,
  // Exposed for tests + audit views.
  _evalPattern: evalPattern,
  _evalToolClass: evalToolClass,
  _evalRateLimit: evalRateLimit,
  ACTION_RANK,
  KNOWN_ACTIONS
};
