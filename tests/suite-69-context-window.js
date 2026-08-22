// SPDX-License-Identifier: AGPL-3.0-only
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const router = require(path.join(ROOT, 'proxy', 'modules', 'router.js'));

console.log('\nContext window (CTX):');

test('CTX-1: a [1m] model id means the client believes a million', () => {
  assert.strictEqual(router.believedContextWindow('claude-opus-5[1m]', null), 1000000);
  assert.strictEqual(router.believedContextWindow('claude-sonnet-4-6[1m]', null), 1000000);
});

test('CTX-2: the 1M beta header means the same, without the suffix', () => {
  assert.strictEqual(
    router.believedContextWindow('claude-sonnet-4-6', { 'anthropic-beta': 'context-1m-2025-08-07' }),
    1000000);
});

test('CTX-3: a plain id falls to the registry default, never to a guess', () => {
  assert.strictEqual(router.believedContextWindow('claude-opus-5', null), 200000);
  assert.strictEqual(router.believedContextWindow('claude-sonnet-4-6', { 'anthropic-beta': 'tools-2024' }), 200000);
});

test('CTX-4: a dated vendor id resolves by family, not by exact key', () => {
  assert.strictEqual(router.effectiveLimitFor('claude-sonnet-4-6-20251101'), 1000000);
  assert.strictEqual(router.effectiveLimitFor('claude-haiku-4-5-20251001'), 200000);
});


test('CTX-6: a vendor-prefixed hosted id is never mistaken for a local file', () => {
  assert.ok(router.effectiveLimitFor('openai/gpt-oss-120b') >= 128000);
  assert.ok(router.effectiveLimitFor('minimax/minimax-m2.5') >= 1000000);
});

test('CTX-7: an unknown id keeps the conservative default', () => {
  assert.strictEqual(router.effectiveLimitFor('nobody-ships-this-model'), 128000);
});

test('CTX-8: every counted field is scaled, by the same ratio', () => {
  const u = { input_tokens: 60000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 10000, output_tokens: 500 };
  router.scaleUsage(u, 'gpt-5.6-sol', 1000000);
  const ratio = 1000000 / router.effectiveLimitFor('gpt-5.6-sol');
  assert.strictEqual(u.input_tokens, Math.ceil(60000 * ratio));
  assert.strictEqual(u.cache_read_input_tokens, Math.ceil(40000 * ratio));
  assert.strictEqual(u.cache_creation_input_tokens, Math.ceil(10000 * ratio));
  assert.strictEqual(u.output_tokens, 500, 'output is not part of the input budget');
});

test('CTX-9: the believed window moves the ratio — it is not a constant', () => {
  const at200k = { input_tokens: 100000 };
  const at1m   = { input_tokens: 100000 };
  router.scaleUsage(at200k, 'gpt-5.6-sol', 200000);
  router.scaleUsage(at1m,   'gpt-5.6-sol', 1000000);
  assert.ok(at1m.input_tokens > at200k.input_tokens * 4,
    'a [1m] client must report ~5x what a 200K client does for the same lane');
});

test('CTX-10: no response exit ships an unscaled usage envelope', () => {
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  const scaled = (src.match(/scaleUsage\(/g) || []).length;
  assert.ok(scaled >= 5, 'expected every response exit to scale usage, found ' + scaled);
  assert.ok(!/usage\.input_tokens\s*=\s*scaleTokens\(/.test(src),
    'input_tokens scaled alone — the cached fields would stay raw');
});

test('CTX-11: a fully cached turn is still scaled', () => {
  const u = { input_tokens: 0, cache_read_input_tokens: 180000 };
  router.scaleUsage(u, 'gpt-5.6-sol', 1000000);
  assert.ok(u.cache_read_input_tokens > 180000,
    'cache_read must be scaled even when input_tokens is 0');
});

test('CTX-12: an upstream SSE stream is scaled inside its events', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"kimi-for-coding","usage":{"input_tokens":50000,"cache_read_input_tokens":30000}}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n');
  const out = router.scaleUsageInSSE(sse, 'kimi-for-coding', 1000000);
  const ev = JSON.parse(out.split('\n')[1].slice(6));
  const ratio = 1000000 / router.effectiveLimitFor('kimi-for-coding');
  assert.strictEqual(ev.message.usage.input_tokens, Math.ceil(50000 * ratio));
  assert.strictEqual(ev.message.usage.cache_read_input_tokens, Math.ceil(30000 * ratio));
  assert.ok(out.startsWith('event: message_start'), 'wire shape must survive');
  assert.ok(out.includes('event: message_stop'), 'events without usage pass through');
});

test('CTX-13: no exit gates scaling on input_tokens being non-zero', () => {
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  assert.ok(!/usage\s*&&\s*\w+\.usage\.input_tokens\s*&&/.test(src),
    'a truthiness gate on input_tokens skips fully cached turns');
});

const modelContext = require(path.join(ROOT, 'shared-core', 'model-context.js'));
const os = require('os');
const GB = 1024 * 1024 * 1024;

function ggufBytes(entries) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); };
  const out = [Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(entries.length)];
  for (const [key, type, value] of entries) {
    out.push(str(key), u32(type));
    if (type === 8) out.push(str(value));
    else if (type === 4) out.push(u32(value));
    else if (type === 9) {
      out.push(u32(8), u64(value.length));
      for (const s of value) out.push(str(s));
    }
  }
  return Buffer.concat(out);
}

function writeModel(dir, name, trained) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, ggufBytes([
    ['tokenizer.ggml.tokens', 9, ['a', 'bb', 'ccc']],
    ['general.name', 8, 'x'.repeat(4096)],
    ['general.architecture', 8, 'test'],
    ['test.context_length', 4, trained],
    ['test.block_count', 4, 32],
    ['test.embedding_length', 4, 4096],
    ['test.attention.head_count', 4, 32],
    ['test.attention.head_count_kv', 4, 8]
  ]));
  return p;
}

const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-ctx-'));
const MODEL = writeModel(FIXTURES, 'test-model.gguf', 32768);

test('CTX-14: metadata survives the keys the sizer does not want', () => {
  const meta = modelContext.ggufMetadata(MODEL);
  assert.strictEqual(modelContext.trainedContext(meta), 32768,
    'a string or array stepped over by the wrong length desynchronises the cursor');
  assert.strictEqual(modelContext.kvBytesPerToken(meta), 131072);
});

test('CTX-15: a model gets its trained window when the machine can hold it', () => {
  const r = modelContext.chooseContextSize(MODEL, { total_bytes: 24 * GB });
  assert.strictEqual(r.size, 32768);
  assert.strictEqual(r.source, 'model');
});

test('CTX-16: the window follows total memory, not what is momentarily free', () => {
  const small = modelContext.chooseContextSize(MODEL, { total_bytes: 6 * GB });
  assert.ok(small.size < 32768 && small.size >= 4096, 'must scale down, not collapse');
  assert.strictEqual(small.source, 'memory');
  const again = modelContext.chooseContextSize(MODEL, { total_bytes: 6 * GB });
  assert.strictEqual(again.size, small.size);
});

test('CTX-17: the weights are charged against the budget, not ignored', () => {
  const light = modelContext.chooseContextSize(MODEL, { total_bytes: 8 * GB, model_bytes: 0 });
  const heavy = modelContext.chooseContextSize(MODEL, { total_bytes: 8 * GB, model_bytes: 3 * GB });
  assert.ok(heavy.size < light.size,
    'weights are resident once loaded; a budget that ignores them over-commits');
});

test('CTX-18: an operator value outranks every derivation', () => {
  assert.deepStrictEqual(
    modelContext.chooseContextSize(MODEL, { explicit: 65536, total_bytes: 4 * GB }),
    { size: 65536, source: 'operator' });
});

test('CTX-19: unreadable metadata lands on the floor, never on nothing', () => {
  const r = modelContext.chooseContextSize(path.join(FIXTURES, 'absent.gguf'), {});
  assert.strictEqual(r.size, 4096);
  assert.strictEqual(r.source, 'fallback');
});

test('CTX-20: a machine smaller than its model still yields a loadable size', () => {
  const r = modelContext.chooseContextSize(MODEL, { total_bytes: 2 * GB, model_bytes: 4 * GB });
  assert.strictEqual(r.size, 4096, 'a negative budget must not become a negative window');
});

const { execFileSync } = require('child_process');

function firstAnswerAfterRestart(cacheEndpoints, model, queryId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-home-'));
  try {
    fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
    fs.writeFileSync(path.join(home, '.troth', 'config.json'), JSON.stringify({
      providers: { local: { enabled: true, host: '127.0.0.1', port: 1, model } }
    }));
    fs.writeFileSync(path.join(home, '.troth', 'context-windows.json'), JSON.stringify({
      saved_at: Date.now(), endpoints: cacheEndpoints, catalogue: {}
    }));
    const out = execFileSync(process.execPath, ['-e',
      'const r = require(process.argv[1]); console.log("=" + r.effectiveLimitFor(process.argv[2]));',
      path.join(ROOT, 'proxy', 'modules', 'router.js'), queryId || model
    ], { env: Object.assign({}, process.env, { HOME: home }), encoding: 'utf8', timeout: 30000 });
    const line = out.trim().split('\n').filter((l) => l.charAt(0) === '=').pop();
    return parseInt(String(line).slice(1), 10);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
}

const FRESH = () => Date.now();
const STALE = () => Date.now() - 25 * 60 * 60 * 1000;

test('CTX-5: a local model file gets the local window, not a hosted default', () => {
  const local = firstAnswerAfterRestart({}, 'sandbox.gguf');
  assert.strictEqual(local, 16384,
    'a .gguf id must resolve through the local lane, not through the hosted default');
  assert.notStrictEqual(local, 128000);
});

test('CTX-21: a learned window answers the first turn after a restart', () => {
  const answer = firstAnswerAfterRestart(
    { 'local|127.0.0.1:1|seeded.gguf': { n: 98765, at: FRESH() } }, 'seeded.gguf');
  assert.strictEqual(answer, 98765, 'a restart must not re-scale the first turn against a placeholder');
});

test('CTX-22: an entry past its life is refused, not served', () => {
  const answer = firstAnswerAfterRestart(
    { 'local|127.0.0.1:1|seeded.gguf': { n: 98765, at: STALE() } }, 'seeded.gguf');
  assert.notStrictEqual(answer, 98765, 'a stale window would outlive the server that reported it');
});

test('CTX-23: another model on the same endpoint inherits nothing', () => {
  const answer = firstAnswerAfterRestart(
    { 'local|127.0.0.1:1|other.gguf': { n: 98765, at: FRESH() } }, 'seeded.gguf');
  assert.notStrictEqual(answer, 98765, 'the window belongs to the loaded model, not to the address');
});

const { getCatalog } = require(path.join(ROOT, 'proxy', 'modules', 'catalog.js'));

const ANSWERED_BY_CATALOGUE = [
  'kimi-k2.5',
  'Qwen/Qwen3-235B-A22B',
  'meta-llama/Llama-4-Maverick'
];

test('CTX-24: every hosted model Settings offers has a window behind it', () => {
  const cat = getCatalog() || {};
  const missing = [];
  Object.keys(cat).forEach((provider) => {
    if (provider === 'local') return;
    ((cat[provider] || {}).models || []).forEach((m) => {
      if (ANSWERED_BY_CATALOGUE.indexOf(m.id) !== -1) return;
      if (router.resolveContextWindow(m.id).source === 'default') missing.push(provider + '/' + m.id);
    });
  });
  assert.deepStrictEqual(missing, [],
    'offered in a dropdown, measured against a placeholder: ' + missing.join(', '));
});

test('CTX-25: a local model is measured by the server, never by a catalogue', () => {
  const cat = getCatalog() || {};
  const locals = ((cat.local || {}).models || []).map((m) => m.id);
  assert.ok(locals.length, 'the catalog offers local models; this asserts what they resolve to');
  const saved = router.__test.providers.local;
  try {
    locals.forEach((id) => {
      router.__test.providers.local = { enabled: true, host: '127.0.0.1', port: 1, model: id };
      const got = router.resolveContextWindow(id).source;
      assert.ok(got === 'endpoint' || got === 'fallback' || got === 'operator' || got === 'declared',
        id + ' resolved through "' + got + '" instead of the local lane');
    });
  } finally {
    router.__test.providers.local = saved;
  }
});

const endpointWindow = require(path.join(ROOT, 'shared-core', 'endpoint-window.js'));

test('CTX-26: a window is read from whichever shape the server publishes', () => {
  assert.strictEqual(
    endpointWindow.windowFromPayload('/props', { default_generation_settings: { n_ctx: 32768 } }), 32768);
  assert.strictEqual(
    endpointWindow.windowFromPayload('/api/v0/models', { data: [{ loaded_context_length: 262144 }] }), 262144);
  assert.strictEqual(
    endpointWindow.windowFromPayload('/v1/models', { data: [{ max_model_len: 131072 }] }), 131072);
  assert.strictEqual(
    endpointWindow.windowFromPayload('/api/tags', { models: [{ details: { context_length: 8192 } }] }), 8192);
  assert.strictEqual(
    endpointWindow.windowFromPayload('/v1/model', { max_seq_len: 4096 }), 4096);
  assert.strictEqual(endpointWindow.windowFromPayload('/v1/models', { data: [{ id: 'x' }] }), 0);
});

function localLaneUsage() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-lane-'));
  const NL = String.fromCharCode(10, 10);
  const script = [
    "const http=require('http');",
    "const {makeLlamaCppTransport}=require(process.argv[1]+'/shared-core/transports/llamacpp.js');",
    "const NL=String.fromCharCode(10,10);",
    "const seen=[];",
    "const srv=http.createServer((req,res)=>{",
    "  if(req.method==='GET'&&req.url==='/props'){res.writeHead(200,{'content-type':'application/json'});",
    "    return res.end(JSON.stringify({default_generation_settings:{n_ctx:8192}}));}",
    "  let b='';req.on('data',c=>b+=c);req.on('end',()=>{seen.push(b);",
    "    let asked=false;try{asked=!!JSON.parse(b).stream_options.include_usage;}catch(_){}",
    "    res.writeHead(200,{'content-type':'text/event-stream'});",
    "    res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model:'m',system_fingerprint:'b9957',choices:[{index:0,delta:{content:'ok'}}]})+NL);",
    "    if(asked)res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model:'m',system_fingerprint:'b9957',choices:[],usage:{completion_tokens:5,prompt_tokens:54,total_tokens:59,prompt_tokens_details:{cached_tokens:50}},timings:{cache_n:50,prompt_n:4}})+NL);",
    "    res.write('data: [DONE]'+NL);res.end();});",
    "});",
    "srv.listen(0,'127.0.0.1',async()=>{",
    "  const port=srv.address().port;",
    "  const t=makeLlamaCppTransport({host:'http://127.0.0.1:'+port,model:'m'});",
    "  const run=async()=>{const s=await t.stream({system:'s',user:'u',options:{max_tokens:4}});",
    "    let u=null;for await(const c of s){if(c&&c.usage)u=c.usage;}return u;};",
    "  const first=await run();",
    "  await new Promise(r=>setTimeout(r,700));",
    "  const second=await run();",
    "  const bare=await new Promise(r=>{const body=JSON.stringify({model:'m',messages:[{role:'user',content:'u'}],stream:true});",
    "    const rq=http.request({host:'127.0.0.1',port:port,path:'/v1/chat/completions',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},rs=>{let x='';rs.on('data',c=>x+=c);rs.on('end',()=>r(x));});rq.end(body);});",
    "  console.log('='+JSON.stringify({asked:seen[0].indexOf('include_usage')>=0,first,second,",
    "    usageWhenNotAsked:bare.split(String.fromCharCode(10)).filter(l=>l.indexOf('\"usage\"')>=0).length}));",
    "  process.exit(0);",
    "});"
  ].join('');
  try {
    const out = execFileSync(process.execPath, ['-e', script, ROOT], {
      env: Object.assign({}, process.env, { HOME: home }), encoding: 'utf8', timeout: 30000
    });
    const line = out.trim().split('\n').filter((l) => l.charAt(0) === '=').pop();
    return JSON.parse(String(line).slice(1));
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
}

test('CTX-27: the local lane asks for token accounting, and reports what it used', () => {
  const r = localLaneUsage();
  assert.strictEqual(r.usageWhenNotAsked, 0,
    'a streaming server reports nothing unless the request asks — this is what made the meter blank');
  assert.ok(r.asked, 'so the request has to ask, on every turn');
  assert.ok(r.first, 'the turn must carry usage');
  assert.strictEqual(r.first.context_used, 54);
});

test('CTX-28: the denominator comes from the server, once it has answered', () => {
  const r = localLaneUsage();
  assert.strictEqual(r.second.context_window, 8192,
    'the window a surface divides by must be the one the server was started with');
  assert.strictEqual(r.second.context_used, 54);
});

const anthropicTransport = require(path.join(ROOT, 'shared-core', 'transports', 'anthropic.js'));
const codexTransport = require(path.join(ROOT, 'shared-core', 'transports', 'codex-oauth.js'));

test('CTX-29: the Anthropic lane counts the cached prompt, not just the new part', () => {
  const events = [];
  anthropicTransport.parseFrame(
    'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 300, cache_read_input_tokens: 180000, cache_creation_input_tokens: 20000 }
      }
    }),
    (e) => events.push(e));
  const u = events.map((e) => e.usage).filter(Boolean)[0];
  assert.ok(u, 'message_start must carry usage');
  assert.strictEqual(u.context_used, 200300);
  assert.strictEqual(u.input_tokens, 300);
});

test('CTX-30: the Codex lane reports what the response says it consumed', () => {
  const events = [];
  codexTransport.parseFrame(
    'event: response.completed\ndata: ' + JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 41000, output_tokens: 250 } }
    }),
    (e) => events.push(e));
  const u = events.map((e) => e.usage).filter(Boolean)[0];
  assert.ok(u, 'response.completed must carry usage when the response states it');
  assert.strictEqual(u.context_used, 41000);
  assert.strictEqual(u.output_tokens, 250);
  assert.ok(events.some((e) => e.done), 'the stream must still end');
});

test('CTX-31: a response that states no usage emits none', () => {
  const events = [];
  codexTransport.parseFrame(
    'event: response.completed\ndata: {"type":"response.completed"}',
    (e) => events.push(e));
  assert.deepStrictEqual(events, [{ done: true }]);
});

};
