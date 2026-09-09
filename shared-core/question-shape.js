// SPDX-License-Identifier: AGPL-3.0-only
// question-shape - what a question asks of memory, in any language.
//
// The reconciled view needs the shape of a question, not its words: what is
// counted (the head), what the user did with it (acquire, attend, visit,
// work, lead, own), the span it names, whether it asks about what happened
// or what is planned, whether it asks for advice. The model reads that
// shape in one small structured call, so the same view serves a question in
// Greek or English alike. Without a model the English patterns stand in.
// Shapes are cached per process, keyed by the question and its day.
'use strict';

let _parseTimeWindow = null;
try { _parseTimeWindow = require('./time-window.js').parseTimeWindow; } catch (_) {}

const FAMILIES = ['acquire', 'attend', 'visit', 'work', 'lead', 'own'];
const DAY_MS = 86400000;
// What kind of answer the question wants: a place, a time, a person, a
// thing, a count, a reason, a way of doing something. The reader is told
// which, so a channel is not served where a place was asked.
const ASKS = ['place', 'time', 'person', 'thing', 'count', 'reason', 'manner', 'other'];
// Whether the question is about what is still open (to pick up, to return,
// to pay, to renew), what is done, or does not care.
const STATUS_ASKS = ['pending', 'done', 'any'];
const SCHEMA = {
  type: 'object',
  properties: {
    count: { type: 'boolean' },
    request: { type: 'boolean' },
    head: { type: ['string', 'null'] },
    // Every family the question names ("worked on or bought" is two), so a
    // line kept by any of them stays in the ledger.
    verb_families: { type: 'array', items: { type: 'string', enum: FAMILIES.concat(['other', 'none']) } },
    past: { type: 'boolean' },
    window_days: { type: ['integer', 'null'] },
    window_kind: { type: 'string', enum: ['relative', 'this_year', 'this_month', 'this_week', 'none'] },
    asks: { type: 'string', enum: ASKS },
    status: { type: 'string', enum: STATUS_ASKS }
  },
  required: ['count', 'request', 'head', 'verb_families', 'past', 'window_days', 'window_kind', 'asks', 'status']
};

const PROMPT = [
  'Read the question and describe its shape for a memory system. Answer with ONE JSON object and nothing else.',
  'Fields:',
  '- count: true when it asks how many, a total, or the order of several events.',
  '- request: true when it asks for a recommendation, suggestion, tips, ideas or advice.',
  '- head: the thing being counted or asked about, as a short noun phrase in the question\'s own language, singular (e.g. "model kit", "clothing item", "wedding"); null if none.',
  '- verb_families: every family of what the user did with the head that the question names, as a list: acquire (bought, got, received), attend (went to an event), visit (went to a place, tried a restaurant), work (made, built, finished, worked on), lead (led, managed), own (currently has); ["other"] or ["none"] otherwise. "worked on or bought" is ["work", "acquire"].',
  '- past: true when it asks about what has already happened, false when about plans.',
  '- window_days: the number of days back the question limits itself to (last month = 30, past three months = 90), or null.',
  '- window_kind: relative for "past N ...", this_year / this_month / this_week for calendar spans, none otherwise.',
  '- asks: the kind of answer wanted: place (where), time (when, how long ago), person (who), thing (what, which), count (how many, how much, an order of events), reason (why), manner (how), or other.',
  '- status: pending when it asks what is still open or owed (still to pick up, to return, to pay, to renew, not yet done), done when it asks what was completed, any when it does not care.',
  '',
  'Question: '
].join('\n');

const _cache = new Map();
const CACHE_MAX = 500;

function _windowFrom(shape, refTs) {
  const ref = Number.isFinite(refTs) ? refTs : Date.now();
  if (shape.window_kind === 'relative' && Number.isFinite(shape.window_days) && shape.window_days > 0) {
    return { since: ref - shape.window_days * DAY_MS, until: ref, span: shape.window_days + ' days' };
  }
  const d = new Date(ref);
  if (shape.window_kind === 'this_year') return { since: Date.UTC(d.getUTCFullYear(), 0, 1), until: ref, span: 'this year' };
  if (shape.window_kind === 'this_month') return { since: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), until: ref, span: 'this month' };
  if (shape.window_kind === 'this_week') return { since: ref - ((d.getUTCDay() + 6) % 7) * DAY_MS - (ref % DAY_MS), until: ref, span: 'this week' };
  return null;
}

// The English patterns, as the fallback and the regression baseline.
// The wh-word, as the English fallback for what kind of answer is wanted.
function _asksByPatterns(lower) {
  if (/\b(how many|how much|how often|number of|total|count|order of|first to last|earliest to latest)\b/.test(lower)) return 'count';
  if (/\b(where|which (?:store|shop|place|city|restaurant|country)|what (?:store|shop|place|city|restaurant|country))\b/.test(lower)) return 'place';
  if (/\b(when|how long ago|what (?:day|date|time|year|month)|how many days|how many weeks|how many months)\b/.test(lower)) return 'time';
  if (/\b(who|whom|whose)\b/.test(lower)) return 'person';
  if (/\bwhy\b/.test(lower)) return 'reason';
  if (/\bhow (?:do|did|can|should|would)\b/.test(lower)) return 'manner';
  if (/\b(what|which)\b/.test(lower)) return 'thing';
  return 'other';
}

function shapeByPatterns(question, refTs) {
  const q = String(question || '');
  const lower = q.toLowerCase();
  let head = null, phrase = null;
  try {
    const e = require('./engram.js');
    head = e.countNounHead(q);
    phrase = e.countNounPhrase ? e.countNounPhrase(q) : null;
  } catch (_) {}
  const fam = [];
  if (/\b(acquire[ds]?|acquired|bought|buy|purchase[ds]?|purchased|got|get|received?|obtain(?:ed)?|adopt(?:ed)?|pick(?:ed)? up)\b/.test(lower)) fam.push('acquire');
  if (/\b(attend(?:ed)?|went to|go to|been to)\b/.test(lower)) fam.push('attend');
  if (/\b(visit(?:ed)?|tried|been to|eaten at|dined at)\b/.test(lower)) fam.push('visit');
  if (/\b(work(?:ed)? on|built|build|made|make|finish(?:ed)?|complete[ds]?|written|wrote|painted|assembled)\b/.test(lower)) fam.push('work');
  if (/\b(led|lead(?:ing)?|manage[ds]?|managed|run|ran)\b/.test(lower)) fam.push('lead');
  if (/\b(own|owns|keep|currently have|do i (?:still |currently )?have|have (?:got )?(?:at home|now|left)|how many [a-z]+ (?:do|did) i have)\b/.test(lower)) fam.push('own');
  return {
    source: 'patterns',
    count: /\b(how many|how much|number of|total|count|order of|first to last|earliest to latest)\b/i.test(q),
    request: /\b(can you (?:recommend|suggest)|any (?:tips|suggestions|recommendations|ideas|advice)|what should i|could you (?:recommend|suggest)|suggest (?:some|a)|recommend (?:some|a)|help me (?:choose|pick|plan|decide)|what (?:would|do) you recommend)\b/i.test(q),
    head,
    head_phrase: phrase,
    families: fam,
    past: /\b(have i|did i|i have|i've|have attended|did|attended|bought|went|visited|acquired|worked on|made|led)\b/.test(lower),
    asks: _asksByPatterns(lower),
    status: /\b(still (?:need|have) to|need to (?:pick up|return|pay|renew|collect)|haven't (?:yet|picked|returned|paid)|not yet|pending|outstanding|owe|owed|to be (?:picked up|returned))\b/.test(lower) ? 'pending' : 'any',
    window: _parseTimeWindow ? _parseTimeWindow(q, refTs) : null
  };
}

function _parseModel(text) {
  const s = String(text || '').trim();
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

// llmCall(prompt, { json_schema }) -> text. Any OpenAI-compatible endpoint
// works; llama.cpp honours the schema, others return free JSON that is parsed
// from the first object in the text.
async function shapeQuestion(question, opts) {
  opts = opts || {};
  const q = String(question || '').trim();
  if (!q) return shapeByPatterns(q, opts.reference_ts);
  const day = Number.isFinite(opts.reference_ts) ? Math.floor(opts.reference_ts / DAY_MS) : 'now';
  const key = day + '|' + q;
  if (_cache.has(key)) return _cache.get(key);
  let shape = null;
  if (typeof opts.llmCall === 'function') {
    try {
      const text = await opts.llmCall(PROMPT + q, { json_schema: SCHEMA });
      const j = _parseModel(text);
      if (j && typeof j === 'object') {
        const famIn = Array.isArray(j.verb_families) ? j.verb_families : (typeof j.verb_family === 'string' ? [j.verb_family] : []);
        const fam = famIn.filter((f) => FAMILIES.includes(f));
        const head = typeof j.head === 'string' && j.head.trim() ? j.head.trim().toLowerCase() : null;
        shape = {
          source: 'model',
          count: !!j.count,
          request: !!j.request,
          head: head ? head.split(/\s+/).pop() : null,
          head_phrase: head,
          families: fam,
          past: j.past !== false,
          asks: ASKS.includes(j.asks) ? j.asks : 'other',
          status: STATUS_ASKS.includes(j.status) ? j.status : 'any',
          window: _windowFrom(j, opts.reference_ts)
        };
      }
    } catch (_) { shape = null; }
  }
  if (!shape) shape = shapeByPatterns(q, opts.reference_ts);
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, shape);
  return shape;
}

// A one-call llmCall against an OpenAI-compatible chat endpoint, structured
// output requested through llama.cpp's json_schema field, thinking off,
// deterministic, bounded. Same shape the instance extractor uses.
function makeShapeCall(cfg) {
  cfg = cfg || {};
  const host = String(cfg.host || 'http://127.0.0.1:1234').replace(/\/$/, '');
  const timeoutMs = cfg.timeout_ms || 20000;
  return async function llmCall(prompt, o) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const body = {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0, max_tokens: 200, stream: false,
        chat_template_kwargs: { enable_thinking: false }
      };
      if (o && o.json_schema) body.json_schema = o.json_schema;
      if (cfg.model) body.model = cfg.model;
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.api_key) headers.Authorization = 'Bearer ' + cfg.api_key;
      const res = await fetch(host + '/v1/chat/completions', { method: 'POST', headers, signal: ac.signal, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('shape http ' + res.status);
      const j = await res.json();
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      return (msg && msg.content) || '';
    } finally { clearTimeout(timer); }
  };
}

// The same one call through the operator's own troth proxy (/v1/messages,
// Anthropic shape): the proxy holds the credentials and picks the engine from
// the model id, this process never sees a key. No schema can be forced on
// that road, so the prompt rides the system text and the first JSON object
// in the reply is what shapeQuestion parses. x-troth-raw keeps the prompt as
// written: no coding discipline prepended, no plan generated into it.
function makeProxyShapeCall(cfg) {
  cfg = cfg || {};
  const host = String(cfg.host || process.env.TROTH_PROXY_HOST || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const model = cfg.model || process.env.TROTH_PROXY_SHAPE_MODEL || 'gpt-5.4-mini';
  const timeoutMs = cfg.timeout_ms || 20000;
  return async function llmCall(prompt) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const body = {
        model, max_tokens: 200, stream: false,
        system: prompt,
        messages: [{ role: 'user', content: 'Reply with the JSON object and nothing else.' }]
      };
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-troth-source': 'question-shape', 'x-troth-raw': '1' };
      const res = await fetch(host + '/v1/messages', { method: 'POST', headers, signal: ac.signal, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('shape http ' + res.status);
      const j = await res.json();
      return (Array.isArray(j.content) ? j.content : [])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('');
    } finally { clearTimeout(timer); }
  };
}

module.exports = { shapeQuestion, shapeByPatterns, makeShapeCall, makeProxyShapeCall, FAMILIES, ASKS, STATUS_ASKS, SCHEMA };
