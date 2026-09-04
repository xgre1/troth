// SPDX-License-Identifier: AGPL-3.0-only
// openai-translate — body + response translation between Anthropic
// Messages API and OpenAI Responses API.
//
// Why: troth's proxy speaks Anthropic Messages on both sides (Claude
// Code clients send Anthropic-shaped requests; the proxy emits
// Anthropic-shaped responses for downstream caching, critic, codelens,
// etc.). To route a request to OpenAI's Responses API (used by
// chatgpt.com/backend-api/codex/responses for ChatGPT-subscription
// auth), we have to map the body shape going OUT and the response
// shape coming BACK so the rest of the proxy pipeline keeps working.
//
// Scope (intentional):
//   - Non-streaming round-trip only. Streaming is a future step; the
//     proxy provider call sites all use the non-streaming convention
//     (consume full upstream, return Anthropic JSON) so this is the
//     minimum viable surface.
//   - Text-only content. Tool-use / images deferred — the OpenAI
//     Responses API uses different shapes for tools (`function_call`
//     vs Anthropic's `tool_use` blocks) that need a separate
//     translation pass to round-trip cleanly. We pass tools[] through
//     unchanged where possible and surface a warning if the model
//     emits a function_call (operator can switch transports).
//
// Verified  against developers.openai.com/api/reference/
// resources/responses + chatgpt.com/backend-api/codex/responses
// behavior observed in numman-ali/opencode-openai-codex-auth.

// ── Anthropic body → OpenAI Responses body ────────────────────────────

// `system` in Anthropic is `string | Array<{type:'text', text:string}>`.
// `instructions` in Responses is a single string. Concatenate text
// blocks with newlines so multi-block system prompts (cachestable
// breakpoints, voice-shape inserts) survive the round-trip.
function flattenSystem(sys) {
  if (sys == null) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map(function (b) {
      if (!b) return '';
      if (typeof b === 'string') return b;
      if (typeof b.text === 'string') return b.text;
      return '';
    }).filter(Boolean).join('\n\n');
  }
  return '';
}

// Anthropic message content can be `string | Array<{type:'text', text:string}|...>`.
// OpenAI Responses input wants `Array<{type:'input_text'|'output_text', text:string}>`
// per role (input_text for user, output_text for prior assistant turns).
function messageContentToBlocks(content, role) {
  var inputType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type: inputType, text: content }];
  if (!Array.isArray(content)) return [];
  var out = [];
  for (var i = 0; i < content.length; i++) {
    var b = content[i];
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: inputType, text: b.text });
    else if (b.type === 'input_text' && typeof b.text === 'string') out.push({ type: 'input_text', text: b.text });
    else if (b.type === 'output_text' && typeof b.text === 'string') out.push({ type: 'output_text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'input_text', text: '[tool_use omitted in cross-API translation]' });
    else if (b.type === 'tool_result') {
      var tr = '';
      if (typeof b.content === 'string') tr = b.content;
      else if (Array.isArray(b.content)) tr = b.content.map(function (x) { return (x && x.text) || ''; }).join('\n');
      out.push({ type: 'input_text', text: '[tool_result] ' + tr });
    }
  }
  return out;
}

// Build the OpenAI Responses body from an Anthropic Messages body.
// `model` defaults to the openai_sub provider's configured default; the
// caller can override via opts.defaultModel for chain-level routing.
function anthropicToResponses(anthropicBody, opts) {
  opts = opts || {};
  var b = anthropicBody || {};
  var input = [];
  var msgs = Array.isArray(b.messages) ? b.messages : [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m || !m.role) continue;
    var role = m.role === 'assistant' ? 'assistant' : 'user';
    // Agentic round-trip: Anthropic carries tool calls/results as content
    // BLOCKS inside messages; the Responses API wants them as SEPARATE
    // top-level input items (function_call / function_call_output, correlated
    // by call_id). Split them out so multi-step tool loops survive — without
    // this the model never sees its own prior calls and re-emits them as text.
    var textBlocks = [];
    if (Array.isArray(m.content)) {
      for (var k = 0; k < m.content.length; k++) {
        var blk = m.content[k];
        if (!blk) continue;
        if (blk.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: blk.id || ('call_' + k),
            name: blk.name || '',
            arguments: typeof blk.input === 'string' ? blk.input : JSON.stringify(blk.input || {})
          });
        } else if (blk.type === 'tool_result') {
          var rOut = '';
          if (typeof blk.content === 'string') rOut = blk.content;
          else if (Array.isArray(blk.content)) rOut = blk.content.map(function (x) { return (x && x.text) || ''; }).join('\n');
          input.push({
            type: 'function_call_output',
            call_id: blk.tool_use_id || blk.id || '',
            output: rOut
          });
        } else {
          textBlocks.push(blk);
        }
      }
    } else {
      textBlocks = m.content;
    }
    var blocks = messageContentToBlocks(textBlocks, role);
    if (blocks.length) input.push({ role: role, content: blocks });
  }
  // Translate Anthropic tools[] ({name, description, input_schema}) into the
  // Responses function-tool shape ({type:'function', name, description,
  // parameters}). WITHOUT this the model has no tool schema, so it can't make
  // a structured call and instead writes the call as plain text ("<Write …>")
  // that never executes — the exact "talks but never acts" bug on ChatGPT.
  var respTools = [];
  if (Array.isArray(b.tools)) {
    for (var ti = 0; ti < b.tools.length; ti++) {
      var t = b.tools[ti];
      if (!t || !t.name) continue;
      respTools.push({
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || t.parameters || { type: 'object', properties: {} }
      });
    }
  }
  var out = {
    // The codex /backend-api/codex/responses endpoint only accepts ITS OWN
    // current models (gpt-5.5 / gpt-5.4 / gpt-5.4-mini per OpenAI Codex docs,
    //). The inbound Anthropic-namespace b.model (e.g. a Claude id, or
    // a deprecated codex name) gets rejected with HTTP 400, so the configured
    // provider model (opts.defaultModel) is authoritative here. gpt-5.2/5.3-
    // codex are DEPRECATED for ChatGPT sign-in — never default to them.
    model:             opts.defaultModel || (b.model && b.model !== 'any' ? b.model : 'gpt-6-astra'),
    instructions:      flattenSystem(b.system),
    input:             input,
    stream:            false,
    store:             false
  };
  // The codex endpoint is strict: it 400s on params it doesn't accept
  // ("Unsupported parameter: max_output_tokens"). It manages its own
  // sampling via reasoning effort, so we do NOT send max_output_tokens,
  // temperature, or top_p — matching what the official codex CLI sends.
  if (respTools.length) {
    out.tools = respTools;
    // Map Anthropic tool_choice → Responses. Default "auto" lets the model
    // decide; only force when the caller explicitly demanded a tool.
    var tc = b.tool_choice;
    if (tc && tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', name: tc.name };
    else if (tc && tc.type === 'any') out.tool_choice = 'required';
    else out.tool_choice = 'auto';
    out.parallel_tool_calls = false;
  }
  return out;
}

// ── OpenAI Responses response → Anthropic Messages response ───────────

// Reconstruct one Anthropic-shaped non-streaming response from a
// completed OpenAI Responses payload. The proxy callsite that emits
// the response to the downstream client expects this shape.
function responsesToAnthropic(responsePayload, opts) {
  opts = opts || {};
  var r = responsePayload || {};
  // Walk r.output[] and concatenate every output_text block. Some
  // Responses payloads emit multiple message items; keep them in order.
  var text = '';
  var toolUses = [];
  var output = Array.isArray(r.output) ? r.output : [];
  for (var i = 0; i < output.length; i++) {
    var item = output[i];
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (var j = 0; j < item.content.length; j++) {
        var c = item.content[j];
        if (c && c.type === 'output_text' && typeof c.text === 'string') text += c.text;
        else if (c && typeof c.text === 'string') text += c.text;
      }
    } else if (item.type === 'output_text' && typeof item.text === 'string') {
      text += item.text;
    } else if (item.type === 'function_call') {
      // Round-trip the call as an Anthropic tool_use block so the router's
      // parser surfaces a real structured tool_call (which the entity then
      // EXECUTES) instead of a dead text marker.
      var parsedArgs = {};
      if (typeof item.arguments === 'string') {
        try { parsedArgs = JSON.parse(item.arguments); } catch (_) { parsedArgs = {}; }
      } else if (item.arguments && typeof item.arguments === 'object') {
        parsedArgs = item.arguments;
      }
      toolUses.push({
        type: 'tool_use',
        // Fallback id must be unique ACROSS turns, not just within this
        // response — a bare loop index ('toolu_0') can collide with a prior
        // turn's block and miswire tool_result pairing in long agent runs.
        id: item.call_id || item.id || ('toolu_r' + Date.now().toString(36) + '_' + i),
        name: item.name || '',
        input: parsedArgs
      });
    }
  }
  var content = [];
  if (text) content.push({ type: 'text', text: text });
  for (var ti = 0; ti < toolUses.length; ti++) content.push(toolUses[ti]);
  if (!content.length) content.push({ type: 'text', text: '' });
  var usage = r.usage || {};
  var anth = {
    id:            (r.id ? 'msg_' + String(r.id).replace(/^resp_?/, '') : ('msg_' + Date.now())),
    type:          'message',
    role:          'assistant',
    model:         r.model || opts.modelHint || 'gpt-6-astra',
    content:       content,
    // tool_use stop_reason tells the agentic loop to execute + continue.
    stop_reason:   toolUses.length ? 'tool_use' : (r.status === 'incomplete' ? 'max_tokens' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens:  usage.input_tokens  || 0,
      output_tokens: usage.output_tokens || 0
    }
  };
  return anth;
}

module.exports = {
  flattenSystem,
  messageContentToBlocks,
  anthropicToResponses,
  responsesToAnthropic
};
