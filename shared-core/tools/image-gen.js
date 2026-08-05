// SPDX-License-Identifier: AGPL-3.0-only
// image-gen.js — image_generate tool: create an image from a text prompt and
// save it under ~/.troth/images/. TWO sources, resolved per call:
//   chatgpt — the operator's ChatGPT subscription via the Codex Responses
//             endpoint (SSE, base64 PNG on output_item.done)
//   google  — the operator's Google AI key via generateContent
//             (plain JSON, base64 inlineData on a candidate part)
// Auto order prefers the plan (zero marginal cost on the flat rate) and falls
// back to the key; args.source pins one explicitly.
//
// WHY this route: the operator already linked their ChatGPT plan for the codex
// chat transport (transports/codex-oauth.js). The same OAuth token + the same
// chatgpt.com/backend-api/codex/responses endpoint also serve image generation
// when the request carries tools:[{type:'image_generation'}] — verified against
// the working OSS impl leeguooooo/chatgpt-imagegen (docs/how-it-works.md). So an
// image faculty costs ZERO new dependency, ZERO new key, ZERO new pricing path:
// it bills against the flat-rate subscription exactly like a chat turn.
//
// AUTH REUSE: we do NOT re-implement token load/refresh/headers. We import the
// codex transport's shared primitives (ensureCodexToken / buildCodexHeaders /
// resolveCodexModel / codexUrl) so an auth fix in the transport propagates here
// automatically — a forked copy would silently rot the moment the refresh flow
// changes. This tool is chat's twin on the same pipe, not a parallel client.
//
// TEST SEAM: the whole network+SSE call is behind an injectable driver
// (ctx._httpDriver, else module-level opts.httpDriver, else the real https
// path). Tests pass a fake driver that replays a canned SSE event list, so the
// happy/malformed paths are fully offline and deterministic — no live ChatGPT
// account, no socket. See tests/suite-14-image-gen.js.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const crypto = require('crypto');

const codexOAuth = require('../transports/codex-oauth.js');

const IMAGES_DIR   = path.join(os.homedir(), '.troth', 'images');
const CALL_TIMEOUT_MS = 180 * 1000;  // hard ceiling on the whole generate call

// OpenAI-compatible function tool. Kept deliberately small: prompt is the only
// required field. size is pass-through ONLY — the ChatGPT-account Codex endpoint
// is strict about unknown params (it 400s on max_output_tokens/tool_choice), so
// we forward size solely when the caller supplied it and otherwise omit it
// entirely rather than guess a default the endpoint might reject.
const schema = {
  type: 'function',
  function: {
    name: 'image_generate',
    description: 'Generate an image from a text prompt using the operator\'s linked ChatGPT plan or their Google AI key, and save it under ~/.troth/images/. Returns the saved file path. Use when the user asks to create/draw/render an image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw. A detailed natural-language description of the desired image.' },
        // size is NOT advertised: the ChatGPT-account endpoint 400s on
        // unexpected params and we have not live-verified tools[0].size.
        // buildImageBody still forwards it if a caller passes one, so
        // re-enabling after verification is a one-line schema change.
        source: { type: 'string', enum: ['chatgpt', 'google'], description: 'Optional. chatgpt = the linked ChatGPT plan; google = the Google AI key from Settings. Omit to pick automatically (plan first, key as fallback).' },
      },
      required: ['prompt'],
    },
  },
};

// Build the Responses-API body for an image request: the normal shape PLUS the
// image_generation tool. Model is resolved by the SAME guard chat uses so we
// never hardcode a second model id. size rides in only when the caller set it.
function buildImageBody(prompt, size, model) {
  const body = {
    model,
    instructions: '',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: String(prompt) }] }
    ],
    tools: [{ type: 'image_generation' }],
    stream: true,
    store: false,
  };
  if (size) body.tools[0].size = String(size);
  return JSON.stringify(body);
}

// ── Google AI (Gemini) source ──────────────────────────────────────────────
//
// Second source: a BYO Google AI key read from
// the SAME providers.google_ai.apiKey slot the text engine uses - one key,
// both uses, no duplicate field. Endpoint shape verified  against
// the current docs: POST v1beta/models/<model>:generateContent with
// generationConfig.responseModalities ['TEXT','IMAGE']; the image returns as
// base64 inlineData on a candidate part (plain JSON, not SSE). Preview model
// ids churn, so the id is overridable via env or config.
const GOOGLE_IMAGE_BASE          = 'https://generativelanguage.googleapis.com/v1beta';
const GOOGLE_IMAGE_MODEL_DEFAULT = 'gemini-3.1-flash-image-preview';

function readTrothConfig() {
  const cfgPath = process.env.TROTH_CONFIG_PATH || path.join(os.homedir(), '.troth', 'config.json');
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) { return {}; }
}

function readGoogleKey() {
  const prov = (readTrothConfig().providers || {}).google_ai || {};
  const key = (typeof prov.apiKey === 'string' && prov.apiKey.trim())
    ? prov.apiKey.trim()
    : String(process.env.GEMINI_API_KEY || '').trim();
  return key || null;
}

function resolveGoogleImageModel() {
  if (process.env.TROTH_GEMINI_IMAGE_MODEL) return process.env.TROTH_GEMINI_IMAGE_MODEL;
  const prov = (readTrothConfig().providers || {}).google_ai || {};
  return (typeof prov.image_model === 'string' && prov.image_model.trim())
    ? prov.image_model.trim()
    : GOOGLE_IMAGE_MODEL_DEFAULT;
}

function buildGeminiBody(prompt) {
  return JSON.stringify({
    contents: [{ parts: [{ text: String(prompt) }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });
}

// First image part of a generateContent response -> { b64, mime } (or null).
// Accepts both inlineData (REST camelCase) and inline_data (proto snake_case).
function extractGeminiImage(json) {
  const cands = (json && Array.isArray(json.candidates)) ? json.candidates : [];
  for (const c of cands) {
    const parts = (c && c.content && Array.isArray(c.content.parts)) ? c.content.parts : [];
    for (const part of parts) {
      const inline = part && (part.inlineData || part.inline_data);
      if (!inline || typeof inline.data !== 'string' || !inline.data.length) continue;
      const mime = String(inline.mimeType || inline.mime_type || 'image/png');
      if (/^image\//.test(mime)) return { b64: inline.data, mime };
    }
  }
  return null;
}

// Surface an upstream google failure ({error:{message}}) or a safety block
// (promptFeedback.blockReason) as a clean string; null when healthy.
function extractGeminiError(json) {
  if (json && json.error) {
    return (json.error.message || ('google error ' + (json.error.code || 'unknown')));
  }
  if (json && json.promptFeedback && json.promptFeedback.blockReason) {
    return 'blocked: ' + json.promptFeedback.blockReason;
  }
  return null;
}

// Split a raw SSE text buffer into '\n\n'-delimited frames and pull the single
// JSON `data:` payload out of each. Mirrors the transport's frame boundary
// convention. Returns the parsed event objects (unknown/heartbeat frames drop).
function parseSseEvents(raw) {
  const out = [];
  const frames = String(raw || '').split('\n\n');
  for (const frame of frames) {
    let dataStr = '';
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;   // heartbeat comment
      if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr || dataStr === '[DONE]') continue;
    try { out.push(JSON.parse(dataStr)); } catch (_) { /* skip malformed frame */ }
  }
  return out;
}

// Extract the base64 PNG from a list of Responses events. The image lands on the
// response.output_item.done event whose item.type === 'image_generation_call'
// and item.result is the base64 string. Progress events
// (.in_progress/.generating/.partial_image) are ignored — we only need the final
// result. Returns the base64 string or null if the stream never produced one.
function extractImageB64(events) {
  for (const ev of events) {
    if (!ev) continue;
    const type = ev.type || '';
    if (type === 'response.output_item.done' && ev.item &&
        ev.item.type === 'image_generation_call' &&
        typeof ev.item.result === 'string' && ev.item.result.length) {
      return ev.item.result;
    }
  }
  return null;
}

// Scan events for a surfaced upstream failure (response.failed / error) so a
// well-formed error stream returns a clean {ok:false} instead of "no image".
function extractStreamError(events) {
  for (const ev of events) {
    if (!ev) continue;
    const type = ev.type || '';
    if (type === 'response.failed' || type === 'error') {
      return (ev.error && ev.error.message) || 'codex image stream reported a failure';
    }
  }
  return null;
}

// The real network driver: POST the body to the Codex Responses endpoint over
// https, collect the full SSE stream to a string, and return the raw text. Kept
// as the DEFAULT of an injectable seam so tests replace it wholesale. Rejects on
// transport error or non-2xx (so run() can map it to a structured envelope).
// The abort signal is honored so run()'s timeout can tear the socket down.
function realHttpDriver({ url, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      headers,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error('codex image http ' + res.statusCode + ': ' + chunks.slice(0, 400));
          e.code = 'http_status';
          return reject(e);
        }
        resolve(chunks);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      // AbortSignal → destroy the socket. run()'s timer fires this.
      const onAbort = () => { try { req.destroy(new Error('timeout')); } catch (_) {} };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}

// Module-level opts let a test (or an embedder) swap the driver without a ctx.
// ctx._httpDriver still wins per-call so a single test can override in isolation.
const opts = { httpDriver: realHttpDriver };

// run(args, ctx) — the tool entrypoint. NEVER throws: every failure path returns
// a structured {ok:false, error, hint} object (the registry's dispatchToolCall
// contract — see shared-core/tools/index.js). On success writes the PNG and
// returns {ok:true, path, bytes, note}.
async function run(args, ctx) {
  args = args || {};
  ctx  = ctx  || {};
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'bad_args', hint: 'Provide a non-empty prompt string describing the image.' };
  }
  const explicit = (args.source === 'chatgpt' || args.source === 'google') ? args.source : null;

  // Source resolution. Probes are cheap and side-effect-free: a token
  // load/refresh for the plan, a config read for the key. Auto order prefers
  // the ChatGPT plan (zero marginal cost on the flat rate) and falls back to
  // the Google AI key; an explicit args.source pins one and reports honestly
  // when that one is not configured.
  // '_codexToken' in ctx is the plan-side test seam (twin of _googleKey /
  // _httpDriver): the shared token store is process-global state, and the test
  // harness interleaves async bodies, so a per-call injection is the only
  // deterministic way to pin "linked"/"not linked" in a scenario.
  let token = null;
  if (explicit !== 'google') {
    if ('_codexToken' in ctx) {
      token = ctx._codexToken;
    } else {
      try { token = await codexOAuth.ensureCodexToken(); } catch (_) { token = null; }
    }
  }
  // '_googleKey' in ctx is the test seam (same philosophy as _httpDriver):
  // process.env mutations race in the test harness (async bodies interleave),
  // so tests inject the key per-call instead of mutating shared env state.
  const googleKey = ('_googleKey' in ctx) ? ctx._googleKey : readGoogleKey();
  let source = explicit || (token ? 'chatgpt' : (googleKey ? 'google' : null));
  if (source === 'chatgpt' && !token) {
    return { ok: false, error: 'chatgpt_sub not linked', hint: 'Link ChatGPT in Settings to generate images with your plan.' };
  }
  if (source === 'google' && !googleKey) {
    return { ok: false, error: 'google_key_missing', hint: 'Add your Google AI key in Settings to use the Google image source.' };
  }
  if (!source) {
    return { ok: false, error: 'no_image_source', hint: 'Link ChatGPT in Settings or add a Google AI key - either one enables images.' };
  }

  const driver = ctx._httpDriver || opts.httpDriver;

  const buildRequestFor = (src) => {
    if (src === 'chatgpt') {
      const model     = codexOAuth.resolveCodexModel((ctx.options && ctx.options.model), null);
      const body      = buildImageBody(prompt, args.size, model);
      const sessionId = codexOAuth.newSessionId();
      const convId    = codexOAuth.newConversationId();
      return {
        url:     codexOAuth.codexUrl(codexOAuth.DEFAULT_BASE, codexOAuth.DEFAULT_PATH),
        headers: codexOAuth.buildCodexHeaders(token, body, sessionId, convId),
        body, prompt, size: args.size, model,
      };
    }
    const model = resolveGoogleImageModel();
    const body  = buildGeminiBody(prompt);
    return {
      url: new URL(GOOGLE_IMAGE_BASE + '/models/' + encodeURIComponent(model) + ':generateContent'),
      headers: {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(body),
        'x-goog-api-key': googleKey,
      },
      body, prompt, model,
    };
  };

  // Bound each attempt with ONE timer that does double duty: it aborts the
  // real driver (AbortController -> socket teardown) AND rejects the race so a
  // driver that ignores the signal (e.g. a test fake) still can't hang the
  // call. The timer is cleared in `finally` - an uncleared setTimeout keeps
  // the Node event loop alive for the full 180s even after run() resolves.
  const callOnce = async (request) => {
    const ac = new AbortController();
    let timer = null;
    try {
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => {
          try { ac.abort(); } catch (_) {}
          rej(Object.assign(new Error('image generation timed out'), { code: 'timeout' }));
        }, CALL_TIMEOUT_MS);
      });
      return await Promise.race([
        driver(Object.assign({ signal: ac.signal }, request)),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // The Codex lane fails with a TYPED in-stream overload error while the
  // request itself is well-formed (HTTP 200, response.created, then
  // service_unavailable_error/server_is_overloaded - captured raw,
  // while the chatgpt.com web UI generated fine: the API lane has its own
  // capacity). That is weather, not a defect: retried with a short backoff,
  // and in AUTO mode a lane that still fails hands over to the next one.
  const RETRY_WAITS_MS = [5000, 15000];
  const isOverloaded = (v) => /overload|service_unavailable|server_is_overloaded/i.test(String(v || ''));

  // AUTO mode gets a second door. "Plan first, key as fallback" used to be
  // resolved once, at link-time - so with the plan linked but its lane down,
  // the Google key sat unused while the user got an error (operator hit this
  // web ChatGPT fine, Codex lane overloaded, fresh Gemini key on
  // file, still no image). An explicit args.source pins one lane and reports
  // honestly; auto means "get me an image", so failures fall through.
  const order = explicit ? [source] : (source === 'chatgpt' && googleKey ? ['chatgpt', 'google'] : [source]);
  let b64 = null;
  let mime = 'image/png';
  let lastFail = null;

  for (const src of order) {
    const request = buildRequestFor(src);
    let raw = null;
    let attempt = 0;
    let transportFail = null;
    for (;;) {
      try {
        raw = await callOnce(request);
      } catch (e) {
        if ((e && e.code) !== 'timeout' && isOverloaded(e && e.message) && attempt < RETRY_WAITS_MS.length) {
          await new Promise(r => setTimeout(r, RETRY_WAITS_MS[attempt++]));
          continue;
        }
        transportFail = {
          ok: false,
          error: (e && e.code) === 'timeout' ? 'timeout' : 'request_failed',
          hint: src === 'chatgpt'
            ? 'The image request to the ChatGPT plan endpoint failed. Check the ChatGPT link in Settings and try again.'
            : 'The image request to the Google AI endpoint failed. Check the key in Settings and try again.',
          detail: String((e && e.message) || e),
        };
        break;
      }
      if (src === 'chatgpt' && attempt < RETRY_WAITS_MS.length) {
        const events = Array.isArray(raw) ? raw : parseSseEvents(raw);
        const streamErr = extractStreamError(events);
        if (streamErr && isOverloaded(streamErr)) {
          await new Promise(r => setTimeout(r, RETRY_WAITS_MS[attempt++]));
          continue;
        }
      }
      break;
    }
    if (transportFail) { lastFail = transportFail; continue; }

    // Per-source response parsing. chatgpt streams SSE; google returns a
    // single JSON document. Drivers may hand back pre-parsed shapes (event
    // array / an object) so the test seam can skip re-serializing.
    if (src === 'chatgpt') {
      const events = Array.isArray(raw) ? raw : parseSseEvents(raw);
      const streamErr = extractStreamError(events);
      if (streamErr) {
        lastFail = { ok: false, error: 'generation_failed', hint: 'The image service reported an error. Try rephrasing the prompt.', detail: streamErr };
        continue;
      }
      b64 = extractImageB64(events);
      if (!b64) {
        lastFail = { ok: false, error: 'no_image_in_stream', hint: 'The response contained no image data. Try again or rephrase the prompt.' };
        continue;
      }
      source = src;
      break;
    }
    let json;
    try { json = (raw && typeof raw === 'object') ? raw : JSON.parse(String(raw)); }
    catch (e) {
      lastFail = { ok: false, error: 'bad_google_response', hint: 'The Google AI endpoint returned unreadable data. Try again.', detail: String((e && e.message) || e) };
      continue;
    }
    const gerr = extractGeminiError(json);
    if (gerr) {
      lastFail = { ok: false, error: 'generation_failed', hint: 'The Google image service reported an error. Check the key and quota, then try rephrasing.', detail: gerr };
      continue;
    }
    const img = extractGeminiImage(json);
    if (!img) {
      lastFail = { ok: false, error: 'no_image_in_response', hint: 'The response contained no image data. Try again or rephrase the prompt.' };
      continue;
    }
    b64 = img.b64;
    mime = img.mime;
    source = src;
    break;
  }
  if (!b64) return lastFail;

  let bytes;
  try { bytes = Buffer.from(b64, 'base64'); }
  catch (e) { return { ok: false, error: 'bad_image_data', hint: 'The service returned unreadable image data. Try again.', detail: String((e && e.message) || e) }; }
  if (!bytes || !bytes.length) {
    return { ok: false, error: 'empty_image_data', hint: 'The service returned an empty image. Try again.' };
  }

  // Write the image. mkdir -p first (idempotent). Extension follows the actual
  // mime - the plan route is png; google may hand back jpeg/webp. A write
  // failure (e.g. read-only home) is a structured error, not a throw.
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/webp' ? 'webp' : 'png');
  const fname = 'img-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex') + '.' + ext;
  const outPath = path.join(IMAGES_DIR, fname);
  try {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(outPath, bytes);
  } catch (e) {
    return { ok: false, error: 'write_failed', hint: 'Could not save the image to ~/.troth/images. Check disk space and permissions.', detail: String((e && e.message) || e) };
  }

  return {
    ok: true,
    path: outPath,
    bytes: bytes.length,
    source,
    note: source === 'chatgpt'
      ? 'generated via ChatGPT plan (unofficial route)'
      : 'generated via Google AI key (Gemini)',
  };
}

module.exports = {
  schema,
  run,
  // Exposed for tests.
  buildImageBody,
  parseSseEvents,
  extractImageB64,
  extractStreamError,
  buildGeminiBody,
  extractGeminiImage,
  extractGeminiError,
  readGoogleKey,
  resolveGoogleImageModel,
  GOOGLE_IMAGE_MODEL_DEFAULT,
  IMAGES_DIR,
  opts,
};
