'use strict';

const engram = require('./engram.js');
const state = require('./state.js');

const REGISTRY_SCOPE_PREFIX = 'context:registry:';
const CTX_PREFIX = 'ctx:';
const UNSORTED = 'ctx:unsorted';

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9Ͱ-Ͽ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || null;
}

function contextIdFor(name) {
  const slug = slugify(name);
  return slug ? CTX_PREFIX + slug : null;
}

function listContexts(opts) {
  opts = opts || {};
  const rows = engram.listEngrams({
    audience: 'all',
    principal: null,
    scope_prefix: REGISTRY_SCOPE_PREFIX,
    limit: Math.min(500, opts.limit || 200)
  }) || [];
  const bySlug = new Map();
  for (const e of rows) {
    if (!e || typeof e.scope !== 'string') continue;
    const slug = e.scope.slice(REGISTRY_SCOPE_PREFIX.length);
    if (!slug) continue;
    const prev = bySlug.get(slug);
    if (!prev || (e.ts || 0) > (prev.ts || 0)) {
      bySlug.set(slug, {
        slug,
        context_id: CTX_PREFIX + slug,
        statement: e.statement || null,
        source_authority: e.source_authority || null,
        ts: e.ts || null,
        id: e.id
      });
    }
  }
  return [...bySlug.values()];
}

function ensureContext(name, opts) {
  opts = opts || {};
  const slug = slugify(name);
  if (!slug) return { ok: false, error: 'unslugifiable_name' };
  const existing = listContexts().find((c) => c.slug === slug);
  if (existing) return { ok: true, context_id: existing.context_id, existed: true, id: existing.id };
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'context-registry',
    user_id: opts.user_id || 'default',
    cwd: opts.cwd || null,
    statement: 'context ' + slug + (opts.purpose ? ': ' + String(opts.purpose).slice(0, 300) : ''),
    source: opts.source || 'context-registry.ensureContext',
    source_authority: opts.source_authority || 'llm_inferred',
    scope: REGISTRY_SCOPE_PREFIX + slug,
    audience: 'substrate_internal',
    memory_class: 'operational',
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'registry_write_refused' };
  return { ok: true, context_id: CTX_PREFIX + slug, existed: false, id };
}

function seedContexts(opts) {
  opts = opts || {};
  const created = [];
  const seen = new Set(listContexts().map((c) => c.slug));
  const add = (name, source) => {
    const slug = slugify(name);
    if (!slug || seen.has(slug)) return;
    const r = ensureContext(slug, { source: 'context-registry.seed:' + source, agent_id: opts.agent_id });
    if (r.ok && !r.existed) { created.push(r.context_id); seen.add(slug); }
  };
  try {
    const db = state.db();
    const projRows = db.prepare(
      "SELECT DISTINCT json_extract(output,'$.project_id') p FROM action_records " +
      "WHERE type='commitment' AND json_extract(output,'$.project_id') IS NOT NULL LIMIT 200"
    ).all();
    for (const r of projRows) if (r && r.p) add(r.p, 'project_id');
  } catch (_) { /* seed source unavailable — registry still works */ }
  try {
    const ap = require('./active-project.js');
    const snap = ap.activitySnapshot({ limit_recent: 1 });
    for (const p of (snap.active_projects || [])) add(p.short_name, 'active_project');
  } catch (_) { /* seed source unavailable */ }
  return { ok: true, created, total: seen.size };
}

// A context is mentioned when its slug or its de-dashed phrase appears as
// whole words (any script); a slug inside a longer word ("north" inside
// "northwind") is no mention, and a denied slug never resolves.
function _wordRe(needle) {
  const esc = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+');
  return new RegExp('(?<![\\p{L}\\p{N}])' + esc + '(?![\\p{L}\\p{N}])', 'iu');
}
function mentionsContext(text, c) {
  const t = String(text || '');
  if (!t || !c || !c.slug || _DENY.has(c.slug)) return false;
  try {
    if (_wordRe(c.slug).test(t)) return true;
    const phrase = c.slug.replace(/-/g, ' ');
    return phrase !== c.slug && phrase.length >= 4 && _wordRe(phrase).test(t);
  } catch (_) { return false; }
}
// A registry entity carries a context when its slug is the context's slug,
// or when it is a company, organization, project or product whose slug
// begins with the context's slug ("northwind" carries ctx:north, the
// folder's short name for the company). A person never carries a context
// by prefix.
const CARRIER_KINDS = /^(organization|organisation|company|project|product|client|customer|employer|business|brand)$/i;
function _entityCarries(ident, slug) {
  if (!ident || !ident.slug || !slug) return false;
  if (ident.slug === slug) return true;
  if (!CARRIER_KINDS.test(String(ident.kind || ''))) return false;
  // The company's short name as a folder ("north" for northwind), or the
  // company's name leading a longer slug ("brightpress" for brightpress-tracker).
  return (slug.length >= 4 && ident.slug.startsWith(slug)) || (ident.slug.length >= 4 && slug.startsWith(ident.slug + '-'));
}
function resolveMention(text) {
  const t = String(text || '');
  if (!t) return null;
  let best = null;
  const registry = listContexts();
  for (const c of registry) {
    if (mentionsContext(t, c) && (!best || c.slug.length > best.slug.length)) best = c;
  }
  if (best) return best.context_id;
  // A registry entity that carries a context's slug names that context by
  // any of its names ("Northwind" for ctx:north).
  try {
    const identities = require('./entity-identity.js').loadRegistry({}) || [];
    for (const ident of identities) {
      if (!ident || !ident.slug || _DENY.has(ident.slug)) continue;
      const c = registry.find((x) => !_DENY.has(x.slug) && _entityCarries(ident, x.slug));
      if (!c) continue;
      for (const n of [ident.canonical].concat(ident.aliases || [])) {
        if (!n || String(n).length < 3) continue;
        let re; try { re = _wordRe(String(n)); } catch (_) { continue; }
        if (re.test(t) && (!best || c.slug.length > best.slug.length)) { best = c; break; }
      }
    }
  } catch (_) { /* no entity registry → slugs and phrases only */ }
  return best ? best.context_id : null;
}

const path = require('path');
const os = require('os');
const _sessionCtxCache = new Map();
const SESSION_CTX_TTL_MS = 10 * 60 * 1000;
// Generic folder and scratch words never name a topic: the machine's own
// layout is not a subject of the operator's work.
const _DENY = new Set(['tmp', 'temp', 'downloads', 'desktop', 'documents', 'home', 'versions', 'general',
  'tool-results', 'prompts', 'ephemeral', 'core', 'src', 'lib', 'bin', 'dist', 'build', 'test', 'tests',
  'scratch', 'scratchpad', 'node-modules', path.basename(os.homedir()).toLowerCase()]);

function resolveSessionContext(sessionId) {
  if (!sessionId) return null;
  const hit = _sessionCtxCache.get(sessionId);
  // Only RESOLVED contexts are cached. A session's context evolves as file
  // activity accumulates: caching a null on the session's first write (zero
  // votes yet) would freeze every later stamp at null for the TTL window.
  if (hit && hit.ctx && Date.now() - hit.at < SESSION_CTX_TTL_MS) return hit.ctx;
  let ctx = null;
  try {
    const contexts = listContexts()
      .filter((c) => !_DENY.has(c.slug))
      .sort((a, b) => b.slug.length - a.slug.length);
    const rows = state.db().prepare(
      "SELECT json_extract(input,'$.file_path') fp FROM action_records " +
      "WHERE session_id = ? AND type IN ('edit','read') AND json_extract(input,'$.file_path') IS NOT NULL " +
      'ORDER BY timestamp DESC LIMIT 200'
    ).all(sessionId);
    const votes = new Map();
    let total = 0;
    for (const r of rows) {
      const low = String(r.fp || '').toLowerCase();
      if (!low.startsWith('/')) continue;
      for (const c of contexts) {
        if (low.includes('/' + c.slug + '/') || low.endsWith('/' + c.slug)) {
          votes.set(c.context_id, (votes.get(c.context_id) || 0) + 1);
          total++;
          break;
        }
      }
    }
    let best = null, bestN = 0;
    for (const [cid, n] of votes) if (n > bestN) { best = cid; bestN = n; }
    if (best && bestN >= 3 && bestN / total >= 0.6) ctx = best;
  } catch (_) { ctx = null; }
  if (ctx) _sessionCtxCache.set(sessionId, { ctx, at: Date.now() });
  return ctx;
}

// The context a conversation is bound to, by the chain every surface uses:
// an explicit statement in this message ("working on X", "πάμε στο X") wins;
// else the binding already recorded for the session; else the directory the
// session runs in, when that names a registered context and is not a home
// folder; else the session's own file activity; else a plain mention in the
// message. A new binding is recorded as a context_bind decision in the
// session, so every later read of the session agrees with this one.
const BIND_RE = /\b(δουλεύουμε|πάμε στο|switch to|working on|work on)\b/i;

const _bindingCache = new Map();   // session_id → { ctx, at }
const BINDING_TTL_MS = 5 * 60 * 1000;
const BINDING_MISS_TTL_MS = 15 * 1000;
function currentBinding(sessionId) {
  if (!sessionId) return null;
  const key = String(sessionId);
  const hit = _bindingCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ctx ? BINDING_TTL_MS : BINDING_MISS_TTL_MS)) return hit.ctx;
  let ctx = null;
  try {
    const rows = state.queryActions({ type: 'decision', session_id: key, limit: 40 }) || [];
    for (const r of rows) {
      let inp = r.input;
      if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch (_) { inp = null; } }
      if (inp && inp.kind === 'context_bind' && r.context_id) { ctx = r.context_id; break; }
    }
  } catch (_) { ctx = null; }
  _bindingCache.set(key, { ctx, at: Date.now() });
  return ctx;
}

function recordBinding(ctxId, by, opts) {
  try {
    const ar = require('./action-record.js');
    state.recordAction({
      id: ar.uuidv7(), timestamp: Date.now(), type: 'decision',
      agent_id: opts.agent_id || 'context-registry', session_id: opts.session_id || null,
      cwd: opts.cwd || null, context_id: ctxId,
      audience: 'substrate_internal', memory_class: 'operational',
      input: { kind: 'context_bind' },
      output: { kind: 'context_bind', context_id: ctxId, bound_by: by, trigger: String(opts.trigger || '').slice(0, 140) }
    }, 'context_bind ' + ctxId + ' ' + by);
  } catch (_) { /* the binding holds for this read without its audit row */ }
  if (opts.session_id) _bindingCache.set(String(opts.session_id), { ctx: ctxId, at: Date.now() });
}

function bindSession(opts) {
  opts = opts || {};
  const text = String(opts.text || '');
  const current = currentBinding(opts.session_id);
  const bind = (ctx, by) => {
    if (ctx && ctx !== current) {
      recordBinding(ctx, by, { session_id: opts.session_id, cwd: opts.cwd, agent_id: opts.agent_id, trigger: text });
    }
    return { context_id: ctx, by };
  };
  if (BIND_RE.test(text)) {
    const explicit = declaredContext(text);
    if (explicit) return bind(explicit, 'explicit');
  }
  if (current) return { context_id: current, by: 'recorded' };
  const cwd = opts.cwd ? String(opts.cwd) : '';
  const base = path.basename(cwd);
  const cwdCtx = base ? contextIdFor(base) : null;
  if (cwdCtx && cwd !== os.homedir() && !_DENY.has(slugify(base)) &&
      listContexts().some((c) => c.context_id === cwdCtx)) {
    return bind(cwdCtx, 'cwd');
  }
  const voted = resolveSessionContext(opts.session_id);
  if (voted) return bind(voted, 'activity');
  const mention = resolveMention(text);
  if (mention) return bind(mention, 'mention');
  return { context_id: null, by: null };
}

// A matcher for "this text names one of these contexts": the context's slug
// or phrase as whole words, or a name of a registry entity that carries the
// context's slug. Built once per read, so a scoped recall pays the regex
// work once for all its candidates.
function contextNamer(contexts) {
  const res = [];
  let identities = [];
  try { identities = require('./entity-identity.js').loadRegistry({}) || []; } catch (_) { identities = []; }
  for (const raw of (contexts || [])) {
    const id = String(raw || '');
    if (!id.startsWith(CTX_PREFIX)) continue;
    const slug = id.slice(CTX_PREFIX.length);
    if (!slug || _DENY.has(slug)) continue;
    const names = new Set([slug]);
    const phrase = slug.replace(/-/g, ' ');
    if (phrase !== slug && phrase.length >= 4) names.add(phrase);
    // The subject's own word names every facet: "troth" for troth-core.
    const fam = contextFamily(id);
    if (fam.head) names.add(fam.head);
    for (const ident of identities) {
      if (!ident || !_entityCarries(ident, slug)) continue;
      for (const n of [ident.canonical].concat(ident.aliases || [])) {
        if (n && String(n).length >= 3) names.add(String(n));
      }
    }
    for (const n of names) { try { res.push(_wordRe(n)); } catch (_) { /* unusable name */ } }
  }
  if (!res.length) return () => false;
  return (text) => {
    const t = String(text || '');
    if (!t) return false;
    for (const re of res) if (re.test(t)) return true;
    return false;
  };
}
function namesAnyContext(text, contexts) { return contextNamer(contexts)(text); }
function isDeniedSlug(slug) { return _DENY.has(String(slug || '').toLowerCase()); }

// A subject has facets: troth-core, troth-positioning and troth-files are
// one subject, troth, and knowledge flows across its facets. The family of
// a context is the leading word of its slug when at least two registry
// contexts share that word (one of them may bear it alone); a lone context
// is its own family. Live threads stay apart regardless; this is about
// knowledge.
function contextFamily(contextId) {
  const id = String(contextId || '');
  const one = { head: null, members: new Set(id ? [id] : []) };
  if (!id.startsWith(CTX_PREFIX)) return one;
  const slug = id.slice(CTX_PREFIX.length);
  const head = slug.split('-')[0];
  if (!head || head.length < 3 || _DENY.has(head)) return one;
  const kin = listContexts().filter((c) => c.slug === head || c.slug.startsWith(head + '-'));
  if (kin.length < 2) return one;
  const members = new Set([id]);
  for (const c of kin) members.add(c.context_id);
  return { head, members };
}
// Every context a bound read covers: the given ones and their families.
function scopeContexts(contexts) {
  const out = new Set();
  for (const raw of (contexts || [])) {
    const fam = contextFamily(raw);
    for (const m of fam.members) out.add(m);
  }
  return out;
}

// What the operator declared they work on: the registered context the
// statement names, else a context minted from the name in the statement
// ("working on brightpress tracker" → ctx:brightpress-tracker). A short
// declaration is the operator naming a topic; a long message that happens
// to say "working on" mints nothing, and neither does a plain mention.
const DECLARED_RE = /(?:δουλεύουμε\s+(?:στο|στη|στην|στον|με\s+το|με\s+τη|με\s+την)?|πάμε\s+στο|switch\s+to|working\s+on|work\s+on)\s+(?:the\s+|a\s+|an\s+|το\s+|τη\s+|την\s+|τον\s+)?([\p{L}\p{N}][\p{L}\p{N}_-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}_-]*){0,2})/iu;
const NOT_A_NAME = new Set(['it', 'this', 'that', 'them', 'something', 'stuff', 'things', 'here', 'there', 'αυτό', 'αυτή', 'αυτο', 'εκείνο', 'κάτι', 'κατι']);
const TRAILING_WORD = /\s+(?:today|now|again|tonight|σήμερα|τώρα|πάλι)$/iu;
function declaredContext(text) {
  const t = String(text || '');
  if (!BIND_RE.test(t)) return null;
  const known = resolveMention(t);
  if (known) return known;
  if (t.trim().split(/\s+/).length > 14) return null;
  const m = DECLARED_RE.exec(t);
  if (!m) return null;
  const name = m[1].replace(TRAILING_WORD, '').replace(/[\s_-]+$/, '').trim();
  const first = name.split(/\s+/)[0].toLowerCase();
  if (!name || NOT_A_NAME.has(first) || /ing$/i.test(first)) return null;
  const slug = slugify(name);
  if (!slug || slug.length < 3 || _DENY.has(slug)) return null;
  // The name was read from the operator's words by the partner, so the
  // registry row carries the read tier; the signed operator tier stays
  // with its own entry points.
  const r = ensureContext(name, { source: 'operator statement' });
  return r && r.ok ? r.context_id : null;
}

module.exports = {
  slugify,
  contextIdFor,
  listContexts,
  ensureContext,
  seedContexts,
  resolveMention,
  mentionsContext,
  namesAnyContext,
  contextNamer,
  declaredContext,
  isDeniedSlug,
  contextFamily,
  scopeContexts,
  resolveSessionContext,
  currentBinding,
  bindSession,
  REGISTRY_SCOPE_PREFIX,
  CTX_PREFIX,
  UNSORTED
};
