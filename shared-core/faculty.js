// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// faculty.js — the model-agnostic faculty seam (the model-agnostic seam).
//
// THE thesis boundary: the SUBSTRATE authors the prompt and PARSES the
// returned tokens into intents through STVC. The LLM is a rented language
// region behind this one call; it NEVER holds a tool that writes authoritative
// memory or commits an action (standard S2). Any transport — anthropic,
// llamacpp, ollama, codex-oauth, or a minimal raw-HTTP shim — satisfies
// the contract by returning tokens.
//
// SCOPE OF M0: this is the SEAM only — a uniform wake() over the existing
// transports plus reflection-independence bookkeeping. The prompt-AUTHORING
// and token→intent PARSING (the drift fix that deletes intent_emit) is faculty workstream
// built INSIDE this module. Marked explicitly so the seam layers don't
// double-build. (See standards S1/S2, owedBy faculty workstream.)

const transportConfig = require('./transport-config.js');

// Resolve a transport by family name to a uniform { generate } shape. Each
// transport module under./transports exposes its own call surface; this
// adapter normalizes them. Returns null if the family is unavailable.
function _resolveTransport(family) {
  switch (family) {
    case 'anthropic':   return require('./transports/anthropic.js');
    case 'llamacpp':    return require('./transports/llamacpp.js');
    case 'ollama':      return require('./transports/ollama.js');
    case 'codex-oauth': return require('./transports/codex-oauth.js');
    case 'router':      return require('./transports/router.js');
    case 'subprocess':
    case 'subprocess-cli': return require('./transports/subprocess-cli.js');
    default: return null;
  }
}

// Which model family is currently driving the faculty. Per feedback: default
// to Claude (subscription) when local is offline. transport-config is the
// source of truth for the operator's wired provider.
function activeFamily() {
  try {
    const cfg = transportConfig.resolve ? transportConfig.resolve() : null;
    if (cfg && cfg.family) return cfg.family;
  } catch (_) {}
  return process.env.TROTH_FACULTY_FAMILY || 'anthropic';
}

// Families that run on the operator's OWN hardware — no engram bytes leave the
// machine. Everything NOT in this set is treated as REMOTE. Fail-closed by
// design: a new/unknown provider is gated by the sensitivity wall until
// explicitly classified local, so secrets can't leak through an unrecognized
// transport name.
const _LOCAL_FAMILIES = new Set(['llamacpp', 'ollama', 'subprocess', 'subprocess-cli']);
function _isRemoteFamily(family) { return !_LOCAL_FAMILIES.has(String(family || '')); }

// An engram is forbidden-on-remote if it carries operator
// secrets / vault material / health / financial data, is operator_only
// audience, is explicitly tagged sensitivity:'forbid_remote', OR is
// substrate_internal (engram-schemas.js documents substrate_internal as
// "never exposed to model context" — vault receipts etc.).
const _SENSITIVE_SCOPE_RE = /^(operator_secret|vault|health|financial):/i;
function _isSensitiveEngram(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.sensitivity === 'forbid_remote') return true;
  const aud = String(e.audience || '');
  if (aud === 'operator_only' || aud === 'substrate_internal') return true;
  if (_SENSITIVE_SCOPE_RE.test(String(e.scope || ''))) return true;
  return false;
}
function _scanSensitivity(engrams) {
  const list = Array.isArray(engrams) ? engrams : [];
  let count = 0;
  for (const e of list) if (_isSensitiveEngram(e)) count++;
  return { sensitive: count > 0, count };
}

// Best-effort token estimate when a transport reports no usage. char/4 is the
// standard rough heuristic; never fabricated as exact.
function _estimateTokens(s) { const n = String(s || '').length; return n ? Math.ceil(n / 4) : 0; }

// faculty_cost engram per wake — operator-visible cost/latency ledger.
function _facultyCostEngram(o) {
  o = o || {};
  return {
    class:    'faculty_cost',
    scope:    'faculty:cost',
    audience: 'operator',
    statement: 'faculty wake ' + o.family + ' — ' + (o.tokens_in | 0) + ' in / ' +
      (o.tokens_out | 0) + ' out, ' + (o.latency_ms | 0) + 'ms' + (o.refused ? ' [refused]' : ''),
    payload: {
      tick_id:      o.tick_id || null,
      faculty_class: o.family,
      provider:     o.family,
      tokens_in:    o.tokens_in  | 0,
      tokens_out:   o.tokens_out | 0,
      cost_usd:     (typeof o.cost_usd === 'number') ? o.cost_usd : 0,
      latency_ms:   o.latency_ms | 0,
      refused:      !!o.refused,
    },
  };
}

// remote_faculty_refused engram — audit trail for a blocked remote wake.
// reason ∈ {'sensitive_context', 'budget_exceeded'}.
function _remoteRefusedEngram(o) {
  o = o || {};
  const reason = o.reason || 'sensitive_context';
  return {
    class:    'remote_faculty_refused',
    scope:    'faculty:remote_refused',
    audience: 'operator',
    statement: 'remote faculty ' + o.family + ' refused: ' + reason +
      (reason === 'sensitive_context'
        ? ' (' + (o.sensitive_engram_count | 0) + ' engram(s))'
        : ' (' + (o.spent_usd != null ? o.spent_usd : '?') + ' / ' +
          (o.daily_usd != null ? o.daily_usd : '?') + ' USD)'),
    payload: {
      tick_id:                o.tick_id || null,
      faculty:                o.family,
      reason:                 reason,
      sensitive_engram_count: o.sensitive_engram_count | 0,
      spent_usd:              (typeof o.spent_usd === 'number') ? o.spent_usd : null,
      daily_usd:              (typeof o.daily_usd === 'number') ? o.daily_usd : null,
    },
  };
}

// Default engram writer: maps a schema object {scope,audience,statement,payload}
// to engram.recordEngram. payload rides in extra_output (recordEngram's
// arbitrary-metadata channel). auto_verify off — these are operational ledger
// records, not recall-pool memory. Overridable via opts.writeEngram for tests.
function _defaultEngramWriter(ctx) {
  ctx = ctx || {};
  return function (eng) {
    if (!eng) return;
    const engram = require('./engram.js');
    engram.recordEngram({
      agent_id:    ctx.agent_id || 'partner',
      user_id:     ctx.user_id  || 'operator',
      cwd:         ctx.cwd || null,
      statement:   eng.statement,
      scope:       eng.scope,
      audience:    eng.audience,
      source:      'faculty.wake',
      salience:    1,
      auto_verify: false,
      extra_output: eng.payload || {},
    });
  };
}

// wake({ prompt, grammar, audience, context_engrams, family, reflection,
//        ctx, tick_id, writeEngram, now, _transport })
//   → { tokens, worker_model_family, reflection_independence, faculty_cost }
//   | { tokens:'', refused:true, reason, sensitive_engram_count,... }
//
// The substrate (caller) authors `prompt`. wake() ONLY produces tokens. It
// never receives or forwards a writing tool. `grammar` (optional) is a decode
// constraint the transport may honor (L2-DECODE-TIME); ignored transports
// degrade to text. `reflection:true` requires a model family DIFFERENT from
// the worker that produced the content being reflected on (PART-C:64-92) —
// wake records whether independence held.
async function wake(opts) {
  opts = opts || {};
  const family = opts.family || activeFamily();
  const ctx = opts.ctx || {};
  const now = (typeof opts.now === 'function') ? opts.now : Date.now;
  const writeEngram = (typeof opts.writeEngram === 'function')
    ? opts.writeEngram
    : _defaultEngramWriter(ctx);

  // Sensitivity gate: a REMOTE faculty must never receive
  // operator-secret / vault / health / financial / operator_only /
  // substrate_internal engrams in its context. Refuse the wake — substrate
  // decides whether to re-wake on a local family. Both the refusal and a
  // zero-cost faculty_cost record are surfaced to the operator.
  if (_isRemoteFamily(family)) {
    const scan = _scanSensitivity(opts.context_engrams);
    if (scan.sensitive) {
      try { writeEngram(_remoteRefusedEngram({ family, reason: 'sensitive_context', sensitive_engram_count: scan.count, tick_id: opts.tick_id })); } catch (_) {}
      try { writeEngram(_facultyCostEngram({ family, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, tick_id: opts.tick_id, refused: true })); } catch (_) {}
      return {
        tokens: '', refused: true, reason: 'sensitive_context',
        sensitive_engram_count: scan.count, worker_model_family: family,
        reflection_independence: null,
      };
    }
    // Budget gate: if a remote daily
    // USD budget is in effect and already exhausted, refuse the wake
    // BEFORE the transport hit — caller can re-wake on a local family.
    // Local families bypass this gate (no marginal cost). budget.daily_usd
    // = 0 means "no remote calls today" (the explicit zero-budget case the
    // design spec calls out). Missing budget = unbounded (legacy behavior).
    const budget = opts.budget;
    if (budget && typeof budget.daily_usd === 'number') {
      const spent = (typeof budget.spent_usd === 'number') ? budget.spent_usd : 0;
      if (spent >= budget.daily_usd) {
        try { writeEngram(_remoteRefusedEngram({ family, reason: 'budget_exceeded', spent_usd: spent, daily_usd: budget.daily_usd, tick_id: opts.tick_id })); } catch (_) {}
        try { writeEngram(_facultyCostEngram({ family, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, tick_id: opts.tick_id, refused: true })); } catch (_) {}
        return {
          tokens: '', refused: true, reason: 'budget_exceeded',
          spent_usd: spent, daily_usd: budget.daily_usd,
          worker_model_family: family, reflection_independence: null,
        };
      }
    }
  }

  const transport = opts._transport || _resolveTransport(family);
  if (!transport || typeof transport.generate !== 'function') {
    throw new Error('faculty.wake: no usable transport for family=' + family +
      ' (transport must expose generate({prompt,grammar})→{text|tokens})');
  }
  const t0 = now();
  const res = await transport.generate({
    prompt:  opts.prompt,
    grammar: opts.grammar || null,
    audience: opts.audience || null,
  });
  const latency_ms = Math.max(0, now() - t0);
  const tokens = (res && (res.tokens || res.text)) || '';

  // faculty_cost engram per wake. Token counts honor transport-reported usage
  // when present, else a char/4 estimate. cost_usd stays 0 unless the transport
  // reports it — never fabricate a price.
  const usage = (res && res.usage) || {};
  const tokens_in  = (typeof usage.input_tokens  === 'number') ? usage.input_tokens  : _estimateTokens(opts.prompt);
  const tokens_out = (typeof usage.output_tokens === 'number') ? usage.output_tokens : _estimateTokens(tokens);
  const cost_usd   = (typeof usage.cost_usd === 'number') ? usage.cost_usd : 0;
  try { writeEngram(_facultyCostEngram({ family, tokens_in, tokens_out, cost_usd, latency_ms, tick_id: opts.tick_id, refused: false })); } catch (_) {}

  // Reflection independence: a reflection wake must not run on the same family
  // that produced the reflected-upon content.
  let reflection_independence = null;
  if (opts.reflection) {
    reflection_independence = !!(opts.reflected_worker_family && opts.reflected_worker_family !== family);
  }
  return {
    tokens, worker_model_family: family, reflection_independence,
    faculty_cost: { tokens_in, tokens_out, cost_usd, latency_ms },
  };
}

module.exports = {
  wake,
  activeFamily,
  _resolveTransport,
  // Sensitivity gate + cost ledger:
  _isRemoteFamily,
  _isSensitiveEngram,
  _scanSensitivity,
  _estimateTokens,
  _facultyCostEngram,
  _remoteRefusedEngram,
};
