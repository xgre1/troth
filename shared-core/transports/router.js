// SPDX-License-Identifier: AGPL-3.0-only
// troth router transport — the SAFE default for the entity orchestrator.
//
// Wraps proxy/modules/router.js's callFlash() so the substrate's language
// faculty rides the existing troth provider fleet (Alibaba flat-rate,
// OpenRouter, NVIDIA, DeepSeek, DeepInfra, Local) with all of its
// fallback chain, rate limiting, and BYOK isolation. Never hits
// Anthropic directly from this module — that path is BYOK-only and
// considered a ToS risk for serial automated calls (see the Anthropic
// transport for that opt-in path).
//
// The router exposes a non-streaming callFlash(prompt) → text. We adapt
// it to the orchestrator's streaming contract by emitting one delta on
// completion. Tight-loop semantics still apply — the orchestrator just
// sees the whole fragment in a single chunk. Real streaming via the
// router can be added when the underlying chain exposes SSE; for now
// the surface is identical and the orchestrator's evaluator path still
// runs (it just sees the final text instead of incremental tokens).

function makeRouterTransport(opts) {
  opts = opts || {};
  // Lazy require — proxy/modules/router.js pulls in many deps and we
  // don't want to load it during unit tests of unrelated modules.
  let routerMod = null;
  function loadRouter() {
    if (routerMod) return routerMod;
    routerMod = require('../../proxy/modules/router.js');
    return routerMod;
  }

  function stream(req) {
    const router = loadRouter();
    const callFlash = router.callFlash;
    const callFallbackChain = router.callFallbackChain;
    if (typeof callFlash !== 'function') {
      const err = new Error('router transport: proxy/modules/router.js does not export callFlash');
      err.code = 'router_missing';
      throw err;
    }

    // Two transport shapes feed in here:
    //
    //   1. Agentic shape — composeAgentic builds { messages: [
    //        {role:'system', content: <substrate prefix>},
    //        {role:'user',   content: <actual prompt>},
    //        ...
    //      ]}. We MUST preserve role separation through the proxy — if we
    //      flatten everything into a single user message, the substrate
    //      envelope (engrams, anchors, identity) bleeds into the prompt as
    //      if it were the user's question. Observed  as the LLM
    //      responding to substrate context items as live tasks instead of
    //      to what the user actually typed. Fix: build an Anthropic-shape
    //      body with system at the top level and only user/assistant/tool
    //      turns in messages[], then ride the existing fallback chain
    //      (callFallbackChain) which already converts to each provider's
    //      native format downstream.
    //
    //   2. Legacy shape — { system, user } from callOnce. Untouched path.
    //
    // The router's callFlash flattens to user-only and is reserved for
    // single-prompt aux calls; we bypass it when messages[] is present.
    let result;
    if (Array.isArray(req.messages) && req.messages.length && typeof callFallbackChain === 'function') {
      const systemParts = [];
      const turns = [];
      for (const m of req.messages) {
        if (!m) continue;
        const role = m.role || 'user';
        if (role === 'system') {
          const c = typeof m.content === 'string'
            ? m.content
            : (m.content == null ? '' : JSON.stringify(m.content));
          systemParts.push(c);
          continue;
        }
        if (role === 'tool') {
          // Tool result coming back from composeAgentic. Anthropic native
          // shape is a user turn with a tool_result content block. Use
          // it — flattening to plain text strips the tool_use_id linkage
          // and the model loses track of which call the result belongs
          // to, then either re-calls the same tool or gives up with no
          // text. (Observed  as the empty-◇ regression even
          // after tool_calls were threaded through the iterator.)
          const resultStr = typeof m.content === 'string'
            ? m.content
            : (m.content == null ? '' : JSON.stringify(m.content));
          turns.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: m.tool_call_id || m.id || 'unknown',
              content: resultStr
            }]
          });
          continue;
        }
        if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          // Assistant turn that issued tool calls. Rebuild Anthropic
          // content array: optional text block + one tool_use block per
          // OpenAI-shape tool_call (which is what composeAgentic emits).
          const blocks = [];
          if (m.content && typeof m.content === 'string' && m.content.trim()) {
            blocks.push({ type: 'text', text: m.content });
          }
          for (const tc of m.tool_calls) {
            if (!tc || !tc.function) continue;
            let parsedInput = {};
            try { parsedInput = JSON.parse(tc.function.arguments || '{}'); }
            catch (_) { parsedInput = { _raw: String(tc.function.arguments || '') }; }
            blocks.push({
              type: 'tool_use',
              id: tc.id || ('tu_' + Math.random().toString(36).slice(2, 8)),
              name: tc.function.name || 'unknown',
              input: parsedInput
            });
          }
          turns.push({ role: 'assistant', content: blocks });
          continue;
        }
        // Plain user/assistant turn with string content.
        const c = typeof m.content === 'string'
          ? m.content
          : (m.content == null ? '' : JSON.stringify(m.content));
        turns.push({ role, content: c });
      }
      const body = {
        model: (req.options && req.options.model) || 'any',
        max_tokens: (req.options && req.options.max_tokens) || 2000,
        stream: false,
        think: false,
        messages: turns
      };
      if (systemParts.length) body.system = systemParts.join('\n\n');

      // Tools — composeAgentic threads them through req.options.tools in
      // OpenAI shape ({type:'function', function:{name, description,
      // parameters}}). Without this conversion the upstream model sees
      // no tools and emits XML-style fake function-call syntax as text
      // (observed  from Claude: 'I will search the substrate
      // <function_calls><invoke name="engram_search...'). Convert to
      // Anthropic native tools[] shape so the model emits real tool_use
      // blocks instead.
      if (req.options && Array.isArray(req.options.tools) && req.options.tools.length) {
        body.tools = req.options.tools.map((t) => {
          if (!t) return null;
          if (t.type === 'function' && t.function) {
            return {
              name: t.function.name,
              description: t.function.description || '',
              input_schema: t.function.parameters || { type: 'object', properties: {} }
            };
          }
          // Already Anthropic-shape (or close enough) — pass through.
          if (t.name && (t.input_schema || t.parameters)) {
            return {
              name: t.name,
              description: t.description || '',
              input_schema: t.input_schema || t.parameters
            };
          }
          return null;
        }).filter(Boolean);
      }
      // The out-param the proxy uses to distinguish "nothing was ever
      // configured" from "everything was tried and failed". Both arrive here
      // as a null result and look identical without it, and only the first
      // has a fix the operator can act on.
      const _fbOpts = { wantMeta: true, pinFailure: null };
      result = Promise.resolve(callFallbackChain(JSON.stringify(body), _fbOpts))
        .then((res) => {
          // callFallbackChain resolves null ONLY when the whole provider chain
          // is exhausted (every provider failed: rate-limit / credit / auth, and
          // the in-chain local backend too). Flag it distinctly so the autonomous
          // coordinator can PAUSE (resumable) instead of laundering exhaustion
          // into an empty 'ok' turn. A model that legitimately returns empty text
          // still comes back as a real body, so this does not misfire on that.
          if (res == null) {
            const noEngine = !!(_fbOpts.pinFailure && _fbOpts.pinFailure.reason === 'no_engine_configured');
            return { text: '', tool_calls: [], _exhausted: true, _noEngine: noEngine };
          }
          // wantMeta resolves { body, served_by } — older router builds
          // (or the flat-string error path) still hand back a bare string.
          const raw = (res && typeof res === 'object' && 'body' in res) ? res.body : res;
          const parsed = parseUpstreamResponse(raw);
          if (res && typeof res === 'object' && res.served_by) parsed.served_by = res.served_by;
          return parsed;
        });
    } else {
      const prompt = req.system
        ? String(req.system) + '\n\n' + String(req.user || '')
        : String(req.user || '');
      result = Promise.resolve(callFlash(prompt)).then((text) => (
        // callFlash also resolves null on exhaustion — flag it so this legacy
        // (non-agentic) path surfaces a clear 'offline' turn instead of a silent
        // empty success. (Autonomous pursuit uses the messages[] branch above.)
        text == null ? { text: '', tool_calls: [], _exhausted: true }
                     : { text: String(text), tool_calls: [] }
      ));
    }

    // Build an async iterator that resolves once with the router's
    // response. Emits text as a delta AND tool_calls when the upstream
    // returned Anthropic-shape tool_use blocks (or OpenAI-shape
    // function_call/tool_calls). composeAgentic in llm-orchestrator
    // reads both signals — without the tool_calls passthrough, agentic
    // turns whose first model output is a tool invocation come back as
    // empty text and the loop terminates with no answer.
    let settled = false;
    let payload = null;
    let error = null;
    const promise = result
      .then((p) => { payload = p || { text: '', tool_calls: [] }; settled = true; })
      .catch((e) => { error = e; settled = true; });

    let yieldedDelta = false;
    let yieldedTools = false;
    let yieldedUsage = false;
    let doneEmitted = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (!settled) await promise;
        if (error) {
          return { value: { done: true, _abort_reason: 'router_error' }, done: false };
        }
        if (!yieldedDelta) {
          yieldedDelta = true;
          // Provider-chain exhaustion → surface a distinct abort (rides the
          // existing _abort_reason machinery). 'providers_exhausted' is NOT in
          // llm-orchestrator's isTransient regex, so it surfaces immediately as
          // abortReason 'transport_providers_exhausted' rather than being retried.
          if (payload && payload._exhausted) {
            doneEmitted = true;
            // Same silence, two causes. An install with nothing configured gets
            // its own reason so the surface can name the command that fixes it
            // instead of describing an exhaustion that never happened.
            return { value: { done: true, _abort_reason: payload._noEngine ? 'no_engine_configured' : 'providers_exhausted' }, done: false };
          }
          return { value: { delta: payload.text || '' }, done: false };
        }
        if (!yieldedTools && payload.tool_calls && payload.tool_calls.length) {
          yieldedTools = true;
          return { value: { tool_calls: payload.tool_calls }, done: false };
        }
        if (!yieldedUsage) {
          yieldedUsage = true;
          if (payload && payload.usage) {
            return { value: { usage: {
              input_tokens:  payload.usage.prompt_tokens     || payload.usage.input_tokens  || 0,
              output_tokens: payload.usage.completion_tokens || payload.usage.output_tokens || 0
            } }, done: false };
          }
        }
        if (!doneEmitted) {
          doneEmitted = true;
          // served_by rides the done frame — the orchestrator copies it
          // onto the composed result so the entity can attribute the
          // reply to the provider that ACTUALLY answered (chain truth),
          // not the faculty name.
          return { value: { done: true, served_by: payload.served_by || null }, done: false };
        }
        return { value: undefined, done: true };
      }
    };
  }

  // Parse the upstream JSON response into { text, tool_calls } regardless
  // of whether it came back as Anthropic Messages-API shape or
  // OpenAI-style chat-completion shape. tool_calls are normalized to the
  // OpenAI function-call form llm-orchestrator's composeAgentic expects:
  //   { id, type:'function', function:{ name, arguments:<json-string> } }
  function parseUpstreamResponse(responseStr) {
    const empty = { text: '', tool_calls: [] };
    if (!responseStr) return empty;
    let data;
    try { data = JSON.parse(responseStr); }
    catch (_) {
      return typeof responseStr === 'string' && responseStr.length > 10
        ? { text: responseStr, tool_calls: [] }
        : empty;
    }
    // Anthropic shape: { content: [ {type:'text',text}, {type:'tool_use', id, name, input}, ... ] }
    if (Array.isArray(data.content)) {
      const text = data.content
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      const tool_calls = data.content
        .filter((b) => b && b.type === 'tool_use')
        .map((b) => ({
          id: b.id || ('tc_' + Math.random().toString(36).slice(2, 8)),
          type: 'function',
          function: {
            name: b.name || 'unknown',
            arguments: JSON.stringify(b.input || {})
          }
        }));
      return { text, tool_calls, usage: data.usage || null };
    }
    // OpenAI shape: { choices:[ { message:{content, reasoning_content,
    // tool_calls:[...]}}]}.
    //
    // Qwen3.6 (local llama-server) emits its visible answer to
    // 'reasoning_content' and leaves 'content' empty whenever its
    // chat-template's thinking mode is on — which happens in practice
    // even when the upstream body says think:false, because the proxy
    // chain may not propagate that flag to llama.cpp's chat-template
    // layer. Falling back to reasoning_content makes the response
    // visible without depending on the think-suppression path being
    // wired everywhere; if both are present, content wins.
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const msg = data.choices[0].message;
      const tool_calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const text = (msg.content && String(msg.content).trim())
        || (msg.reasoning_content && String(msg.reasoning_content).trim())
        || '';
      return { text, tool_calls, usage: data.usage || null };
    }
    return empty;
  }

  function abort(/* streamHandle */) {
    // The router call is non-streaming; once dispatched we can't cancel
    // mid-flight without provider-level support. Substrate's
    // evaluator-cancel still terminates the iteration on our side,
    // it just doesn't free the upstream request. Acceptable for v0.1
    // provider-side cancellation is a router-layer enhancement.
  }

  return { stream, abort };
}

module.exports = { makeRouterTransport };
