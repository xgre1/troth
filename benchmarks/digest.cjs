// SPDX-License-Identifier: AGPL-3.0-only
// digest.cjs - full ingestion for a benchmark haystack: the same digestion a
// long-running entity accrues over time (identity registry, typed instances,
// chunked archive, vectors), compressed into ingest time inside the
// question's hermetic box. Question-blind by construction: it runs on the
// haystack alone, before the question is seen, with one generic extractor
// for every question type.
//
// Extraction is a pure function of session text, so results are cached
// content-addressed (sha1 of the texts + prompt version) in a directory
// shared across boxes. Nothing question-specific crosses the cache: repeated
// sessions distill once, reruns are nearly free.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ic = require('../shared-core/instance-consolidation.js');
const identity = require('../shared-core/entity-identity.js');
const chameleon = require('../shared-core/chameleon.js');
const state = require('../shared-core/state.js');

const PROMPT_V2 = process.env.TROTH_EXTRACT_PROMPT === 'v2';
const PROMPT_VERSION = PROMPT_V2 ? 'combined-v2.1' : 'combined-v1.3';

function _sessionsFromDb(agent_id) {
  const rows = state.queryActions({ type: 'tool_call', agent_id, limit: 100000, order: 'asc' }) || [];
  const bySession = new Map();
  for (const row of rows) {
    let inp;
    try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input; } catch (_) { continue; }
    if (!inp || inp.tool_name !== 'dialogue.turn') continue;
    const user_text = (inp.args && inp.args.user_text) || '';
    if (!user_text) continue;
    const k = row.session_id || '__unscoped__';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push({ id: row.id, timestamp: row.timestamp, session_id: row.session_id, user_text });
  }
  return bySession;
}

// The prompt dates every turn so the words' relative days resolve, so the
// day is part of what was extracted: the same text said on another day is
// another extraction. The key carries each turn's day next to its text.
function _dayOf(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '-';
}
function _cacheKey(turns) {
  const h = crypto.createHash('sha1');
  h.update(PROMPT_VERSION);
  for (const t of turns) h.update(' ' + _dayOf(t.timestamp) + ' ' + t.user_text);
  return h.digest('hex');
}

// One session through extraction: prompt -> cache -> model -> parse.
// Shared by digestHaystack and the extraction probe so both speak the same
// prompt version and the same cache.
async function extractSession(opts) {
  const turns = opts.turns;
  const llmCall = opts.llmCall;
  const cacheDir = opts.cacheDir;
  const stats = { cache_hit: false, extractor_call: false };
  let raw = null;
  const key = _cacheKey(turns);
  const cachePath = cacheDir ? path.join(cacheDir, key + '.json') : null;
  if (cachePath && fs.existsSync(cachePath)) {
    try { raw = fs.readFileSync(cachePath, 'utf8'); stats.cache_hit = true; } catch (_) { raw = null; }
  }
  if (raw == null) {
    raw = await llmCall(PROMPT_V2 ? ic.buildCombinedPromptV2(turns) : ic.buildCombinedPrompt(turns));
    stats.extractor_call = true;
    if (cachePath) { try { fs.writeFileSync(cachePath, String(raw)); } catch (_) {} }
  }
  const parsed = PROMPT_V2
    ? ic.parseCombinedExtractionV2(raw, turns.length, turns)
    : ic.parseCombinedExtraction(raw, turns.length);
  return { raw: raw, parsed: parsed, stats: stats };
}

// Digest every session already ingested for agent_id. llmCall is injected:
// the bench wires the studio extractor, tests wire a fixture.
async function digestHaystack(opts) {
  const agent_id = opts.agent_id;
  const user_id = opts.user_id;
  const llmCall = opts.llmCall;
  const cacheDir = opts.cacheDir;
  if (typeof llmCall !== 'function') throw new Error('digest: llmCall required');
  if (cacheDir) { try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {} }

  const stats = {
    sessions: 0, identities: 0, instances: 0, dup: 0, no_provenance: 0,
    dropped: 0, chunks: 0, cache_hits: 0, extractor_calls: 0
  };
  const bySession = _sessionsFromDb(agent_id);
  const pool = [];
  for (const entry of bySession) {
    const sessionId = entry[0];
    const turns = entry[1];
    stats.sessions++;
    const ex = await extractSession({ turns: turns, llmCall: llmCall, cacheDir: cacheDir });
    if (ex.stats.cache_hit) stats.cache_hits++;
    if (ex.stats.extractor_call) stats.extractor_calls++;
    const parsed = ex.parsed;
    stats.dropped += parsed.dropped;

    // Identities land FIRST: instance merging consults the registry.
    for (const ident of parsed.identities) {
      const w = identity.recordEntityIdentity({
        agent_id: agent_id, user_id: user_id,
        name: ident.name, kind: ident.kind, relation: ident.relation,
        aliases: ident.aliases,
        provenance_ref: turns.slice(0, 1).map(function (t) { return 'dialogue.turn:' + t.id; })
      });
      // `updated` marks a refresh of an existing row, so it is false on a
      // first sighting: count every identity that reached the registry.
      if (w && w.id) stats.identities++;
    }

    const w = ic.writeInstances({
      instances: parsed.instances, turns: turns, agent_id: agent_id, user_id: user_id,
      session_id: sessionId === '__unscoped__' ? null : sessionId,
      source: 'bench_digest', _pool: pool
    });
    stats.instances += w.written + w.transitions + w.strengthened;
    stats.dup += w.dup;
    stats.no_provenance += w.no_provenance;

    // The archive half - the same road the chat import takes: the session as
    // a chunked, embedded document in the docs:chats corpus.
    const doc = turns.map(function (t) { return 'user: ' + t.user_text; }).join('\n\n');
    const c = await chameleon.ingestDocument({
      agent_id: agent_id, scope: 'docs:chats', cwd: null,
      text: doc, title: 'session ' + sessionId,
      source: 'import:bench:' + sessionId
    });
    if (c && c.ok) stats.chunks += (c.recorded || 0);
  }
  return stats;
}

module.exports = { digestHaystack: digestHaystack, extractSession: extractSession, PROMPT_VERSION: PROMPT_VERSION };
