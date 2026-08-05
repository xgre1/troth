// SPDX-License-Identifier: AGPL-3.0-only
// Kimi Code membership transport - the NATIVE lane for the Kimi faculty.
//
// Kimi plays with BOTH backbones. The Kimi Code endpoint
// (https://api.kimi.com/coding/) is Anthropic-compatible - same /v1/messages
// SSE wire shape, same native tool-call shape - so Kimi does NOT need the
// claude CLI harness to answer. When the operator's backbone is the troth
// loop (backbone != "claude_cli"), a kimi_sub pin runs NATIVE through this
// transport instead of being force-wired onto the claude_cli harness (the
// old quick path). Riding the harness stays valid
// too - it is selected when backbone == "claude_cli" (subprocess-cli points
// ANTHROPIC_BASE_URL at Kimi). This faculty is the second half of "both".
//
// It is a thin wrapper over the shared Anthropic transport
// (shared-core/transports/anthropic.js): the Anthropic streaming + tool-call
// handling is endpoint-agnostic, so we only override base_url + api_key +
// model. Everything else (SSE parsing, abort, usage, served_by, tool_use
// accumulation) is inherited unchanged.
//
// Configuration via env (read at call time so tests can override, matching
// the anthropic transport's convention):
//   TROTH_KIMI_SUB_KEY   - required for real calls (the membership key)
//   TROTH_KIMI_SUB_MODEL - model identifier (default 'kimi-for-coding')
//   TROTH_KIMI_SUB_BASE  - base URL override (default https://api.kimi.com/coding/)
//
// The key is NEVER logged. It travels only in the x-api-key request header
// that makeAnthropicTransport already sets; nothing in this module prints it.

'use strict';

const { makeAnthropicTransport } = require('./anthropic.js');

const DEFAULT_BASE  = 'https://api.kimi.com/coding/';
const DEFAULT_MODEL = 'kimi-for-coding';

function makeKimiSubTransport(opts) {
  opts = opts || {};
  // Resolve at call time via a lazy factory-per-stream: read the Kimi envs
  // fresh on each stream() so tests (and live re-config) can override without
  // rebuilding the faculty. We build the inner Anthropic transport with the
  // Kimi endpoint parameters; it reads api_key/model/base at construction and
  // then per-call, so wrapping once is sufficient, but we keep the env read
  // inside stream() to match the anthropic transport's "read at call time".
  function inner() {
    const apiKey = opts.api_key || process.env.TROTH_KIMI_SUB_KEY || null;
    const model  = opts.model   || process.env.TROTH_KIMI_SUB_MODEL || DEFAULT_MODEL;
    // Same via-proxy contract as the harness lane (subprocess-cli.js): the
    // app sets TROTH_KIMI_VIA_PROXY=1 when its proxy is running, and the
    // proxy's model-addressed kimi lane adds tool-block compression, caching
    // and context filtering the direct endpoint never sees — the melt the
    // operator measured
    // was exactly this lane going direct. An explicit TROTH_KIMI_SUB_BASE /
    // opts.base_url still outranks the flag: whoever overrides the base has
    // decided where the traffic goes. Without the flag (open-repo installs,
    // proxy down) the direct lane stays — a dead loopback would strand the
    // faculty entirely.
    let base = opts.base_url || process.env.TROTH_KIMI_SUB_BASE || null;
    if (!base) {
      base = (process.env.TROTH_KIMI_VIA_PROXY || '').trim() === '1'
        ? require('../dashboard-url.js').proxyBaseUrl()
        : DEFAULT_BASE;
    }
    if (!apiKey) {
      // Match the anthropic transport's hard-fail contract: a missing key must
      // surface as a transport error the orchestrator records, never a silent
      // empty stream. Throwing here (rather than deferring to anthropic's own
      // ANTHROPIC_API_KEY check) keeps the error text Kimi-specific.
      const err = new Error('kimi_sub transport: TROTH_KIMI_SUB_KEY not set');
      err.code = 'no_api_key';
      throw err;
    }
    return makeAnthropicTransport({ api_key: apiKey, model, base_url: base, max_tokens: opts.max_tokens });
  }

  return {
    stream(req) { return inner().stream(req); },
    abort(streamHandle) {
      try { return inner().abort(streamHandle); } catch (_) { /* best-effort */ }
    }
  };
}

module.exports = { makeKimiSubTransport, DEFAULT_BASE, DEFAULT_MODEL };
