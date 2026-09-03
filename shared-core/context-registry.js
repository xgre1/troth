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

function resolveMention(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  let best = null;
  for (const c of listContexts()) {
    const needle = c.slug.replace(/-/g, ' ');
    if (t.includes(c.slug) || (needle.length >= 4 && t.includes(needle))) {
      if (!best || c.slug.length > best.slug.length) best = c;
    }
  }
  return best ? best.context_id : null;
}

const path = require('path');
const os = require('os');
const _sessionCtxCache = new Map();
const SESSION_CTX_TTL_MS = 10 * 60 * 1000;
const _DENY = new Set(['tmp', 'downloads', 'desktop', 'documents', 'home', path.basename(os.homedir()).toLowerCase()]);

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

function currentBinding(sessionId) {
  if (!sessionId) return null;
  try {
    const rows = state.queryActions({ type: 'decision', session_id: sessionId, limit: 40 }) || [];
    for (const r of rows) {
      let inp = r.input;
      if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch (_) { inp = null; } }
      if (inp && inp.kind === 'context_bind' && r.context_id) return r.context_id;
    }
  } catch (_) { /* no record → unbound */ }
  return null;
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
    const explicit = resolveMention(text);
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

module.exports = {
  slugify,
  contextIdFor,
  listContexts,
  ensureContext,
  seedContexts,
  resolveMention,
  resolveSessionContext,
  currentBinding,
  bindSession,
  REGISTRY_SCOPE_PREFIX,
  CTX_PREFIX,
  UNSORTED
};
