// SPDX-License-Identifier: AGPL-3.0-only
// quarantine.js — wires shared-core/dual-context.js (CaMeL P-LLM/Q-LLM
// split) into the existing transport stack.
//
// Why this file: dual-context.js shipped at 285 LOC with ZERO callers
// the substrate-thesis defense against indirect prompt injection
// (web/email/SMS body content trying to coerce the planner) was a
// dormant primitive. This module is the bridge: it wraps dual-context's
// runQuarantined with an llmCall sourced from the existing
// llm-orchestrator / transports system, so any substrate caller can do
// safe typed-extraction in one line.
//
// API:
//   quarantinedExtract({untrusted_data, field_schemas, ask_for,
//                        provider_hint?, model?, timeout_ms?, ctx?})
//     → Promise<{ ok, value?, errors?, transcript_preview?, reason? }>
//
//   redactUntrustedKeys(plannerContext, keys)
//     → context object with named keys replaced by REDACTED markers
//
// Caller pattern (e.g. in a future web-fetch wrapping):
//   const r = await quarantine.quarantinedExtract({
//     untrusted_data: rawPageBody,
//     field_schemas: { phone: {type:'phone'}, url: {type:'url'} },
//     ask_for: 'phone number + canonical URL from the page'
//   });
//   if (r.ok) substrate.write({ phone: r.value.phone, url: r.value.url });
//   else substrate.write({ extraction_failed: r.reason });
//
// Substrate-thesis: the P-LLM never sees rawPageBody. Only typed values
// fitting the schema cross back into planner context. Schema is the wall.

'use strict';

const dualContext = require('./dual-context.js');

// Lazy-require the orchestrator so callers in test contexts that don't
// have a live provider configured don't blow up at module load. They
// can pass a custom llmCall via opts.llmCall to bypass.
function _defaultLlmCall(prompt, opts) {
  const orch = require('./llm-orchestrator.js');
  // llm-orchestrator's primary entry varies by codebase version. Use
  // the public callOnce / generate / runOnce style — we probe + fall
  // back so this stays portable across substrate revisions.
  const callable =
    (typeof orch.callOnce === 'function'   && orch.callOnce)   ||
    (typeof orch.generate === 'function'   && orch.generate)   ||
    (typeof orch.runOnce  === 'function'   && orch.runOnce)    ||
    (typeof orch.complete === 'function'   && orch.complete);
  if (!callable) {
    return Promise.reject(new Error('quarantine: llm-orchestrator has no callable entry; pass opts.llmCall explicitly'));
  }
  return Promise.resolve(callable({
    prompt,
    system: 'You are a quarantined typed-value extractor.',
    max_tokens: opts && opts.max_tokens || 400,
    temperature: 0,
    provider_hint: opts && opts.provider_hint,
    model:         opts && opts.model,
    timeout_ms:    opts && opts.timeout_ms
  })).then((res) => {
    // Normalize across return shapes: string OR {text} OR {content[0].text}
    if (typeof res === 'string') return res;
    if (res && typeof res.text === 'string') return res.text;
    if (res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string') {
      return res.content[0].text;
    }
    return String(res || '');
  });
}

async function quarantinedExtract(opts) {
  opts = opts || {};
  const llmCall = (typeof opts.llmCall === 'function')
    ? opts.llmCall
    : (prompt) => _defaultLlmCall(prompt, opts);
  return dualContext.runQuarantined({
    untrusted_data: opts.untrusted_data,
    field_schemas:  opts.field_schemas,
    ask_for:        opts.ask_for,
    llmCall,
    timeout_ms:     opts.timeout_ms
  });
}

function redactUntrustedKeys(plannerContext, keys) {
  return dualContext.ensurePrivileged(plannerContext, {
    untrusted_keys: Array.isArray(keys) ? keys : []
  });
}

// Convenience: wrap an existing engram-like object before it reaches
// planner context. Marks the named fields as quarantined-untrusted in
// the planner view, while leaving the original engram unchanged in
// substrate storage (the substrate keeps full audit; only the planner
// view is redacted).
function planSafeView(engramLike, untrustedFieldNames) {
  if (!engramLike || typeof engramLike !== 'object') return engramLike;
  return redactUntrustedKeys(engramLike, untrustedFieldNames || ['body', 'content', 'text', 'snippet', 'raw']);
}

module.exports = {
  quarantinedExtract,
  redactUntrustedKeys,
  planSafeView
};
