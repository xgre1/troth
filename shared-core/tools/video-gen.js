// SPDX-License-Identifier: AGPL-3.0-only
// video-gen.js — video_generate tool: render a short clip from a text prompt
// (or a still image) and save it as an MP4 under ~/.troth/videos/. TWO lanes,
// resolved per call, both on keys the operator already holds:
//   openrouter — the OpenRouter key against the videos endpoint. Default model
//                bytedance/seedance-2.5; any other id the endpoint carries is
//                selectable (the Seedance 2.0 family, Kling 3, Veo 3.1, Hailuo
//                3). Async job: submit, poll, download.
//   google_ai  — the Google AI key straight at Veo (default veo-3.1-fast),
//                the SAME providers.google_ai.apiKey slot image-gen reads.
//                Long-running operation: submit, poll, download.
// Auto order is openrouter then google_ai, by which key exists; args.provider
// pins one and reports honestly when its key is missing. Unlike image-gen
// there is NO cross-lane fallthrough on failure: a job that died after ninety
// seconds of billable rendering must not silently start a second billable job.
//
// DRIVER SEAM — deliberately NOT image-gen's, do not "unify" them. image-gen's
// driver POSTs once, rejects on any non-2xx and hands back text. Video needs
// GET as well as POST, a binary body for the MP4, and the status code on a
// failed reply: a 4xx submit carries the provider's reason, and a 5xx on one
// poll is a blip to retry while the job keeps rendering upstream. So
// ctx._httpDriver (else opts.httpDriver, else the real https path) takes
//   {method, url, headers, body?, signal, expect: 'json' | 'binary'}
// and RESOLVES {status, headers, body} for EVERY status — body a string for
// 'json', a Buffer for 'binary', redirects already followed. It rejects only
// when no reply came at all (socket error, abort). Both the MP4 path and the
// retry-on-5xx path depend on this shape.
//
// TIME IS INJECTED: ctx._sleep and ctx._now replace the poll loop's timer and
// clock, so a test walks a six-minute poll in zero wall time. Keys ride
// ctx._openrouterKey / ctx._googleKey per call for the same reason image-gen's
// _googleKey does: the harness interleaves async bodies and shared env races.

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

// A bare tool process has no proxy boot behind it, so the keys the dashboard
// wrote to ~/.troth/.env reach process.env only if this module asks.
try { require('../env-file.js').load(); } catch (_) { /* no .env is a normal state */ }

const VIDEOS_DIR = path.join((process.env.HOME || os.homedir()), '.troth', 'videos');

const POLL_INTERVAL_MS   = 6000;
const POLL_CEILING_MS    = 6 * 60 * 1000;
const POLL_RETRIES       = 3;           // consecutive 5xx / no-reply polls tolerated
const REQUEST_TIMEOUT_MS = 120 * 1000;  // one submit, poll or download
const MIN_VIDEO_BYTES    = 1024;
const MAX_IMAGE_BYTES    = 8 * 1024 * 1024;

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const GOOGLE_BASE     = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_MODEL = { openrouter: 'bytedance/seedance-2.5', google_ai: 'veo-3.1-fast' };
const DEFAULTS      = { seconds: 8, aspect: '9:16', resolution: '720p', audio: true };

const ASPECTS     = ['9:16', '16:9'];
const RESOLUTIONS = ['480p', '720p', '1080p'];
const PROVIDERS   = ['openrouter', 'google_ai'];
const PROVIDER_LABEL = { openrouter: 'OpenRouter', google_ai: 'Google AI' };

const schema = {
  type: 'function',
  function: {
    name: 'video_generate',
    description: 'Generate a short video from a text prompt (or an image) using the operator\'s OpenRouter or Google AI key, and save it as an MP4 under ~/.troth/videos/. Returns the saved file path. Slow - 30 seconds to a few minutes - and it costs money: roughly $0.50-$2.00 for an 8-second 720p clip.',
    parameters: {
      type: 'object',
      properties: {
        prompt:     { type: 'string',  description: 'What should happen in the clip: subject, motion, camera, style.' },
        duration_s: { type: 'integer', description: 'Clip length in seconds, 3-30 (clamped to what the chosen model supports). Default 8.' },
        aspect:     { type: 'string',  enum: ASPECTS, description: 'Frame shape. Default 9:16.' },
        resolution: { type: 'string',  enum: RESOLUTIONS, description: 'Default 720p.' },
        audio:      { type: 'boolean', description: 'Generate a soundtrack. Default true.' },
        image_path: { type: 'string',  description: 'Optional local image to animate as the first frame.' },
        provider:   { type: 'string',  enum: PROVIDERS, description: 'Omit to pick whichever key is configured.' },
        model:      { type: 'string',  description: 'Optional provider model id. Omit for the default.' },
      },
      required: ['prompt'],
    },
  },
};

// What each model renders and what it costs. Verified 2026-09-04 against
// GET /api/v1/videos/models. Keys are the ids the openrouter lane sends; the
// google_ai lane looks its short ids up under 'google/'.
//   seconds     {min,max} range, or {only:[...]} when the model takes a fixed
//               set; absent means the request passes through unclamped.
//   resolutions the values the endpoint accepts; a request is moved to the
//               nearest one by pixel height (ties go lower: cheaper).
//   only8s      resolutions the model renders only as an 8 s clip.
//   price       {tokens: $ per million video tokens} — Seedance bills
//               W×H×24×seconds/1024 tokens — or {second: {<resolution>:
//               {on, off?}}}: $ per second with audio on, and off when mute
//               clips are priced separately.
// The estimate is used ONLY when the provider reports no usage.cost. A model
// missing here yields no estimate at all rather than a wrong number.
const MODELS = {
  'bytedance/seedance-2.5':      { seconds: { min: 3, max: 30 }, resolutions: ['480p', '720p'],          price: { tokens: 10.7 } },
  'bytedance/seedance-2.0':      { seconds: { min: 3, max: 15 }, resolutions: ['480p', '720p', '1080p'], price: { tokens: 7.0 } },
  'bytedance/seedance-2.0-fast': { seconds: { min: 3, max: 15 }, resolutions: ['480p', '720p'],          price: { tokens: 4.2 } },
  'bytedance/seedance-2.0-mini': { seconds: { min: 3, max: 15 }, resolutions: ['480p', '720p'],          price: { tokens: 3.5 } },
  'kwaivgi/kling-v3.0-std':      { seconds: { min: 3, max: 15 }, resolutions: ['720p'], price: { second: { '720p': { on: 0.126, off: 0.084 } } } },
  'kwaivgi/kling-v3.0-pro':      { seconds: { min: 3, max: 15 }, resolutions: ['720p'], price: { second: { '720p': { on: 0.168, off: 0.112 } } } },
  'google/veo-3.1':              { seconds: { only: [4, 6, 8] }, resolutions: ['720p', '1080p'], only8s: ['1080p'], price: { second: { '720p': { on: 0.40, off: 0.20 }, '1080p': { on: 0.40 } } } },
  'google/veo-3.1-fast':         { seconds: { only: [4, 6, 8] }, resolutions: ['720p', '1080p'], only8s: ['1080p'], price: { second: { '720p': { on: 0.10, off: 0.08 }, '1080p': { on: 0.12 } } } },
  'google/veo-3.1-lite':         { seconds: { only: [4, 6, 8] }, resolutions: ['720p', '1080p'], only8s: ['1080p'], price: { second: { '720p': { on: 0.05, off: 0.03 }, '1080p': { on: 0.08 } } } },
  'minimax/hailuo-3':            { resolutions: ['2K'],           price: { second: { '2K': { on: 0.13 } } } },
  'minimax/hailuo-3-max':        { resolutions: ['480p', '768p'], price: { second: { '480p': { on: 0.05 }, '768p': { on: 0.08 } } } },
};

// Frame dimensions per resolution, for the token-billed models.
const PIXELS = { '480p': [854, 480], '720p': [1280, 720], '768p': [1366, 768], '1080p': [1920, 1080], '2K': [2560, 1440] };
const HEIGHT = (r) => (PIXELS[r] ? PIXELS[r][1] : Number(String(r).replace(/\D/g, '')) || 0);

function readTrothConfig() {
  const cfgPath = process.env.TROTH_CONFIG_PATH || path.join((process.env.HOME || os.homedir()), '.troth', 'config.json');
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) { return {}; }
}

// providers.<name>.apiKey from config, then the env names in order. The key
// goes into a request header and nowhere else.
function readProviderKey(name, envNames) {
  const prov = (readTrothConfig().providers || {})[name] || {};
  if (typeof prov.apiKey === 'string' && prov.apiKey.trim()) return prov.apiKey.trim();
  for (const n of envNames) {
    const v = String(process.env[n] || '').trim();
    if (v) return v;
  }
  return null;
}
function readOpenrouterKey() { return readProviderKey('openrouter', ['OPENROUTER_API_KEY']); }
// GEMINI_API_KEY first to match image-gen, GOOGLE_AI_API_KEY second to match
// the dashboard's key map: the two names have drifted apart in the tree.
function readGoogleKey()     { return readProviderKey('google_ai', ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY']); }

// ── Failure envelopes ─────────────────────────────────────────────────────

function badArgs(hint) {
  return { ok: false, error: 'bad_args', hint };
}
function providerFail(status, message) {
  const msg = String(message || 'no reason given').trim();
  return {
    ok: false,
    error: 'provider_error',
    status: Number(status) || 0,
    hint: 'The video service refused this job: ' + msg + '. Try a shorter clip or a different prompt.',
    detail: msg,
  };
}
function requestFail(provider, e) {
  return {
    ok: false,
    error: 'request_failed',
    hint: 'The video request could not reach ' + PROVIDER_LABEL[provider] + '. Check the network and the key in Settings, then try again.',
    detail: String((e && e.message) || e),
  };
}
function timeoutFail(jobId, ceilingMs) {
  const minutes = Math.round(ceilingMs / 60000);
  return {
    ok: false,
    error: 'timeout',
    id: jobId,
    hint: 'The clip was still rendering after ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '. The job id is ' + jobId
      + ' - the provider may still finish it; try a shorter duration or a faster model.',
  };
}
function emptyVideoFail(contentType, why) {
  return {
    ok: false,
    error: 'empty_video',
    hint: 'The service returned no usable video. Try again or rephrase the prompt.',
    detail: (why || 'not an MP4') + (contentType ? ' (content-type ' + contentType + ')' : ''),
  };
}

// ── Validation ────────────────────────────────────────────────────────────

function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function loadImage(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) return badArgs('image_path must be the path of a PNG, JPEG or WebP file on this machine.');
  let stat;
  try { stat = fs.statSync(imagePath); } catch (_) { return badArgs('image_path does not exist or cannot be read: ' + imagePath); }
  if (!stat.isFile()) return badArgs('image_path is not a file: ' + imagePath);
  if (stat.size > MAX_IMAGE_BYTES) return badArgs('image_path is ' + (stat.size / (1024 * 1024)).toFixed(1) + ' MB; the limit is 8 MB.');
  let buf;
  try { buf = fs.readFileSync(imagePath); } catch (_) { return badArgs('image_path cannot be read: ' + imagePath); }
  const mime = sniffImageMime(buf);
  if (!mime) return badArgs('image_path must be a PNG, JPEG or WebP image: ' + imagePath);
  return { ok: true, mime, b64: buf.toString('base64') };
}

// Every field checked before any key is read or any request built. Returns the
// normalised request or a bad_args envelope naming the field and its range.
function validate(args) {
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return badArgs('Provide a non-empty prompt string describing the clip.');
  const out = { prompt: prompt.trim(), seconds: DEFAULTS.seconds, aspect: DEFAULTS.aspect, resolution: DEFAULTS.resolution, audio: DEFAULTS.audio, image: null, provider: null, model: null };
  if (args.duration_s != null) {
    const d = Number(args.duration_s);
    if (!Number.isInteger(d) || d < 3 || d > 30) return badArgs('duration_s must be a whole number of seconds from 3 to 30.');
    out.seconds = d;
  }
  if (args.aspect != null) {
    if (ASPECTS.indexOf(args.aspect) < 0) return badArgs('aspect must be one of ' + ASPECTS.join(', ') + '.');
    out.aspect = args.aspect;
  }
  if (args.resolution != null) {
    if (RESOLUTIONS.indexOf(args.resolution) < 0) return badArgs('resolution must be one of ' + RESOLUTIONS.join(', ') + '.');
    out.resolution = args.resolution;
  }
  if (args.audio != null) {
    if (typeof args.audio !== 'boolean') return badArgs('audio must be true or false.');
    out.audio = args.audio;
  }
  if (args.provider != null) {
    if (PROVIDERS.indexOf(args.provider) < 0) return badArgs('provider must be one of ' + PROVIDERS.join(', ') + '.');
    out.provider = args.provider;
  }
  if (args.model != null) {
    if (typeof args.model !== 'string' || !args.model.trim()) return badArgs('model must be a provider model id string.');
    out.model = args.model.trim();
  }
  if (args.image_path != null) {
    const img = loadImage(args.image_path);
    if (!img.ok) return img;
    out.image = img;
  }
  return out;
}

// ── Fitting a request to a model ──────────────────────────────────────────

function nearestSeconds(list, want) {
  let best = list[0];
  for (const s of list) {
    const d = Math.abs(s - want), bd = Math.abs(best - want);
    if (d < bd || (d === bd && s < best)) best = s;
  }
  return best;
}
function nearestResolution(list, want) {
  const h = HEIGHT(want);
  let best = null;
  for (const r of list) {
    if (best === null) { best = r; continue; }
    const d = Math.abs(HEIGHT(r) - h), bd = Math.abs(HEIGHT(best) - h);
    if (d < bd || (d === bd && HEIGHT(r) < HEIGHT(best))) best = r;
  }
  return best;
}
const listOf = (a) => a.length > 1 ? a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1] : String(a[0]);

// Move seconds and resolution onto what the model renders, and say so in
// notes. When a resolution renders only at 8 s and the caller asked for a
// shorter clip, the clip keeps its length and drops a step: the cheaper of
// the two changes, and the one the caller can undo by asking for 8 s.
function fitToModel(caps, seconds, resolution, notes, label) {
  if (caps.seconds) {
    let pick = seconds;
    if (caps.seconds.only) pick = nearestSeconds(caps.seconds.only, seconds);
    else pick = Math.min(Math.max(seconds, caps.seconds.min), caps.seconds.max);
    if (pick !== seconds) {
      const renders = caps.seconds.only ? listOf(caps.seconds.only) + ' s clips' : caps.seconds.min + '-' + caps.seconds.max + ' s clips';
      notes.push('duration ' + (pick < seconds ? 'shortened' : 'extended') + ' to ' + pick + ' s: ' + label + ' renders ' + renders);
      seconds = pick;
    }
  }
  if (caps.resolutions && caps.resolutions.length) {
    let pick = nearestResolution(caps.resolutions, resolution);
    let why = label + ' renders ' + listOf(caps.resolutions);
    if (caps.only8s && caps.only8s.indexOf(pick) >= 0 && seconds !== 8) {
      const open = caps.resolutions.filter((r) => caps.only8s.indexOf(r) < 0);
      if (open.length) {
        why = label + ' renders ' + pick + ' only as an 8 s clip';
        pick = nearestResolution(open, resolution);
      }
    }
    if (pick !== resolution) {
      notes.push('resolution set to ' + pick + ': ' + why);
      resolution = pick;
    }
  }
  return { seconds, resolution };
}

function round4(n) { return Math.round(n * 1e4) / 1e4; }

// null when the model or resolution is unknown: silence over a wrong number.
function estimateCost(modelId, seconds, resolution, audio) {
  const m = MODELS[modelId];
  if (!m || !m.price) return null;
  if (m.price.tokens) {
    const d = PIXELS[resolution];
    if (!d) return null;
    const tokens = d[0] * d[1] * 24 * seconds / 1024;
    return round4(tokens * m.price.tokens / 1e6);
  }
  const row = m.price.second && m.price.second[resolution];
  if (!row) return null;
  const rate = audio ? row.on : (row.off != null ? row.off : row.on);
  return round4(rate * seconds);
}

// ── Lane plans: model, fitted request, body ───────────────────────────────

function planOpenrouter(v) {
  const model = v.model || DEFAULT_MODEL.openrouter;
  const caps  = MODELS[model] || null;
  const notes = [];
  let { seconds, resolution } = v;
  if (caps) ({ seconds, resolution } = fitToModel(caps, seconds, resolution, notes, model));
  const body = { model, prompt: v.prompt, duration: seconds, resolution, aspect_ratio: v.aspect, generate_audio: v.audio };
  if (v.image) {
    body.frame_images = [{ type: 'image_url', image_url: { url: 'data:' + v.image.mime + ';base64,' + v.image.b64 }, frame_type: 'first_frame' }];
  }
  return { provider: 'openrouter', model, priceKey: model, seconds, resolution, aspect: v.aspect, audio: v.audio, notes, body };
}

function planGoogle(v) {
  const model = (v.model || DEFAULT_MODEL.google_ai).replace(/^google\//, '').replace(/-generate-preview$/, '');
  const caps  = MODELS['google/' + model] || null;
  const notes = [];
  let { seconds, resolution } = v;
  if (caps) ({ seconds, resolution } = fitToModel(caps, seconds, resolution, notes, model));
  // Audio is native on this lane and cannot be switched off; say so rather
  // than let audio:false look honoured.
  if (v.audio === false) notes.push('audio is always on for ' + model + '; audio:false has no effect on this provider');
  const body = { instances: [{ prompt: v.prompt }], parameters: { aspectRatio: v.aspect, resolution, durationSeconds: seconds } };
  if (v.image) body.instances[0].image = { inlineData: { mimeType: v.image.mime, data: v.image.b64 } };
  return { provider: 'google_ai', model, priceKey: 'google/' + model, endpointModel: model + '-generate-preview', seconds, resolution, aspect: v.aspect, audio: true, notes, body };
}

// ── HTTP ──────────────────────────────────────────────────────────────────

// The real driver. Follows up to five redirects; a hop to another host
// drops the key headers so the credential never reaches a third party (the
// download URLs both providers hand out are signed and need no key).
function realHttpDriver({ method, url, headers, body, signal, expect }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    const hop = (target, m, hdrs, payload, left) => {
      const u = target instanceof URL ? target : new URL(String(target));
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({
        method:   m,
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'http:' ? 80 : 443),
        path:     u.pathname + u.search,
        headers:  hdrs,
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && left > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, u); } catch (e) { return finish(reject, e); }
          const nh = Object.assign({}, hdrs);
          if (next.host !== u.host) { delete nh.authorization; delete nh['x-goog-api-key']; }
          const nm = (status === 307 || status === 308) ? m : 'GET';
          if (nm === 'GET') { delete nh['content-type']; delete nh['content-length']; }
          return hop(next, nm, nh, nm === 'GET' ? null : payload, left - 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          finish(resolve, { status, headers: res.headers, body: expect === 'binary' ? buf : buf.toString('utf8') });
        });
        res.on('error', (e) => finish(reject, e));
      });
      req.on('error', (e) => finish(reject, e));
      if (signal) {
        const onAbort = () => { try { req.destroy(new Error('aborted')); } catch (_) {} };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      if (payload) req.write(payload);
      req.end();
    };
    hop(url, method, headers || {}, body, 5);
  });
}

const opts = { httpDriver: realHttpDriver };

// One request, bounded by a timer that aborts the socket AND rejects the
// race, so a driver that ignores the signal still cannot hang the call. The
// timer is cleared in finally: a live setTimeout keeps the event loop up.
async function callOnce(driver, request) {
  const ac = new AbortController();
  let timer = null;
  try {
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        try { ac.abort(); } catch (_) {}
        rej(Object.assign(new Error('no reply within ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' s'), { code: 'timeout' }));
      }, REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([driver(Object.assign({ signal: ac.signal }, request)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'object') return body;
  try { return JSON.parse(String(body)); } catch (_) { return null; }
}
function is2xx(status) { return status >= 200 && status < 300; }
function headerOf(headers, name) {
  if (!headers) return '';
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return k ? String(headers[k]) : '';
}
function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'binary');
  return Buffer.alloc(0);
}

// The provider's own words for a refusal, from the shapes both lanes use:
// {error:{message}}, {error:"..."}, {message}, or a job's error field.
function messageOf(json, raw) {
  if (json) {
    if (json.error && typeof json.error === 'object' && json.error.message) return String(json.error.message);
    if (typeof json.error === 'string' && json.error) return json.error;
    if (typeof json.message === 'string' && json.message) return json.message;
    if (typeof json.detail === 'string' && json.detail) return json.detail;
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  return text.trim().slice(0, 300) || 'no reason given';
}

// ── Poll loop, shared by both lanes ───────────────────────────────────────
//
// fetch() performs one poll through the driver; read(status, json) returns
// {done:true, value} | {fail: envelope} | {pending:true}. A 5xx, a reply that
// is not JSON, or no reply at all is a blip: the job is still running
// upstream, so it is retried POLL_RETRIES times in a row before it counts.
// Bounded twice — by the injected clock and by a poll count — so a clock that
// never advances still cannot spin.
async function pollUntilDone(io, jobId, fetch, read) {
  const startedAt = io.now();
  const maxPolls = Math.ceil(io.ceiling / io.interval);
  let blips = 0;
  for (let polls = 0; polls < maxPolls; polls++) {
    const elapsed = io.now() - startedAt;
    if (elapsed >= io.ceiling) break;
    await io.sleep(Math.min(io.interval, io.ceiling - elapsed));
    let reply;
    try { reply = await fetch(); }
    catch (e) {
      if (++blips <= POLL_RETRIES) continue;
      return requestFail(io.provider, e);
    }
    const json = parseJson(reply.body);
    if (reply.status >= 500 || (is2xx(reply.status) && !json)) {
      if (++blips <= POLL_RETRIES) continue;
      return providerFail(reply.status, messageOf(json, reply.body));
    }
    blips = 0;
    if (!is2xx(reply.status)) return providerFail(reply.status, messageOf(json, reply.body));
    const verdict = read(reply.status, json);
    if (verdict.fail) return verdict.fail;
    if (verdict.done) return { ok: true, value: verdict.value };
  }
  return timeoutFail(jobId, io.ceiling);
}

// ── Lanes ─────────────────────────────────────────────────────────────────
// Each resolves {ok:true, id, bytes, contentType, cost_usd} or a failure
// envelope. The key touches nothing but the header object.

async function renderOpenrouter(plan, key, io) {
  const auth    = { authorization: 'Bearer ' + key, accept: 'application/json' };
  const payload = JSON.stringify(plan.body);
  let reply;
  try {
    reply = await callOnce(io.driver, {
      method: 'POST', url: OPENROUTER_BASE + '/videos',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, auth),
      body: payload, expect: 'json',
    });
  } catch (e) { return requestFail('openrouter', e); }
  const json = parseJson(reply.body);
  if (!is2xx(reply.status)) return providerFail(reply.status, messageOf(json, reply.body));
  const id = json && (json.id || json.generation_id);
  if (!id) return providerFail(reply.status, 'the job reply carried no id');
  let pollUrl = (json.polling_url && typeof json.polling_url === 'string') ? json.polling_url : '/api/v1/videos/' + encodeURIComponent(id);
  if (pollUrl[0] === '/') pollUrl = 'https://openrouter.ai' + pollUrl;

  const done = await pollUntilDone(io, id,
    () => callOnce(io.driver, { method: 'GET', url: pollUrl, headers: auth, expect: 'json' }),
    (status, job) => {
      const st = String((job && job.status) || '').toLowerCase();
      if (st === 'completed' || st === 'succeeded') return { done: true, value: job };
      if (st === 'failed' || st === 'expired' || st === 'cancelled' || st === 'canceled') {
        const said = (job.error && typeof job.error === 'object') ? String(job.error.message || '') : (typeof job.error === 'string' ? job.error : '');
        return { fail: providerFail(status, said || ('the job ended as ' + st)) };
      }
      return { pending: true };
    });
  if (!done.ok) return done;
  const job  = done.value || {};
  const cost = (job.usage && typeof job.usage.cost === 'number') ? job.usage.cost : null;

  let dl;
  try {
    dl = await callOnce(io.driver, {
      method: 'GET', url: OPENROUTER_BASE + '/videos/' + encodeURIComponent(id) + '/content?index=0',
      headers: { authorization: auth.authorization }, expect: 'binary',
    });
  } catch (e) { return requestFail('openrouter', e); }
  if (!is2xx(dl.status)) return providerFail(dl.status, messageOf(parseJson(dl.body), dl.body));
  return { ok: true, id, bytes: toBuffer(dl.body), contentType: headerOf(dl.headers, 'content-type'), cost_usd: cost };
}

async function renderGoogle(plan, key, io) {
  const auth    = { 'x-goog-api-key': key };
  const payload = JSON.stringify(plan.body);
  let reply;
  try {
    reply = await callOnce(io.driver, {
      method: 'POST', url: GOOGLE_BASE + '/models/' + encodeURIComponent(plan.endpointModel) + ':predictLongRunning',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, auth),
      body: payload, expect: 'json',
    });
  } catch (e) { return requestFail('google_ai', e); }
  const json = parseJson(reply.body);
  if (!is2xx(reply.status)) return providerFail(reply.status, messageOf(json, reply.body));
  const name = json && typeof json.name === 'string' && json.name;
  if (!name) return providerFail(reply.status, 'the job reply carried no operation name');

  const done = await pollUntilDone(io, name,
    () => callOnce(io.driver, { method: 'GET', url: GOOGLE_BASE + '/' + name.replace(/^\/+/, ''), headers: auth, expect: 'json' }),
    (status, op) => {
      if (!op || op.done !== true) return { pending: true };
      if (op.error) return { fail: providerFail(status, messageOf(op, '')) };
      const gen = (op.response && (op.response.generateVideoResponse || op.response)) || {};
      const samples = Array.isArray(gen.generatedSamples) ? gen.generatedSamples : [];
      const uri = samples[0] && samples[0].video && samples[0].video.uri;
      if (!uri) {
        const reasons = Array.isArray(gen.raiMediaFilteredReasons) ? gen.raiMediaFilteredReasons.join('; ') : '';
        return { fail: providerFail(status, reasons || 'the finished job carried no video') };
      }
      return { done: true, value: uri };
    });
  if (!done.ok) return done;

  let dl;
  try { dl = await callOnce(io.driver, { method: 'GET', url: done.value, headers: auth, expect: 'binary' }); }
  catch (e) { return requestFail('google_ai', e); }
  if (!is2xx(dl.status)) return providerFail(dl.status, messageOf(parseJson(dl.body), dl.body));
  return { ok: true, id: name, bytes: toBuffer(dl.body), contentType: headerOf(dl.headers, 'content-type'), cost_usd: null };
}

// ── Disk ──────────────────────────────────────────────────────────────────

function looksLikeMp4(bytes) {
  return bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp';
}

// Temp-then-rename with an fsync between, so a download killed halfway never
// leaves a file that looks finished. The temp name starts with a dot so a
// directory listing of finished clips does not show it.
function saveVideo(bytes) {
  const stamp     = Date.now() + '-' + crypto.randomBytes(2).toString('hex');
  const finalPath = path.join(VIDEOS_DIR, 'vid-' + stamp + '.mp4');
  const tempPath  = path.join(VIDEOS_DIR, '.vid-' + stamp + '.part');
  try {
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    const fd = fs.openSync(tempPath, 'w');
    try {
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tempPath, finalPath);
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    return { ok: false, error: 'write_failed', hint: 'Could not save the video to ~/.troth/videos. Check disk space and permissions.', detail: String((e && e.message) || e) };
  }
  return { ok: true, path: finalPath };
}

// Every string in an outgoing result is swept for the keys this call held.
// Provider messages are quoted verbatim in detail and hint, and a provider
// that echoes a bad credential back would otherwise put it in the transcript.
function scrubSecrets(value, secrets) {
  const live = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  if (!live.length) return value;
  const sweep = (v) => {
    if (typeof v === 'string') { for (const s of live) v = v.split(s).join('[key]'); return v; }
    if (Array.isArray(v)) return v.map(sweep);
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
      const o = {};
      for (const k of Object.keys(v)) o[k] = sweep(v[k]);
      return o;
    }
    return v;
  };
  return sweep(value);
}

// ── Entry point ───────────────────────────────────────────────────────────

async function render(v, ctx) {
  const openrouterKey = ('_openrouterKey' in ctx) ? ctx._openrouterKey : readOpenrouterKey();
  const googleKey     = ('_googleKey' in ctx)     ? ctx._googleKey     : readGoogleKey();
  const provider = v.provider || (openrouterKey ? 'openrouter' : (googleKey ? 'google_ai' : null));
  if (!provider) {
    return { ok: false, error: 'no_key', hint: 'Add an OpenRouter or Google AI key in Settings - either one enables video.' };
  }
  const key = provider === 'openrouter' ? openrouterKey : googleKey;
  if (!key) {
    return { ok: false, error: 'provider_key_missing', hint: 'Add your ' + PROVIDER_LABEL[provider] + ' key in Settings, or omit provider to use the key you already have.' };
  }

  const io = {
    provider,
    driver:   ctx._httpDriver || opts.httpDriver,
    now:      ctx._now   || Date.now,
    sleep:    ctx._sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    interval: Number(ctx._pollIntervalMs) > 0 ? Number(ctx._pollIntervalMs) : POLL_INTERVAL_MS,
    ceiling:  Number(ctx._pollCeilingMs)  > 0 ? Number(ctx._pollCeilingMs)  : POLL_CEILING_MS,
  };
  const plan = provider === 'openrouter' ? planOpenrouter(v) : planGoogle(v);

  const startedAt = io.now();
  const got = provider === 'openrouter' ? await renderOpenrouter(plan, key, io) : await renderGoogle(plan, key, io);
  if (!got.ok) return got;
  const elapsed = io.now() - startedAt;

  const bytes = got.bytes;
  if (!bytes || bytes.length < MIN_VIDEO_BYTES) return emptyVideoFail(got.contentType, bytes && bytes.length ? bytes.length + ' bytes' : 'empty body');
  if (!looksLikeMp4(bytes)) return emptyVideoFail(got.contentType, 'not an MP4 container');

  const saved = saveVideo(bytes);
  if (!saved.ok) return saved;

  const out = { ok: true, path: saved.path, seconds: plan.seconds, resolution: plan.resolution, aspect: plan.aspect, provider, model: plan.model };
  if (typeof got.cost_usd === 'number') {
    out.cost_usd = got.cost_usd;
    out.cost_estimated = false;
  } else {
    const est = estimateCost(plan.priceKey, plan.seconds, plan.resolution, plan.audio);
    if (est != null) { out.cost_usd = est; out.cost_estimated = true; }
  }
  out.elapsed_ms = elapsed;
  out.bytes = bytes.length;
  if (plan.notes.length) out.note = plan.notes.join('; ');
  return out;
}

// run(args, ctx) — the tool entrypoint. NEVER throws: every failure is a
// structured {ok:false, error, hint, detail?} (the registry's dispatchToolCall
// contract, see shared-core/tools/index.js), and every result is swept for
// the keys before it leaves.
async function run(args, ctx) {
  args = args || {};
  ctx  = ctx  || {};
  const secrets = [ctx._openrouterKey, ctx._googleKey];
  let result;
  try {
    const v = validate(args);
    if (v.ok === false) return v;
    if (!('_openrouterKey' in ctx)) secrets.push(readOpenrouterKey());
    if (!('_googleKey' in ctx))     secrets.push(readGoogleKey());
    result = await render(v, ctx);
  } catch (e) {
    result = { ok: false, error: 'unexpected_error', hint: 'The video tool hit an error it did not expect. Try again.', detail: String((e && e.message) || e) };
  }
  return scrubSecrets(result, secrets);
}

module.exports = {
  schema,
  run,
  // Exposed for tests.
  MODELS,
  DEFAULT_MODEL,
  estimateCost,
  fitToModel,
  planOpenrouter,
  planGoogle,
  readOpenrouterKey,
  readGoogleKey,
  VIDEOS_DIR,
  POLL_INTERVAL_MS,
  POLL_CEILING_MS,
  opts,
};
