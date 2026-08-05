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
})();
