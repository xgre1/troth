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
  // WHERE this text came from, carried on every passage.
  //
  // Not the `audience` field, and that distinction is the whole design.
  // audienceOk() in recall.js is an EXACT match against what the caller asked
  // for (default 'model_visible'), so tagging fetched text
  // 'synthesis_of_external' does not lower its trust — it makes it INVISIBLE.
  // A page from the open web has to be readable and MARKED, because the two
  // failure modes are "knowledge that never answers" and "a stranger's words
  // carrying the same weight as the operator's own documents", and both are
  // unacceptable. So provenance is its own field: recall still returns it, and
  // whoever reads it can see it came from outside.
  const provenanceTier = opts.provenance_tier === 'external' ? 'external' : 'operator';
  const provenanceRef  = opts.provenance_ref ? String(opts.provenance_ref).slice(0, 300) : null;
  const title   = opts.title ? String(opts.title).trim() : null;
  const embeddingHost = opts.embedding_host || cfg.embeddingHost();

  // SECRET GATE. Bulk text is the one road into the substrate where nobody
  // read the document first: a folder of PDFs, a fetched page, a notes file
  // with a key pasted into it. A measurable share of ordinary
  // knowledge-shaped files (markdown notes, not config files) carries a
  // credential-shaped literal.
  // Ingested raw, those get chunked, embedded, and then RETURNED BY RECALL
  // to whatever model is answering.
  //
  // harvest() BEFORE redact(), and this order is the whole point: the
  // redactor masks literals it has already collected, so redact() alone on a
  // document it has never seen is a NO-OP. Verified by experiment before this
  // line was written — the obvious one-liner would have passed a test that
  // harvested first and shipped a gate that does nothing.
  //
  // The chat-import roads (claude-session-watcher, backfill-claude-sessions)
  // already do this per turn. This closes the same hole on the document road.
  let safeText = text;
  try {
    const redactor = require('./secret-redactor.js');
    redactor.harvest(text);
    safeText = redactor.redact(text);
  } catch (_) { /* redactor unavailable: ingest the text as given */ }

  const chunks = chunkText(safeText, opts);
  // compute OUTSIDE the write path: chunk statements and their
  // best-effort embeddings (async, can take seconds on a long document).
  let embedded = 0;
  const prepared = [];
  for (let i = 0; i < chunks.length; i++) {
    const stmt = title ? '[' + title + ' #' + (i + 1) + '] ' + chunks[i] : chunks[i];
    let embedding = null;
    if (embeddingHost) {
      try { embedding = await engram.embedRequest(embeddingHost, stmt); }
      catch (_) { embedding = null; }
    }
    // FALL BACK TO THE EMBEDDER ON THIS MACHINE.
    //
    // When the configured host is remote and asleep, embedRequest returns null
    // WITHOUT throwing, so chunks store with no vector and nothing reports it.
    // The text is there, the meaning is not, and the corpus answers only to
    // exact words.
    //
    // The local embedder was up the whole time and answers in 8ms. A remote
    // preference must degrade to it, not to silence.
    if (!embedding) {
      try {
        const local = require('./local-embedder.js');
        const v = await local.embed(stmt);
        if (v && v.length) embedding = Array.from(v);
      } catch (_) { embedding = null; }
    }
    if (embedding) embedded++;
    prepared.push({ stmt: stmt, embedding: embedding });
  }
  // ONE synchronous transaction writes every chunk row. The
  // document's ingest marker IS its chunk rows (listIngestedSources reads
  // input.source off them), so a half-written document would read as
  // "already imported" and its missing tail could never be completed —
  // the close-the-laptop interrupt.
  // All-or-nothing instead: an interrupted import leaves NOTHING behind
  // and the next run ingests the document whole; a completed one is
  // complete. No duplicates on either road. recordEngram is synchronous
  // on the same connection, so the whole batch commits or rolls back as
  // one — vectors included.
  let recorded = 0;
  const ids = [];
  try {
    const stateDb = require('./state.js')._dbForQuery();
    stateDb.transaction(() => {
      for (const p of prepared) {
        const id = engram.recordEngram({
          agent_id, user_id, cwd,
          statement: p.stmt,
          source,
          provenance: { tier: provenanceTier, ref: provenanceRef },
          salience: typeof opts.salience === 'number' ? opts.salience : 1.0,
          embedding: p.embedding,
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
        // Strict all-or-nothing: recordEngram returning null (validation
        // refusal, write failure) would leave a session that LOOKS
        // imported while missing chunks — the soft variant of the
        // interrupt bug. One bad chunk rolls the whole session back;
        // the next run retries it complete.
        if (!id) throw new Error('chunk ' + (ids.length + 1) + '/' + prepared.length + ' refused — rolling the session back');
        recorded++; ids.push(id);
      }
    })();
  } catch (e) {
    return { ok: false, error: 'ingest_tx_failed: ' + String(e && e.message || e), scope, chunks: chunks.length, recorded: 0, embedded: 0, ids: [] };
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
//
// This counted scopes among the engrams listEngrams() would return — and
// that reader caps its LIMIT at 2000 rows, so the answer silently meant
// "among the 2000 most recent engrams". On a 43k-engram substrate it
// reported 57 scopes against a true 2024, and a corpus ingested earlier
// than the last 2000 writes did not exist as far as any caller could tell.
// state.scopeInventory answers the same question with one GROUP BY over the
// whole table, and carries the embedded count so a surface can show which
// corpora are actually searchable.
function listScopes(opts) {
  opts = opts || {};
  const state = require('./state.js');
  return state.scopeInventory({
    agent_id:         opts.agent_id,
    cwd:              opts.cwd,
    strict_isolation: opts.strict_isolation,
    principal:        opts.principal,
    prefix:           opts.prefix,
    limit:            opts.limit
  });
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

// Prefix variant for scope FAMILIES (docs:chats + docs:chats:<project>).
// The import's idempotency must see a session as ingested no matter which
// project scope it landed in — exact-match here is how per-project scoping
// would have re-imported every legacy flat-scope session as a duplicate.
function listIngestedSourcesPrefix(scopePrefix) {
  if (!scopePrefix) return [];
  try {
    const state = require('./state.js');
    const rows = state._dbForQuery().prepare(
      "SELECT DISTINCT json_extract(input,'$.source') AS src FROM action_records " +
      "WHERE json_extract(output,'$.scope') LIKE ? AND json_extract(input,'$.source') LIKE 'import:%'"
    ).all(scopePrefix + '%');
    return rows.map(r => r.src).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = {
  chunkText,
  ingestDocument,
  listIngestedSources,
  listIngestedSourcesPrefix,
  queryScope,
  listScopes,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNK_OVERLAP
};
