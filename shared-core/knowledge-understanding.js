// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What the partner read becomes what it knows. The knowledge drain keeps a
// document as chunks; this pass reads the chunks of each new source once and
// writes the durable facts they state as knowledge, each with its source and
// the day it was read, and links a fact to an open goal it answers, so a
// research goal shows what was found instead of staying open forever.
//
// Roads: the local engine when it answers, else the operator's engine through
// the proxy under the shared daily budget; a reader given by the caller in
// tests. TROTH_KNOWLEDGE_LLM=0 turns the pass off.

const KU_WATERMARK_SCOPE = 'internal:ku_watermark';
const KU_SOURCES_PER_RUN = () => { const n = Number(process.env.TROTH_KNOWLEDGE_SOURCES_PER_RUN); return Number.isFinite(n) && n >= 0 ? n : 4; };
const MAX_CHARS = 6000;

const SCHEMA = {
  type: 'object',
  properties: {
    facts: { type: 'array', items: { type: 'object', properties: {
      what: { type: 'string' },
      subject: { type: 'string' }
    }, required: ['what', 'subject'] } }
  },
  required: ['facts']
};
const PROMPT = [
  'Read this excerpt of a document. List up to five DURABLE facts it states about its subject matter - a product, a model, a tool, a price, a date, a capability, a rule - facts that would still be true next month.',
  'Write each fact as ONE self-contained sentence in your own words, naming its subject the way the document names it (a model name, a product, a company); never a sentence about the document or the page itself, never navigation, boilerplate, opinions or marketing.',
  'For each fact give "subject": what it is about, as named in the excerpt. When the excerpt states nothing durable, answer {"facts":[]}.',
  'Answer with ONE JSON object {"facts":[{"what":"...","subject":"..."}]} and nothing else.',
  '', 'Document: '
].join('\n');

// The reader: the local engine when it answers, else the operator's engine
// through the proxy, one turn of the shared daily budget per source.
function makeReader() {
  if (process.env.TROTH_KNOWLEDGE_LLM === '0') return null;
  const qs = require('./question-shape.js');
  const ic = require('./instance-consolidation.js');
  let pickP = null;
  const pick = async () => {
    let host = null;
    try { host = require('./transport-config.js').llamacppHost(); } catch (_) { host = null; }
    const probe = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return !!r.ok; } catch (_) { return false; } };
    if (host && await probe(String(host).replace(/\/+$/, '') + '/health')) return { road: 'local', call: qs.makeShapeCall({ host, timeout_ms: 20000 }) };
    if (String(process.env.TROTH_INSTANCE_EXTRACT_ENGINE || '') === '0') return { road: 'none', call: null };
    const proxy = 'http://127.0.0.1:' + (process.env.GF_PORT || '8000');
    if (await probe(proxy + '/health')) return { road: 'engine', call: qs.makeProxyShapeCall({ host: proxy, model: process.env.TROTH_INSTANCE_EXTRACT_MODEL || 'claude-sonnet-5', timeout_ms: 30000 }) };
    return { road: 'none', call: null };
  };
  const read = async function read(text) {
    if (!pickP) pickP = pick();
    const picked = await pickP;
    read.road = picked ? picked.road : 'none';
    if (!picked || !picked.call) return null;
    if (picked.road === 'engine') {
      // The daily engine budget is shared with the self-facts pass; a
      // reserve stays for what the operator says about themselves.
      const reserve = Math.max(0, Number(process.env.TROTH_KNOWLEDGE_BUDGET_RESERVE) || 100);
      if (ic.engineBudget().remaining <= reserve) return null;
      ic.spendEngine(1);
    }
    const out = await picked.call(PROMPT + String(text).slice(0, MAX_CHARS), { json_schema: SCHEMA });
    const s = String(out || '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
    return Array.isArray(j && j.facts) ? j.facts : null;
  };
  return read;
}

function normText(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

// A subject that is only what any page is made of names nothing.
const GENERIC_SUBJECT = new Set(['model', 'models', 'page', 'document', 'article', 'site', 'website', 'user', 'users', 'item', 'thing', 'section', 'post', 'blog', 'content', 'text', 'file', 'this', 'it', 'they']);
// A fact stands when it is a sentence of its own, the excerpt names its
// subject, and the fact names that subject.
function factStands(what, subject, text) {
  const w = normText(what), subj = normText(subject), t = normText(text);
  if (!w || w.split(' ').length < 5 || w.length > 400) return false;
  if (!subj || subj.length < 2 || GENERIC_SUBJECT.has(subj)) return false;
  if (t && !t.includes(subj)) return false;
  // A durable fact names something: a proper name, a version, a quantity.
  // "Sign in to like this model" names nothing.
  if (!/[A-ZΑ-Ω][a-zα-ω]|[0-9]/.test(String(what).slice(1))) return false;
  return w.includes(subj);
}

const STOP = new Set(['what', 'which', 'that', 'this', 'with', 'from', 'about', 'their', 'there', 'these', 'those', 'have', 'been', 'were', 'will', 'would', 'could', 'should', 'into', 'through', 'currently', 'actually', 'first', 'well', 'research', 'verify', 'published', 'support']);
function contentTokens(s) {
  const out = new Set();
  for (const tok of normText(s).split(' ')) if (tok.length >= 4 && !STOP.has(tok)) out.add(tok);
  return out;
}
// A fact answers a goal when the fact and its source's title share at least
// two content words with the goal's statement.
function linkGoals(fact, title, goals) {
  const have = contentTokens(fact + ' ' + (title || ''));
  const hits = [];
  for (const g of goals || []) {
    if (!g || !g.id || !g.statement) continue;
    let n = 0;
    for (const tok of contentTokens(g.statement)) if (have.has(tok)) n++;
    if (n >= 2) hits.push(g);
  }
  return hits;
}

// Chunks come as "[title #n] text"; a source is one scope and one title.
function groupSources(rows) {
  const groups = new Map();
  for (const r of rows) {
    let out; try { out = typeof r.output === 'string' ? JSON.parse(r.output) : r.output; } catch (_) { continue; }
    if (!out || typeof out.statement !== 'string') continue;
    const m = /^\[(.+?) #(\d+)\]\s*/.exec(out.statement);
    const title = m ? m[1] : '';
    const n = m ? parseInt(m[2], 10) : 0;
    const key = String(out.scope || '') + '|' + title;
    if (!groups.has(key)) groups.set(key, { key, scope: String(out.scope || ''), title, chunks: [], first_ts: r.timestamp, last_ts: r.timestamp, ref: null });
    const g = groups.get(key);
    g.chunks.push({ id: r.id, n, text: out.statement.slice(m ? m[0].length : 0), ts: r.timestamp });
    g.first_ts = Math.min(g.first_ts, r.timestamp);
    g.last_ts = Math.max(g.last_ts, r.timestamp);
    if (!g.ref && out.provenance && out.provenance.ref) g.ref = String(out.provenance.ref);
  }
  const list = [...groups.values()];
  for (const g of list) g.chunks.sort((a, b) => a.n - b.n);
  list.sort((a, b) => a.first_ts - b.first_ts);
  return list;
}

async function run(view) {
  const ctx = (view && view.substrate_ctx) || {};
  const engram = require('./engram.js');
  const state = require('./state.js');
  let read = null;
  let road = 'none';
  if (view && typeof view.read_knowledge === 'function') { read = view.read_knowledge; road = 'given'; }
  else { try { read = makeReader(); road = read ? 'engine' : 'off'; } catch (_) { read = null; } }
  if (!read) return { events: [], notes: ['knowledge_understanding: no reader (' + road + ')'] };

  let watermark = 0;
  let markId = null;
  try {
    const marks = (engram.listEngrams({ scope: KU_WATERMARK_SCOPE, audience: 'all', limit: 5 }) || [])
      .filter((e) => e && e.scope === KU_WATERMARK_SCOPE).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (marks[0]) { markId = marks[0].id; const m = /processed_through:\s*(\d+)/.exec(String(marks[0].statement || '')); if (m) watermark = parseInt(m[1], 10) || 0; }
  } catch (_) { watermark = 0; }
  // The first run ever starts at the drain's last day rather than at the
  // beginning of time: a backlog of every document ever read is not a
  // budget one idle afternoon holds.
  if (!watermark) watermark = Date.now() - 24 * 60 * 60 * 1000;

  let rows = [];
  try { rows = state.queryActions({ type: 'commitment', scope_prefix: 'docs:', since: watermark + 1, limit: 400, order: 'asc' }) || []; } catch (_) { rows = []; }
  const sources = groupSources(rows);
  if (!sources.length) return { events: [], notes: ['knowledge_understanding: no new documents since ' + new Date(watermark).toISOString()] };

  const budget = KU_SOURCES_PER_RUN();
  const todo = sources.slice(0, budget);
  const rest = sources.slice(budget);
  let facts = 0, findings = 0, skipped = 0, readSources = 0;
  let goals = [];
  try { goals = require('./typed-goal.js').listGoals({ status: 'open', limit: 50 }) || []; } catch (_) { goals = []; }
  const goalStatus = require('./goal-status.js');
  for (const src of todo) {
    const text = src.chunks.slice(0, 8).map((c) => c.text).join('\n').slice(0, MAX_CHARS);
    if (text.trim().length < 80) { skipped++; continue; }
    let found = null;
    try { found = await read(text); } catch (_) { found = null; }
    if (!Array.isArray(found)) { if (read.road === 'none' || road === 'off') break; skipped++; continue; }
    readSources++;
    const corpus = src.scope.replace(/^docs:/, '');
    const isWeb = /^web:/.test(corpus);
    for (const f of found.slice(0, 5)) {
      const what = String((f && f.what) || '').replace(/\s+/g, ' ').trim();
      const subject = String((f && f.subject) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!factStands(what, subject, text)) { skipped++; continue; }
      const id = engram.recordEngram({
        agent_id: ctx.agent_id || 'background-worker',
        user_id: ctx.user_id || 'default',
        cwd: ctx.cwd || null,
        statement: what,
        scope: 'knowledge:' + corpus,
        source: 'background_worker.knowledge_understanding',
        source_authority: 'plr_evolved',
        memory_class: 'semantic',
        auto_verify: false,
        provenance_tier: isWeb ? 'external' : 'operator',
        provenance_ref: src.ref || null,
        extra_output: {
          provenance: { tier: isWeb ? 'external' : 'operator', ref: src.ref || null },
          payload: { subject, source_title: src.title, source_scope: src.scope, read_day: new Date().toISOString().slice(0, 10), chunk_ids: src.chunks.slice(0, 8).map((c) => c.id) }
        }
      });
      if (!id) { skipped++; continue; }
      facts++;
      for (const g of linkGoals(what, src.title, goals)) {
        try {
          const done = goalStatus.markFinding({ goal_id: g.id, agent_id: ctx.agent_id || 'background-worker', statement: what, knowledge_id: id, source_title: src.title, source_ref: src.ref || null });
          if (done) findings++;
        } catch (_) { /* a finding is an aid, never a gate */ }
      }
    }
  }
  // The watermark moves to the last chunk of the sources read, and never
  // past the first chunk of a source left for the next run.
  let through = todo.reduce((m, s) => Math.max(m, s.last_ts), watermark);
  if (rest.length) through = Math.min(through, rest[0].first_ts - 1);
  if (through > watermark) {
    try {
      engram.recordEngram({
        agent_id: ctx.agent_id || 'background-worker',
        statement: 'processed_through: ' + through,
        scope: KU_WATERMARK_SCOPE, source: 'background_worker.knowledge_understanding', source_authority: 'plr_evolved',
        auto_verify: false, salience: 0.1,
        extra_output: markId ? { lifetime: { supersedes: [markId], reason: 'watermark_moved' } } : undefined
      });
    } catch (_) { /* the next run reads the same sources again */ }
  }
  return {
    events: [],
    notes: ['knowledge_understanding (' + (read.road || road) + '): sources=' + readSources + ' facts=' + facts + ' findings=' + findings + ' skipped=' + skipped + ' left=' + rest.length + ' watermark→' + new Date(through).toISOString()]
  };
}

const task = {
  name: 'knowledge_understanding',
  cadence_ms: 10 * 60 * 1000,
  run
};

module.exports = { task, run, makeReader, factStands, linkGoals, groupSources, KU_WATERMARK_SCOPE };
