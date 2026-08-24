// SPDX-License-Identifier: AGPL-3.0-only
// instance-consolidation — the substrate counts what it UNDERSTOOD.
//
// Counting questions ("how many doctors did I visit") fail on raw turns
// because distinctness, status and coreference are judgment calls an
// answerer re-litigates per question. Consolidation owns that judgment
// ONCE, off the turn path: a distillation pass walks new dialogue turns
// at worker cadence and writes typed INSTANCE engrams — one per real-world
// occurrence, with entity identity resolved against the registry
// (entity-identity.js) and provenance back to the turns that attest it.
//
// Design anchors:
// - Two strata, permanently composed: instances are the understood stratum;
//   the raw-turn sweep stays for reconciliation. Instances never replace
//   the primary record (fact-as-key, not fact-as-substitute).
// - Provenance is mandatory: an instance that cannot point at its source
//   turns is NOT written. Over-counting from invented instances is the
//   failure mode worse than today's.
// - Extraction unit is the worker WINDOW grouped by session, not the
//   single turn — utterance-level extraction atomizes one event into
//   many instances.
// - audience: substrate_internal — instances are a typed pool for a typed
//   question. Conversational recall never mounts them; the count reader
//   lifts them explicitly (audience:'all'). Poisoning-safe by construction.
// - Watermark idempotence, same mechanics as wm_consolidation: a
//   substrate_internal engram records processed_through; a pass that
//   cannot reach its extractor RETAINS the window (no watermark advance)
//   so unavailability queues instead of dropping.
'use strict';

const engram = require('./engram.js');
const state = require('./state.js');
const identity = require('./entity-identity.js');

const SCOPE_PREFIX = 'instance:';
const WATERMARK_SCOPE = 'system:instance_consolidation:watermark';
const KINDS = ['visit', 'purchase', 'event', 'activity', 'possession'];
const STATUSES = ['completed', 'planned', 'recurring', 'cancelled', 'owed'];
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function enabled() {
  return process.env.TROTH_INSTANCE_CONSOLIDATION === '1';
}

// ── Extraction prompt ───────────────────────────────────────────────────

// User-half only: instances record what the USER did/has/attended. The
// assistant's suggestions are the mirror-pollution class — never instances.
function buildPrompt(turns) {
  const lines = turns.map((t, i) =>
    '[' + i + '] (' + new Date(t.timestamp).toISOString().slice(0, 10) + ') ' +
    String(t.user_text || '').slice(0, 600));
  return [
    'Extract first-person INSTANCES from the user statements below.',
    'An instance is one real-world occurrence the user reports about themselves:',
    'a visit they made, a purchase, an event they attended, an activity they did,',
    'a possession they have.',
    '',
    'Rules:',
    '- ONLY what the user states about their own life. Never suggestions,',
    '  hypotheticals, or other people\'s actions.',
    '- One instance per real-world occurrence. The same occurrence mentioned',
    '  twice is ONE instance citing both statements.',
    '- status: completed | planned | recurring | cancelled — from the user\'s',
    '  wording, not assumed.',
    '- date_iso: YYYY-MM-DD only when the statement pins it; otherwise null.',
    '  NEVER guess dates.',
    '- turn_idxs: the [N] indexes attesting the instance. Mandatory.',
    '',
    'Return ONLY a JSON array (no prose):',
    '[{"kind":"visit|purchase|event|activity|possession","entity":"who/what",',
    '"description":"one line","date_iso":"YYYY-MM-DD or null",',
    '"status":"completed","qualifier":"verb from the user (visited/bought/attended/led/...)",',
    '"quantity":null,"turn_idxs":[0]}]',
    '',
    'User statements:',
    ...lines
  ].join('\n');
}

// ── Parse + validate ────────────────────────────────────────────────────

// Tolerant of fences and prose margins; intolerant of schema violations.
// A row missing its provenance (turn_idxs) is DROPPED, not repaired —
// the covenant is that every instance can show its turns.
function _validateInstanceRows(arr, turnCount, out) {
  for (const row of arr) {
    if (!row || typeof row !== 'object') { out.dropped++; continue; }
    const kind = String(row.kind || '').toLowerCase();
    const entity = String(row.entity || '').trim();
    const description = String(row.description || '').trim();
    const status = STATUSES.includes(String(row.status || '').toLowerCase())
      ? String(row.status).toLowerCase() : 'completed';
    const date_iso = (typeof row.date_iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date_iso))
      ? row.date_iso : null;
    const idxs = Array.isArray(row.turn_idxs)
      ? row.turn_idxs.filter(n => Number.isInteger(n) && n >= 0 && n < turnCount)
      : [];
    if (!KINDS.includes(kind) || !entity || !description || !idxs.length) {
      out.dropped++;
      continue;
    }
    out.instances.push({
      kind, entity, description, date_iso, status,
      qualifier: row.qualifier ? String(row.qualifier).trim() : null,
      quantity: Number.isFinite(row.quantity) ? row.quantity : null,
      turn_idxs: idxs
    });
  }
  return out;
}

// Tolerant of fences and prose margins; intolerant of schema violations.
function parseExtraction(text, turnCount) {
  const out = { instances: [], dropped: 0 };
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch (_) { return out; }
  if (!Array.isArray(arr)) return out;
  return _validateInstanceRows(arr, turnCount, out);
}

// Combined extraction: identities AND instances in ONE model call per
// session window. Identity comes first in the schema on purpose — instance
// merging consults the registry, so a session's identities must land
// before its instances are written.
function buildCombinedPrompt(turns) {
  const lines = turns.map((t, i) =>
    '[' + i + '] (' + new Date(t.timestamp).toISOString().slice(0, 10) + ') ' +
    String(t.user_text || '').slice(0, 600));
  return [
    'Extract TWO things from the user statements below.',
    '',
    '1. identities — people, places or organizations the user names with a',
    '   relation or role ("my sister Jen" → name Jen, relation sister;',
    '   "Dr. Patel, my ENT" → name Dr. Patel, relation ENT specialist).',
    '   Include alternate ways the user refers to them as aliases.',
    '2. instances — one entry per real-world occurrence the user reports',
    '   about themselves: a visit made, a purchase, an event attended, an',
    '   activity done, a possession. ONLY what the user states about their',
    '   own life — never suggestions or hypotheticals. The same occurrence',
    '   mentioned twice is ONE instance citing both statements.',
    '   status: completed | planned | recurring | cancelled — from the',
    '   user\'s wording. date_iso: YYYY-MM-DD only when the statement pins',
    '   it; otherwise null — NEVER guess dates. turn_idxs: the [N] indexes',
    '   attesting the entry. Mandatory.',
    '',
    'Return ONLY a JSON object (no prose):',
    '{"identities":[{"name":"Jen","kind":"person","relation":"sister","aliases":["my sister"]}],',
    ' "instances":[{"kind":"visit","entity":"Dr. Patel","description":"one line",',
    '"date_iso":null,"status":"completed","qualifier":"visited","quantity":null,"turn_idxs":[0]}]}',
    '',
    'User statements:',
    ...lines
  ].join('\n');
}

// v2: identities carry role/specialty, instances carry distinguishing
// attributes, and EVERY row carries a verbatim quote from the statements
// that attest it. The quote is verified mechanically (normalized substring
// against the session text) - an extraction that cannot show its sentence
// is dropped at the gate, no second model call needed.
function buildCombinedPromptV2(turns) {
  const lines = turns.map((t, i) =>
    '[' + i + '] (' + new Date(t.timestamp).toISOString().slice(0, 10) + ') ' +
    String(t.user_text || '').slice(0, 600));
  return [
    'Extract TWO things from the user statements below.',
    '',
    '1. identities - people, places or organizations the user names, with the',
    '   most SPECIFIC role or relation the statements support: a medical',
    '   specialty ("ENT specialist", "dermatologist"), a profession, a',
    '   kinship ("sister"). Include every way the user refers to them as',
    '   aliases ("my sister", "the ENT", "Dr. Patel").',
    '2. instances - one entry per real-world occurrence the user reports',
    '   about themselves (visit, purchase, event, activity, possession).',
    '   ONLY what the user states about their own life - never suggestions',
    '   or hypotheticals. The same occurrence mentioned twice is ONE entry',
    '   citing both statements. The description MUST carry the DISTINGUISHING',
    '   attributes the statements give (size, name, model, place: "20-gallon',
    '   community tank", not just "tank").',
    '   status: completed | planned | recurring | cancelled | owed - from the',
    '   user\'s wording, never assumed. "owed" is an outstanding obligation',
    '   the user has incurred and not yet discharged (still to return,',
    '   still to pick up, still owes, must renew). "owed" is something the',
    '   USER must still do - a thing merely expected to arrive or happen on',
    '   its own is not owed. A stated obligation stays owed until the user',
    '   explicitly says it was done: narrating a related past action does',
    '   not discharge "I need to...".',
    '   An outstanding obligation is its OWN instance, separate from the',
    '   purchase or exchange that created it: "I bought boots and I still',
    '   need to return them" is TWO entries - the purchase (completed) and',
    '   the return (owed).',
    '   kind MUST be one of: visit, purchase, event, activity, possession.',
    '   NEVER invent a kind. Intention and obligation live in status, never',
    '   in kind - write kind:"activity" status:"planned", not',
    '   "planned_activity". A trip or a stay is kind:"visit".',
    '   date_iso: YYYY-MM-DD only when the statement pins',
    '   it; otherwise null - NEVER guess dates. turn_idxs: the [N] indexes',
    '   attesting the entry.',
    '',
    'EVERY identity and instance MUST include "quote": a verbatim snippet',
    '(at most 160 characters) copied EXACTLY from one of the statements that',
    'attest it. No quote, no entry.',
    '',
    'Return ONLY a JSON object (no prose):',
    '{"identities":[{"name":"Dr. Patel","kind":"person","relation":"ENT specialist",',
    '"aliases":["the ENT"],"quote":"..."}],',
    ' "instances":[{"kind":"visit","entity":"Dr. Patel","description":"ENT follow-up for sinusitis",',
    '"date_iso":null,"status":"completed","qualifier":"visited","quantity":null,"turn_idxs":[0],"quote":"..."}]}',
    '',
    'User statements:',
    ...lines
  ].join('\n');
}

function _normQuote(s) {
  return String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Mechanical grounding: the quote must appear (normalized) inside the
// session's own text. Pure string arithmetic - no model, no judgment.
// A quote may splice turns with an ellipsis; each elided span is then
// required separately — of the spans long enough to verify (≥8 normalized
// chars) every one must be present, and for instances the haystack narrows
// to the turns the row itself cites, so two true spans from unrelated
// turns cannot be stitched into one false claim. Single-span quotes take
// exactly the original path.
function _quoteAttested(quote, turns, idxs) {
  const raw = String(quote || '');
  const parts = raw.split(/\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*/).filter(Boolean);
  if (parts.length <= 1) {
    const q = _normQuote(raw);
    if (q.length < 8) return false;
    const hay = _normQuote(turns.map((t) => t.user_text).join(' '));
    return hay.indexOf(q) >= 0;
  }
  let pool = turns;
  if (Array.isArray(idxs) && idxs.length) {
    const within = idxs.filter((i) => Number.isInteger(i) && i >= 0 && i < turns.length);
    if (within.length) pool = within.map((i) => turns[i]);
  }
  const hay = _normQuote(pool.map((t) => t.user_text).join(' '));
  const spans = parts.map(_normQuote).filter((s) => s.length >= 8);
  if (!spans.length) return false;
  return spans.every((s) => hay.indexOf(s) >= 0);
}

function parseCombinedExtractionV2(text, turnCount, turns) {
  const base = parseCombinedExtraction(text, turnCount);
  const out = { identities: [], instances: [], dropped: base.dropped, quote_fail: 0 };
  const src = String(text || '');
  let obj = null;
  try { obj = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)); } catch (_) { obj = null; }
  const idRows = (obj && Array.isArray(obj.identities)) ? obj.identities : [];
  const instRows = (obj && Array.isArray(obj.instances)) ? obj.instances : [];
  for (const ident of base.identities) {
    const row = idRows.find((r) => r && String(r.name || '').trim() === ident.name);
    if (row && _quoteAttested(row.quote, turns)) {
      ident.quote = String(row.quote).slice(0, 200);
      out.identities.push(ident);
    } else { out.quote_fail++; }
  }
  for (const inst of base.instances) {
    const row = instRows.find((r) => r && String(r.entity || '').trim() === inst.entity &&
      String(r.description || '').trim() === inst.description);
    if (row && _quoteAttested(row.quote, turns, inst.turn_idxs)) {
      inst.quote = String(row.quote).slice(0, 200);
      out.instances.push(inst);
    } else { out.quote_fail++; }
  }
  return out;
}

function parseCombinedExtraction(text, turnCount) {
  const out = { identities: [], instances: [], dropped: 0 };
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return out;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch (_) { return out; }
  if (!obj || typeof obj !== 'object') return out;
  for (const row of (Array.isArray(obj.identities) ? obj.identities : [])) {
    if (!row || typeof row !== 'object') { out.dropped++; continue; }
    const name = String(row.name || '').trim();
    if (!name || name.length < 2 || name.length > 80) { out.dropped++; continue; }
    out.identities.push({
      name,
      kind: row.kind ? String(row.kind) : null,
      relation: row.relation ? String(row.relation) : null,
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String).slice(0, 8) : []
    });
  }
  _validateInstanceRows(Array.isArray(obj.instances) ? obj.instances : [], turnCount, out);
  return out;
}

// ── Write ───────────────────────────────────────────────────────────────────────

// Verb classes for facet accounting. Closed and tiny on purpose: the class
// ranks commitment (a stated "played" is never demoted by a later
// "interested in"); the raw verb is preserved so surface form never dies.
const _VERB_CLASSES = [
  [/^(led|lead(s)?|ran|run|organi[sz]ed|hosted|managed|founded|directed)\b/, 'agentive'],
  [/^(played|attended|visited|went|watched|saw|took|did|completed|finished|got back|wore|made)\b/, 'experiential'],
  [/^(worked on|joined|helped|contributed|participated)\b/, 'participatory'],
  [/^(bought|purchased|sold|returned|exchanged|ordered|paid|got)\b/, 'transactional'],
  [/^(planning|planned to|considering|interested in|thinking|might|want(ed)? to|hoping|going to|will|schedule)\b/, 'prospective']
];

function _verbClass(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return 'other';
  for (const pair of _VERB_CLASSES) if (pair[0].test(s)) return pair[1];
  return 'other';
}

function _mergeFacets(oldFacets, oldQualifier, oldRefs, newQualifier, newRefs) {
  const facets = Array.isArray(oldFacets)
    ? oldFacets.map((f) => ({ verb: f.verb, class: f.class, refs: (f.refs || []).slice() }))
    : [];
  if (!facets.length && oldQualifier) {
    facets.push({ verb: oldQualifier, class: _verbClass(oldQualifier), refs: (oldRefs || []).slice() });
  }
  if (newQualifier) {
    const hit = facets.find((f) => f.verb === newQualifier);
    if (hit) {
      for (const r of (newRefs || [])) if (hit.refs.indexOf(r) === -1) hit.refs.push(r);
    } else {
      facets.push({ verb: newQualifier, class: _verbClass(newQualifier), refs: (newRefs || []).slice() });
    }
  }
  return facets;
}

// A stated commitment outranks a prospect; ties go to the earliest attested.
function _primaryQualifier(facets, fallback) {
  if (!Array.isArray(facets) || !facets.length) return fallback || null;
  const solid = facets.find((f) => f.class !== 'prospective' && f.class !== 'other') ||
    facets.find((f) => f.class !== 'prospective');
  return (solid || facets[0]).verb;
}

// A retelling must never blank measured substance: keep whichever description
// carries digits when only one does; otherwise the newer non-empty wins.
function _preferDescription(oldD, newD) {
  const o = String(oldD || '');
  const n = String(newD || '');
  if (!n) return o;
  if (!o) return n;
  if (/\d/.test(o) && !/\d/.test(n)) return o;
  return n;
}

// A merge keeps ONE primary description and never silently discards the
// other: when the losing retelling carries any content token the primary
// lacks, it survives as a ' · ' clause on the same string — so the fact a
// user stated twice ("30 hours on hard", then "25 on normal") stays on the
// row every surface mounts. Bounds degrade to the primary unchanged, never
// to a truncated clause: this exists to end silent truncation, not to
// reintroduce it. An overlap threshold cannot gate this — measured: shared
// extractor boilerplate swamps the discriminators (games 0.667, citrus
// 0.571 overlap, both destroyed) — so the trigger is any novel content
// token at all.
const _CLAUSE_SEP = ' · ';
function _composeDescription(oldD, newD) {
  const primary = _preferDescription(oldD, newD);
  const o = String(oldD || ''), n = String(newD || '');
  const discarded = primary === n ? o : n;
  if (!discarded || discarded === primary) return primary;
  const tok = (x) => new Set(String(x || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 4 || /^\d+$/.test(t)));
  const p = tok(primary);
  let novel = false;
  for (const t of tok(discarded)) if (!p.has(t)) { novel = true; break; }
  if (!novel) return primary;
  if (primary.split(_CLAUSE_SEP).length + discarded.split(_CLAUSE_SEP).length > 3) return primary;
  const candidate = primary + _CLAUSE_SEP + discarded;
  return candidate.length > 400 ? primary : candidate;
}

function _statementFor(inst) {
  const extras = (inst.facets || [])
    .filter((f) => f && f.verb && f.verb !== inst.qualifier)
    .map((f) => f.verb);
  return inst.kind + ': ' +
    (inst.qualifier ? inst.qualifier + ' ' : '') +
    inst.entity + ' — ' + inst.description +
    (Number.isFinite(inst.quantity) ? ' (qty ' + inst.quantity + ')' : '') +
    ' [' + inst.status + (inst.basis === 'entailed' ? ', inferred' : '') + (inst.date_iso ? ', ' + inst.date_iso : '') + ']' +
    (extras.length ? ' (also said: ' + extras.join(', ') + ')' : '');
}

// Current instance pool — the ONE view lifecycle matching runs against.
// listEngrams follows supersession chains, so a superseded instance never
// re-matches. Loaded once per pass and mutated as writes land.
function _loadPool(opts) {
  const pool = [];
  try {
    const rows = engram.listEngrams({
      scope_prefix: SCOPE_PREFIX,
      audience: 'all',
      agent_id: opts.agent_id || undefined,
      limit: 1000
    }) || [];
    for (const r of rows) {
      const inst = r && r.payload && r.payload.instance;
      if (inst) pool.push({ id: r.id, statement: String(r.statement || '').trim(), instance: inst });
    }
  } catch (_) {}
  return pool;
}

function _refsOf(id) {
  try {
    const raw = state.getAction(id);
    if (!raw) return [];
    const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : (raw.output || {});
    return Array.isArray(out.provenance_ref) ? out.provenance_ref.map(String) : [];
  } catch (_) { return []; }
}

function _normEntity(s) {
  return String(s || '').trim().toLowerCase().normalize('NFKC');
}

// Same real-world occurrence? Conservative on purpose — over-counting
// (two instances for one wedding) is the covenant-breaking failure, so
// ambiguity merges: same kind, same entity IDENTITY (slug when both
// resolved, normalized surface string otherwise), and dates compatible.
// Two PINNED, different dates are two occurrences — never merged.
function _descOverlap(a, b) {
  // Numbers are kept whole ("5" vs "20" gallons IS the difference between
  // two possessions); words shorter than 4 chars are noise.
  const tok = (x) => new Set(String(x || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 4 || /^\d+$/.test(t)));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

// Social events retold across sessions drift in entity wording ("Emily and
// Sarah's wedding" / "my cousin's wedding" / "Rachel") while the separating
// truth lives elsewhere: named participants, and place/time ANCHORS inside
// the text. Measured on a real haystack where every session shares one
// date, so session timestamps separate nothing. Four rungs, in order:
// disjoint named participants split; a shared name joins; same-axis anchors
// with no overlap split; no separator anywhere joins (retellings are the
// norm, over-counting the covenant-breaking failure).
const _EVENT_HEAD = /(wedding|birthday|funeral|graduation|anniversary|baby shower|bachelorette|bachelor party|reunion|festival)/i;
const _NAME_STOP = new Set(['User', 'The', 'A', 'An', 'My', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

function _eventText(inst) {
  return String(inst.entity || '') + ' ' + String(inst.description || '') + ' ' + String(inst.quote || '');
}

function _headNoun(inst) {
  const m = _EVENT_HEAD.exec(_eventText(inst));
  return m ? m[1].toLowerCase() : null;
}

// Role words are WEAK names: they mark that someone is named, but a shared
// role never joins two occasions on its own - two different cousins have
// two different weddings. Proper names stay strong.
const _ROLE_WORDS = new Set(['cousin', 'sister', 'brother', 'mother', 'father', 'mom', 'dad',
  'aunt', 'uncle', 'niece', 'nephew', 'grandma', 'grandpa', 'grandmother', 'grandfather',
  'roommate', 'friend', 'partner', 'neighbor', 'neighbour', 'colleague', 'boss', 'wife',
  'husband', 'spouse', 'bride', 'groom', 'sibling', 'parent', 'child', 'son', 'daughter',
  'family', 'buddy', 'classmate', 'coworker']);

// Identities per role word within the caller's brain: when TWO known people
// are cousins, the bare alias "my cousin" names neither of them uniquely.
function _roleOwnerCounts(opts) {
  const map = new Map();
  try {
    const ident = require('./entity-identity.js');
    const regs = ident.loadRegistry({ agent_id: opts && opts.agent_id }) || [];
    for (const r of regs) {
      const rel = String(r.relation || '').toLowerCase();
      for (const w of rel.split(/[^a-z]+/)) if (_ROLE_WORDS.has(w)) map.set(w, (map.get(w) || 0) + 1);
    }
  } catch (_) {}
  return map;
}

function _nameTokens(inst, opts) {
  const text = _eventText(inst);
  const desc = String(inst.description || '');
  const ent = String(inst.entity || '');
  const out = new Set();
  const weak = new Set();
  const dOpenM = /^\s*([A-Z][a-z]{2,})\b/.exec(desc);
  const dOpen = dOpenM ? dOpenM[1] : null;
  const isPossessive = (w) => new RegExp('\\b' + w + "['’]s\\b").test(desc);
  const lcOnlyInEntity = (w) => new RegExp('\\b' + w.toLowerCase() + '\\b').test(ent) &&
    !new RegExp('\\b' + w.toLowerCase() + '\\b').test(desc + ' ' + String(inst.quote || ''));
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    if (_NAME_STOP.has(m[1])) continue;
    // A real name is capitalized EVERYWHERE it appears; a word that also
    // shows up lowercase in the same text is sentence-case, not a person -
    // unless the lowercase lives only in the ENTITY while the description
    // holds it as a POSSESSIVE ("sister's wedding" + "Sister's wedding
    // where..."): that is a name.
    if (new RegExp('\\b' + m[1].toLowerCase() + '\\b').test(text) && !(isPossessive(m[1]) && lcOnlyInEntity(m[1]))) continue;
    // A capitalized description OPENER is a sentence start, not a person -
    // unless possessive, or echoed by the entity itself.
    if (dOpen && m[1] === dOpen && !isPossessive(m[1]) && !new RegExp('\\b' + m[1] + '\\b', 'i').test(ent)) continue;
    if (_ROLE_WORDS.has(m[1].toLowerCase())) { weak.add(m[1].toLowerCase()); continue; }
    out.add(m[1].toLowerCase());
  }
  // A lowercase POSSESSIVE role names a person relationally ("mom's 60th",
  // "my cousin's wedding") - weak, like its capitalized form.
  for (const m of (desc + ' ' + ent).matchAll(/\b([a-z]{2,})['’]s\b/g)) {
    if (_ROLE_WORDS.has(m[1])) weak.add(m[1]);
  }
  // The registry speaks for role-only references: "the bride's wedding"
  // carries Jen into the participant rung when exactly one identity owns
  // that alias - a shared alias stays silent, same hits-of-one idiom the
  // entity resolver already uses. A bare-role alias whose role two known
  // people hold names neither; a canonical that is itself a role stays weak.
  try {
    const ident = require('./entity-identity.js');
    const hits = ident.lookupFromText(text, { agent_id: opts && opts.agent_id }) || [];
    if (hits.length) {
      const counts = ident.uniqueNameOwners({ agent_id: opts && opts.agent_id });
      const roleOwners = _roleOwnerCounts(opts);
      const roleAmbiguous = (n) => {
        const bare = String(n || '').replace(/^(?:my|the|our)\s+/i, '').trim().toLowerCase();
        return _ROLE_WORDS.has(bare) && (roleOwners.get(bare) || 0) > 1;
      };
      for (const h of hits) {
        const uniq = (h.matched || []).some((n) => counts.get(ident.normAlias(n)) === 1 && !roleAmbiguous(n));
        if (!uniq || !h.identity || !h.identity.canonical) continue;
        const c = String(h.identity.canonical).toLowerCase();
        if (c.split(/\s+/).some((w) => _ROLE_WORDS.has(w))) weak.add(c); else out.add(c);
      }
    }
  } catch (_) { /* registry absent - surface names alone */ }
  out._weak = weak;
  return out;
}

function _eventAnchors(inst) {
  const text = _eventText(inst).toLowerCase();
  const anchors = new Set();
  for (const m of text.matchAll(/\b(?:in|last|this|next)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/g)) anchors.add('t:' + m[1]);
  if (/\blast weekend\b/.test(text)) anchors.add('t:last-weekend');
  if (/\blast month\b/.test(text)) anchors.add('t:last-month');
  if (/\byesterday\b/.test(text)) anchors.add('t:yesterday');
  for (const m of text.matchAll(/\b(vineyard|beach|rooftop|church|downtown|hotel|barn|lakeside|mountains?|backyard|city)\b/g)) anchors.add('p:' + m[1]);
  return anchors;
}

// A self-referential entity names the speaker, not a thing. In a single-user
// ledger every row is implicitly about the user, so 'user' carries zero
// discriminating information as a merge key — two such rows are never the
// same occurrence by name alone. The list is measured from the extraction
// corpus: only these two strings occur; near-self entities ("my sister",
// "user's website") name real things and keep merging normally.
const SELF_ENTITY = new Set(['user', 'self']);

function _sameEvent(e, inst, opts) {
  const h1 = _headNoun(e), h2 = _headNoun(inst);
  if (!h1 || h1 !== h2) return null; // not this arm's call
  const n1 = _nameTokens(e, opts), n2 = _nameTokens(inst, opts);
  // A shared PROPER name joins, and outranks anchors: a unique registry
  // alias must carry a retelling through a drifting venue description.
  for (const n of n1) if (n2.has(n)) return true;
  const a1 = _eventAnchors(e), a2 = _eventAnchors(inst);
  const axis = (s, p) => [...s].some((x) => x.startsWith(p));
  const axisShared = (p) => [...a1].some((x) => x.startsWith(p) && a2.has(x));
  // Same axis on both sides with nothing shared is two occasions.
  if (axis(a1, 't:') && axis(a2, 't:') && !axisShared('t:')) return false;
  if (axis(a1, 'p:') && axis(a2, 'p:') && !axisShared('p:')) return false;
  // A shared anchor is positive evidence of the same occasion even when
  // the human labels drift (roommate / cousin / friend).
  if (axisShared('t:') || axisShared('p:')) return true;
  // Both sides name someone - proper or role - and share nobody: two
  // occasions. A shared role alone falls through to the covenant default.
  const w1 = n1._weak || new Set(), w2 = n2._weak || new Set();
  if ((n1.size + w1.size) && (n2.size + w2.size)) {
    let anyShared = false;
    for (const w of w1) if (w2.has(w)) anyShared = true;
    if (!anyShared) return false;
  }
  return true; // nothing separates them - the same occasion, retold
}

function _sameOccurrence(entry, inst, entity_slug, opts) {
  const e = entry.instance;
  if (!e || e.kind !== inst.kind) return false;
  // An entailed occurrence and a stated one with DIFFERENT statuses are
  // different occurrences by construction: the derived prior visit must
  // never absorb the scheduled follow-up it was inferred from.
  if ((e.basis === 'entailed') !== (inst.basis === 'entailed') && e.status !== inst.status) return false;
  if (e.kind === 'event') {
    const verdict = _sameEvent(e, inst, opts);
    if (verdict === false) return false;
    if (verdict === true) {
      // Two PINNED, different dates are two occurrences - never merged,
      // whatever the wording shares.
      if (e.date_iso && inst.date_iso && e.date_iso !== inst.date_iso) return false;
      return true;
    }
  }
  if (SELF_ENTITY.has(_normEntity(inst.entity))) return false;
  const entityMatch = (e.entity_slug && entity_slug)
    ? e.entity_slug === entity_slug
    : _normEntity(e.entity) === _normEntity(inst.entity);
  if (!entityMatch) return false;
  if (e.date_iso && inst.date_iso && e.date_iso !== inst.date_iso) return false;
  // Possessions are the kind where several similar items are the NORM
  // (three fish tanks, two rackets): a name-level match with unpinned
  // dates is not the same object unless the descriptions agree too.
  if (inst.kind === 'possession' && _descOverlap(e.description, inst.description) < 0.5) return false;
  return true;
}

// Status lifecycle: newest evidence wins, terminal states never regress.
// A stale "planned" retelling cannot downgrade a completed/cancelled
// occurrence — the ku organ's newest-wins, with a direction guard.
const TERMINAL_STATUS = { completed: true, cancelled: true };

// ── Entailed occurrences ──────────────────────────────────────────────
// Some statements ENTAIL a completed occurrence without stating it: booking
// a follow-up presupposes the first visit; holding a prescription "from
// Dr. P" is impossible without an encounter. Membership test for the
// artifact schema (encounter-constitutive): could the user truthfully hold
// this "from P" with zero interaction ever having occurred? A closed
// schema mints visit rows [completed, inferred] carrying the entailing
// turns as receipts. Derivation reads STATED rows only (no chaining),
// never mints when a stated completed visit for the same person exists,
// and ships dark behind its own flag.
const _ARTIFACT_RE = /\b(prescription|referral|diagnosis|filling|crown|stitches)\b[^.]*?\bfrom\s+(Dr\.?\s*[A-Z][\w.]*(?:\s+[A-Z][a-z]+)?|[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)/;
const _FOLLOWUP_RE = /\b(follow[\s-]?up|another appointment with|again with)\b/i;

function entailmentEnabled() {
  return process.env.TROTH_INSTANCE_ENTAILMENT === '1';
}

function _hasStatedCompletedVisit(pool, entity) {
  const norm = _normEntity(entity);
  return pool.some((p) => {
    const e = p.instance;
    return e && e.kind === 'visit' && e.status === 'completed' && e.basis !== 'entailed' && _normEntity(e.entity) === norm;
  });
}

function _deriveEntailed(pool, opts, stats) {
  const derived = [];
  for (const p of pool.slice()) {
    const e = p.instance;
    if (!e || e.basis === 'entailed') continue;
    const text = String(e.description || '') + ' ' + String(p.statement || '');
    if (e.kind === 'visit' && _FOLLOWUP_RE.test(text) && !_hasStatedCompletedVisit(pool, e.entity)) {
      derived.push({
        kind: 'visit', entity: e.entity,
        description: 'prior visit implied by the follow-up being arranged',
        date_iso: null, status: 'completed', basis: 'entailed',
        qualifier: 'visited', quantity: null,
        _provenance_refs: _refsOf(p.id)
      });
    }
    if (e.kind === 'possession' || e.kind === 'purchase') {
      const m = _ARTIFACT_RE.exec(String(e.description || ''));
      if (m && m[2] && !_hasStatedCompletedVisit(pool, m[2])) {
        derived.push({
          kind: 'visit', entity: m[2].trim(),
          description: 'visit implied by the ' + m[1] + ' they issued',
          date_iso: null, status: 'completed', basis: 'entailed',
          qualifier: 'visited', quantity: null,
          _provenance_refs: _refsOf(p.id)
        });
      }
    }
  }
  if (!derived.length) return;
  const w = writeInstances({
    instances: derived, turns: [],
    agent_id: opts.agent_id, user_id: opts.user_id, cwd: opts.cwd,
    session_id: opts.session_id || null, source: 'instance_entailment',
    _pool: pool, _entailing: true
  });
  stats.derived = (stats.derived || 0) + w.written + w.strengthened;
}

function writeInstances(opts) {
  const turns = opts.turns || [];
  const stats = { written: 0, dup: 0, no_provenance: 0, transitions: 0, strengthened: 0 };
  const pool = opts._pool || _loadPool(opts);
  for (const inst of (opts.instances || [])) {
    const refs = Array.isArray(inst._provenance_refs) && inst._provenance_refs.length
      ? inst._provenance_refs.slice()
      : (inst.turn_idxs || [])
        .map(i => turns[i] && turns[i].id ? 'dialogue.turn:' + turns[i].id : null)
        .filter(Boolean);
    if (!refs.length) { stats.no_provenance++; continue; }
    // Identity resolution: if the mind knows who this entity is, the
    // instance carries the canonical slug — counting merges by identity,
    // not by surface string ("my sister" and "Jen" become one column).
    let entity_slug = null, canonical = null;
    try {
      const hits = identity.lookupFromText(inst.entity, { agent_id: opts.agent_id });
      if (hits.length === 1) {
        entity_slug = hits[0].identity.slug;
        canonical = hits[0].identity.canonical;
      }
    } catch (_) {}

    const match = pool.find(p => _sameOccurrence(p, inst, entity_slug, opts));
    let finalInst, supersedes = null, reason = null, provenance = refs;
    if (match) {
      const old = match.instance;
      const oldRefs = _refsOf(match.id);
      provenance = Array.from(new Set(oldRefs.concat(refs)));
      // Basis precedence: an entailed arrival may only ATTEST a stated row
      // (provenance grows, every field stands); a stated arrival onto an
      // entailed row overwrites freely and promotes the basis.
      if (inst.basis === 'entailed' && old.basis !== 'entailed') {
        if (provenance.length === oldRefs.length) { stats.dup++; continue; }
        finalInst = Object.assign({}, old);
        supersedes = match.id;
        reason = 'entailed_attestation';
      } else {
      let status = inst.status;
      if (TERMINAL_STATUS[old.status] && inst.status === 'planned') status = old.status;
      const changed = status !== old.status || provenance.length !== oldRefs.length || (old.basis === 'entailed' && inst.basis !== 'entailed');
      if (!changed) { stats.dup++; continue; }
      // Every verb the user ever attached to this occurrence is kept as an
      // attested facet with its own receipts — a later "interested in" adds a
      // facet, it never overwrites a stated "played". The scalar qualifier
      // stays the strongest commitment so the rendered line cannot lie.
      const facets = _mergeFacets(old.facets, old.qualifier, oldRefs, inst.qualifier, refs);
      finalInst = {
        kind: inst.kind,
        // Keep the richer identity: canonical when known, else whichever
        // surface form arrived first.
        entity: canonical || old.canonical || inst.entity,
        entity_slug: entity_slug || old.entity_slug || null,
        canonical: canonical || old.canonical || null,
        description: _composeDescription(old.description, inst.description),
        date_iso: inst.date_iso || old.date_iso || null,
        status,
        basis: (inst.basis !== 'entailed' || old.basis !== 'entailed') ? 'stated' : 'entailed',
        qualifier: _primaryQualifier(facets, inst.qualifier || old.qualifier || null),
        facets,
        quantity: Number.isFinite(inst.quantity) ? inst.quantity : (old.quantity != null ? old.quantity : null),
        session_id: opts.session_id || old.session_id || null
      };
      supersedes = match.id;
      reason = old.basis === 'entailed' && inst.basis !== 'entailed'
        ? 'basis_promotion'
        : (status !== old.status ? 'status_transition' : 'restatement');
      }
    } else {
      finalInst = {
        kind: inst.kind,
        entity: canonical || inst.entity,
        entity_slug,
        canonical,
        description: inst.description,
        date_iso: inst.date_iso,
        status: inst.status,
        basis: inst.basis === 'entailed' ? 'entailed' : 'stated',
        qualifier: inst.qualifier,
        facets: inst.qualifier ? [{ verb: inst.qualifier, class: _verbClass(inst.qualifier), refs: refs.slice() }] : [],
        quantity: inst.quantity,
        session_id: opts.session_id || null
      };
    }

    const statement = _statementFor(finalInst);
    const extra_output = {
      payload: { instance: finalInst },
      provenance_ref: provenance
    };
    if (supersedes) extra_output.lifetime = { supersedes, reason };
    const id = engram.recordEngram({
      agent_id: opts.agent_id,
      user_id: opts.user_id,
      cwd: opts.cwd || null,
      statement,
      scope: SCOPE_PREFIX + finalInst.kind,
      source: opts.source || 'instance_consolidation',
      source_authority: 'plr_evolved',
      audience: 'substrate_internal',
      memory_class: 'operational',
      auto_verify: false,
      extra_output
    });
    if (!id) continue;
    const entry = { id, statement, instance: finalInst };
    if (supersedes) {
      const at = pool.indexOf(match);
      if (at >= 0) pool[at] = entry; else pool.push(entry);
      if (reason === 'status_transition') stats.transitions++; else stats.strengthened++;
    } else {
      pool.push(entry);
      stats.written++;
    }
  }
  if (entailmentEnabled() && !opts._entailing) {
    try { _deriveEntailed(pool, opts, stats); } catch (_) { /* derivation is additive — never fatal */ }
  }
  return stats;
}

// ── Window pass (worker + bench share this) ─────────────────────────────

function _readWatermark(agent_id) {
  try {
    const marks = engram.listEngrams({ audience: 'substrate_internal', limit: 20, agent_id: agent_id || undefined }) || [];
    const last = marks
      .filter(e => e && e.scope === WATERMARK_SCOPE)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    if (last && last.statement) {
      const m = last.statement.match(/processed_through:\s*(\d+)/);
      if (m) return parseInt(m[1], 10) || 0;
    }
  } catch (_) {}
  return 0;
}

function _writeWatermark(opts, ts) {
  try {
    engram.recordEngram({
      agent_id: opts.agent_id,
      user_id: opts.user_id,
      cwd: opts.cwd || null,
      statement: 'processed_through: ' + ts,
      scope: WATERMARK_SCOPE,
      source: 'instance_consolidation',
      audience: 'substrate_internal',
      memory_class: 'operational',
      salience: 0.1,
      auto_verify: false
    });
  } catch (_) {}
}

function _turnHalves(row) {
  let inp;
  try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input; }
  catch (_) { inp = null; }
  return {
    id: row.id,
    timestamp: row.timestamp,
    session_id: row.session_id || null,
    user_text: (inp && inp.args && inp.args.user_text) || ''
  };
}

// One consolidation pass over turns newer than the watermark.
// llmCall: async (prompt) => text. Injected — the worker wires the local
// transport, the bench wires the studio answerer, tests wire a fixture.
// Extractor unreachable ⇒ the pass aborts BEFORE the watermark advances:
// the un-distilled window is the queue, and the next pass retries it.
//
// opts.since (explicit, ≥0): the caller owns the window. The watermark is
// neither read nor written — required for ingested histories whose turns
// carry timestamps far older than any cadence lookback (a bench haystack,
// an imported archive): the 24h first-run guard would otherwise see an
// empty window and distill nothing. Idempotence in caller-windowed mode
// comes from pool matching, not from the watermark.
async function runPass(opts) {
  opts = opts || {};
  if (typeof opts.llmCall !== 'function') throw new Error('instance-consolidation: llmCall required');
  const now = opts.now || Date.now();
  const callerWindow = Number.isFinite(opts.since) && opts.since >= 0;
  let since;
  if (callerWindow) {
    since = opts.since;
  } else {
    since = _readWatermark(opts.agent_id);
    if (!since) since = now - FIRST_RUN_LOOKBACK_MS;
  }

  let rows = [];
  try {
    rows = state.queryActions({
      type: 'tool_call',
      agent_id: opts.agent_id || undefined,
      since: callerWindow ? since : since + 1,
      limit: opts.limit || 200,
      order: 'asc'
    }) || [];
  } catch (_) { rows = []; }
  const turns = rows.map(_turnHalves).filter(t => t.user_text && t.user_text.length >= 12);
  if (!turns.length) {
    return { processed: 0, written: 0, dup: 0, no_provenance: 0, dropped: 0, watermark: since, advanced: false };
  }

  // Group by session — the extraction unit. Within one window a session's
  // turns arrive together, so one occurrence told across three turns is
  // seen whole and distilled once.
  const bySession = new Map();
  for (const t of turns) {
    const k = t.session_id || '__unscoped__';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(t);
  }

  const stats = { processed: turns.length, written: 0, dup: 0, no_provenance: 0, dropped: 0, transitions: 0, strengthened: 0 };
  const pool = _loadPool(opts);
  let latestTs = since;
  for (const [sessionId, sessTurns] of bySession) {
    const prompt = buildPrompt(sessTurns);
    let raw;
    try {
      raw = await opts.llmCall(prompt);
    } catch (e) {
      // Extractor down — retain the whole window for the next pass.
      return Object.assign(stats, { watermark: since, advanced: false, transport_error: String(e && e.message || e) });
    }
    const parsed = parseExtraction(raw, sessTurns.length);
    stats.dropped += parsed.dropped;
    const w = writeInstances({
      instances: parsed.instances,
      turns: sessTurns,
      agent_id: opts.agent_id,
      user_id: opts.user_id,
      cwd: opts.cwd,
      session_id: sessionId === '__unscoped__' ? null : sessionId,
      _pool: pool
    });
    stats.written += w.written;
    stats.dup += w.dup;
    stats.no_provenance += w.no_provenance;
    stats.transitions += w.transitions;
    stats.strengthened += w.strengthened;
    for (const t of sessTurns) latestTs = Math.max(latestTs, t.timestamp);
  }
  if (!callerWindow) _writeWatermark(opts, latestTs);
  return Object.assign(stats, {
    watermark: latestTs,
    advanced: !callerWindow,
    windowed_by: callerWindow ? 'caller' : 'watermark'
  });
}

// Default extractor transport: the configured llama.cpp server, spoken
// raw and deterministically (temperature 0, thinking off, bounded).
// Same request shape the bench's local lane uses.
function makeLlamacppExtractor(cfg) {
  cfg = cfg || {};
  const transportConfig = require('./transport-config.js');
  const host = cfg.host || transportConfig.llamacppHost();
  const timeoutMs = cfg.timeout_ms || 60 * 1000;
  return async function llmCall(prompt) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(String(host).replace(/\/$/, '') + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: cfg.max_tokens || 1024,
          stream: false,
          chat_template_kwargs: { enable_thinking: false }
        })
      });
      if (!res.ok) throw new Error('extractor http ' + res.status);
      const body = await res.json();
      const msg = body && body.choices && body.choices[0] && body.choices[0].message;
      return (msg && msg.content) || '';
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  enabled,
  entailmentEnabled,
  buildPrompt,
  parseExtraction,
  buildCombinedPrompt,
  buildCombinedPromptV2,
  parseCombinedExtraction,
  parseCombinedExtractionV2,
  writeInstances,
  runPass,
  makeLlamacppExtractor,
  SCOPE_PREFIX,
  WATERMARK_SCOPE,
  KINDS,
  STATUSES
};
