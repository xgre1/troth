// SPDX-License-Identifier: AGPL-3.0-only
// entity-identity — canonical identity for the entity axis.
//
// Phase D built the ENTITY axis as recognition-from-grammar: file paths,
// function names, ALL_CAPS constants, tool vocabulary. Deliberately blind
// to people, places and life entities — a naive capitalized-word extractor
// floods the axis (the tool-vocabulary auto-extract produced 256+ duplicate
// engrams in production before it was removed; suite-05 PF4 pins that).
//
// This module adds the missing half: IDENTITY. Who "Jen" is; that
// "my sister" and "Jen" name the same referent; that "Dr. Patel" is the
// ENT specialist. Identity is memory CONTENT, not axis mechanics, so it
// lives as ordinary engrams (scope `entity:<slug>`) — write-time
// verify/dedup, provenance, tombstones, supersession, decay: all inherited,
// nothing new to maintain. The axis then recognizes the names the mind
// KNOWS (registry-driven), never what merely looks like a name
// (grammar-driven). Recognition-from-memory: recall grows as the mind
// learns who people are; precision never drops because every alias was
// deliberately recorded.
//
// Counting depends on this: coreference across sessions — "sister's
// wedding" and "Jen and Tom's wedding" naming ONE event — cannot be
// resolved from raw turns alone.
// Instance consolidation needs identity to merge; multiAxisQuery gains
// alias expansion through the same scoring path for free.
'use strict';

const engram = require('./engram.js');

const SCOPE_PREFIX = 'entity:';
const REGISTRY_TTL_MS = 30 * 1000;

// name → slug. Unicode-aware (Greek survives), diacritics stripped,
// non-alphanumerics collapse to '-'. "Dr. Patel" → "dr-patel".
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Local acceptability check (NOT entity-axis's — requiring entity-axis
// here would cycle once multiAxisQuery lazy-requires this module).
// Aliases shorter than 3 chars would match everywhere; longer than 80
// are not names.
function _acceptableAlias(s) {
  const t = String(s || '').trim();
  return t.length >= 3 && t.length <= 80;
}

function _normAlias(s) {
  return String(s || '').trim().toLowerCase().normalize('NFKC');
}

// Union of alias lists, case-insensitive dedup, first-seen casing wins.
function _mergeAliases(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const a of (list || [])) {
      const t = String(a || '').trim();
      if (!_acceptableAlias(t)) continue;
      const key = _normAlias(t);
      if (!seen.has(key)) seen.set(key, t);
    }
  }
  return Array.from(seen.values());
}

// ── Registry ────────────────────────────────────────────────────────────

let _cache = null;       // { key, ts, identities }
function _cacheKey(opts) {
  return [opts.agent_id || '', opts.principal === null ? '<null>' : (opts.principal || '')].join('|');
}

// Load every current identity engram. listEngrams pushes scope_prefix
// into SQL and follows supersession chains, so this returns the CURRENT
// view of each identity — superseded alias sets never resurface.
function loadRegistry(opts) {
  opts = opts || {};
  const key = _cacheKey(opts);
  const now = Date.now();
  if (!opts.fresh && _cache && _cache.key === key && (now - _cache.ts) < REGISTRY_TTL_MS) {
    return _cache.identities;
  }
  let rows = [];
  try {
    rows = engram.listEngrams({
      scope_prefix: SCOPE_PREFIX,
      agent_id: opts.agent_id || undefined,
      principal: opts.principal,
      limit: 500
    }) || [];
  } catch (_) { rows = []; }
  const identities = [];
  for (const row of rows) {
    // listEngrams returns HYDRATED engram objects, not raw action rows:
    // custom output keys are not exposed — only the whitelisted set, which
    // includes the caller-controlled `payload` (engram.js hydration maps
    // rec.output.payload). entity_identity therefore rides inside payload.
    const ident = row && row.payload && row.payload.entity_identity;
    if (!ident || !ident.slug || !ident.canonical) continue;
    identities.push({
      id: row.id,
      slug: String(ident.slug),
      canonical: String(ident.canonical),
      kind: ident.kind ? String(ident.kind) : null,
      relation: ident.relation ? String(ident.relation) : null,
      aliases: Array.isArray(ident.aliases) ? ident.aliases.map(String) : []
    });
  }
  _cache = { key, ts: now, identities };
  return identities;
}

function getIdentity(slugOrName, opts) {
  const slug = slugify(slugOrName);
  if (!slug) return null;
  const reg = loadRegistry(opts || {});
  return reg.find(i => i.slug === slug) || null;
}

// ── Write ───────────────────────────────────────────────────────────────

// Record (or extend) an identity. Idempotent: same canonical + no new
// aliases + same kind/relation is a no-op returning the existing row.
// New aliases supersede the previous identity engram (lifetime.supersedes)
// so listEngrams' chain-following keeps exactly one current view.
function recordEntityIdentity(opts) {
  opts = opts || {};
  const canonical = String(opts.name || '').trim();
  const slug = slugify(canonical);
  if (!slug || !opts.agent_id) return null;
  const scope = SCOPE_PREFIX + slug;

  const existing = getIdentity(canonical, {
    agent_id: opts.agent_id, principal: opts.principal, fresh: true
  });
  const aliases = _mergeAliases([
    existing ? existing.aliases : [],
    [canonical],
    opts.aliases
  ]);
  const kind = opts.kind ? String(opts.kind) : (existing ? existing.kind : null);
  const relation = opts.relation ? String(opts.relation) : (existing ? existing.relation : null);

  if (existing &&
      aliases.length === existing.aliases.length &&
      kind === existing.kind && relation === existing.relation) {
    return { id: existing.id, slug, scope, aliases: existing.aliases, updated: false };
  }

  const statement = opts.statement ||
    (canonical +
      (kind ? ' — ' + kind : '') +
      (relation ? ' (' + relation + ')' : '') +
      (aliases.length > 1 ? '; also known as: ' + aliases.filter(a => a !== canonical).join(', ') : ''));

  // Inside `payload`: the only caller-controlled output field the
  // listEngrams hydration exposes (see loadRegistry). lifetime +
  // provenance_ref stay top-level — the write-time supersedes check
  // reads output.lifetime directly.
  const extra_output = {
    payload: { entity_identity: { slug, canonical, kind, relation, aliases } }
  };
  if (existing) extra_output.lifetime = { supersedes: existing.id };
  if (Array.isArray(opts.provenance_ref) && opts.provenance_ref.length) {
    extra_output.provenance_ref = opts.provenance_ref.map(String);
  }

  const id = engram.recordEngram({
    agent_id: opts.agent_id,
    user_id: opts.user_id,
    cwd: opts.cwd,
    statement,
    scope,
    source: opts.source || 'entity-identity',
    salience: typeof opts.salience === 'number' ? opts.salience : undefined,
    tier: opts.tier,
    extra_output
  });
  if (!id) return null;
  _cache = null;
  return { id, slug, scope, aliases, updated: !!existing };
}

// ── Read ────────────────────────────────────────────────────────────────

function _boundaryRegex(name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is ASCII-only — Greek aliases need unicode-aware boundaries.
  return new RegExp('(?<![\\p{L}\\p{N}])' + esc + '(?![\\p{L}\\p{N}])', 'iu');
}

// Which known identities does this text mention (by canonical or alias)?
// Registry-driven — an unknown name matches nothing, by design.
function lookupFromText(text, opts) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const reg = loadRegistry(opts || {});
  const hits = [];
  for (const ident of reg) {
    const names = _mergeAliases([[ident.canonical], ident.aliases]);
    const matched = [];
    for (const name of names) {
      let re;
      try { re = _boundaryRegex(name); } catch (_) { continue; }
      if (re.test(t)) matched.push(name);
    }
    if (matched.length) hits.push({ identity: ident, matched });
  }
  return hits;
}

// Query-side expansion: for every identity the text mentions, return the
// FULL name set (canonical + aliases) as extra entity tokens. The caller
// (multiAxisQuery) feeds them through the same findByEntity scoring path —
// purely additive, no new ranking rules.
function expandForQuery(text, opts) {
  const hits = lookupFromText(text, opts);
  const tokens = [];
  const seen = new Set();
  for (const h of hits) {
    for (const name of _mergeAliases([[h.identity.canonical], h.identity.aliases])) {
      const key = _normAlias(name);
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(name);
    }
  }
  return { tokens, identities: hits.map(h => h.identity) };
}

// A name is linkable when the registry resolves it to exactly one identity —
// "the bride" links while only one bride is known, and "my friend" stops
// linking the day a second friend carries it. Same idiom as the consolidation
// entity resolver: act only on hits.length === 1.
function uniqueNameOwners(opts) {
  const counts = new Map();
  for (const ident of loadRegistry(opts || {})) {
    for (const name of _mergeAliases([[ident.canonical], ident.aliases])) {
      const k = _normAlias(name);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

function linkableNames(ident, opts) {
  const counts = uniqueNameOwners(opts);
  return _mergeAliases([[ident.canonical], ident.aliases])
    .filter((n) => counts.get(_normAlias(n)) === 1);
}

function _resetCacheForTests() { _cache = null; }

module.exports = {
  slugify,
  recordEntityIdentity,
  loadRegistry,
  getIdentity,
  lookupFromText,
  expandForQuery,
  uniqueNameOwners,
  linkableNames,
  normAlias: _normAlias,
  SCOPE_PREFIX,
  _resetCacheForTests
};
