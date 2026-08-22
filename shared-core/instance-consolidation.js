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
const STATUSES = ['completed', 'planned', 'recurring', 'cancelled'];
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
function parseExtraction(text, turnCount) {
  const out = { instances: [], dropped: 0 };
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch (_) { return out; }
  if (!Array.isArray(arr)) return out;
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

// ── Write ───────────────────────────────────────────────────────────────

function _statementFor(inst) {
  return inst.kind + ': ' +
    (inst.qualifier ? inst.qualifier + ' ' : '') +
    inst.entity + ' — ' + inst.description +
    ' [' + inst.status + (inst.date_iso ? ', ' + inst.date_iso : '') + ']';
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
function _sameOccurrence(entry, inst, entity_slug) {
  const e = entry.instance;
  if (!e || e.kind !== inst.kind) return false;
  const entityMatch = (e.entity_slug && entity_slug)
    ? e.entity_slug === entity_slug
    : _normEntity(e.entity) === _normEntity(inst.entity);
  if (!entityMatch) return false;
  if (e.date_iso && inst.date_iso && e.date_iso !== inst.date_iso) return false;
  return true;
}

// Status lifecycle: newest evidence wins, terminal states never regress.
// A stale "planned" retelling cannot downgrade a completed/cancelled
// occurrence — the ku organ's newest-wins, with a direction guard.
const TERMINAL_STATUS = { completed: true, cancelled: true };

function writeInstances(opts) {
  const turns = opts.turns || [];
  const stats = { written: 0, dup: 0, no_provenance: 0, transitions: 0, strengthened: 0 };
  const pool = opts._pool || _loadPool(opts);
  for (const inst of (opts.instances || [])) {
    const refs = (inst.turn_idxs || [])
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

    const match = pool.find(p => _sameOccurrence(p, inst, entity_slug));
    let finalInst, supersedes = null, reason = null, provenance = refs;
    if (match) {
      const old = match.instance;
      let status = inst.status;
      if (TERMINAL_STATUS[old.status] && inst.status === 'planned') status = old.status;
      const oldRefs = _refsOf(match.id);
      provenance = Array.from(new Set(oldRefs.concat(refs)));
      const changed = status !== old.status || provenance.length !== oldRefs.length;
      if (!changed) { stats.dup++; continue; }
      finalInst = {
        kind: inst.kind,
        // Keep the richer identity: canonical when known, else whichever
        // surface form arrived first.
        entity: canonical || old.canonical || inst.entity,
        entity_slug: entity_slug || old.entity_slug || null,
        canonical: canonical || old.canonical || null,
        description: inst.description || old.description,
        date_iso: inst.date_iso || old.date_iso || null,
        status,
        qualifier: inst.qualifier || old.qualifier || null,
        quantity: Number.isFinite(inst.quantity) ? inst.quantity : (old.quantity != null ? old.quantity : null),
        session_id: opts.session_id || old.session_id || null
      };
      supersedes = match.id;
      reason = status !== old.status ? 'status_transition' : 'restatement';
    } else {
      finalInst = {
        kind: inst.kind,
        entity: canonical || inst.entity,
        entity_slug,
        canonical,
        description: inst.description,
        date_iso: inst.date_iso,
        status: inst.status,
        qualifier: inst.qualifier,
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
async function runPass(opts) {
  opts = opts || {};
  if (typeof opts.llmCall !== 'function') throw new Error('instance-consolidation: llmCall required');
  const now = opts.now || Date.now();
  let since = _readWatermark(opts.agent_id);
  if (!since) since = now - FIRST_RUN_LOOKBACK_MS;

  let rows = [];
  try {
    rows = state.queryActions({
      type: 'tool_call',
      agent_id: opts.agent_id || undefined,
      since: since + 1,
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
  _writeWatermark(opts, latestTs);
  return Object.assign(stats, { watermark: latestTs, advanced: true });
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
  buildPrompt,
  parseExtraction,
  writeInstances,
  runPass,
  makeLlamacppExtractor,
  SCOPE_PREFIX,
  WATERMARK_SCOPE,
  KINDS,
  STATUSES
};
