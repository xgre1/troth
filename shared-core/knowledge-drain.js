// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The reservoir of what the partner has seen.
//
// The substrate has always kept what the operator SAID. What the partner READ
// was kept as a receipt and nothing more: a path, a line count and a byte
// count — not one byte of content — filed as substrate_internal, so even the
// receipt was unreachable. Most reads are re-reads of a file already opened,
// because there was nowhere for it to have stayed.
//
// The proxy queues a POINTER the moment it sees a document read (it is the one
// place that knows the tool, the path and the content hash together). This
// drains that queue: read, gate, chunk, embed, store — all of it here, on the
// idle worker, because embedding costs 51ms per 800 characters and the
// operator's turn already carries 488ms of hook time.
//
// Deliberately NOT here:
//   • code — codelens already indexes it and it goes stale on every edit
//   • web pages — they need a provenance tier that does not exist yet:
//     `audience` is exact-match at read time, so tagging fetched text
//     'synthesis_of_external' makes it INVISIBLE rather than lower-trust.
//     Marking untrusted text as trusted is worse than not keeping it.
const fs   = require('fs');
const path = require('path');

// Budget per run. Embedding dominates: a 15-chunk document is ~0.8s, so eight
// documents is a few seconds of idle time — enough to keep up with a working
// day, small enough that a backlog never blocks the other 26 tasks.
const DEFAULT_BUDGET = 8;
const MAX_BYTES = 2 * 1024 * 1024;

// Where a document belongs, derived from where it lives. A corpus per project
// answers "what was this for" without anyone having to say so — the same
// question operator rules answer with their scope.
function scopeFor(absPath, homeDir) {
  const p = String(absPath || '');
  // The FOLDER names the corpus, never the file: a document is part of a
  // body of work, and one file per corpus is a filing cabinet with one sheet
  // in every drawer.
  const parts = p.split(path.sep).filter(Boolean).slice(0, -1);
  const home = String(homeDir != null ? homeDir : (process.env.HOME || '')).split(path.sep).filter(Boolean);
  let rest = parts;
  if (home.length && parts.length > home.length && parts.slice(0, home.length).join('/') === home.join('/')) {
    rest = parts.slice(home.length);
  }
  // Skip the containers that say nothing about what a document is for. The
  // machine prefixes are here too: a path under someone else's home, or one
  // this process cannot resolve, must not end up in a corpus called "users".
  const generic = new Set([
    'Users', 'users', 'home', 'Documents', 'documents', 'Desktop', 'desktop',
    'Downloads', 'downloads', 'projects', 'project', 'src', 'current', 'tmp',
    'var', 'private', 'folders'
  ]);
  // The first segment after a home prefix is the username; skip it too.
  const named = rest.find((seg, i) => {
    if (generic.has(seg)) return false;
    if (seg.indexOf('.') === 0) return false;
    if (i === 1 && (rest[0] === 'Users' || rest[0] === 'home')) return false;
    return true;
  });
  const slug = String(named || 'unsorted').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 48);
  return 'docs:seen:' + slug;
}

async function drainOnce(state, opts) {
  opts = opts || {};
  const chameleon = require('./chameleon.js');
  const budget = Math.max(1, Math.min(50, opts.budget || DEFAULT_BUDGET));
  const rows = state.listPendingKnowledge(budget * 3);
  const out = { scanned: 0, ingested: 0, chunks: 0, reasons: 0, skipped: 0, gone: 0, already: 0 };

  for (const row of rows) {
    if (out.ingested >= budget) break;
    out.scanned++;
    const isWeb = row.kind === 'web';
    if (!isWeb && row.kind !== 'file') { state.markKnowledgeDone(row.id, 'kind_not_supported'); out.skipped++; continue; }

    // Already held? The expensive half is embedding, so this is asked first.
    if (row.sha && state.knowledgeAlreadyIngested(row.sha)) {
      state.markKnowledgeDone(row.id, 'already_ingested'); out.already++; continue;
    }

    let text = '';
    if (isWeb) {
      // A page has no durable source: re-fetching later would get different
      // bytes, or a paywall, or nothing. So the queue carries the body for
      // this kind, and only this kind.
      text = String(row.payload || '');
      if (!text.trim()) { state.markKnowledgeDone(row.id, 'empty_payload'); out.skipped++; continue; }
      if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);
    } else {
      // Not readFileSync(path,'utf8'). That is right for markdown and nonsense
      // for a PDF, and the operator's folders hold 123 of them plus 16 rtf and
      // 9 docx — all of which would have been chunked as binary mojibake,
      // embedded, and served back as recall hits. The extractor uses tools
      // already on the machine and SKIPS what it cannot read, because a corpus
      // full of garbage is worse than a corpus missing a document.
      const extracted = require('./text-extract.js').extract(row.ref, { max_bytes: MAX_BYTES });
      if (!extracted.ok) {
        if (extracted.reason === 'source_gone') { state.markKnowledgeDone(row.id, 'source_gone'); out.gone++; }
        else { state.markKnowledgeDone(row.id, extracted.reason); out.skipped++; }
        continue;
      }
      text = extracted.text;
    }
    if (!text.trim()) { state.markKnowledgeDone(row.id, 'empty'); out.skipped++; continue; }

    try {
      // The secret gate lives inside ingestDocument (harvest + redact before
      // chunking), so nothing here has to remember to call it.
      // WHERE the document belongs, not just what it is called.
      //
      // recall gives a passage whose cwd matches the current project a full
      // boost and everything else half of one (cwdBoost, recall.js). Filing
      // these with cwd:null — which the first version did — means a corpus
      // about one project never surfaces preferentially while working in that
      // project, which is exactly the behaviour the reservoir exists to give.
      // The folder the document lives in is the truthful answer.
      const docCwd = isWeb ? null : (path.dirname(row.ref) || null);
      const r = await chameleon.ingestDocument({
        agent_id: opts.agent_id || 'knowledge-drain',
        user_id: 'default',
        cwd: docCwd,
        scope: isWeb ? webScopeFor(row.ref) : scopeFor(row.ref, opts.home),
        text,
        title: isWeb ? webTitleFor(row.ref) : path.basename(row.ref),
        // WHOSE words these are. A page from the open web is readable and
        // MARKED; a document the operator handed over is theirs. Same shelf,
        // different label — because the alternative to marking it is either
        // hiding it or letting a stranger's page carry the operator's weight.
        provenance_tier: isWeb ? 'external' : 'operator',
        provenance_ref:  isWeb ? row.ref : null,
        // The sha IS the idempotency key: knowledgeAlreadyIngested reads it
        // back, so the same content is never chunked twice however many times
        // it is read.
        source: 'seen:' + (row.sha || 'nosha'),
        embedding_host: opts.embedding_host || null
      });
      if (r && r.ok) {
        out.ingested++; out.chunks += (r.recorded || 0);
        // The WHY, kept apart from the material.
        //
        // The passages stay pure text — a document should read as itself, not
        // as text with our bookkeeping stapled to every paragraph. One
        // sentence per document carries the reason, and because it is an
        // ordinary engram in the same corpus it answers the question the
        // operator actually asks later: "what was I looking at when I was
        // working on X". The substrate already holds 14,995 search records and
        // none of them answer that, because a grep pattern is not a reason.
        if (row.why) {
          try {
            require('./engram.js').recordEngram({
              agent_id: opts.agent_id || 'knowledge-drain',
              user_id: 'default', cwd: docCwd,
              statement: 'Read ' + path.basename(row.ref) + ' while working on: ' + row.why,
              source: 'seen-why:' + (row.sha || 'nosha'),
              scope: isWeb ? webScopeFor(row.ref) : scopeFor(row.ref, opts.home),
              // The reason carries the same mark as the material it explains:
              // a line about why an outside page was opened is not operator
              // knowledge either.
              provenance_tier: isWeb ? 'external' : 'operator',
              provenance_ref:  isWeb ? row.ref : row.ref,
              salience: 1,
              auto_verify: false
            });
            out.reasons = (out.reasons || 0) + 1;
          } catch (_) { /* the material is kept either way */ }
        }
        state.markKnowledgeDone(row.id, 'ingested ' + (r.recorded || 0) + ' passages');
      } else {
        state.markKnowledgeDone(row.id, 'ingest_failed: ' + (r && r.error || 'unknown'));
        out.skipped++;
      }
    } catch (e) {
      state.markKnowledgeDone(row.id, 'threw: ' + String(e && e.message || e).slice(0, 120));
      out.skipped++;
    }
  }
  return out;
}

// A corpus per site, so "what did I read on arxiv" is one question and the
// operator can see at a glance whose material they are carrying.
function webScopeFor(url) {
  let host = 'unknown';
  try { host = new URL(String(url)).hostname.replace(/^www\./, ''); } catch (_) {}
  const slug = String(host || 'unknown').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 48);
  return 'docs:web:' + slug;
}

function webTitleFor(url) {
  try {
    const u = new URL(String(url));
    const tail = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(tail).slice(0, 80);
  } catch (_) { return String(url).slice(0, 80); }
}

module.exports = { drainOnce, scopeFor, webScopeFor, webTitleFor, DEFAULT_BUDGET };
