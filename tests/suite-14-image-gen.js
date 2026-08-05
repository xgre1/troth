// SPDX-License-Identifier: AGPL-3.0-only
// suite-14-image-gen.js — image_generate tool (shared-core/tools/image-gen.js).
//
// Fully OFFLINE + deterministic. The tool's whole network+SSE call is behind an
// injectable driver (ctx._httpDriver); every test here passes a fake driver that
// replays a canned Responses-API SSE stream, so nothing hits the socket or needs
// a real ChatGPT account. HOME is redirected to a throwaway dir so the happy path
// writes into a temp ~/.troth/images we clean up, not the operator's real one.
//
// Coverage:
//   (a) happy path — fake SSE with a valid base64 PNG lands a file, ok:true+path
//   (b) no-source / not-linked — honest structured errors, exact operator hints
//   (e) google-key source — generateContent JSON path: key header, body shape,
//       image landing, upstream-error mapping (see GEM1-GEM3)
//   (c) malformed / errored stream — ok:false, never throws, writes NO file
//   (d) regression — the transport-helper refactor still resolves model/headers
//       the way the chat path relied on (guards the extraction of ensureCodexToken
//       / resolveCodexModel / buildCodexHeaders out of makeCodexOAuthTransport).

module.exports = function run({ test }) {
const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');

// Build a real (tiny 1x1) PNG at runtime so the happy-path asserts on genuine
// PNG bytes rather than a magic blob — no fixture file, no external dependency.
function tinyPngBuffer() {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type), data]);
    // CRC32 over type+data.
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
  ihdr[8] = 8; ihdr[9] = 2;   // 8-bit, RGB
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));  // one red pixel
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Serialize events into a Responses-API SSE text stream (the shape the real
// endpoint emits) so the driver returns exactly what the network would.
function sseFrom(events) {
  return events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e)).join('\n\n') + '\n\n';
}

// A fake driver that ignores the socket and replays a fixed SSE string. Records
// the request so tests can assert body/headers were built correctly.
function fakeDriver(sseText, sink) {
  return async function ({ url, headers, body }) {
    if (sink) { sink.url = url; sink.headers = headers; sink.body = body; }
    return sseText;
  };
}

// Redirect HOME so ~/.troth/images resolves inside a temp dir. image-gen.js
// reads os.homedir() at require time, so we set HOME BEFORE first require and
// bust the cache. Restore + re-bust at the end so later suites see the real path.
const TMP_HOME = path.join(os.tmpdir(), 'troth-imagegen-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
fs.mkdirSync(TMP_HOME, { recursive: true });
const _origHome = process.env.HOME;
process.env.HOME = TMP_HOME;

// Bust the WHOLE chain that captures os.homedir() at require time, in dependency
// order: image-gen → codex-oauth (transport) → codex-token-store + codex-auth.
// If we only bust image-gen + the store, the transport keeps its OLD tokenStore
// reference (bound to the real HOME) and ensureCodexToken reads the wrong file —
// so a token we save into TMP_HOME is invisible and every call looks "not linked".
const IMG_PATH   = require.resolve('../shared-core/tools/image-gen.js');
const TX_PATH    = require.resolve('../shared-core/transports/codex-oauth.js');
const STORE_PATH = require.resolve('../shared-core/codex-token-store.js');
const AUTH_PATH  = require.resolve('../shared-core/codex-auth.js');
for (const p of [IMG_PATH, TX_PATH, STORE_PATH, AUTH_PATH]) delete require.cache[p];
const imageGen   = require('../shared-core/tools/image-gen.js');
const tokenStore = require('../shared-core/codex-token-store.js');

console.log('\nImage generation (image_generate):');

// A live, non-expired token so ensureCodexToken() succeeds without a refresh
// round-trip (refresh would hit the network — not offline). Saved into the
// redirected HOME's ~/.troth/codex-token.json.
function saveLiveToken() {
  tokenStore.save({
    access_token:  'at-test',
    refresh_token: 'rt-test',
    expires_at:    Date.now() + 60 * 60 * 1000,
    account_id:    'acct-test',
  });
}

test('IMG1: schema is an OpenAI function tool named image_generate with required prompt', () => {
  const s = imageGen.schema;
  assert.strictEqual(s.type, 'function');
  assert.strictEqual(s.function.name, 'image_generate');
  assert.deepStrictEqual(s.function.parameters.required, ['prompt']);
  assert.ok(s.function.parameters.properties.prompt, 'prompt param present');
  // size is deliberately NOT advertised (endpoint 400s on unexpected params,
  // tools[0].size unverified live) - the run() pass-through stays covered by IMG2b.
  assert.strictEqual(s.function.parameters.properties.size, undefined, 'size param NOT advertised');
});

test('IMG2: happy path — valid base64 PNG in output_item.done lands a file, ok:true', async () => {
  await Promise.resolve();  // defer token mutation into the serial flush (see IMG-teardown note)
  saveLiveToken();
  const png = tinyPngBuffer();
  const b64 = png.toString('base64');
  const sink = {};
  const sse = sseFrom([
    { type: 'response.image_generation_call.in_progress' },
    { type: 'response.image_generation_call.generating' },
    { type: 'response.output_item.done', item: { type: 'image_generation_call', result: b64 } },
    { type: 'response.completed' },
  ]);
  const out = await imageGen.run({ prompt: 'a red pixel' }, { _httpDriver: fakeDriver(sse, sink) });
  assert.strictEqual(out.ok, true, 'ok true: ' + JSON.stringify(out));
  assert.ok(out.path && out.path.indexOf(path.join('.troth', 'images')) >= 0, 'path under ~/.troth/images');
  assert.strictEqual(out.bytes, png.length, 'byte count matches decoded PNG');
  assert.strictEqual(out.note, 'generated via ChatGPT plan (unofficial route)');
  // File actually exists and is the PNG we sent.
  const onDisk = fs.readFileSync(out.path);
  assert.ok(onDisk.equals(png), 'saved bytes equal the decoded PNG');
  // Request body forwarded the image_generation tool + reused a codex model.
  const reqBody = JSON.parse(sink.body);
  assert.deepStrictEqual(reqBody.tools, [{ type: 'image_generation' }], 'image_generation tool forwarded');
  assert.ok(/^gpt-5/.test(reqBody.model), 'reused a resolved gpt-5* codex model, not a hardcoded new id');
  assert.strictEqual(sink.headers.authorization, 'Bearer at-test', 'reused transport Bearer auth');
  assert.strictEqual(sink.headers['chatgpt-account-id'], 'acct-test', 'reused chatgpt-account-id header');
});

test('IMG2b: size is forwarded only when supplied', async () => {
  await Promise.resolve();
  saveLiveToken();
  const b64 = tinyPngBuffer().toString('base64');
  const sink = {};
  const sse = sseFrom([
    { type: 'response.output_item.done', item: { type: 'image_generation_call', result: b64 } },
    { type: 'response.completed' },
  ]);
  const out = await imageGen.run({ prompt: 'sized', size: '1024x1024' }, { _httpDriver: fakeDriver(sse, sink) });
  assert.strictEqual(out.ok, true);
  const reqBody = JSON.parse(sink.body);
  assert.strictEqual(reqBody.tools[0].size, '1024x1024', 'size rides the image_generation tool when set');
});

test('IMG3: no source at all is an honest error; explicit chatgpt keeps the link hint', async () => {
  await Promise.resolve();
  // _googleKey/_codexToken: null pin "nothing configured" PER CALL - async
  // test bodies interleave in this harness, so BOTH shared stores race across
  // tests (IMG3 read GEM1's env key; IMG4's saveLiveToken landed between
  // IMG3's two calls). The ctx seams make the scenario deterministic.
  let out, threw = false;
  try { out = await imageGen.run({ prompt: 'x' }, { _httpDriver: fakeDriver('', {}), _googleKey: null, _codexToken: null }); }
  catch (_) { threw = true; }
  assert.strictEqual(threw, false, 'run must never throw');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'no_image_source');
  assert.strictEqual(out.hint, 'Link ChatGPT in Settings or add a Google AI key - either one enables images.');
  // Pinning the plan explicitly still yields the operator-facing link hint.
  const pinned = await imageGen.run({ prompt: 'x', source: 'chatgpt' }, { _httpDriver: fakeDriver('', {}), _googleKey: null, _codexToken: null });
  assert.strictEqual(pinned.ok, false);
  assert.strictEqual(pinned.error, 'chatgpt_sub not linked');
  assert.strictEqual(pinned.hint, 'Link ChatGPT in Settings to generate images with your plan.');
});

test('IMG4: malformed / errored stream — ok:false, no throw, no file written', async () => {
  await Promise.resolve();
  saveLiveToken();
  // (i) response.failed error event.
  const errSse = sseFrom([
    { type: 'response.failed', error: { message: 'content policy' } },
  ]);
  let out, threw = false;
  try { out = await imageGen.run({ prompt: 'boom' }, { _httpDriver: fakeDriver(errSse, {}) }); }
  catch (_) { threw = true; }
  assert.strictEqual(threw, false, 'run must not throw on error stream');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'generation_failed');
  assert.ok(out.detail && /content policy/.test(out.detail), 'surfaces upstream message');
  // A failed run returns NO path — the file-write branch is only reached on
  // success. (We assert on the return contract, not a shared dir count: the
  // happy-path tests share ~/.troth/images, so a global file count would race.)
  assert.ok(!('path' in out), 'error result carries no saved path');
  // (ii) garbage / no image event → structured no_image_in_stream.
  const junk = await imageGen.run({ prompt: 'junk' }, { _httpDriver: fakeDriver('event: ping\ndata: not-json\n\n', {}) });
  assert.strictEqual(junk.ok, false);
  assert.strictEqual(junk.error, 'no_image_in_stream');
  assert.ok(!('path' in junk), 'no-image result carries no saved path');
});

test('IMG5: bad_args — empty prompt returns ok:false without touching the network', async () => {
  await Promise.resolve();
  saveLiveToken();
  let hit = false;
  const out = await imageGen.run({ prompt: '   ' }, { _httpDriver: async () => { hit = true; return ''; } });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'bad_args');
  assert.strictEqual(hit, false, 'must not call the driver for a bad prompt');
});

// --- REGRESSION: transport-helper refactor -------------------------------
// The image tool imports ensureCodexToken / resolveCodexModel / buildCodexHeaders
// / codexUrl that were extracted OUT of makeCodexOAuthTransport. Assert those
// helpers behave the way the existing chat path depends on, so the refactor
// stays behavior-identical for chat.
test('IMG6: transport shared helpers unchanged (model guard, header set, url join)', () => {
  delete require.cache[require.resolve('../shared-core/transports/codex-oauth.js')];
  const cx = require('../shared-core/transports/codex-oauth.js');
  // Model guard: plain gpt-5* honored; codex/local ids fall back to default.
  assert.strictEqual(cx.resolveCodexModel('gpt-5.5', null), 'gpt-5.5', 'plain gpt-5.5 honored');
  assert.strictEqual(cx.resolveCodexModel('gpt-5.2-codex', null), cx.DEFAULT_MODEL, 'codex id rejected → default');
  assert.strictEqual(cx.resolveCodexModel('Qwen3.6-35B', null), cx.DEFAULT_MODEL, 'local id rejected → default');
  // Header set: Bearer + account id + the load-bearing beta header.
  const h = cx.buildCodexHeaders({ access_token: 'AT', account_id: 'A1' }, 'BODY', 'sid', 'cid');
  assert.strictEqual(h.authorization, 'Bearer AT');
  assert.strictEqual(h['chatgpt-account-id'], 'A1');
  assert.strictEqual(h['openai-beta'], cx.OPENAI_BETA);
  // The originator is operator-supplied (see shared-core/codex-auth.js), so
  // whatever is configured here is what must reach the header set.
  assert.strictEqual(h['originator'], cx.originator() || undefined);
  assert.strictEqual(h['accept'], 'text/event-stream');
  // No account id → header omitted (matches original conditional).
  const h2 = cx.buildCodexHeaders({ access_token: 'AT' }, 'B', 's', 'c');
  assert.ok(!('chatgpt-account-id' in h2), 'account-id header omitted when token has none');
  // URL join keeps /backend-api (the bug the concatenation fixed).
  const u = cx.codexUrl(cx.DEFAULT_BASE, cx.DEFAULT_PATH);
  assert.strictEqual(u.pathname, '/backend-api/codex/responses');
});

// --- Google AI (Gemini) source -------------------------------------------
// Same offline discipline: a fake driver returns a canned generateContent JSON
// document. The key rides the ctx._googleKey seam (NOT process.env / a temp
// config): async test bodies interleave in this harness, so shared-env
// mutation races across tests. readGoogleKey()'s config/env fallback itself
// is pure sync fs read - covered implicitly by the seam default path.

test('GEM1: google source - canned generateContent JSON lands the image file', async () => {
  await Promise.resolve();
  const png = tinyPngBuffer();
  const sink = {};
  const fake = async (req) => {
    Object.assign(sink, req);
    return JSON.stringify({
      candidates: [{ content: { parts: [
        { text: 'here you go' },
        { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
      ] } }],
    });
  };
  const out = await imageGen.run({ prompt: 'a gem', source: 'google' }, { _httpDriver: fake, _googleKey: 'test-key-123' });
  assert.strictEqual(out.ok, true, 'ok result: ' + JSON.stringify(out));
  assert.strictEqual(out.source, 'google');
  assert.ok(String(sink.url).indexOf(':generateContent') !== -1, 'hits generateContent');
  assert.strictEqual(sink.headers['x-goog-api-key'], 'test-key-123', 'key rides the header');
  const body = JSON.parse(sink.body);
  assert.deepStrictEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE'], 'asks for an image modality');
  assert.ok(fs.existsSync(out.path), 'file written');
  assert.ok(fs.readFileSync(out.path).equals(png), 'exact png bytes on disk');
});

test('GEM2: google source without a key is an honest structured error, no network', async () => {
  await Promise.resolve();
  let hit = false;
  const out = await imageGen.run({ prompt: 'x', source: 'google' },
    { _httpDriver: async () => { hit = true; return ''; }, _googleKey: null });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'google_key_missing');
  assert.strictEqual(hit, false, 'must not call the driver without a key');
});

test('GEM3: google upstream error -> generation_failed with detail, no file', async () => {
  await Promise.resolve();
  const out = await imageGen.run({ prompt: 'x', source: 'google' },
    { _httpDriver: async () => JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }), _googleKey: 'k3' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'generation_failed');
  assert.ok(/quota exceeded/.test(out.detail || ''), 'surfaces the upstream message');
  assert.ok(!('path' in out), 'no saved path on error');
});

// Cleanup MUST run AFTER the async bodies above, not at registration time. This
// harness invokes each test fn synchronously and defers promise-returning bodies
// to a serial flush at the end — so a synchronous teardown here would restore
// HOME and delete TMP_HOME (with the saved token) BEFORE those deferred run()
// calls execute, making them see the wrong home / no token. Registering teardown
// as the LAST promise-returning test queues it behind every other IMG test, so it
// fires during flush after they complete.
test('IMG-teardown: restore HOME + bust caches + remove temp home', async () => {
  process.env.HOME = _origHome;
  for (const p of [IMG_PATH, TX_PATH, STORE_PATH, AUTH_PATH]) delete require.cache[p];
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

};
