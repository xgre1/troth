// SPDX-License-Identifier: AGPL-3.0-only
// Chameleon — L3 enterprise data ingestion.
//
// Engram (L2) stores point facts the substrate has explicitly chosen
// to remember. Chameleon (L3) is the bulk path: ingest a document
// corpus, chunk it semantically, embed each chunk, persist as scoped
// engrams. The substrate then reaches into a corpus by name when a
// query touches that domain — separate scopes don't bleed into each
// other.
//
// Why scoped: an enterprise substrate often serves multiple disjoint
// knowledge bases (legal docs, codebase, internal wiki, customer
// transcripts). Mixing them in one undifferentiated engram pool
// floods retrieval with cross-context noise. Scopes give the
// substrate the same selection it has over which goal is active.
//
// Chunking: paragraph-grouped fixed-budget chunks with light overlap.
// Better than naive line splits; doesn't need a tokenizer; preserves
// sentence boundaries when present. Chunk size ≈ 800 chars with
// 100-char overlap by default — small enough that an embedding
// captures the chunk's gist, large enough that single-claim
// retrieval still has supporting context.

const cfg    = require('./transport-config.js');
const engram = require('./engram.js');

const DEFAULT_CHUNK_CHARS   = 800;
const DEFAULT_CHUNK_OVERLAP = 100;

// Split a long text into roughly-equal chunks at paragraph / sentence
// boundaries when possible, falling back to character cuts when a
// single block exceeds the budget. Returns an array of strings.
function chunkText(text, opts) {
  opts = opts || {};
  const target  = Math.max(120, opts.chunk_chars   || DEFAULT_CHUNK_CHARS);
  const overlap = Math.max(0,   opts.chunk_overlap || DEFAULT_CHUNK_OVERLAP);
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  // Pre-split by blank lines (paragraph), then by sentence within
  // paragraphs. This produces a list of sentence-ish fragments we
  // pack greedily into chunks.
  const blocks = [];
  for (const para of t.split(/\n\s*\n+/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    // Sentence split (best-effort, language-agnostic-ish).
    const sentences = trimmed.split(/(?<=[.!?\u3002\uFF01\uFF1F])\s+/);
    for (const s of sentences) {
      const ss = s.trim();
      if (!ss) continue;
      // If a single sentence blows the budget, hard-cut it.
      if (ss.length > target * 1.5) {
        for (let i = 0; i < ss.length; i += target) {
          blocks.push(ss.slice(i, i + target));
        }
      } else {
        blocks.push(ss);
      }
    }
  }
  // Pack greedy: accumulate until adding the next block would exceed
  // target; emit; carry over `overlap` chars from the tail to seed
  // the next chunk so retrieval near boundaries still finds context.
  const chunks = [];
  let cur = '';
  for (const b of blocks) {
    if (!cur) { cur = b; continue; }
    if (cur.length + 1 + b.length <= target) {
      cur += ' ' + b;
    } else {
      chunks.push(cur);
      const tail = overlap > 0 && cur.length > overlap ? cur.slice(-overlap) : '';
      cur = (tail ? tail + ' ' : '') + b;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Ingest a single document into the substrate's engram store under a
// named scope. Each chunk becomes one engram. Embeddings computed
// in series to keep memory pressure modest; for very large corpora
// the caller can batch by calling ingestDocument multiple times.
//
// Options:
//   agent_id     — required
//   user_id, cwd — substrate context
//   scope        — required; the corpus name (e.g., 'docs:legal-2026')
//   text         — the document body
//   title        — optional title; prepended to each chunk for context
//   source       — provenance string ('ingest:filename', 'ingest:url:...')
//   embedding_host — defaults to cfg.embeddingHost()
//   chunk_chars / chunk_overlap — chunking knobs
async function ingestDocument(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  const scope    = opts.scope;
  const text     = String(opts.text || '');
  if (!agent_id || !scope || !text.trim()) {
    return { ok: false, error: 'agent_id, scope, text required', recorded: 0 };
  }
  const user_id = opts.user_id || 'default';
  const cwd     = opts.cwd || null;
  const source  = opts.source || ('ingest:' + scope);
  const title   = opts.title ? String(opts.title).trim() : null;
  const embeddingHost = opts.embedding_host || cfg.embeddingHost();

  const chunks = chunkText(text, opts);
  let recorded = 0;
  let embedded = 0;
  const ids = [];
  for (let i = 0; i < chunks.length; i++) {
    const stmt = title ? '[' + title + ' #' + (i + 1) + '] ' + chunks[i] : chunks[i];
    let embedding = null;
    if (embeddingHost) {
      try { embedding = await engram.embedRequest(embeddingHost, stmt); }
      catch (_) { embedding = null; }
    }
    if (embedding) embedded++;
    const id = engram.recordEngram({
      agent_id, user_id, cwd,
      statement: stmt,
      source,
      salience: typeof opts.salience === 'number' ? opts.salience : 1.0,
      embedding,
      scope,
      //  engram.recordEngram now defaults
      // auto_verify=true. Bulk ingest paths (this one) opt out: each
      // chunk would run pool-comparison against existing engrams,
      // O(N²) for an N-chunk document — would push a 1000-chunk import
      // from seconds to minutes. Caller still gets default truth_score=1
      // / tier='working' (the safe defaults engram.recordEngram applies
      // when verify is skipped).
      auto_verify: false
    });
    if (id) { recorded++; ids.push(id); }
  }
  return { ok: true, scope, chunks: chunks.length, recorded, embedded, ids };
}

// Query a single named scope — convenience wrapper around
// engram.retrieveRelevant. Returns { items, scope, query }.
async function queryScope(opts) {
  opts = opts || {};
  const items = await engram.retrieveRelevant({
    agent_id:        opts.agent_id,
    cwd:             opts.cwd,
    query:           opts.query,
    k:               opts.k || 5,
    embedding_host:  opts.embedding_host,
    scope:           opts.scope
  });
  return { scope: opts.scope, query: opts.query, items };
}

// List the distinct scopes a substrate currently has populated. Useful
// for the UI dashboard ("which corpora are loaded?") and for the
// substrate-tools surface (the language faculty can ask "what corpora
// can I query?" before running a search).
function listScopes(opts) {
  opts = opts || {};
  const all = engram.listEngrams({
    agent_id: opts.agent_id,
    cwd:      opts.cwd,
    limit:    opts.scan_limit || 2000
  });
  const counts = new Map();
  for (const e of all) {
    if (!e.scope) continue;
    counts.set(e.scope, (counts.get(e.scope) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([scope, count]) => ({ scope, count }))
    .sort((a, b) => b.count - a.count);
}

// Distinct provenance `source` tags already ingested into a scope. Powers
// idempotent re-import (skip sessions already present) and "what's new"
// detect counts. Single JSON scan over action_records; cheap vs re-ingest.
function listIngestedSources(scope) {
  if (!scope) return [];
  try {
    const state = require('./state.js');
    const rows = state._dbForQuery().prepare(
      "SELECT DISTINCT json_extract(input,'$.source') AS src FROM action_records " +
      "WHERE json_extract(output,'$.scope') = ? AND json_extract(input,'$.source') LIKE 'import:%'"
    ).all(scope);
    return rows.map(r => r.src).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = {
  chunkText,
  ingestDocument,
  listIngestedSources,
  queryScope,
  listScopes,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNK_OVERLAP
};
