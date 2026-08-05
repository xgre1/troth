// SPDX-License-Identifier: AGPL-3.0-only
// Persona layer — HTTP bridge to locally tuned LLM (llama-server).
//
// The frontier LLM (Claude) calls troth_query_persona_context. That tool
// reaches this module, which forwards the request to a llama-server running
// the user's persona-tuned base model + LoRA adapter. The server returns
// short instruction text describing how the agent should behave on this
// turn — terseness, push-back style, idiosyncratic preferences. The text
// goes back through the MCP tool result channel.
//
// llama-server speaks the OpenAI-compatible /v1/chat/completions API, so we
// use a zero-dependency HTTP client (Node's built-in http/https) rather than
// pulling in fetch polyfills or openai SDK. Keeps the plugin install lean.
//
// Configuration via env (read at call time so tests can override):
//   TROTH_LAYER_B_ENDPOINT — base URL, e.g. http://YOUR-LOCAL-LLM-HOST:8080
//   TROTH_LAYER_B_MODEL    — model name to send to /v1/chat/completions
//   TROTH_LAYER_B_TIMEOUT  — milliseconds (default 5000)
//
// If the endpoint is unset OR the request fails, queryPersona returns
// { ok: false, reason } so callers can fall through gracefully — Layer B is
// always optional, never load-bearing for correctness of Layer A.

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 5000;
const SYSTEM_PROMPT = [
  'You are a persona-context generator. Given the user query and recent',
  'context, produce a SHORT directive (1-3 sentences max) describing how',
  'the calling agent should respond — preferred terseness, push-back',
  'tendencies, idiosyncratic stylistic preferences. Output the directive',
  'only. No preamble, no explanation, no quotes.'
].join(' ');

// ── Public API ────────────────────────────────────────────────────────────
// queryPersona({ user_text, recent_context }) → Promise<{ ok, text?, reason? }>
// Returns text on success. On any failure (no endpoint, timeout, bad
// response shape) returns { ok: false, reason } and the caller should
// propagate that as a tool result the model can interpret as "no
// persona context available".
async function queryPersona(opts) {
  opts = opts || {};
  const endpoint = process.env.TROTH_LAYER_B_ENDPOINT;
  if (!endpoint) return { ok: false, reason: 'endpoint_not_configured' };

  // No brand-locked fallback — if the user hasn't set TROTH_LAYER_B_MODEL,
  // surface that explicitly instead of guessing a model their llama-server
  // doesn't have loaded.
  const model    = process.env.TROTH_LAYER_B_MODEL;
  if (!model) return { ok: false, reason: 'model_not_configured', hint: 'set TROTH_LAYER_B_MODEL to the persona-LLM identifier' };
  const timeout  = parseInt(process.env.TROTH_LAYER_B_TIMEOUT, 10) || DEFAULT_TIMEOUT_MS;

  const userMessage = formatUserMessage(opts.user_text, opts.recent_context);
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage }
    ],
    max_tokens: 128,
    temperature: 0.2,
    stream: false
  });

  let url;
  try { url = new URL('/v1/chat/completions', endpoint); }
  catch (e) { return { ok: false, reason: 'bad_endpoint_url', detail: e.message }; }

  return new Promise((resolve) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, reason: 'http_status', status: res.statusCode });
          return;
        }
        try {
          const parsed = JSON.parse(chunks);
          const text = parsed
            && parsed.choices
            && parsed.choices[0]
            && parsed.choices[0].message
            && parsed.choices[0].message.content;
          if (typeof text !== 'string' || !text.trim()) {
            resolve({ ok: false, reason: 'empty_completion' });
            return;
          }
          resolve({ ok: true, text: text.trim() });
        } catch (e) {
          resolve({ ok: false, reason: 'parse_error', detail: e.message });
        }
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => {
      resolve({ ok: false, reason: 'request_error', detail: e.message });
    });
    req.write(body);
    req.end();
  });
}

// Compose the user-side prompt for the persona model. Keeps recent context
// short — the LoRA-tuned model's job is to react to current intent + short
// history, not summarize the entire session.
function formatUserMessage(userText, recentContext) {
  const parts = [];
  if (recentContext && typeof recentContext === 'string' && recentContext.trim()) {
    const trimmed = recentContext.trim().slice(-2000); // last 2KB only
    parts.push('Recent context:\n' + trimmed);
  }
  if (userText && typeof userText === 'string' && userText.trim()) {
    parts.push('Current user message:\n' + userText.trim().slice(0, 2000));
  }
  if (parts.length === 0) parts.push('(no input provided)');
  return parts.join('\n\n');
}

module.exports = {
  queryPersona,
  // Exported for test introspection only.
  _internal: { formatUserMessage, SYSTEM_PROMPT, DEFAULT_TIMEOUT_MS }
};
