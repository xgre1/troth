// SPDX-License-Identifier: AGPL-3.0-only
// Ollama streaming transport for the Substrate-as-Entity orchestrator.
//
// Implements the transport contract:
//   stream({ system, user, options }) → AsyncIterable<{ delta?, done? }>
//   abort(streamHandle)
//
// Uses Ollama's /api/chat endpoint with stream:true. Newline-delimited
// JSON deltas (NOT SSE — Ollama uses NDJSON). Zero deps — Node's
// built-in http.
//
// Configuration via env (read at call time):
//   TROTH_OLLAMA_HOST  — base URL (default http://127.0.0.1:11434)
//                          For a remote host: http://<host>:11434
//                          (Tailscale / LAN hostname, etc.)
//   TROTH_OLLAMA_MODEL — model identifier (default 'qwen3:latest')
//
// Modern Apple Silicon hosts run Qwen 3 70B in 5-15 t/s territory; the
// orchestrator's tight-loop semantics (stream + per-fragment evaluator
// + abort) work cleanly with this throughput because each focused
// fragment is short.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const cfg   = require('../transport-config.js');

function makeOllamaTransport(opts) {
  opts = opts || {};
  const hostDefault  = opts.host  || null;
  const modelDefault = opts.model || null;

  function stream(req) {
    const host  = hostDefault || cfg.ollamaHost();
    const model = (req.options && req.options.model) || modelDefault || cfg.ollamaModel();
    const url   = new URL('/api/chat', host);

    // composeAgentic drives transports with a `messages` array, not {system,user}
    // consume it directly (ollama supports multi-turn); else fall back.
    let messages = [];
    if (!String(req.user || '') && Array.isArray(req.messages) && req.messages.length) {
      const toText = (c) => Array.isArray(c) ? c.map((b) => (b && (b.text || b.content)) || (typeof b === 'string' ? b : '')).join('') : String(c == null ? '' : c);
      for (const m of req.messages) {
        if (!m) continue;
        const txt = toText(m.content);
        if (!txt.trim()) continue;
        messages.push({ role: m.role === 'tool' ? 'user' : m.role, content: m.role === 'tool' ? ('Tool result: ' + txt) : txt });
      }
    }
    if (!messages.length) {
      if (req.system) messages.push({ role: 'system', content: String(req.system) });
      messages.push({ role: 'user', content: String(req.user || '') });
    }

    // keep_alive holds the model resident on the Ollama side between
    // calls. Without it, a 23GB+ model gets evicted after ~5 min idle
    // and the next call pays the full cold-load tax (30-60s on Mac
    // Studio M3 Ultra). 10 minutes is a sensible default for entity
    // workflows where calls cluster around user activity.
    // R9 (act, don't narrate): forward the substrate tool surface so Ollama can
    // actually call Read/Write/Edit/Bash. Ollama's /api/chat accepts an
    // OpenAI-shape tools[] and returns message.tool_calls. Without this the
    // faculty degrades to prose ("I edited X" with no real call).
    const bodyObj = {
      model,
      messages,
      stream: true,
      keep_alive: (req.options && req.options.keep_alive) || '10m',
      options: req.options && req.options.ollama_params || {}
    };
    if (req.options && Array.isArray(req.options.tools) && req.options.tools.length) {
      bodyObj.tools = req.options.tools;
      if (req.options.tool_choice != null) bodyObj.tool_choice = req.options.tool_choice;
    }
    const body = JSON.stringify(bodyObj);

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

    const lib = url.protocol === 'https:' ? https : http;
    const reqHandle = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port:    url.port || (url.protocol === 'https:' ? 443 : 80),
      path:    url.pathname + url.search,
      headers: {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          error = new Error('ollama http ' + res.statusCode + ': ' + chunks.slice(0, 500));
          error.code = 'http_status';
          ended = true;
          while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'http_error' });
        });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      let sentServed = false;
      res.on('data', (chunk) => {
        buf += chunk;
        // Ollama emits one JSON object per line.
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          // R2 (which-model display): surface the real served model ONCE so the
          // UI shows the actual Ollama model, not a pre-call config guess.
          if (!sentServed) { sentServed = true; emit({ served_by: { provider: 'ollama', model } }); }
          if (msg && msg.message && typeof msg.message.content === 'string') {
            if (msg.message.content) emit({ delta: msg.message.content });
          }
          // R9 (act): emit native tool calls so composeAgentic dispatches them.
          // Ollama returns arguments as an OBJECT; composeAgentic JSON.parse()s
          // tc.function.arguments, so it MUST be a string — stringify objects.
          if (msg && msg.message && Array.isArray(msg.message.tool_calls) && msg.message.tool_calls.length) {
            const tcs = msg.message.tool_calls.map((tc, i) => {
              const fn = (tc && tc.function) || {};
              let args = fn.arguments;
              if (args != null && typeof args !== 'string') { try { args = JSON.stringify(args); } catch (_) { args = '{}'; } }
              return { id: tc.id || ('ollama_tc_' + i), type: 'function', function: { name: fn.name || '', arguments: args || '{}' } };
            });
            emit({ tool_calls: tcs });
          }
          if (msg && msg.done) {
            const _p = msg.prompt_eval_count || 0;
            const _e = msg.eval_count || 0;
            if (_p > 0 || _e > 0) {
              const _u = { input_tokens: _p, output_tokens: _e };
              if (_p > 0) _u.context_used = _p;
              emit({ usage: _u });
            }
            emit({ done: true });
          }
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

module.exports = { makeOllamaTransport };
