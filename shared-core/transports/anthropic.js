// SPDX-License-Identifier: AGPL-3.0-only
// Anthropic streaming transport for the Substrate-as-Entity orchestrator.
//
// Implements the transport contract expected by shared-core/llm-orchestrator.js:
//   stream({ system, user, options }) → AsyncIterable<{ delta?, done? }>
//   abort(streamHandle) — best-effort cancellation
//
// Uses Anthropic's /v1/messages streaming endpoint (SSE). Zero
// dependencies — Node's built-in https + a tiny SSE line parser.
// Same pattern as shared-core/identity.js (Layer B HTTP bridge): we
// keep external SDKs out of the substrate so the plugin install stays
// lean and tests can stub the transport directly.
//
// This transport is endpoint-agnostic by design: any Anthropic-compatible
// /v1/messages endpoint (same SSE wire shape, same tool-call shape) rides
// the SAME code path. The Kimi Code membership faculty (shared-core/
// transports/kimi-sub.js) is a thin wrapper that passes its own base_url +
// api_key + model into makeAnthropicTransport, so the streaming and
// tool-call handling below serve Kimi natively when backbone="troth"
// kimi plays with BOTH backbones: it rides the claude CLI harness when
// backbone="claude_cli", and runs NATIVE here when backbone is the troth loop.
//
// Configuration via env (read at call time so tests can override):
//   ANTHROPIC_API_KEY  — required for real calls
//   TROTH_ENTITY_MODEL — model identifier (default 'claude-sonnet-4-6')
//   ANTHROPIC_BASE_URL — override (default https://api.anthropic.com)
//
// The orchestrator's tight-loop semantics work as expected with this
// transport: each fragment call opens a new SSE stream, substrate reads
// it incrementally, abort() cancels the in-flight HTTP request, and the
// next fragment opens a fresh stream.

const https = require('https');
const { URL } = require('url');

const DEFAULT_BASE  = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

function makeAnthropicTransport(opts) {
  opts = opts || {};
  const apiKeyDefault = opts.api_key || null;
  const modelDefault  = opts.model   || null;
  const baseDefault   = opts.base_url || null;
  // Turn-sized, not probe-sized. Lane audit 2026-08-15: no caller on the
  // entity path ever passed max_tokens, so every lane built on this
  // transport (anthropic, kimi_sub) inherited a 1024 ceiling and real
  // replies hit the wall mid-sentence. One knob for every lane:
  // TROTH_ENTITY_MAX_TOKENS, hosted fallback 8192.
  const maxTokensDefault = opts.max_tokens ||
    parseInt(process.env.TROTH_ENTITY_MAX_TOKENS || '8192', 10);

  function stream(req) {
    const apiKey = apiKeyDefault || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Hard fail with a useful error rather than a silent empty stream.
      // The orchestrator records this as a transport_error.
      const err = new Error('anthropic transport: ANTHROPIC_API_KEY not set');
      err.code = 'no_api_key';
      throw err;
    }
    const model = (req.options && req.options.model) || modelDefault || process.env.TROTH_ENTITY_MODEL || DEFAULT_MODEL;
    const base  = baseDefault || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE;
    // Path-preserving join. An absolute-path URL ('/v1/messages', base) DROPS
    // any path prefix on the base, so a base like https://api.kimi.com/coding/
    // would resolve to https://api.kimi.com/v1/messages and miss the endpoint.
    // Joining a RELATIVE 'v1/messages' against a base normalized to end in '/'
    // keeps the prefix (…/coding/v1/messages) AND is byte-identical for the
    // Anthropic default (https://api.anthropic.com/v1/messages).
    const url   = new URL('v1/messages', base.endsWith('/') ? base : base + '/');

    let _sys = String(req.system || '');
    let _user = String(req.user || '');
    // composeAgentic drives transports with a `messages` array, not {system,user}
    // without this the request got EMPTY content. Flatten to system + ONE user
    // prompt (single message keeps Anthropic's strict role-alternation happy).
    if (!_user && Array.isArray(req.messages) && req.messages.length) {
      const toText = (c) => Array.isArray(c) ? c.map((b) => (b && (b.text || b.content)) || (typeof b === 'string' ? b : '')).join('') : String(c == null ? '' : c);
      const sys = []; const convo = [];
      for (const m of req.messages) {
        if (!m) continue;
        const txt = toText(m.content).trim();
        if (m.role === 'system') { if (txt) sys.push(txt); }
        else if (txt) convo.push((m.role === 'assistant' ? 'Assistant: ' : m.role === 'tool' ? 'Tool result: ' : 'User: ') + txt);
      }
      if (!_sys && sys.length) _sys = sys.join('\n\n');
      _user = convo.join('\n\n');
    }
    // R9 (act, don't narrate): forward the substrate tool surface in Anthropic's
    // NATIVE shape so the direct-API faculty actually calls tools instead of only
    // describing them. Convert OpenAI {type:function,function:{...}} ->
    // {name,description,input_schema} (mirrors router.js); map tool_choice.
    const bodyObj = {
      model,
      max_tokens: (req.options && req.options.max_tokens) || maxTokensDefault,
      stream: true,
      system: _sys,
      messages: [{ role: 'user', content: _user }]
    };
    if (req.options && Array.isArray(req.options.tools) && req.options.tools.length) {
      bodyObj.tools = req.options.tools.map((t) => {
        if (t && t.type === 'function' && t.function) return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } };
        if (t && t.name && (t.input_schema || t.parameters)) return { name: t.name, description: t.description || '', input_schema: t.input_schema || t.parameters };
        return null;
      }).filter(Boolean);
      const tcChoice = req.options.tool_choice;
      if (tcChoice === 'required' || tcChoice === 'any') bodyObj.tool_choice = { type: 'any' };
      else if (tcChoice === 'auto') bodyObj.tool_choice = { type: 'auto' };
      else if (tcChoice && typeof tcChoice === 'object' && tcChoice.function && tcChoice.function.name) bodyObj.tool_choice = { type: 'tool', name: tcChoice.function.name };
    }
    const body = JSON.stringify(bodyObj);

    // We expose the request object via stream.handle so abort() can
    // destroy it. The async iterator pulls events from a queue that the
    // SSE parser fills as data arrives.
    const queue = [];
    const waiters = [];
    let ended = false;
    let error = null;
    function emit(ev) {
      if (waiters.length) waiters.shift()(ev);
      else queue.push(ev);
    }
    function next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      if (error) return Promise.reject(error);
      return new Promise((r) => waiters.push(r));
    }

    // Protocol-aware: the base may be the LOCAL troth proxy (http://127.0.0.1)
    // the via-proxy subscription lanes depend on it — or any other plain-
    // http Anthropic-compatible endpoint. Unconditional https.request opened
    // a TLS handshake against the plain-http loopback and every via-proxy
    // call died on connect.
    const _isHttps = url.protocol === 'https:';
    const reqHandle = (_isHttps ? https : require('http')).request({
      method:  'POST',
      hostname: url.hostname,
      port:    url.port || (_isHttps ? 443 : 80),
      path:    url.pathname + url.search,
      headers: {
        'content-type':         'application/json',
        'content-length':       Buffer.byteLength(body),
        'x-api-key':            apiKey,
        'anthropic-version':    ANTHROPIC_VERSION,
        'accept':               'text/event-stream'
      }
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          error = new Error('anthropic http ' + res.statusCode + ': ' + chunks.slice(0, 500));
          error.code = 'http_status';
          ended = true;
          while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'http_error' });
        });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      const toolAcc = {}; // content-block index -> {id,name,args} accumulated across deltas
      res.on('data', (chunk) => {
        buf += chunk;
        // SSE frames are separated by blank lines.
        let nn;
        while ((nn = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nn);
          buf = buf.slice(nn + 2);
          parseFrame(frame, emit, toolAcc);
        }
      });
      res.on('end', () => {
        ended = true;
        emit({ done: true });
      });
      res.on('error', (e) => {
        error = e;
        ended = true;
        while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'stream_error' });
      });
    });
    reqHandle.on('error', (e) => {
      error = e;
      ended = true;
      while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'request_error' });
    });
    reqHandle.write(body);
    reqHandle.end();

    const iter = {
      [Symbol.asyncIterator]() { return iter; },
      next: async () => {
        const ev = await next();
        if (ev === null) return { value: undefined, done: true };
        return { value: ev, done: false };
      },
      _request: reqHandle
    };
    return iter;
  }

  function abort(streamHandle) {
    try {
      if (streamHandle && streamHandle._request && !streamHandle._request.destroyed) {
        streamHandle._request.destroy();
      }
    } catch (_) { /* best-effort */ }
  }

  return { stream, abort };
}

// ── SSE frame parser ───────────────────────────────────────────────────
// Anthropic emits events of these shapes (we only consume content_block_delta
// and message_stop; the rest are status):
//   event: content_block_delta\n
//   data: { "type":"content_block_delta", "delta":{"type":"text_delta","text":"..."} }
//   event: message_stop\n
//   data: {...}
// Lines starting with `:` are comments (heartbeats); ignore them.

function parseFrame(frame, emit, acc) {
  const lines = frame.split('\n');
  let event = '';
  let dataStr = '';
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  if (!event && !dataStr) return;
  let data;
  try { data = dataStr ? JSON.parse(dataStr) : null; } catch (_) { return; }
  // Which-model display: message_start carries the resolved model.
  if (event === 'message_start' && data && data.message && data.message.model) {
    emit({ served_by: { provider: 'anthropic', model: data.message.model } });
    if (data.message.usage && data.message.usage.input_tokens) {
      emit({ usage: { input_tokens: data.message.usage.input_tokens || 0, output_tokens: 0 } });
    }
    return;
  }
  // Token accounting: message_delta carries cumulative output_tokens.
  if (event === 'message_delta' && data && data.usage) {
    emit({ usage: { input_tokens: 0, output_tokens: data.usage.output_tokens || 0 } });
    return;
  }
  // R9 (act): a tool_use content block begins — record id+name, accumulate args.
  if (event === 'content_block_start' && acc && data && data.content_block && data.content_block.type === 'tool_use') {
    acc[data.index] = { id: data.content_block.id, name: data.content_block.name, args: '' };
    return;
  }
  if (event === 'content_block_delta' && data && data.delta) {
    if (typeof data.delta.text === 'string') { emit({ delta: data.delta.text }); return; }
    // R9: streamed tool-call arguments (partial JSON, one block at a time).
    if (data.delta.type === 'input_json_delta' && acc && acc[data.index]) {
      acc[data.index].args += (data.delta.partial_json || '');
      return;
    }
  }
  if (event === 'message_stop') {
    // R9: flush accumulated tool_use blocks as ONE tool_calls chunk — composeAgentic
    // OVERWRITES pendingToolCalls per chunk, so every call must arrive together.
    if (acc) {
      const keys = Object.keys(acc).sort((a, b) => Number(a) - Number(b));
      const tcs = keys.map((k, i) => ({ id: acc[k].id || ('anth_tc_' + i), type: 'function', function: { name: acc[k].name || '', arguments: acc[k].args || '{}' } }));
      if (tcs.length) emit({ tool_calls: tcs });
    }
    emit({ done: true });
    return;
  }
  // content_block_stop, ping — ignored
}

module.exports = { makeAnthropicTransport, parseFrame };
