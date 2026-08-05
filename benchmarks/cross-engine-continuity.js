#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// cross-engine-continuity — G1.
//
// The dream's distinguishing claim (entity Property 11): substrate is
// the MIND, the LLM is the POWER. Same substrate state should drive
// identity-preserving behavior across any language faculty. Hosted
// mode falls back to envelope-style injection (no decode-time steering
// on closed APIs); this bench measures whether THAT envelope path
// still preserves identity.
//
// Procedure:
//   1. Seed engrams once for agent_id=operator-cross-engine (planted user
//      facts identical to substrate-eval-v2 §1).
//   2. Probe each engine. Skip if unreachable / no key — never fail.
//   3. For each reachable engine, run three benches with the substrate
//      prefix composed identically:
//        a. Memory recall (planted facts retrieved + answered)
//        b. Working-context recall (project setup recalled from prefix)
//        c. Voice persistence (substrate's "max 60 words" honored)
//   4. Report per-engine deltas + pass/fail vs acceptance criteria.
//
// Acceptance (per the plan):
//   - Memory recall  >= 60% per engine
//   - Voice persistence: substrate replies under 60 words >= 80% per engine
// If any reachable engine fails, document why — transport bug? prefix
// format wrong for that provider? — don't blame the substrate yet.
//
// Embedding always against local llama-server (engram retrieval is
// engine-agnostic by design — that IS the point of the test).

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const cfg     = require('../shared-core/transport-config.js');
const engram  = require('../shared-core/engram.js');
const envFile = require('../shared-core/env-file.js');

// Source ~/.troth/.env (and project .env if present) into process.env
// before any transport reads its key. Existing process.env wins — parent
// shell can override file values for one-off runs.
envFile.load({ projectRoot: path.resolve(__dirname, '..') });

const EMBED_HOST = process.env.TROTH_EMBEDDING_HOST || cfg.embeddingHost();
const AGENT      = 'operator-cross-engine';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BASE    = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_MODEL   = process.env.TROTH_ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ── Generic HTTP helper (non-streaming) ─────────────────────────────────

function postJson(host, urlPath, body, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, host);
    const data = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'content-type':   'application/json',
      'content-length': Buffer.byteLength(data),
      'connection':     'close'
    };
    if (opts.headers) Object.assign(headers, opts.headers);
    const req = lib.request({
      method: 'POST', hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers,
      agent: false, timeout: opts.timeout || 60000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('http ' + res.statusCode + ': ' + buf.slice(0, 300)));
        }
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

function getJson(host, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, host);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET', hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: opts.headers || {},
      agent: false, timeout: opts.timeout || 5000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('http ' + res.statusCode));
        }
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Per-engine non-streaming chat wrappers ──────────────────────────────

async function chatLlama(promptText, opts) {
  const host  = cfg.llamacppHost();
  const model = cfg.llamacppModel();
  const messages = [];
  if (opts && opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: promptText });
  const r = await postJson(host, '/v1/chat/completions', {
    model, messages, stream: false,
    n_predict: (opts && opts.max_tokens) || 200,
    temperature: opts && opts.temperature != null ? opts.temperature : 0.5,
    chat_template_kwargs: { enable_thinking: false }
  }, { timeout: 90000 });
  return (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
}

async function chatOllama(promptText, opts) {
  const host  = cfg.ollamaHost();
  const model = cfg.ollamaModel();
  const messages = [];
  if (opts && opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: promptText });
  const r = await postJson(host, '/api/chat', {
    model, messages, stream: false,
    keep_alive: '10m',
    options: {
      temperature: opts && opts.temperature != null ? opts.temperature : 0.5,
      num_predict: (opts && opts.max_tokens) || 200
    }
  }, { timeout: 120000 });
  return (r.message && r.message.content) || '';
}

async function chatAnthropic(promptText, opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await postJson(ANTHROPIC_BASE, '/v1/messages', {
    model: ANTHROPIC_MODEL,
    max_tokens: (opts && opts.max_tokens) || 200,
    temperature: opts && opts.temperature != null ? opts.temperature : 0.5,
    system: (opts && opts.system) || '',
    messages: [{ role: 'user', content: promptText }]
  }, {
    timeout: 90000,
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    }
  });
  // Anthropic non-stream returns { content: [{type:'text', text:'...'}] }
  if (Array.isArray(r.content)) {
    return r.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('');
  }
  return '';
}

// ── Reachability probes ─────────────────────────────────────────────────

async function probeLlama() {
  try { await getJson(cfg.llamacppHost(), '/health', { timeout: 3000 }); return { ok: true }; }
  catch (e) { return { ok: false, reason: 'unreachable: ' + (e.message || e) }; }
}
async function probeOllama() {
  try { await getJson(cfg.ollamaHost(), '/api/tags', { timeout: 3000 }); return { ok: true }; }
  catch (e) { return { ok: false, reason: 'unreachable: ' + (e.message || e) }; }
}
async function probeAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'ANTHROPIC_API_KEY not set (skip is normal)' };
  return { ok: true };
}

// ── Substrate identity (engine-agnostic envelope) ───────────────────────

// Synthetic operator persona for the cross-engine continuity benchmark.
// The benchmark validates that DIFFERENT inference engines all stay
// in-character against the SAME substrate identity envelope — it does
// NOT need real operator facts (those would leak personal data into a
// public benchmark fixture). The persona below is fictional and
// constant across runs; the substrate property under test is "identity
// persists across engine swap," not "the substrate knows what brand
// of laptop the operator owns."
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

// ── Planted facts (mirror substrate-eval-v2 §1) ─────────────────────────

// Planted facts use a SYNTHETIC persona — fictional facts the
// substrate must hold across an engine swap. The property under test
// is "substrate identity persists across LLM transport changes," not
// "the LLM knows the operator's dog's name." Keeping these generic + neutral
// avoids leaking real operator data into a public benchmark fixture
// (which other operators would otherwise inherit when they run this).
const PLANTED = [
  { stmt: 'The operator prefers tabs over spaces in source code',                q: 'What does the operator prefer for indentation?',          must: /tabs/i },
  { stmt: 'The operator works on a Rust project named argus',                    q: 'What project is the operator working on?',                must: /argus/i },
  { stmt: 'The operator owns a beagle named Pepper',                             q: 'What is the operator\'s dog named?',                      must: /Pepper/i },
  { stmt: 'The operator lives in city Foo',                                      q: 'Where does the operator live?',                           must: /Foo/i },
  { stmt: 'The operator prefers helix editor for code',                          q: 'Which editor does the operator use?',                     must: /helix/i },
  { stmt: 'The operator has a meeting every Tuesday at 10 AM',                   q: 'When is the operator\'s weekly meeting?',                 must: /Tuesday|10/i },
  { stmt: 'The operator\'s monthly cloud budget is 500 dollars',                 q: 'What is the operator\'s monthly cloud budget?',           must: /500/ },
  { stmt: 'The operator is fluent in three languages: Alpha, Beta, and Gamma',   q: 'How many languages does the operator speak?',             must: /three|3/i }
];

const CONTEXT_PROBES = [
  { q: 'What language is troth written in?',                   must: /node|javascript/i },
  { q: 'What database does troth use for L1?',                 must: /sqlite/i },
  { q: 'What model is the operator running locally?',            must: /llama|gguf|local/i },
  { q: 'What is the operator\'s active focus this week?',        must: /engram|chameleon|substrate|primitive|learning|KV/i },
  { q: 'What inference engines does troth support?',           must: /llama|ollama|anthropic/i }
];

const VOICE_PROBES = [
  'Explain how a hash map works.',
  'Describe what a TCP handshake does.',
  'What is dependency injection?',
  'Explain cache invalidation.',
  'What is the role of a load balancer?'
];

// ── Per-engine bench passes ─────────────────────────────────────────────

async function benchOnEngine(engineId, chat) {
  // 1. Memory recall: baseline (no prefix) vs substrate (engram-retrieved
  //    memories injected into prefix). Engrams are seeded ONCE outside,
  //    shared across all engines — that's the test.
  const memDetail = [];
  let baseHits = 0, subHits = 0;
  for (const p of PLANTED) {
    const items = await engram.retrieveRelevant({
      agent_id: AGENT, cwd: '/tmp/cross-engine-bench',
      query: p.q, k: 5, embedding_host: EMBED_HOST
    });
    const sys = composeIdentityPrefix(items.map(i => i.statement));
    const b = await chat(p.q);
    const s = await chat(p.q, { system: sys });
    const bH = p.must.test(b) ? 1 : 0;
    const sH = p.must.test(s) ? 1 : 0;
    baseHits += bH; subHits += sH;
    memDetail.push({ q: p.q, bHit: !!bH, sHit: !!sH, s_text: s.slice(0, 100), b_text: b.slice(0, 100) });
  }

  // 2. Working-context recall: same identity prefix (no per-query engram
  //    injection — context lives in the prefix's "What you know" block).
  const ctxDetail = [];
  let ctxBaseHits = 0, ctxSubHits = 0;
  const sysCtx = composeIdentityPrefix();
  for (const p of CONTEXT_PROBES) {
    const b = await chat(p.q);
    const s = await chat(p.q, { system: sysCtx });
    const bH = p.must.test(b) ? 1 : 0;
    const sH = p.must.test(s) ? 1 : 0;
    ctxBaseHits += bH; ctxSubHits += sH;
    ctxDetail.push({ q: p.q, bHit: !!bH, sHit: !!sH, s_text: s.slice(0, 100) });
  }

  // 3. Voice persistence: substrate prefix says "max 60 words". Did the
  //    engine honor it?
  const voiceDetail = [];
  let baseWords = 0, subWords = 0, under60 = 0;
  for (const p of VOICE_PROBES) {
    const b = await chat(p);
    const s = await chat(p, { system: sysCtx });
    const bw = b.split(/\s+/).filter(Boolean).length;
    const sw = s.split(/\s+/).filter(Boolean).length;
    baseWords += bw; subWords += sw;
    if (sw <= 60) under60++;
    voiceDetail.push({ q: p, baseline_words: bw, substrate_words: sw, substrate: s.slice(0, 80) });
  }

  return {
    engine: engineId,
    memory: {
      n: PLANTED.length,
      baseline_recall:  baseHits / PLANTED.length,
      substrate_recall: subHits  / PLANTED.length,
      delta_pp: ((subHits - baseHits) / PLANTED.length) * 100,
      detail: memDetail
    },
    context: {
      n: CONTEXT_PROBES.length,
      baseline_recall:  ctxBaseHits / CONTEXT_PROBES.length,
      substrate_recall: ctxSubHits  / CONTEXT_PROBES.length,
      delta_pp: ((ctxSubHits - ctxBaseHits) / CONTEXT_PROBES.length) * 100,
      detail: ctxDetail
    },
    voice: {
      n: VOICE_PROBES.length,
      baseline_avg_words:  baseWords / VOICE_PROBES.length,
      substrate_avg_words: subWords  / VOICE_PROBES.length,
      substrate_under_60w: under60,
      under_60w_rate: under60 / VOICE_PROBES.length,
      detail: voiceDetail
    }
  };
}

function evaluateAcceptance(engineResult) {
  // Per the plan: memory recall >= 60%, voice persistence (under 60w) >= 80%.
  const memOk   = engineResult.memory.substrate_recall >= 0.60;
  const voiceOk = engineResult.voice.under_60w_rate    >= 0.80;
  return {
    memory_pass: memOk,
    voice_pass:  voiceOk,
    overall:     memOk && voiceOk
  };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const tStart = Date.now();
  console.error('[xeng] G1 cross-engine-continuity — agent_id=' + AGENT);
  console.error('[xeng] embedding host (engine-agnostic): ' + EMBED_HOST);

  // 1. Seed engrams ONCE. Embedding via the local llama-server. Same L1
  //    state will drive identity for every transport.
  console.error('[xeng] seeding ' + PLANTED.length + ' engrams for shared substrate state...');
  for (const p of PLANTED) {
    let emb = null;
    try { emb = await engram.embedRequest(EMBED_HOST, p.stmt); } catch (_) {}
    engram.recordEngram({
      agent_id: AGENT, cwd: '/tmp/cross-engine-bench',
      statement: p.stmt, embedding: emb, salience: 1.0, source: 'cross-engine-bench'
    });
  }
  console.error('[xeng] seeding done.');

  // 2. Probe each engine.
  const engines = [
    { id: 'llamacpp',  label: 'Local llama.cpp (' + cfg.llamacppHost() + ')',  probe: probeLlama,    chat: chatLlama  },
    { id: 'ollama',    label: 'Local Ollama ('    + cfg.ollamaHost()   + ')',  probe: probeOllama,   chat: chatOllama },
    { id: 'anthropic', label: 'Anthropic API ('   + ANTHROPIC_BASE     + ')',  probe: probeAnthropic, chat: chatAnthropic }
  ];
  const results = { engines: {}, skipped: {} };
  for (const e of engines) {
    console.error('[xeng] probing ' + e.id + '...');
    const p = await e.probe();
    if (!p.ok) {
      console.error('[xeng]   skip: ' + p.reason);
      results.skipped[e.id] = { reason: p.reason, label: e.label };
      continue;
    }
    console.error('[xeng] running ' + e.id + ' bench (this takes a few minutes)...');
    try {
      const r = await benchOnEngine(e.id, e.chat);
      r.label = e.label;
      r.acceptance = evaluateAcceptance(r);
      results.engines[e.id] = r;
      console.error('[xeng]   ' + e.id + ' memory=' + (r.memory.substrate_recall*100).toFixed(0) +
                    '% context=' + (r.context.substrate_recall*100).toFixed(0) +
                    '% voice<=60w=' + r.voice.substrate_under_60w + '/' + r.voice.n +
                    ' overall=' + (r.acceptance.overall ? 'PASS' : 'FAIL'));
    } catch (err) {
      console.error('[xeng]   ' + e.id + ' FAILED with: ' + (err && err.message || err));
      results.skipped[e.id] = { reason: 'runtime error: ' + (err && err.message || err), label: e.label };
    }
  }

  const elapsed = Date.now() - tStart;
  results._meta = {
    agent_id: AGENT,
    embedding_host: EMBED_HOST,
    elapsed_ms: elapsed,
    started_at: new Date(tStart).toISOString()
  };

  // 3. Compute cross-engine summary table.
  const ran = Object.keys(results.engines);
  const allPass = ran.length > 0 && ran.every(k => results.engines[k].acceptance.overall);
  results._summary = {
    engines_ran: ran.length,
    engines_skipped: Object.keys(results.skipped).length,
    all_pass: allPass,
    dream_property_11_verdict: ran.length === 0
      ? 'INCONCLUSIVE — no engine reachable'
      : (allPass
          ? 'SUPPORTED — substrate identity preserved across reachable engines'
          : 'NOT SUPPORTED on at least one engine — see per-engine detail')
  };

  // 4. Write results.
  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(outDir, 'cross-engine-continuity-' + stamp + '.json');
  const mdPath   = path.join(outDir, 'cross-engine-continuity-' + stamp + '.md');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const md = [];
  md.push('# Cross-Engine Continuity (G1) — ' + new Date().toISOString());
  md.push('');
  md.push('Agent: `' + AGENT + '`  ');
  md.push('Embedding host (shared across engines): `' + EMBED_HOST + '`  ');
  md.push('Total elapsed: ' + (elapsed/1000).toFixed(1) + 's');
  md.push('');
  md.push('**Verdict (Property 11 — language-faculty agnostic):** ' + results._summary.dream_property_11_verdict);
  md.push('');
  md.push('## Per-engine results');
  md.push('');
  md.push('| Engine | Memory recall | Δ vs base | Context recall | Voice ≤60w | Overall |');
  md.push('|---|---|---|---|---|---|');
  for (const id of ran) {
    const r = results.engines[id];
    md.push('| ' + id +
            ' | ' + (r.memory.substrate_recall*100).toFixed(0) + '%' +
            ' | ' + (r.memory.delta_pp >= 0 ? '+' : '') + r.memory.delta_pp.toFixed(0) + 'pp' +
            ' | ' + (r.context.substrate_recall*100).toFixed(0) + '%' +
            ' | ' + r.voice.substrate_under_60w + '/' + r.voice.n +
            ' | ' + (r.acceptance.overall ? '✅ PASS' : '❌ FAIL') + ' |');
  }
  if (Object.keys(results.skipped).length) {
    md.push('');
    md.push('## Skipped engines');
    for (const id of Object.keys(results.skipped)) {
      md.push('- **' + id + '** (' + results.skipped[id].label + ') — ' + results.skipped[id].reason);
    }
  }
  md.push('');
  md.push('## Acceptance criteria (G1)');
  md.push('- Memory recall ≥ 60% per engine');
  md.push('- Voice persistence (substrate replies under 60 words) ≥ 80% per engine');
  md.push('');
  md.push('If a reachable engine fails, the failure is on the substrate-vs-transport coupling');
  md.push('for THAT engine — not on the substrate itself. Document the specific failure mode');
  md.push('(prefix length truncation? template incompatibility? sampler difference?) and');
  md.push('iterate on transport-side accommodations rather than identity content.');

  fs.writeFileSync(mdPath, md.join('\n'));
  console.error('\n[xeng] DONE → ' + jsonPath);
  console.error('[xeng]      → ' + mdPath);
  console.log(JSON.stringify({ json: jsonPath, md: mdPath, summary: results._summary, elapsed_ms: elapsed }, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}

module.exports = {
  composeIdentityPrefix,
  benchOnEngine,
  evaluateAcceptance,
  PLANTED,
  CONTEXT_PROBES,
  VOICE_PROBES
};
