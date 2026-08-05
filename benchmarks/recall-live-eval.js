#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// recall-live-eval — measures REAL recall quality against the LIVE substrate,
// NOT a toy planted-fact set (the gap that let "100% ready" be false).
//
// Categories:
//   lexical      — query shares keywords with the target (FTS path should hit)
//   semantic     — keywords present but correct row needs cosine to rank well
//   pure-semantic — query shares ~NO keywords with the target (ONLY a true dense
//                   arm can retrieve it; exposes the lexical-gate drift)
//   noise-guard  — query whose substrate has nothing relevant; must NOT surface
//                   dead drafts / unrelated app builds
//   nonsense     — out-of-domain; should stay quiet (low cos, no forced hits)
//
// Run: node benchmarks/recall-live-eval.js
const recall = require('../shared-core/recall.js');
const CWD = process.env.TROTH_BENCH_CWD || process.cwd();

// [id, category, query, expectRegex|null, deadRegex|null]
//
// The shipped cases are TEMPLATES about the troth project itself, because a
// live-recall eval is only meaningful against facts YOUR substrate actually
// holds. Write your own probes into benchmarks/recall-live-probes.local.json
// (gitignored, shape: [[id, category, query, expect, dead], ...] with regex
// SOURCES as strings) and they replace the templates. Personal probes stay
// out of the tracked tree by construction: an eval seeded from the
// operator's real life is itself a record of it.
const TEMPLATE_CASES = [
  ['strat-lex',    'lexical',       'open closed AGPL licensing decision troth engine autonomy', /AGPL-3\.0|open core|autonomy/i, null],
  ['strat-puresem','pure-semantic', 'which pieces of the product stay proprietary and which are shared openly with everyone', /AGPL|governed partner|autonomy/i, null],
  ['kv-lex',       'lexical',       'llama-server cache prompt KV prefix reuse', /kv|cache|llama|prefix|inference|metal|gguf/i, null],
  ['pref-puresem', 'pure-semantic', 'coding conventions the operator has asked me to follow', /convention|prefer|style|review|verify/i, null],
  ['guard-noise',  'noise-guard',   'build me a simple bread baking app', null, /abandoned draft|unrelated app build/i],
  ['nonsense',     'nonsense',      'lattice gauge quantum chromodynamics renormalization group flow', null, null],
];
let CASES = TEMPLATE_CASES;
try {
  const local = require('./recall-live-probes.local.json');
  if (Array.isArray(local) && local.length) {
    CASES = local.map(([id, cat, q, exp, dead]) =>
      [id, cat, q, exp ? new RegExp(exp, 'i') : null, dead ? new RegExp(dead, 'i') : null]);
    console.log('probes: using ' + CASES.length + ' local probes (recall-live-probes.local.json)');
  }
} catch (_) { /* no local probe file: run the templates */ }


(async () => {
  const score = { lexical: [0, 0], semantic: [0, 0], 'pure-semantic': [0, 0], 'noise-guard': [0, 0], nonsense: [0, 0] };
  console.log('category        case             verdict                     top1cos  rank');
  console.log('─'.repeat(86));
  const RERANK = process.env.RERANK === '1'; let totLat = 0;
  for (const [id, cat, q, expect, dead] of CASES) {
    const _t0 = Date.now();
    const r = await recall.recall({ query: q, class: 'all', limit: 8, cwd: CWD, rerank: RERANK });
    totLat += Date.now() - _t0;
    const cosArr = r.map(x => x._semantic_cos).filter(c => typeof c === 'number');
    const topCos = cosArr.length ? Math.max(...cosArr) : 0;
    let rank = -1, deadHit = -1;
    r.forEach((x, i) => {
      if (expect && rank < 0 && expect.test(x.statement)) rank = i;
      if (dead && deadHit < 0 && dead.test(x.statement)) deadHit = i;
    });
    let pass, verdict;
    if (dead)      { pass = deadHit < 0;                 verdict = pass ? 'PASS (no dead-draft)' : `FAIL dead@${deadHit}`; }
    else if (cat === 'nonsense') { pass = topCos < 0.62; verdict = pass ? `PASS (quiet ${topCos.toFixed(2)})` : `WEAK (returns ${topCos.toFixed(2)})`; }
    else           { pass = rank === 0;                  verdict = rank === 0 ? 'PASS @0' : rank > 0 ? `WEAK on-topic@${rank}` : 'MISS (not retrieved)'; }
    score[cat][0] += pass ? 1 : 0; score[cat][1] += 1;
    console.log(`${cat.padEnd(15)} ${id.padEnd(16)} ${verdict.padEnd(27)} ${topCos.toFixed(3)}    ${rank < 0 ? '-' : rank}`);
  }
  console.log('─'.repeat(86));
  console.log(`MODE: rerank=${RERANK}   total recall latency: ${totLat}ms (${Math.round(totLat/CASES.length)}ms/query avg)`);
  for (const k of Object.keys(score)) if (score[k][1]) console.log(`  ${k.padEnd(15)} ${score[k][0]}/${score[k][1]}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
