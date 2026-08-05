#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// substrate-eval v2 — measures substrate-as-COLLABORATOR, not as
// content-policy filter. Replaces the v1 "identity adherence" /
// "cross-lingual escape" benchmarks (those measured the wrong thing).
//
// Six benchmarks:
//   1. Memory recall (kept from v1: substrate prefix injection lifts recall)
//   2. Working-context recall (substrate remembers project/setup details)
//   3. Voice persistence (substrate's stated style is honored in output)
//   4. Style consistency across same-prompt repeats (cosine similarity)
//   5. Engram retrieval precision (kept from v1, post-RRF fix)
//   6. Latency (kept from v1)
//
// Output: benchmarks/results/substrate-eval-v2-<ts>.{json,md}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const cfg    = require('../shared-core/transport-config.js');
const engram = require('../shared-core/engram.js');

const HOST  = process.env.TROTH_LLAMACPP_HOST  || cfg.llamacppHost();
const MODEL = process.env.TROTH_LLAMACPP_MODEL || cfg.llamacppModel();
const AGENT = 'bench-v2-' + Date.now();

function postJson(host, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, host);
    const data = JSON.stringify(body);
    const req = http.request({
      method: 'POST', hostname: u.hostname, port: u.port,
      path: u.pathname + u.search,
      headers: { 'content-type':'application/json', 'content-length': Buffer.byteLength(data), 'connection':'close' },
      agent: false, timeout: timeoutMs || 60000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

async function chat(promptText, opts) {
  opts = opts || {};
  const messages = [];
  if (opts.system) messages.push({ role:'system', content: opts.system });
  messages.push({ role:'user', content: promptText });
  const body = {
    model: MODEL, messages, stream: false,
    n_predict: opts.max_tokens || 120,
    temperature: opts.temperature != null ? opts.temperature : 0.5,
    chat_template_kwargs: { enable_thinking: false }
  };
  const r = await postJson(HOST, '/v1/chat/completions', body, 60000);
  return (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
}

// ── Substrate identity used across all benches ──────────────────────────

const SUBSTRATE_PREFERENCES = [
  'I am the operator\'s research collaborator on the troth substrate-as-entity project.',
  'I prefer concise, direct technical answers — terse over verbose. Maximum 60 words per reply.',
  'I cite the specific file path or function when discussing code in this repo.',
  'I push back on weak reasoning instead of agreeing politely.'
];
const SUBSTRATE_CONTEXT = [
  'troth is built in Node.js, single-file SQLite L1 ledger, plug-in transports for llama.cpp + Ollama + Anthropic.',
  'The operator runs a local llama.cpp inference server on their dev machine.',
  'Active focus this week: substrate primitives (engram, chameleon, dialogue, KV state).',
  'The operator prefers tabs in indented code blocks but matches existing file conventions.'
];

function composeIdentityPrefix(extraMemories) {
  const lines = [];
  lines.push('You are the substrate — the persistent collaborator the user has been working with. You are NOT a fresh-start chatbot. Stay in character.');
  lines.push('');
  lines.push('Who you are:');
  for (const p of SUBSTRATE_PREFERENCES) lines.push('  - ' + p);
  lines.push('');
  lines.push('What you know about the work:');
  for (const c of SUBSTRATE_CONTEXT) lines.push('  - ' + c);
  if (extraMemories && extraMemories.length) {
    lines.push('');
    lines.push('Relevant memories surfaced for this turn:');
    for (const m of extraMemories) lines.push('  - ' + m);
  }
  return lines.join('\n');
}

// ── Bench 1: Memory recall (kept from v1 — was +70pp) ──────────────────

async function benchMemoryRecall() {
  const cwd = '/tmp/bench-mem-' + Date.now();
  const planted = [
    { stmt: 'The operator prefers tabs over spaces in source code',          q: 'What does the operator prefer for indentation?',         must: /tabs/i },
    { stmt: 'The operator works on a Rust project named argus',              q: 'What project is the operator working on?',                must: /argus/i },
    { stmt: 'The operator owns a beagle named Pepper',                   q: 'What is the operator\'s dog named?',                      must: /Pepper/i },
    { stmt: 'The operator lives in city Foo',                          q: 'Where does the operator live?',                           must: /Foo/i },
    { stmt: 'The operator prefers helix editor for code',                    q: 'Which editor does the operator use?',                     must: /helix/i },
    { stmt: 'The operator has a meeting every Tuesday at 10 AM',             q: 'When is the operator\'s weekly meeting?',                 must: /Tuesday|10/i },
    { stmt: 'the operator\'s monthly cloud budget is 500 dollars',           q: 'What is the operator\'s monthly cloud budget?',           must: /500/ },
    { stmt: 'The operator is fluent in three languages: Alpha, Beta, and Gamma',          q: 'How many languages does the operator speak?',                must: /Alpha|Gamma/i }
  ];
  for (const p of planted) {
    let emb = null;
    try { emb = await engram.embedRequest(HOST, p.stmt); } catch (_) {}
    engram.recordEngram({ agent_id: AGENT, cwd, statement: p.stmt, embedding: emb, salience: 1.0, source: 'bench' });
  }
  let baseHits = 0, subHits = 0;
  const detail = [];
  for (const p of planted) {
    const b = await chat(p.q);
    const items = await engram.retrieveRelevant({ agent_id: AGENT, cwd, query: p.q, k: 5, embedding_host: HOST });
    const sys = composeIdentityPrefix(items.map(i => i.statement));
    const s = await chat(p.q, { system: sys });
    const bH = p.must.test(b) ? 1 : 0;
    const sH = p.must.test(s) ? 1 : 0;
    baseHits += bH; subHits += sH;
    detail.push({ q: p.q, bHit: !!bH, sHit: !!sH, s_text: s.slice(0,100) });
  }
  return {
    n: planted.length,
    baseline_recall:  baseHits / planted.length,
    substrate_recall: subHits  / planted.length,
    delta: (subHits - baseHits) / planted.length,
    detail
  };
}

// ── Bench 2: Working-context recall ────────────────────────────────────

async function benchContextRecall() {
  // Without substrate, model knows nothing about the project. With
  // substrate, it should recall project + tech stack details.
  const probes = [
    { q: 'What language is troth written in?',         must: /node|javascript/i },
    { q: 'What database does troth use for L1?',       must: /sqlite/i },
    { q: 'What model is loaded on the operator\'s local server?',  must: /gemma|31B/i },
    { q: 'What is the operator\'s active focus this week?',      must: /engram|chameleon|substrate|primitive|learning|KV/i },
    { q: 'What inference engines does troth support?', must: /llama|ollama|anthropic/i }
  ];
  let baseHits = 0, subHits = 0;
  const detail = [];
  const sys = composeIdentityPrefix();
  for (const p of probes) {
    const b = await chat(p.q);
    const s = await chat(p.q, { system: sys });
    const bH = p.must.test(b) ? 1 : 0;
    const sH = p.must.test(s) ? 1 : 0;
    baseHits += bH; subHits += sH;
    detail.push({ q: p.q, bHit: !!bH, sHit: !!sH, s_text: s.slice(0,100) });
  }
  return {
    n: probes.length,
    baseline_recall:  baseHits / probes.length,
    substrate_recall: subHits  / probes.length,
    delta: (subHits - baseHits) / probes.length,
    detail
  };
}

// ── Bench 3: Voice persistence ─────────────────────────────────────────

// Substrate states "I prefer concise, direct technical answers — terse
// over verbose. Maximum 60 words per reply." Test if substrate-prefixed
// outputs are actually shorter than baseline outputs.

async function benchVoicePersistence() {
  const probes = [
    'Explain how a hash map works.',
    'Describe what a TCP handshake does.',
    'What is dependency injection?',
    'Explain cache invalidation.',
    'What is the role of a load balancer?'
  ];
  const sys = composeIdentityPrefix();
  let baseWords = 0, subWords = 0;
  const detail = [];
  for (const p of probes) {
    const b = await chat(p);
    const s = await chat(p, { system: sys });
    const bw = b.split(/\s+/).filter(Boolean).length;
    const sw = s.split(/\s+/).filter(Boolean).length;
    baseWords += bw; subWords += sw;
    detail.push({ q: p, baseline_words: bw, substrate_words: sw, baseline: b.slice(0,80), substrate: s.slice(0,80) });
  }
  const baseAvg = baseWords / probes.length;
  const subAvg  = subWords  / probes.length;
  return {
    n: probes.length,
    baseline_avg_words:  baseAvg,
    substrate_avg_words: subAvg,
    word_reduction_pct:  ((baseAvg - subAvg) / baseAvg) * 100,
    substrate_under_60w: detail.filter(d => d.substrate_words <= 60).length,
    detail
  };
}

// ── Bench 4: Style consistency (multiple same-prompt) ──────────────────

async function benchStyleConsistency() {
  const probe = 'Give a one-sentence description of yourself and what you are working on.';
  const sys = composeIdentityPrefix();
  const baseOuts = [];
  const subOuts = [];
  for (let i = 0; i < 4; i++) {
    baseOuts.push(await chat(probe, { temperature: 0.7 }));
    subOuts.push(await chat(probe, { system: sys, temperature: 0.7 }));
  }
  // Compute pairwise embedding cosine within each group
  async function avgPairCos(strs) {
    const embs = [];
    for (const s of strs) { try { const e = await engram.embedRequest(HOST, s); if (Array.isArray(e) && e.length) embs.push(e); } catch (_) {} }
    if (embs.length < 2) return null;
    const cos = (a, b) => { let d=0,na=0,nb=0; for (let i=0;i<Math.min(a.length,b.length);i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return na && nb ? d/(Math.sqrt(na)*Math.sqrt(nb)) : 0; };
    const sims = []; for (let i=0;i<embs.length;i++) for (let j=i+1;j<embs.length;j++) sims.push(cos(embs[i], embs[j]));
    return sims.reduce((a,b)=>a+b,0) / sims.length;
  }
  const baseCos = await avgPairCos(baseOuts);
  const subCos  = await avgPairCos(subOuts);
  // Also: do substrate outputs mention "troth" or "substrate"
  const subOnTopic = subOuts.filter(t => /troth|substrate|collaborator/i.test(t)).length;
  return {
    n_samples: baseOuts.length,
    baseline_consistency:  baseCos,
    substrate_consistency: subCos,
    substrate_on_topic:    subOnTopic + '/' + subOuts.length,
    samples_baseline:  baseOuts.map(t => t.slice(0,90)),
    samples_substrate: subOuts.map(t => t.slice(0,90))
  };
}

// ── Bench 5: Engram retrieval precision (kept from v1) ─────────────────

async function benchEngramPrecision() {
  const cwd = '/tmp/bench-prec-' + Date.now();
  const facts = [
    'The argus tokenizer is written in Rust','PostgreSQL handles concurrent writes via MVCC','Redis uses single-threaded event loop','gRPC uses HTTP/2 multiplexing','WebSockets enable bidirectional communication','Docker containers share the host kernel','Kubernetes orchestrates container clusters','JWT tokens carry signed claims','TypeScript adds static types to JavaScript','GraphQL allows clients to specify response shape',
    'Pizza Margherita uses tomato basil and mozzarella','Sushi rice is seasoned with rice vinegar','French baguettes have a crispy crust','Carbonara uses eggs guanciale and pecorino','Greek salad does not contain lettuce','Tiramisu means pick-me-up in Italian','Pad thai includes tamarind paste','Risotto requires constant stirring','Croissants use laminated dough','Mole sauce contains chocolate and chiles'
  ];
  for (const f of facts) {
    let emb = null; try { emb = await engram.embedRequest(HOST, f); } catch (_) {}
    engram.recordEngram({ agent_id: AGENT, cwd, statement: f, embedding: emb, salience: 1.0 });
  }
  const queries = [
    ['tokenizer Rust language', /tokenizer/i],
    ['concurrent database writes', /MVCC|concurrent/i],
    ['authentication tokens with claims', /JWT/i],
    ['container orchestration', /Kubernetes/i],
    ['stirring rice for Italian dish', /risotto/i],
    ['Italian dessert with mascarpone', /Tiramisu/i],
    ['sour ingredient in Thai noodles', /tamarind|Pad thai/i]
  ];
  let t1=0, t3=0, t5=0;
  for (const [q, m] of queries) {
    const r = await engram.retrieveRelevant({ agent_id: AGENT, cwd, query: q, k: 5, embedding_host: HOST });
    if (r[0] && m.test(r[0].statement)) t1++;
    if (r.slice(0,3).some(x => m.test(x.statement))) t3++;
    if (r.slice(0,5).some(x => m.test(x.statement))) t5++;
  }
  return { n: queries.length, top1: t1/queries.length, top3: t3/queries.length, top5: t5/queries.length };
}

// ── Bench 6: Latency (kept from v1) ────────────────────────────────────

async function benchLatency() {
  await chat('Say hi', { max_tokens: 5 });
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await chat('Pick a number between 1 and 100. Just the number.', { max_tokens: 10 });
    samples.push(Date.now() - t0);
  }
  samples.sort((a,b) => a-b);
  return { warm_chat_p50_ms: samples[Math.floor(samples.length/2)], samples };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const tStart = Date.now();
  const results = {};
  console.error('[v2] starting at', new Date().toISOString(), 'host', HOST);

  console.error('[v2] 1/6 memory recall...');
  results.memory_recall = await benchMemoryRecall();
  console.error('  baseline=' + results.memory_recall.baseline_recall.toFixed(2),
                'substrate=' + results.memory_recall.substrate_recall.toFixed(2),
                'delta=' + results.memory_recall.delta.toFixed(2));

  console.error('[v2] 2/6 working-context recall...');
  results.context_recall = await benchContextRecall();
  console.error('  baseline=' + results.context_recall.baseline_recall.toFixed(2),
                'substrate=' + results.context_recall.substrate_recall.toFixed(2),
                'delta=' + results.context_recall.delta.toFixed(2));

  console.error('[v2] 3/6 voice persistence...');
  results.voice = await benchVoicePersistence();
  console.error('  baseline_avg_words=' + results.voice.baseline_avg_words.toFixed(0),
                'substrate_avg_words=' + results.voice.substrate_avg_words.toFixed(0),
                'reduction_pct=' + results.voice.word_reduction_pct.toFixed(0),
                'under_60w=' + results.voice.substrate_under_60w + '/5');

  console.error('[v2] 4/6 style consistency...');
  results.style = await benchStyleConsistency();
  console.error('  baseline_consist=' + (results.style.baseline_consistency != null ? results.style.baseline_consistency.toFixed(3) : 'n/a'),
                'substrate_consist=' + (results.style.substrate_consistency != null ? results.style.substrate_consistency.toFixed(3) : 'n/a'),
                'on_topic=' + results.style.substrate_on_topic);

  console.error('[v2] 5/6 engram precision...');
  results.engram = await benchEngramPrecision();
  console.error('  top1=' + results.engram.top1.toFixed(2), 'top3=' + results.engram.top3.toFixed(2), 'top5=' + results.engram.top5.toFixed(2));

  console.error('[v2] 6/6 latency...');
  results.latency = await benchLatency();
  console.error('  warm_chat_p50=' + results.latency.warm_chat_p50_ms + 'ms');

  const elapsed = Date.now() - tStart;
  results._meta = { host: HOST, model: MODEL, elapsed_ms: elapsed };

  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(outDir, 'substrate-eval-v2-' + stamp + '.json');
  const mdPath   = path.join(outDir, 'substrate-eval-v2-' + stamp + '.md');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const md = [
    '# Substrate Evaluation v2 — collaborator framing — ' + new Date().toISOString(),
    '',
    '**Target:** ' + HOST + '  ',
    '**Model:** ' + MODEL + '  ',
    '**Total elapsed:** ' + (elapsed/1000).toFixed(1) + 's',
    '',
    '## 1. Memory recall (planted facts about the user)',
    '- baseline (no substrate): **' + (results.memory_recall.baseline_recall*100).toFixed(0) + '%**',
    '- substrate (engram + identity prefix): **' + (results.memory_recall.substrate_recall*100).toFixed(0) + '%**',
    '- delta: **' + (results.memory_recall.delta > 0 ? '+' : '') + (results.memory_recall.delta*100).toFixed(0) + ' pp**',
    '',
    '## 2. Working-context recall (project + setup details)',
    '- baseline: **' + (results.context_recall.baseline_recall*100).toFixed(0) + '%**',
    '- substrate: **' + (results.context_recall.substrate_recall*100).toFixed(0) + '%**',
    '- delta: **' + (results.context_recall.delta > 0 ? '+' : '') + (results.context_recall.delta*100).toFixed(0) + ' pp**',
    '',
    '## 3. Voice persistence (substrate states "max 60 words")',
    '- baseline avg words: **' + results.voice.baseline_avg_words.toFixed(0) + '**',
    '- substrate avg words: **' + results.voice.substrate_avg_words.toFixed(0) + '**',
    '- reduction: **' + results.voice.word_reduction_pct.toFixed(0) + '%**',
    '- substrate replies under 60 words: **' + results.voice.substrate_under_60w + '/' + results.voice.n + '**',
    '',
    '## 4. Style consistency + on-topic (4 same-prompt repeats)',
    '- baseline pairwise cosine: **' + (results.style.baseline_consistency != null ? results.style.baseline_consistency.toFixed(3) : 'n/a') + '**',
    '- substrate pairwise cosine: **' + (results.style.substrate_consistency != null ? results.style.substrate_consistency.toFixed(3) : 'n/a') + '**',
    '- substrate replies on-topic (mentions troth/substrate/collaborator): **' + results.style.substrate_on_topic + '**',
    '',
    '## 5. Engram retrieval precision (post-RRF hybrid)',
    '- top-1: **' + (results.engram.top1*100).toFixed(0) + '%**',
    '- top-3: **' + (results.engram.top3*100).toFixed(0) + '%**',
    '- top-5: **' + (results.engram.top5*100).toFixed(0) + '%**',
    '',
    '## 6. Latency',
    '- warm chat p50: **' + results.latency.warm_chat_p50_ms + 'ms**',
    ''
  ].join('\n');
  fs.writeFileSync(mdPath, md);
  console.error('\n[v2] DONE → ' + jsonPath);
  console.log(JSON.stringify({ json: jsonPath, md: mdPath, elapsed_ms: elapsed }, null, 2));
}

main().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
