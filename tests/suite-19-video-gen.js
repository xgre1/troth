// SPDX-License-Identifier: AGPL-3.0-only
// suite-19-video-gen.js — video_generate tool (shared-core/tools/video-gen.js).
//
// Fully OFFLINE + deterministic, the suite-14 discipline. Every request goes
// through the injectable driver (ctx._httpDriver), here a scripted queue that
// records what the tool sent; the poll loop's clock and sleep are injected
// (ctx._now / ctx._sleep) so a six-minute poll finishes in zero wall time;
// keys ride ctx._openrouterKey / ctx._googleKey and never touch process.env.
// HOME is redirected to a throwaway dir before the first require so the happy
// path writes into a temp ~/.troth/videos, never the operator's.
//
// Coverage:
//   VID1  schema, registry, permission class
//   VID2  openrouter happy path: submit → pending → completed → bytes on disk
//   VID3  provider refusals: a 4xx submit and a terminal failed job
//   VID4  timeout is bounded by the injected clock and the poll count
//   VID5  no key / pinned lane without its key: honest errors, no network
//   VID6  image-to-video on both lanes; bad image_path is bad_args
//   VID7  no key ever leaks, even when the provider echoes it back
//   VID8  empty, short or non-MP4 bodies leave no file
//   VID9  google_ai lane: fitting to 4/6/8 s, audio always on, full flow
//   VID10 estimates when the provider reports no cost
//   VID11 argument validation

module.exports = function run({ test }) {
const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');

// A real MP4 container at runtime: an ftyp box and an mdat box of zeros, so
// the happy path asserts on genuine container bytes rather than a blob.
function tinyMp4() {
  const box = (type, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(8 + payload.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), payload]);
  };
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2mp41')]));
  const mdat = box('mdat', Buffer.alloc(1024));
  return Buffer.concat([ftyp, mdat]);
}

// A real 1x1 PNG for the image-to-video cases (same builder as suite-14).
function tinyPng() {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type), data]);
    let c = 0xffffffff;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Scripted driver: replies are consumed in order, each optionally checking
// the method and a url fragment; every request lands in the sink so bodies
// and headers can be asserted afterwards. A reply given as an Error rejects,
// the way the real driver does when no reply came at all.
function scriptedDriver(script, sink) {
  const queue = script.slice();
  return async (req) => {
    sink.push({ method: req.method, url: String(req.url), headers: req.headers || {}, body: req.body, expect: req.expect });
    const step = queue.shift();
    if (!step) throw new Error('driver: no scripted reply for ' + req.method + ' ' + req.url);
    if (step.match) {
      if (step.match.method && step.match.method !== req.method) throw new Error('driver: expected ' + step.match.method + ', got ' + req.method + ' ' + req.url);
      if (step.match.urlIncludes && String(req.url).indexOf(step.match.urlIncludes) < 0) throw new Error('driver: expected a url containing ' + step.match.urlIncludes + ', got ' + req.url);
    }
    if (step.reply instanceof Error) throw step.reply;
    const r = step.reply;
    const body = Buffer.isBuffer(r.body) || typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status, headers: r.headers || {}, body };
  };
}

// Sleep advances the clock; nothing else does. A poll test walks the whole
// ceiling in zero wall time and the poll count is exactly ceiling/interval.
function fakeClock() {
  let t = 1000000;
  return { _now: () => t, _sleep: async (ms) => { t += ms; } };
}

const KEY_OR = 'sk-or-v1-test-openrouter-key';
const KEY_GO = 'AIza-test-google-key';

// Redirect HOME so ~/.troth/videos resolves inside a temp dir. video-gen.js and
// env-file.js both read HOME at require time, so HOME moves BEFORE the first
// require and both are busted from the cache; restored and re-busted at the end.
//
// The HOME to restore is the runner's hermetic one (_TROTH_TEST_HOME), not
// whatever process.env.HOME holds now: suites register synchronously and tear
// down in the async flush, so at this point HOME is still suite-14's temp dir,
// which its own teardown removes before ours runs. Restoring to THAT left every
// later suite with a HOME that no longer existed and the read wall in
// suite-28 with nothing to resolve.
const TMP_HOME = path.join(os.tmpdir(), 'troth-videogen-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
fs.mkdirSync(TMP_HOME, { recursive: true });
const _origHome = process.env._TROTH_TEST_HOME || process.env.HOME;
process.env.HOME = TMP_HOME;
const VG_PATH  = require.resolve('../shared-core/tools/video-gen.js');
const ENV_PATH = require.resolve('../shared-core/env-file.js');
for (const p of [VG_PATH, ENV_PATH]) delete require.cache[p];
const videoGen = require('../shared-core/tools/video-gen.js');
const VIDEOS_DIR = path.join(TMP_HOME, '.troth', 'videos');
const mp4 = tinyMp4();

const filesIn = (dir) => { try { return fs.readdirSync(dir); } catch (_) { return []; } };
const OR = 'https://openrouter.ai/api/v1';
const okJob = (id, extra) => Object.assign({ id, status: 'completed', unsigned_urls: ['https://example.invalid/' + id] }, extra || {});
const seedanceScript = (id, extra) => [
  { match: { method: 'POST', urlIncludes: OR + '/videos' }, reply: { status: 202, body: { id, status: 'pending', polling_url: OR + '/videos/' + id } } },
  { match: { method: 'GET', urlIncludes: '/videos/' + id }, reply: { status: 200, body: { id, status: 'in_progress' } } },
  { match: { method: 'GET', urlIncludes: '/videos/' + id }, reply: { status: 200, body: okJob(id, extra) } },
  { match: { method: 'GET', urlIncludes: '/videos/' + id + '/content?index=0' }, reply: { status: 200, headers: { 'content-type': 'video/mp4' }, body: mp4 } },
];

console.log('\nVideo generation (video_generate):');

test('VID1: schema is an OpenAI function tool named video_generate; registered; classified WRITE', () => {
  const s = videoGen.schema;
  assert.strictEqual(s.type, 'function');
  assert.strictEqual(s.function.name, 'video_generate');
  assert.deepStrictEqual(s.function.parameters.required, ['prompt']);
  const p = s.function.parameters.properties;
  assert.deepStrictEqual(p.aspect.enum, ['9:16', '16:9']);
  assert.deepStrictEqual(p.resolution.enum, ['480p', '720p', '1080p']);
  assert.deepStrictEqual(p.provider.enum, ['openrouter', 'google_ai']);
  assert.strictEqual(p.audio.type, 'boolean');
  assert.strictEqual(p.duration_s.type, 'integer');
  assert.ok(p.image_path && p.model, 'image_path and model advertised');
  assert.ok(/costs money/.test(s.function.description), 'description states the cost');
  const reg = require('../shared-core/tools/index.js').REGISTRY;
  assert.ok(reg.video_generate && reg.video_generate.schema.function.name === 'video_generate', 'registered in REGISTRY');
  assert.strictEqual(require('../shared-core/tools/permission.js').classify('video_generate'), 'write');
});

test('VID2: happy path - 202, in_progress, completed, bytes; MP4 on disk, cost verbatim', async () => {
  const sink = [];
  const before = filesIn(VIDEOS_DIR).length;
  const out = await videoGen.run({ prompt: 'a red kite over the sea' }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_1', { usage: { cost: 1.8496, is_byok: false } }), sink),
    _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(out.ok, true, 'ok result: ' + JSON.stringify(out));
  assert.strictEqual(sink.length, 4, 'submit, two polls, one download');
  assert.deepStrictEqual(sink.map((r) => r.method), ['POST', 'GET', 'GET', 'GET']);
  assert.strictEqual(sink[0].url, OR + '/videos');
  assert.strictEqual(sink[3].url, OR + '/videos/gen_1/content?index=0');
  assert.strictEqual(sink[3].expect, 'binary', 'the download asks for bytes');
  assert.strictEqual(sink[0].expect, 'json');
  const body = JSON.parse(sink[0].body);
  assert.strictEqual(body.model, 'bytedance/seedance-2.5');
  assert.strictEqual(body.prompt, 'a red kite over the sea');
  assert.strictEqual(body.duration, 8);
  assert.strictEqual(body.aspect_ratio, '9:16');
  assert.strictEqual(body.resolution, '720p');
  assert.strictEqual(body.generate_audio, true);
  assert.ok(!('frame_images' in body), 'no frame_images without an image');
  for (const r of sink) assert.strictEqual(r.headers.authorization, 'Bearer ' + KEY_OR, 'the key rides the header on ' + r.url);
  assert.ok(out.path.indexOf(VIDEOS_DIR) === 0, 'path under the temp ~/.troth/videos: ' + out.path);
  assert.ok(/\.mp4$/.test(out.path), 'ends .mp4');
  assert.ok(fs.readFileSync(out.path).equals(mp4), 'bytes on disk equal the fixture');
  const after = filesIn(VIDEOS_DIR);
  assert.strictEqual(after.length, before + 1, 'exactly one new file');
  assert.ok(!after.some((f) => /\.part$/.test(f)), 'no .part left behind');
  assert.strictEqual(out.cost_usd, 1.8496);
  assert.strictEqual(out.cost_estimated, false);
  assert.strictEqual(typeof out.elapsed_ms, 'number');
  assert.strictEqual(out.seconds, 8);
  assert.strictEqual(out.resolution, '720p');
  assert.strictEqual(out.aspect, '9:16');
  assert.strictEqual(out.provider, 'openrouter');
  assert.strictEqual(out.model, 'bytedance/seedance-2.5');
  assert.strictEqual(out.bytes, mp4.length);
  assert.ok(!('note' in out), 'nothing to note on a clip rendered as asked');
});

test('VID3: provider refusals - a 400 submit and a terminal failed job; no file, never throws', async () => {
  const before = filesIn(VIDEOS_DIR).length;
  let threw = false, out;
  const sink = [];
  try {
    out = await videoGen.run({ prompt: 'x' }, Object.assign({
      _httpDriver: scriptedDriver([{ reply: { status: 400, body: { error: { message: 'unsupported duration', code: 400 } } } }], sink),
      _openrouterKey: KEY_OR, _googleKey: null,
    }, fakeClock()));
  } catch (_) { threw = true; }
  assert.strictEqual(threw, false, 'run must never throw');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'provider_error');
  assert.strictEqual(out.status, 400);
  assert.ok(/unsupported duration/.test(out.detail), 'provider message in detail');
  assert.ok(/unsupported duration/.test(out.hint), 'and in the hint');
  assert.strictEqual(sink.length, 1, 'no poll after a refused submit');
  assert.ok(!('path' in out));
  // Terminal failure after the job was accepted.
  const sink2 = [];
  const failed = await videoGen.run({ prompt: 'x' }, Object.assign({
    _httpDriver: scriptedDriver([
      { reply: { status: 202, body: { id: 'gen_f', status: 'pending', polling_url: OR + '/videos/gen_f' } } },
      { reply: { status: 200, body: { id: 'gen_f', status: 'failed', error: 'content policy' } } },
    ], sink2),
    _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.error, 'provider_error');
  assert.ok('status' in failed);
  assert.ok(/content policy/.test(failed.detail), 'job error surfaces: ' + JSON.stringify(failed));
  assert.strictEqual(sink2.length, 2, 'no download after a failed job');
  assert.ok(!('path' in failed));
  assert.strictEqual(filesIn(VIDEOS_DIR).length, before, 'no file written on failure');
});

test('VID4: timeout - in_progress forever ends at the ceiling with the job id and a bounded poll count', async () => {
  let polls = 0;
  const forever = async (req) => {
    if (req.method === 'POST') return { status: 202, headers: {}, body: JSON.stringify({ id: 'gen_t', status: 'pending', polling_url: OR + '/videos/gen_t' }) };
    polls++;
    return { status: 200, headers: {}, body: JSON.stringify({ id: 'gen_t', status: 'in_progress' }) };
  };
  const out = await videoGen.run({ prompt: 'x' }, Object.assign({ _httpDriver: forever, _openrouterKey: KEY_OR, _googleKey: null }, fakeClock()));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'timeout');
  assert.strictEqual(out.id, 'gen_t');
  assert.ok(/6 minutes/.test(out.hint) && /gen_t/.test(out.hint), 'hint names the wait and the job id: ' + out.hint);
  assert.strictEqual(polls, videoGen.POLL_CEILING_MS / videoGen.POLL_INTERVAL_MS, 'one poll per interval up to the ceiling');
  assert.strictEqual(polls, 60);
  // Both knobs are ctx-overridable.
  polls = 0;
  const short = await videoGen.run({ prompt: 'x' }, Object.assign({ _httpDriver: forever, _openrouterKey: KEY_OR, _googleKey: null, _pollIntervalMs: 10000, _pollCeilingMs: 30000 }, fakeClock()));
  assert.strictEqual(short.error, 'timeout');
  assert.strictEqual(polls, 3);
  assert.ok(/1 minute\b/.test(short.hint), 'hint reflects the ceiling in force: ' + short.hint);
  // A run of 5xx polls is a blip, not a verdict: the job is still rendering.
  let n = 0;
  const flaky = async (req) => {
    if (req.method === 'POST') return { status: 202, headers: {}, body: JSON.stringify({ id: 'gen_b', status: 'pending' }) };
    n++;
    if (n <= 2) return { status: 503, headers: {}, body: 'upstream busy' };
    if (n === 3) return { status: 200, headers: {}, body: JSON.stringify(okJob('gen_b')) };
    return { status: 200, headers: { 'content-type': 'video/mp4' }, body: mp4 };
  };
  const recovered = await videoGen.run({ prompt: 'x' }, Object.assign({ _httpDriver: flaky, _openrouterKey: KEY_OR, _googleKey: null }, fakeClock()));
  assert.strictEqual(recovered.ok, true, 'two 503 polls then completed: ' + JSON.stringify(recovered));
});

test('VID5: missing keys - no_key, and a pinned lane without its key; the driver is never called', async () => {
  let hit = 0;
  const spy = async () => { hit++; return { status: 500, headers: {}, body: '' }; };
  const none = await videoGen.run({ prompt: 'x' }, { _httpDriver: spy, _openrouterKey: null, _googleKey: null });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.error, 'no_key');
  assert.strictEqual(none.hint, 'Add an OpenRouter or Google AI key in Settings - either one enables video.');
  const pinnedOr = await videoGen.run({ prompt: 'x', provider: 'openrouter' }, { _httpDriver: spy, _openrouterKey: null, _googleKey: KEY_GO });
  assert.strictEqual(pinnedOr.error, 'provider_key_missing');
  assert.ok(/OpenRouter key/.test(pinnedOr.hint) && /omit provider/.test(pinnedOr.hint), pinnedOr.hint);
  const pinnedGo = await videoGen.run({ prompt: 'x', provider: 'google_ai' }, { _httpDriver: spy, _openrouterKey: KEY_OR, _googleKey: null });
  assert.strictEqual(pinnedGo.error, 'provider_key_missing');
  assert.ok(/Google AI key/.test(pinnedGo.hint), pinnedGo.hint);
  assert.strictEqual(hit, 0, 'no network without a key');
});

test('VID6: image-to-video - data URI first frame on openrouter, inlineData on google_ai; bad paths are bad_args', async () => {
  const png = tinyPng();
  const pngPath = path.join(TMP_HOME, 'still.png');
  fs.writeFileSync(pngPath, png);
  const sink = [];
  const out = await videoGen.run({ prompt: 'the still starts to move', image_path: pngPath }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_i'), sink), _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  const body = JSON.parse(sink[0].body);
  assert.strictEqual(body.frame_images.length, 1);
  assert.strictEqual(body.frame_images[0].type, 'image_url');
  assert.strictEqual(body.frame_images[0].frame_type, 'first_frame');
  const url = body.frame_images[0].image_url.url;
  assert.ok(url.indexOf('data:image/png;base64,') === 0, 'data URI: ' + url.slice(0, 40));
  assert.ok(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64').equals(png), 'the still travels intact');
  // The google_ai lane carries it as inlineData on the instance.
  const gsink = [];
  const gout = await videoGen.run({ prompt: 'move', image_path: pngPath, provider: 'google_ai' }, Object.assign({
    _httpDriver: scriptedDriver(veoScript('op_i'), gsink), _openrouterKey: null, _googleKey: KEY_GO,
  }, fakeClock()));
  assert.strictEqual(gout.ok, true, JSON.stringify(gout));
  const gbody = JSON.parse(gsink[0].body);
  assert.strictEqual(gbody.instances[0].image.inlineData.mimeType, 'image/png');
  assert.strictEqual(gbody.instances[0].image.inlineData.data, png.toString('base64'));
  // Bad paths never reach the network.
  let hit = 0;
  const spy = async () => { hit++; return { status: 500, headers: {}, body: '' }; };
  const ctx = { _httpDriver: spy, _openrouterKey: KEY_OR, _googleKey: null };
  const missing = await videoGen.run({ prompt: 'x', image_path: path.join(TMP_HOME, 'nope.png') }, ctx);
  assert.strictEqual(missing.error, 'bad_args');
  assert.ok(/image_path/.test(missing.hint), missing.hint);
  const bigPath = path.join(TMP_HOME, 'big.png');
  fs.writeFileSync(bigPath, Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]));
  const big = await videoGen.run({ prompt: 'x', image_path: bigPath }, ctx);
  assert.strictEqual(big.error, 'bad_args');
  assert.ok(/8 MB/.test(big.hint), big.hint);
  const txtPath = path.join(TMP_HOME, 'notes.txt');
  fs.writeFileSync(txtPath, 'not an image');
  const txt = await videoGen.run({ prompt: 'x', image_path: txtPath }, ctx);
  assert.strictEqual(txt.error, 'bad_args');
  assert.ok(/PNG, JPEG or WebP/.test(txt.hint), txt.hint);
  assert.strictEqual(hit, 0, 'no network for a bad image');
});

test('VID7: no key ever leaks - every failure lane on both lanes, with a provider that echoes the key', async () => {
  const SK_OR = 'sk-or-SENTINEL-OPENROUTER-0000';
  const SK_GO = 'AIza-SENTINEL-GOOGLE-0000';
  const logged = [];
  const spied = ['log', 'error', 'warn', 'info', 'debug'];
  const saved = {};
  for (const m of spied) { saved[m] = console[m]; console[m] = (...a) => { logged.push(a.map(String).join(' ')); }; }
  const results = [];
  try {
    const echo = (key) => ({ error: { message: 'bad credential ' + key } });
    const lanes = [
      { provider: 'openrouter', ctx: { _openrouterKey: SK_OR, _googleKey: null }, key: SK_OR, submitOk: { status: 202, body: { id: 'j', status: 'pending', polling_url: OR + '/videos/j' } },
        failed: { status: 200, body: { id: 'j', status: 'failed', error: 'refused for ' + SK_OR } },
        pending: { status: 200, body: { id: 'j', status: 'in_progress' } },
        done: { status: 200, body: okJob('j') } },
      { provider: 'google_ai', ctx: { _openrouterKey: null, _googleKey: SK_GO }, key: SK_GO, submitOk: { status: 200, body: { name: 'models/veo/operations/j' } },
        failed: { status: 200, body: { name: 'models/veo/operations/j', done: true, error: { message: 'refused for ' + SK_GO } } },
        pending: { status: 200, body: { name: 'models/veo/operations/j', done: false } },
        done: { status: 200, body: { name: 'models/veo/operations/j', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/j:download?alt=media' } }] } } } } },
    ];
    for (const lane of lanes) {
      // 401 on submit that echoes the key back.
      results.push(await videoGen.run({ prompt: 'x', provider: lane.provider }, Object.assign({ _httpDriver: scriptedDriver([{ reply: { status: 401, body: echo(lane.key) } }], []) }, lane.ctx, fakeClock())));
      // Terminal failure that echoes the key back.
      results.push(await videoGen.run({ prompt: 'x', provider: lane.provider }, Object.assign({ _httpDriver: scriptedDriver([{ reply: lane.submitOk }, { reply: lane.failed }], []) }, lane.ctx, fakeClock())));
      // Timeout.
      results.push(await videoGen.run({ prompt: 'x', provider: lane.provider }, Object.assign({ _httpDriver: async (req) => { const r = req.method === 'POST' ? lane.submitOk : lane.pending; return { status: r.status, headers: {}, body: JSON.stringify(r.body) }; } }, lane.ctx, fakeClock())));
      // Empty body on download.
      results.push(await videoGen.run({ prompt: 'x', provider: lane.provider }, Object.assign({ _httpDriver: scriptedDriver([{ reply: lane.submitOk }, { reply: lane.done }, { reply: { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(0) } }], []) }, lane.ctx, fakeClock())));
      // No reply at all, with the key in the socket error.
      results.push(await videoGen.run({ prompt: 'x', provider: lane.provider }, Object.assign({ _httpDriver: scriptedDriver([{ reply: new Error('ECONNRESET while sending ' + lane.key) }], []) }, lane.ctx, fakeClock())));
    }
  } finally {
    for (const m of spied) console[m] = saved[m];
  }
  assert.strictEqual(results.length, 10);
  const codes = results.map((r) => r.error);
  assert.deepStrictEqual(codes, ['provider_error', 'provider_error', 'timeout', 'empty_video', 'request_failed', 'provider_error', 'provider_error', 'timeout', 'empty_video', 'request_failed']);
  for (const r of results) {
    const s = JSON.stringify(r);
    assert.ok(s.indexOf('SENTINEL') < 0, 'a result carried the key: ' + s);
    assert.ok(s.indexOf(SK_OR) < 0 && s.indexOf(SK_GO) < 0);
  }
  assert.ok(!logged.some((l) => l.indexOf('SENTINEL') >= 0), 'console saw the key: ' + logged.join('|'));
  assert.ok(/\[key\]/.test(results[0].detail), 'an echoed key is replaced, not passed through: ' + results[0].detail);
});

test('VID8: empty, short and non-MP4 bodies are empty_video and leave no file', async () => {
  const before = filesIn(VIDEOS_DIR).length;
  const run = (body, type) => videoGen.run({ prompt: 'x' }, Object.assign({
    _httpDriver: scriptedDriver([
      { reply: { status: 202, body: { id: 'gen_e', status: 'pending' } } },
      { reply: { status: 200, body: okJob('gen_e') } },
      { reply: { status: 200, headers: { 'content-type': type }, body } },
    ], []),
    _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  const empty = await run(Buffer.alloc(0), 'video/mp4');
  assert.strictEqual(empty.error, 'empty_video', JSON.stringify(empty));
  const short = await run(mp4.subarray(0, 100), 'video/mp4');
  assert.strictEqual(short.error, 'empty_video');
  assert.ok(/video\/mp4/.test(short.detail), 'content-type in detail: ' + short.detail);
  const html = await run(Buffer.from('<html>' + 'x'.repeat(2000) + '</html>'), 'text/html');
  assert.strictEqual(html.error, 'empty_video');
  assert.ok(/text\/html/.test(html.detail), html.detail);
  assert.strictEqual(html.hint, 'The service returned no usable video. Try again or rephrase the prompt.');
  const after = filesIn(VIDEOS_DIR);
  assert.strictEqual(after.length, before, 'nothing written');
  assert.ok(!after.some((f) => /\.part$/.test(f)), 'no .part left behind');
});

// Veo direct: submit → operation not done → done with a sample → bytes.
function veoScript(op, extra) {
  const name = 'models/veo-3.1-fast-generate-preview/operations/' + op;
  const uri = 'https://generativelanguage.googleapis.com/v1beta/files/' + op + ':download?alt=media';
  return [
    { match: { method: 'POST', urlIncludes: '/v1beta/models/' + ((extra && extra.model) || 'veo-3.1-fast') + '-generate-preview:predictLongRunning' }, reply: { status: 200, body: { name } } },
    { match: { method: 'GET', urlIncludes: '/v1beta/' + name }, reply: { status: 200, body: { name, done: false } } },
    { match: { method: 'GET', urlIncludes: '/v1beta/' + name }, reply: { status: 200, body: { name, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } } } },
    { match: { method: 'GET', urlIncludes: uri }, reply: { status: 200, headers: { 'content-type': 'video/mp4' }, body: mp4 } },
  ];
}

test('VID9: google_ai lane - 12 s becomes 8 s and says so, audio:false is reported as always on, full flow', async () => {
  const sink = [];
  const out = await videoGen.run({ prompt: 'rain on a window', duration_s: 12, audio: false, provider: 'google_ai' }, Object.assign({
    _httpDriver: scriptedDriver(veoScript('op1'), sink), _openrouterKey: null, _googleKey: KEY_GO,
  }, fakeClock()));
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(sink.length, 4);
  for (const r of sink) {
    assert.strictEqual(r.headers['x-goog-api-key'], KEY_GO, 'key header on ' + r.url);
    assert.ok(!('authorization' in r.headers), 'no bearer on the google lane');
  }
  const body = JSON.parse(sink[0].body);
  assert.strictEqual(body.instances[0].prompt, 'rain on a window');
  assert.deepStrictEqual(body.parameters, { aspectRatio: '9:16', resolution: '720p', durationSeconds: 8 });
  assert.strictEqual(sink[3].expect, 'binary');
  assert.strictEqual(out.seconds, 8);
  assert.strictEqual(out.provider, 'google_ai');
  assert.strictEqual(out.model, 'veo-3.1-fast');
  assert.ok(/duration shortened to 8 s/.test(out.note), 'note says the clip was shortened: ' + out.note);
  assert.ok(/audio is always on/.test(out.note), 'note says audio stays on: ' + out.note);
  assert.strictEqual(out.cost_usd, 0.8, '8 s at $0.10/s');
  assert.strictEqual(out.cost_estimated, true);
  assert.ok(fs.readFileSync(out.path).equals(mp4));
  // 1080p renders only as an 8 s clip: a 4 s request keeps its length and drops to 720p.
  const sink2 = [];
  const hd = await videoGen.run({ prompt: 'x', duration_s: 4, resolution: '1080p', provider: 'google_ai' }, Object.assign({
    _httpDriver: scriptedDriver(veoScript('op2'), sink2), _openrouterKey: null, _googleKey: KEY_GO,
  }, fakeClock()));
  assert.strictEqual(hd.ok, true, JSON.stringify(hd));
  assert.strictEqual(JSON.parse(sink2[0].body).parameters.resolution, '720p');
  assert.strictEqual(JSON.parse(sink2[0].body).parameters.durationSeconds, 4);
  assert.ok(/resolution set to 720p/.test(hd.note) && /8 s/.test(hd.note), hd.note);
  // An 8 s 1080p request is rendered as asked.
  const sink3 = [];
  const hd8 = await videoGen.run({ prompt: 'x', duration_s: 8, resolution: '1080p', provider: 'google_ai', model: 'veo-3.1' }, Object.assign({
    _httpDriver: scriptedDriver(veoScript('op3', { model: 'veo-3.1' }), sink3), _openrouterKey: null, _googleKey: KEY_GO,
  }, fakeClock()));
  assert.strictEqual(hd8.ok, true, JSON.stringify(hd8));
  assert.strictEqual(JSON.parse(sink3[0].body).parameters.resolution, '1080p');
  assert.strictEqual(hd8.model, 'veo-3.1');
  assert.strictEqual(hd8.cost_usd, 3.2);
  assert.ok(!('note' in hd8));
  // A finished operation that carries an error is the provider's refusal.
  const bad = await videoGen.run({ prompt: 'x', provider: 'google_ai' }, Object.assign({
    _httpDriver: scriptedDriver([
      { reply: { status: 200, body: { name: 'models/veo/operations/op4' } } },
      { reply: { status: 200, body: { name: 'models/veo/operations/op4', done: true, error: { code: 3, message: 'blocked by safety filters' } } } },
    ], []), _openrouterKey: null, _googleKey: KEY_GO,
  }, fakeClock()));
  assert.strictEqual(bad.error, 'provider_error');
  assert.ok(/blocked by safety filters/.test(bad.detail), bad.detail);
  // A finished operation with no sample names the filter reason.
  const filtered = await videoGen.run({ prompt: 'x', provider: 'google_ai' }, Object.assign({
    _httpDriver: scriptedDriver([
      { reply: { status: 200, body: { name: 'models/veo/operations/op5' } } },
      { reply: { status: 200, body: { name: 'models/veo/operations/op5', done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['the prompt describes a real person'] } } } } },
    ], []), _openrouterKey: null, _googleKey: KEY_GO,
  }, fakeClock()));
  assert.strictEqual(filtered.error, 'provider_error');
  assert.ok(/real person/.test(filtered.detail), filtered.detail);
});

test('VID10: estimates when the provider reports no cost - hailuo-3-max $0.64 for 8 s at 768p, Seedance by token, unknown model stays silent', async () => {
  const sink = [];
  const out = await videoGen.run({ prompt: 'x', model: 'minimax/hailuo-3-max' }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_h'), sink), _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(JSON.parse(sink[0].body).resolution, '768p', 'the 720p default moves to the nearest rendered size');
  assert.strictEqual(JSON.parse(sink[0].body).model, 'minimax/hailuo-3-max');
  assert.strictEqual(out.resolution, '768p');
  assert.strictEqual(out.cost_usd, 0.64);
  assert.strictEqual(out.cost_estimated, true);
  assert.ok(/resolution set to 768p/.test(out.note), out.note);
  // Seedance bills W x H x 24 x s / 1024 video tokens.
  const sd = await videoGen.run({ prompt: 'x' }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_s'), []), _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(sd.ok, true);
  assert.strictEqual(sd.cost_estimated, true);
  assert.ok(Math.abs(sd.cost_usd - 1.849) < 0.001, '8 s 720p on seedance-2.5 is about $1.85: ' + sd.cost_usd);
  // A model the table does not know yields no number at all.
  const unknown = await videoGen.run({ prompt: 'x', model: 'vendor/new-model' }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_u'), []), _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(unknown.ok, true);
  assert.ok(!('cost_usd' in unknown) && !('cost_estimated' in unknown), 'silence over a wrong number: ' + JSON.stringify(unknown));
  assert.strictEqual(unknown.model, 'vendor/new-model');
  // The table itself.
  assert.strictEqual(videoGen.estimateCost('kwaivgi/kling-v3.0-std', 8, '720p', true), 1.008);
  assert.strictEqual(videoGen.estimateCost('kwaivgi/kling-v3.0-std', 8, '720p', false), 0.672);
  assert.strictEqual(videoGen.estimateCost('minimax/hailuo-3-max', 8, '480p', true), 0.4);
  assert.strictEqual(videoGen.estimateCost('minimax/hailuo-3', 8, '2K', true), 1.04);
  assert.strictEqual(videoGen.estimateCost('google/veo-3.1-lite', 8, '720p', true), 0.4);
  // 854 x 480 x 24 x 8 / 1024 = 76,860 tokens at $3.5 per million.
  assert.strictEqual(videoGen.estimateCost('bytedance/seedance-2.0-mini', 8, '480p', true), 0.269);
  assert.strictEqual(videoGen.estimateCost('nobody/knows', 8, '720p', true), null);
  // A reported cost wins over the estimate on the same model.
  const reported = await videoGen.run({ prompt: 'x', model: 'minimax/hailuo-3-max' }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_r', { usage: { cost: 0.7 } }), []), _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(reported.cost_usd, 0.7);
  assert.strictEqual(reported.cost_estimated, false);
});

test('VID11: argument validation names the field and the range, before any key or network', async () => {
  let hit = 0;
  const spy = async () => { hit++; return { status: 500, headers: {}, body: '' }; };
  const ctx = { _httpDriver: spy, _openrouterKey: KEY_OR, _googleKey: null };
  const cases = [
    [{ prompt: '   ' }, /prompt/],
    [{ prompt: 'x', duration_s: 2 }, /duration_s.*3 to 30/],
    [{ prompt: 'x', duration_s: 31 }, /duration_s.*3 to 30/],
    [{ prompt: 'x', duration_s: 7.5 }, /duration_s/],
    [{ prompt: 'x', aspect: '4:3' }, /aspect.*9:16, 16:9/],
    [{ prompt: 'x', resolution: '4K' }, /resolution.*480p, 720p, 1080p/],
    [{ prompt: 'x', audio: 'yes' }, /audio must be true or false/],
    [{ prompt: 'x', provider: 'kling' }, /provider.*openrouter, google_ai/],
    [{ prompt: 'x', model: '' }, /model/],
  ];
  for (const [args, re] of cases) {
    const out = await videoGen.run(args, ctx);
    assert.strictEqual(out.ok, false, JSON.stringify(args));
    assert.strictEqual(out.error, 'bad_args', JSON.stringify(args) + ' -> ' + JSON.stringify(out));
    assert.ok(re.test(out.hint), JSON.stringify(args) + ' hint: ' + out.hint);
  }
  assert.strictEqual(hit, 0, 'no network for bad arguments');
  // Seconds are clamped to the model, not refused: 30 s on a 15 s model.
  const sink = [];
  const long = await videoGen.run({ prompt: 'x', duration_s: 30, model: 'kwaivgi/kling-v3.0-pro', resolution: '480p' }, Object.assign({
    _httpDriver: scriptedDriver(seedanceScript('gen_l'), sink), _openrouterKey: KEY_OR, _googleKey: null,
  }, fakeClock()));
  assert.strictEqual(long.ok, true, JSON.stringify(long));
  assert.strictEqual(JSON.parse(sink[0].body).duration, 15);
  assert.strictEqual(JSON.parse(sink[0].body).resolution, '720p');
  assert.ok(/duration shortened to 15 s/.test(long.note) && /resolution set to 720p/.test(long.note), long.note);
  // A key from config is read only after validation passes; the seam is per call.
  assert.strictEqual(typeof videoGen.readOpenrouterKey, 'function');
  assert.strictEqual(videoGen.readGoogleKey(), null, 'the temp home holds no key');
});

// Teardown rides the async queue so it runs AFTER the bodies above, which the
// harness defers to a serial flush: a synchronous teardown would restore HOME
// and remove the temp tree before any run() had executed.
test('VID-teardown: restore HOME + bust caches + remove temp home', async () => {
  process.env.HOME = _origHome;
  for (const p of [VG_PATH, ENV_PATH]) delete require.cache[p];
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

};

// `node tests/suite-19-video-gen.js` runs this suite on its own.
if (require.main === module) {
  const harness = require('./harness.js');
  module.exports({ test: harness.test, skip: harness.skip });
  harness.flushAsyncTests().then(() => {
    const c = harness.counts();
    console.log('\n=== Results: ' + c.passed + ' passed, ' + c.failed + ' failed' + (c.skipped ? ', ' + c.skipped + ' skipped' : '') + ' ===\n');
    process.exit(c.failed > 0 ? 1 : 0);
  });
}
