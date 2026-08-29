#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// recall-eval — regression harness for Troth memory retrieval.
// READ-ONLY. Runs a fixed set of cases against the live substrate and prints a
// compact, diff-able table so we can prove a fix works AND prove no regression.
'use strict';
const recall = require('../shared-core/recall.js');
const chameleon = require('../shared-core/chameleon.js');
const st = require('../shared-core/state.js');
function scopeOf(id){ try{ const r=st.getAction(id); const o=r&&(typeof r.output==='string'?JSON.parse(r.output):r.output); return (o&&o.scope)||'(none)'; }catch(_){ return '?'; } }

// NOTE: the scope ids and queries below are illustrative placeholders. Point
// them at scopes that exist in YOUR substrate (see `troth recall`); the harness
// only cares that a labeled corpus surfaces for a corpus-targeted query.
// A) corpus-targeted (queryScope) — "give me from THIS research corpus"
const SCOPED = [
  ['docs:research-a','topic A key finding summary'],
  ['docs:research-b','topic B best practice'],
  ['docs:research-c','topic C conversion heuristic'],
  ['research:topic-d','topic D benchmark comparison'],
];
// B) build queries via default recall — does the LABELED research surface?
const BUILD = [
  ['build something using our topic-C research','docs:research-c'],
  ['plan using our topic-D research','research:topic-d'],
  ['what did our research say about topic A','docs:research-a'],
  ['decide using our topic-B research','docs:research-b'],
];
// C) working-case guards (must NOT regress)
const GUARD = [
  'what is the project name',
  'what did we decide about the import dedup',
];

(async()=>{
  console.log('### A) CORPUS-TARGETED queryScope (want >0 from the scope)');
  for(const [scope,q] of SCOPED){
    let n=0,inscope=0; try{ const r=await chameleon.queryScope({agent_id:require('../shared-core/agent-id.js').resolveAgentId(),scope,query:q,k:5}); n=(r.items||[]).length; inscope=(r.items||[]).filter(it=>scopeOf(it.id)===scope).length; }catch(e){}
    console.log('  '+(inscope>0?'PASS':'FAIL')+'  '+scope+'  hits='+n+' inscope='+inscope);
  }
  console.log('### B) BUILD queries via recall.recall (want labeled corpus in top-5)');
  for(const [q,want] of BUILD){
    const hits=await recall.recall({query:q,class:'all',audience:'model_visible',limit:5,rerank:true}).catch(()=>[]);
    const sc=hits.map(h=>scopeOf(h.id)); const got=sc.filter(s=>s===want).length;
    console.log('  '+(got>0?'PASS':'FAIL')+'  want='+want+' got='+got+'/5  ['+sc.join(',')+']');
  }
  console.log('### C) GUARD (working cases — record top hit, must stay stable)');
  for(const q of GUARD){
    const hits=await recall.recall({query:q,class:'all',audience:'model_visible',limit:3,rerank:true}).catch(()=>[]);
    const top=hits[0]; console.log('  q="'+q.slice(0,40)+'" top='+(top?('['+scopeOf(top.id)+'] '+String(top.statement||'').slice(0,50).replace(/\s+/g,' ')):'NONE'));
  }
  console.log('### D) CHATS EXCLUDED from auto-recall (want 0 docs:chats in no-scope recall)');
  for(const q of ['what did we work on in past sessions','what did we discuss about the side project']){
    const hits=await recall.recall({query:q,class:'all',audience:'model_visible',limit:8,rerank:true}).catch(()=>[]);
    const n=hits.map(h=>scopeOf(h.id)).filter(s=>s==='docs:chats').length;
    console.log('  '+(n===0?'PASS':'FAIL')+'  docs:chats in top8='+n+'  q="'+q.slice(0,40)+'"');
  }
  console.log('### E) EXPLICIT chat search still works (want >0 from docs:chats)');
  for(const q of ['payments integration decision we discussed','strategy notes we discussed']){
    let n=0; try{ const r=await chameleon.queryScope({scope:'docs:chats',query:q,k:5}); n=(r.items||[]).filter(it=>scopeOf(it.id)==='docs:chats').length; }catch(e){}
    console.log('  '+(n>0?'PASS':'FAIL')+'  docs:chats hits='+n+'  q="'+q.slice(0,40)+'"');
  }

  // ── F..J: one section per KIND of memory the substrate now holds ─────────
  // A passing unit suite says "nothing broke". It cannot say "the partner
  // knows more than it did". These sections ask each store the question it
  // exists to answer, against the live substrate, and print a score that can
  // be compared between runs.
  let pass = 0, total = 0;
  const check = (label, ok, detail) => {
    total++; if (ok) pass++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  };
  const topFor = async (q, limit) => {
    const hits = await recall.recall({ query: q, class: 'all', audience: 'model_visible', limit: limit || 5, rerank: false }).catch(() => []);
    return Array.isArray(hits) ? hits : (hits && hits.items) || [];
  };

  console.log('### F) OPERATOR RULES — the right rule for the situation, not all of them');
  {
    const lesson = require('../shared-core/lesson.js');
    const rules = lesson.listRules({ limit: 50 });
    check('rules exist at all', rules.length > 0, rules.length + ' on the shelf');
    for (const [q, needle] of [
      ['can i force push this branch to clean up the history', 'force'],
      ['should i patch this quickly or find the real cause first', 'cause']
    ]) {
      const hits = await topFor(q, 5);
      const at = hits.findIndex(h => new RegExp(needle, 'i').test(String(h.statement || '')));
      check('rule surfaces for "' + q.slice(0, 34) + '"', at !== -1 && at < 3,
            at === -1 ? 'not in top 5' : ('rank #' + (at + 1) + ' at ' + hits[at].score));
    }
    // The failure mode this checks for: rules filling slots on
    // questions that have nothing to do with them.
    const unrelated = await topFor('what is the keychain profile used for notarizing', 5);
    const ruleTexts = new Set(rules.map(r => String(r.text || '')));
    const intruders = unrelated.filter(h => ruleTexts.has(String(h.statement || ''))).length;
    check('rules do NOT crowd an unrelated question', intruders <= 1, intruders + ' of 5 slots');
  }

  console.log('### G) OPERATOR KNOWLEDGE — a document answers about its own contents');
  {
    const rows = st._dbForQuery().prepare(
      "SELECT json_extract(output,'$.scope') AS sc, COUNT(*) AS n FROM action_records " +
      "WHERE json_extract(output,'$.scope') LIKE 'docs:%' AND json_extract(output,'$.scope') NOT LIKE 'docs:web:%' " +
      "AND json_extract(output,'$.scope') NOT LIKE 'docs:chats%' GROUP BY sc ORDER BY n DESC LIMIT 3"
    ).all();
    check('operator corpora exist', rows.length > 0, rows.map(r => r.sc + '(' + r.n + ')').join(' '));
    for (const r of rows.slice(0, 2)) {
      let hits = 0;
      try { const q = await chameleon.queryScope({ scope: r.sc, query: 'summary of the main finding', k: 5 }); hits = (q.items || []).length; } catch (_) {}
      check('scoped read works on ' + r.sc, hits > 0, hits + ' passages');
    }
  }

  console.log('### H) EXTERNAL KNOWLEDGE — kept, answerable, and marked');
  {
    const n = st._dbForQuery().prepare(
      "SELECT COUNT(*) AS n FROM action_records WHERE json_extract(output,'$.scope') LIKE 'docs:web:%'"
    ).get().n;
    if (!n) { console.log('  SKIP  nothing fetched from the web yet'); }
    else {
      const sample = st._dbForQuery().prepare(
        "SELECT substr(json_extract(output,'$.statement'), 1, 60) AS st FROM action_records " +
        "WHERE json_extract(output,'$.scope') LIKE 'docs:web:%' LIMIT 1"
      ).get();
      const words = String(sample.st || '').replace(/^\[[^\]]*\]\s*/, '').split(/\s+/).slice(0, 7).join(' ');
      const hits = await topFor(words, 5);
      const found = hits.find(h => h.provenance_tier === 'external');
      check('a fetched page is recallable', !!found, found ? ('rank #' + (hits.indexOf(found) + 1)) : 'not in top 5');
      if (found) check('and carries its origin', !!found.provenance_ref, String(found.provenance_ref || '').slice(0, 50));
    }
  }

  console.log('### I) DID IT WORK — outcomes are attached to real changes');
  {
    const d = st._dbForQuery();
    const ev = d.prepare("SELECT COUNT(*) AS n FROM action_records WHERE json_extract(input,'$.kind')='outcome_event'").get().n;
    check('outcome events exist', ev > 0, ev + ' events');
    const linked = d.prepare(
      "SELECT COUNT(DISTINCT parent_id) AS n FROM action_records WHERE json_extract(input,'$.kind')='outcome_event'"
    ).get().n;
    check('they point at distinct changes', linked > 0, linked + ' changes have an outcome');
  }

  console.log('### J) CODE GRAPH — the structural question, answered');
  {
    const graph = require('../shared-core/code-graph.js');
    const live = graph.whoCalls('recordAction', { cwd: process.cwd(), exact: true });
    check('a live function reads as reached', live.indexed && live.production_callers > 0,
          live.indexed ? (live.production_callers + ' production callers') : 'no index for this directory');
    const dead = graph.whoCalls('markAccepted', { cwd: process.cwd(), exact: true });
    check('a test-only function is named as such', !dead.indexed || dead.production_callers === 0,
          dead.indexed ? dead.verdict.slice(0, 46) : 'no index');
  }

  console.log('### K) EVERY SURFACE — memory is assembled before any transport');
  {
    // The claim: this knowledge is chunks the partner RETRIEVES, in the same
    // store and through the same recall as everything else — so it works the
    // same on a local llama, on the backbone, and on cloud. The proof is that
    // retrieval never touches a provider: recall.recall() takes no transport,
    // the embedder is local, and the memory prefix is built in shared-core
    // BEFORE whichever of the seven transports answers.
    const saved = {
      a: process.env.ANTHROPIC_API_KEY, b: process.env.ANTHROPIC_BASE_URL,
      o: process.env.OPENAI_API_KEY, e: process.env.TROTH_EMBED_HOST
    };
    process.env.ANTHROPIC_API_KEY = '';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.OPENAI_API_KEY = '';
    process.env.TROTH_EMBED_HOST = 'http://127.0.0.1:1';
    let items = [];
    try { items = await topFor('quality score expected click through rate', 3); } catch (_) { items = []; }
    process.env.ANTHROPIC_API_KEY = saved.a || '';
    process.env.ANTHROPIC_BASE_URL = saved.b || '';
    process.env.OPENAI_API_KEY = saved.o || '';
    if (saved.e === undefined) delete process.env.TROTH_EMBED_HOST; else process.env.TROTH_EMBED_HOST = saved.e;
    check('recall answers with every provider unreachable', items.length > 0, items.length + ' hits, no network');
    // Structural, not lexical. A first version grepped the header for the
    // words transport/provider/apiKey and failed on the phrase "prefix
    // provider" inside a comment — a check that reads prose instead of code
    // reports the wrong thing with total confidence.
    const fs = require('fs');
    const rec = fs.readFileSync(require('path').join(__dirname, '..', 'shared-core', 'recall.js'), 'utf8');
    const deps = (rec.match(/require\('([^']+)'\)/g) || []).map(m => m.slice(9, -2));
    const networked = deps.filter(dpath => /transports?\/|anthropic|openai|kimi|ollama|llamacpp|router/i.test(dpath));
    check('and the retrieval path imports no transport', networked.length === 0,
          networked.length ? networked.join(',') : deps.length + ' local deps: ' + deps.join(','));
  }

  console.log('');
  console.log('### SCORE  ' + pass + '/' + total + ' checks passed across every memory kind');
})();
