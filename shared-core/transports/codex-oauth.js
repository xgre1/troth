// SPDX-License-Identifier: AGPL-3.0-only
// transports/codex-oauth — ChatGPT subscription transport for the
// Substrate-as-Entity orchestrator.
//
// Same contract as transports/anthropic.js:
//   stream({ system, user, options }) → AsyncIterable<{ delta?, done? }>
//   abort(streamHandle) — best-effort cancellation
//
// Auth: Bearer access_token from shared-core/codex-token-store.js
// (populated via shared-core/codex-auth.js login flow). On every call
// we check isExpired() and, if true, call codex-auth.refresh() before
// the request; on 401 we ALSO try one refresh+retry to handle
// server-clock skew. If refresh itself fails, the transport throws
// `no_codex_token` so the caller (orchestrator) can record a transport
// error and the operator can re-run `troth codex login`.
//
// Endpoint: chatgpt.com/backend-api/codex/responses (Responses API).
// This is the same endpoint the official Codex CLI hits — verified
//  against numman-ali/opencode-openai-codex-auth source.
// Body shape is the OpenAI Responses API (not the legacy chat
// completions API): {model, instructions, input:[…], stream, store}.
//
// Pricing context: requests under this OAuth path bill against the
// user's ChatGPT Plus/Pro flat-rate subscription, not per-token API
// pricing. Whether their plan permits that is between the operator and
// the vendor: nothing here is bundled that would answer it for them (see
// the client-identity note in ../codex-auth.js).

const https      = require('https');
const crypto     = require('crypto');
const { URL }    = require('url');

const tokenStore = require('../codex-token-store.js');
const codexAuth  = require('../codex-auth.js');

const DEFAULT_BASE     = 'https://chatgpt.com/backend-api';
const DEFAULT_PATH     = '/codex/responses';
// ChatGPT-account (subscription) Codex backend only accepts the plain chat
// models (gpt-5.5), NOT the "*-codex" API-only models, and REJECTS any
// max_output_tokens/max_completion_tokens param — verified live
// (gpt-5.2-codex → 400 "not supported with a ChatGPT account"; gpt-5.5 + token
// param → 400 "Unsupported parameter"; gpt-5.5 with neither → 200).
// The Codex endpoint's accepted list ROTATES without notice (undocumented
// interface). 'gpt-5.6-sol' died upstream on 2026-08-15 (400 "model is not
// supported when using Codex with a ChatGPT account") after a fresh sign-in
// — indistinguishable from auth/quota failures until the response body was
// surfaced, because the transport reported a bare http_error; 'gpt-5.5'
// bare http_error; 'gpt-5.5' verified streaming the same minute. Override
// via TROTH_CODEX_MODEL; when this 400 reappears, probe the shortlist in
// order before touching anything else.
const DEFAULT_MODEL    = 'gpt-5.5';
const DEFAULT_MAX_OUT  = 4096;
// The `originator` header names the application to the vendor. It has a
// default (see codex-auth.js) and stays overridable; an operator who
// blanks it gets the header omitted rather than guessed at. Sending a
// value the endpoint does not recognise costs access to the newest
// models, which is why the default matches the client id it travels with.
function originator() { return codexAuth.originator(); }
const OPENAI_BETA      = 'responses=experimental';

function newSessionId() { return crypto.randomUUID(); }
function newConversationId() { return crypto.randomUUID(); }

// Resolve a usable token: load → refresh-if-expired → return. Throws
// `no_codex_token` if neither path yields a valid token (e.g. user
// never logged in, or refresh_token itself is dead).
//
// Module-level (not a transport closure) so BOTH the chat transport and
// the image_generate tool share ONE token load/refresh path — auth must
// not fork between the two Codex consumers or a refresh fix in one place
// silently rots the other.
async function ensureCodexToken() {
  let tok = tokenStore.load();
  if (!tok) {
    const e = new Error('codex-oauth transport: no token saved (run `troth codex login`)');
    e.code = 'no_codex_token';
    throw e;
  }
  if (tokenStore.isExpired(tok)) {
    try { tok = await codexAuth.refresh(tok); }
    catch (e) {
      // Refresh failed — treat as a hard auth failure so the operator
      // re-authenticates rather than silently looping retries.
      const wrapped = new Error('codex-oauth transport: token refresh failed (' + (e && e.message || e) + ')');
      wrapped.code = 'codex_refresh_failed';
      throw wrapped;
    }
  }
  return tok;
}

// Resolve which model id the ChatGPT-account Codex endpoint will accept.
// The router hands us an AMBIENT model id (often a local model, or a
// "*-codex" API-only id) which this endpoint rejects with 400. Only honor
// a requested model when it's a supported plain gpt-5* chat model; else
// force the known-good default (gpt-5.5). Shared so the image tool resolves
// the SAME model as chat rather than hardcoding a second id.
function resolveCodexModel(reqModel, modelDefault) {
  const m = String(reqModel || modelDefault || process.env.TROTH_CODEX_MODEL || '');
  return (/^gpt-5(\.|-|$)/i.test(m) && !/codex/i.test(m)) ? m : DEFAULT_MODEL;
}

// Build the exact authenticated header set the Codex Responses endpoint
// expects (Bearer + chatgpt-account-id + the beta/session headers).
// Factored out of startStream so the image tool sends byte-for-byte the same
// headers as chat. The endpoint is header-sensitive: openai-beta is required,
// and an operator-supplied originator is sent only when one is configured.
function buildCodexHeaders(token, body, sessionId, conversationId) {
  const headers = {
    'content-type':       'application/json',
    'content-length':     Buffer.byteLength(body),
    'authorization':      'Bearer ' + token.access_token,
    'accept':             'text/event-stream',
    'openai-beta':        OPENAI_BETA,
    'session_id':         sessionId,
    'conversation_id':    conversationId
  };
  const org = originator();
  if (org) headers['originator'] = org;
  if (token.account_id) headers['chatgpt-account-id'] = token.account_id;
  return headers;
}

// Resolve the full Responses endpoint URL (base + path CONCATENATED — see
// startStream's note on why `new URL(absPath, base)` drops /backend-api).
function codexUrl(base, p) {
  return new URL(String(base || DEFAULT_BASE).replace(/\/+$/, '') +
    (String(p || DEFAULT_PATH).startsWith('/') ? (p || DEFAULT_PATH) : '/' + (p || DEFAULT_PATH)));
}

function makeCodexOAuthTransport(opts) {
  opts = opts || {};
  const baseDefault     = opts.base_url || DEFAULT_BASE;
  const pathDefault     = opts.path     || DEFAULT_PATH;
  const modelDefault    = opts.model    || null;
  const maxTokensDefault= opts.max_tokens || DEFAULT_MAX_OUT;
  // Conversation id stays stable across a transport instance so the
  // server can group turns. session_id rotates per stream call (matches
  // the reference impl's notion of "request session").
  const conversationId  = opts.conversation_id || newConversationId();

  // Thin closure over the module-level resolver so callers inside this
  // factory keep their original `ensureToken()` call shape.
  const ensureToken = ensureCodexToken;

  function buildBody(req, model) {
    let system = String(req.system || '');
    let user   = String(req.user   || '');
    // composeAgentic drives transports with a `messages` array, not {system,user}.
    // Without this the codex Responses request got EMPTY input → HTTP error
    // (same class of bug as the claude_cli transport). Flatten messages here.
    if (!user && Array.isArray(req.messages) && req.messages.length) {
      const toText = (c) => Array.isArray(c)
        ? c.map((b) => (b && (b.text || b.content)) || (typeof b === 'string' ? b : '')).join('')
        : String(c == null ? '' : c);
      const sys = [];
      const convo = [];
      for (const m of req.messages) {
        if (!m) continue;
        const txt = toText(m.content).trim();
        if (m.role === 'system') { if (txt) sys.push(txt); }
        else if (txt) {
          const tag = m.role === 'assistant' ? 'Assistant: ' : m.role === 'tool' ? 'Tool result: ' : 'User: ';
          convo.push(tag + txt);
        }
      }
      if (!system && sys.length) system = sys.join('\n\n');
      user = convo.join('\n\n');
    }
    const bodyObj = {
      model,
      instructions: system,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: user }] }
      ],
      stream: true,
      store: false
      // NO max_output_tokens — the ChatGPT-account Codex endpoint rejects it
      // (400 "Unsupported parameter"). Output length is server-governed.
    };
    // R9 (act, don't narrate): forward the substrate tool surface in the Responses
    // API FLAT function shape ({type:'function',name,description,parameters}) so
    // Codex actually calls Read/Write/Edit/Bash instead of only describing them.
    // tool_choice is deliberately NOT forwarded — the ChatGPT-subscription endpoint
    // rejects non-essential params with 400 (same reason max_output_tokens is omitted),
    // and GPT-5.5 doesn't LARP so it doesn't need a forced first-turn tool.
    if (req.options && Array.isArray(req.options.tools) && req.options.tools.length) {
      bodyObj.tools = req.options.tools.map((t) => {
        if (t && t.type === 'function' && t.function) return { type: 'function', name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } };
        if (t && t.name && (t.parameters || t.input_schema)) return { type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || t.input_schema };
        return null;
      }).filter(Boolean);
    }
    return JSON.stringify(bodyObj);
  }

  // The actual streaming call. Factored out so we can call it twice
  // (once normally; once after a refresh on 401).
  function startStream(token, body, model, sessionId) {
    // CONCATENATE base + path. `new URL(path, base)` with an ABSOLUTE path
    // ("/codex/responses") DROPS the base's path ("/backend-api") → it hit
    // chatgpt.com/codex/responses (no /backend-api) → 302 redirect → every codex
    // turn failed with http_error. Concatenation keeps the full path.
    const url = codexUrl(baseDefault, pathDefault);
    const queue = [];
    const waiters = [];
    let ended = false;
    let error = null;
    // Truncation/abrupt-close honesty: a Responses
    // API stream that closes WITHOUT a response.completed/failed frame (socket
    // reset mid-generation, or a response.incomplete this parser has no case
    // for) fell to res.on('end') and emitted a BARE {done:true} — the partial
    // (or empty) text then shipped as a clean, successful turn. Track whether a
    // terminal frame was actually seen so the end handler can abort instead.
    let sawTerminal = false;
    function emit(ev) {
      if (waiters.length) waiters.shift()(ev);
      else queue.push(ev);
    }
    // parseFrame emits through this so a terminal {done} (from
    // response.completed / response.failed) marks the stream as properly
    // closed; the raw `emit` is used everywhere else.
    function emitFromFrame(ev) {
      if (ev && ev.done) sawTerminal = true;
      emit(ev);
    }
    function next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      if (error) return Promise.reject(error);
      return new Promise((r) => waiters.push(r));
    }

    const headers = buildCodexHeaders(token, body, sessionId, conversationId);

    const reqHandle = https.request({
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      headers
    }, (res) => {
      if (res.statusCode === 401) {
        // Surface a typed error so the wrapper can refresh+retry once.
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          error = new Error('codex-oauth http 401: ' + chunks.slice(0, 300));
          error.code = 'auth_expired';
          ended = true;
          while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'auth_expired' });
        });
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (process.env.TROTH_CODEX_DEBUG === '1') { try { console.error('CODEX_HTTP_ERR', res.statusCode, chunks.slice(0, 400)); } catch (_) {} }
          error = new Error('codex-oauth http ' + res.statusCode + ': ' + chunks.slice(0, 500));
          error.code = 'http_status';
          ended = true;
          while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'http_error' });
        });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      const toolAcc = {}; // output_index -> {id,name,args} accumulated across function_call events
      res.on('data', (chunk) => {
        buf += chunk;
        let nn;
        while ((nn = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nn);
          buf = buf.slice(nn + 2);
          parseFrame(frame, emitFromFrame, toolAcc);
        }
      });
      res.on('end', () => {
        ended = true;
        // A terminal frame already emitted its own {done}; don't double-emit.
        if (sawTerminal) { emit({ done: true }); return; }
        // Stream closed with no completion/failure frame: partial or empty
        // text. Tag it so the orchestrator aborts (and walks to the next
        // faculty) instead of shipping it as a clean, complete answer.
        emit({ done: true, _abort_reason: 'stream_ended_without_completion' });
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

  async function stream(req) {
    const token = await ensureToken();
    // Resolve the ChatGPT-account-safe model (see resolveCodexModel). The
    // dispatch/router hands us its AMBIENT model id (often a local model or a
    // "*-codex" API-only id) which this endpoint rejects with 400; the resolver
    // forces the known-good default (gpt-5.5) unless a plain gpt-5* was asked for.
    const model = resolveCodexModel((req.options && req.options.model), modelDefault);
    const body  = buildBody(req, model);
    const sessionId = newSessionId();
    return startStream(token, body, model, sessionId);
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
//
// OpenAI Responses API emits events of these shapes (we accept several
// permissive variants since the spec is still labelled "experimental"
// per the OpenAI-Beta header):
//
//   event: response.output_text.delta
//   data: {"type":"response.output_text.delta","delta":"hello"}
//
//   event: response.completed
//   data: {"type":"response.completed", ...}
//
// Older / alternate shape we also accept (legacy chat-completions style):
//   data: {"choices":[{"delta":{"content":"hi"}}]}
//   data: [DONE]
//
// Lines starting with `:` are heartbeat comments — ignore.

function parseFrame(frame, emit, acc) {
  const lines = frame.split('\n');
  let event = '';
  let dataStr = '';
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  if (!dataStr && !event) return;

  // Legacy chat-completions terminator.
  if (dataStr === '[DONE]') { emit({ done: true }); return; }

  let data;
  try { data = JSON.parse(dataStr); } catch (_) { return; }

  // Responses API — text delta. `delta` is the new chunk of output.
  if (data && (event === 'response.output_text.delta' || data.type === 'response.output_text.delta')) {
    const txt = typeof data.delta === 'string' ? data.delta : (data.delta && data.delta.text);
    if (typeof txt === 'string' && txt.length) emit({ delta: txt });
    return;
  }
  // R2 (which-model display): response.created carries the resolved model.
  if ((event === 'response.created' || (data && data.type === 'response.created')) && data && data.response && data.response.model) {
    emit({ served_by: { provider: 'codex', model: data.response.model } });
    return;
  }
  // R9 (act): function-call lifecycle. Accumulate name + streamed argument JSON
  // keyed by output_index; flushed as ONE tool_calls chunk on completion (below).
  if (acc && (event === 'response.output_item.added' || (data && data.type === 'response.output_item.added')) && data.item && data.item.type === 'function_call') {
    const idx = String(data.output_index != null ? data.output_index : (data.item.id || Object.keys(acc).length));
    acc[idx] = { id: data.item.call_id || data.item.id, name: data.item.name || '', args: data.item.arguments || '' };
    return;
  }
  if (acc && (event === 'response.function_call_arguments.delta' || (data && data.type === 'response.function_call_arguments.delta'))) {
    const idx = String(data.output_index != null ? data.output_index : data.item_id);
    if (acc[idx] && typeof data.delta === 'string') acc[idx].args += data.delta;
    return;
  }
  if (acc && (event === 'response.function_call_arguments.done' || (data && data.type === 'response.function_call_arguments.done'))) {
    const idx = String(data.output_index != null ? data.output_index : data.item_id);
    if (acc[idx] && typeof data.arguments === 'string') acc[idx].args = data.arguments;
    return;
  }
  if (acc && (event === 'response.output_item.done' || (data && data.type === 'response.output_item.done')) && data.item && data.item.type === 'function_call') {
    const idx = String(data.output_index != null ? data.output_index : (data.item.id || Object.keys(acc).length));
    acc[idx] = {
      id:   data.item.call_id || data.item.id || (acc[idx] && acc[idx].id),
      name: data.item.name || (acc[idx] && acc[idx].name) || '',
      args: (typeof data.item.arguments === 'string' && data.item.arguments) || (acc[idx] && acc[idx].args) || ''
    };
    return;
  }
  // Responses API — completion.
  if (event === 'response.completed' || (data && data.type === 'response.completed')) {
    // R9: flush accumulated function calls as ONE tool_calls chunk — composeAgentic
    // OVERWRITES pendingToolCalls per chunk, so every call must arrive together.
    if (acc) {
      const tcs = Object.keys(acc).map((k, i) => ({ id: acc[k].id || ('codex_tc_' + i), type: 'function', function: { name: acc[k].name || '', arguments: acc[k].args || '{}' } }));
      if (tcs.length) emit({ tool_calls: tcs });
    }
    emit({ done: true });
    return;
  }
  // Responses API — error event.
  if (event === 'response.failed' || event === 'error' || (data && data.type === 'response.failed')) {
    const msg = (data && data.error && data.error.message) || 'codex_oauth: response.failed';
    emit({ done: true, error: msg });
    return;
  }

  // Legacy chat-completions delta shape (some Codex routes still emit).
  if (data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].delta) {
    const d = data.choices[0].delta;
    if (typeof d.content === 'string' && d.content.length) {
      emit({ delta: d.content });
    }
    return;
  }
  // response.created, response.in_progress, ping — silent.
}

module.exports = {
  makeCodexOAuthTransport,
  // Shared auth/request primitives — reused by shared-core/tools/image-gen.js so
  // the image_generate tool hits the endpoint with the SAME token/header/model
  // logic as chat instead of duplicating (and drifting from) it.
  ensureCodexToken,
  resolveCodexModel,
  buildCodexHeaders,
  codexUrl,
  newSessionId,
  newConversationId,
  // Exposed for tests.
  parseFrame,
  originator,
  OPENAI_BETA,
  DEFAULT_BASE,
  DEFAULT_PATH,
  DEFAULT_MODEL
};
