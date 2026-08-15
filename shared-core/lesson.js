// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Rules the OPERATOR gave, as opposed to lessons the machine wrote about
// itself.
//
// The substrate held 5,143 rows of type='lesson' and not one of them came
// from a person: 3,785 curriculum import, 886 fidelity warnings, 281 error
// tax, 122 critic. Everything the operator ever said about HOW to work lived
// in conversation only, and died with the window. There was no tool to write
// one — `state.recordOperatorLesson` existed with zero callers, in neither
// registry.
//
// This is the single road both registries call, for the same reason the
// forget handler has one: two implementations of the same rule drift, and the
// half that drifts is always the one nobody tested.
//
// Two things it does that a bare write cannot:
//
//   EMBEDS AT WRITE TIME. A rule with no vector is invisible to the dense arm
//   until the next background drain — measured: a rule written and asked
//   about in the same minute came back with nothing, which reads as "it
//   forgot" and is the exact failure that makes a memory untrustworthy.
//
//   REFUSES A RULE IT ALREADY HOLDS. The exact-text fingerprint below catches
//   a verbatim restatement; the same rule in different words is a different
//   fingerprint and would pile up, so near-duplicates are compared by meaning
//   and handed back to the caller instead of silently doubling the shelf.
const state  = require('./state.js');
const engram = require('./engram.js');

// Similar enough that the caller must LOOK before adding another one.
//
// This is not a duplicate detector and cannot be made into one. Measured on
// eight real rule pairs with this embedder:
//
//   paraphrase of one rule        0.892  0.829  0.644
//   two genuinely distinct rules  0.652  0.535  0.466
//   unrelated                     0.276  0.182
//
// The ranges OVERLAP — "never write identifiers into commits" vs "never push
// tags publicly" (0.652, two different rules) scores higher than a true
// restatement of the quality-over-speed rule (0.644). Any threshold that
// blocks paraphrases also blocks real rules, which is the worse error: a
// dropped rule is silent, a doubled shelf is visible. So nothing is refused
// on similarity alone. Above this line the write asks the caller to look at
// what is already there and either merge or pass confirm — and the caller is
// a model in the conversation, one question away from the operator.
const REVIEW_SIMILARITY = 0.75;

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : null;
}

async function embedText(text, embedding_host) {
  if (embedding_host) {
    try {
      const v = await engram.embedRequest(embedding_host, text);
      if (v && v.length) return { vector: Array.from(v), model: null };
    } catch (_) { /* fall through to the in-process embedder */ }
  }
  try {
    const local = require('./local-embedder.js');
    const v = await local.embed(text);
    if (v && v.length) return { vector: Array.from(v), model: local.MODEL_ID || null };
  } catch (_) { /* no embedder on this machine: the rule is still written */ }
  return null;
}

// Existing operator rules that mean roughly what `vector` means, worst-case
// one small query plus a vector read per rule. There are tens of these, not
// thousands — the shelf is meant to stay short.
function similarRules(vector, limit) {
  const rows = state.listOperatorLessons({ limit: 100 }) || [];
  const out = [];
  for (const r of rows) {
    const v = state.getEmbedding(r.id);
    if (!v) continue;
    const c = cosine(vector, v);
    if (c == null) continue;
    out.push({ id: r.id, text: r.text, scope: r.scope, similarity: Number(c.toFixed(3)) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, limit || 3);
}

async function recordRule(opts) {
  opts = opts || {};
  const text = String(opts.text || opts.lesson || '').trim();
  if (!text) return { ok: false, error: 'empty_rule' };
  if (text.length < 8) return { ok: false, error: 'too_short', detail: 'a rule needs to say what to do' };

  const emb = await embedText(text, opts.embedding_host);
  let similar = [];
  if (emb) {
    similar = similarRules(emb.vector, 3);
    const top = similar[0];
    if (top && top.similarity >= REVIEW_SIMILARITY && !opts.confirm) {
      return {
        ok: false, error: 'similar_rules_exist',
        detail: 'the substrate already holds rules close to this one. Read them: if one of them IS this rule, leave it alone or restate that one; if this is genuinely new, send it again with confirm true. When the wording is ambiguous, ask the operator which they meant rather than guessing.',
        similar
      };
    }
  }

  const wrote = state.recordOperatorLesson({
    lesson:     text,
    why:        opts.why || null,
    scope:      opts.scope === 'project' ? 'project' : 'global',
    cwd:        opts.cwd || null,
    agent_id:   opts.agent_id || 'operator',
    session_id: opts.session_id || null
  });
  if (!wrote) return { ok: false, error: 'write_failed' };
  if (wrote.duplicate) return { ok: true, id: wrote.id, duplicate: true, embedded: true, similar };

  let embedded = false;
  if (emb) {
    try { embedded = !!state.setEmbedding(wrote.id, emb.vector, { model: emb.model }); }
    catch (_) { embedded = false; }
  }
  return {
    ok: true, id: wrote.id, duplicate: false, embedded,
    scope: wrote.scope, similar
  };
}

function listRules(opts) {
  opts = opts || {};
  return state.listOperatorLessons({ limit: opts.limit || 20, cwd: opts.cwd || null }) || [];
}

module.exports = { recordRule, listRules, similarRules, REVIEW_SIMILARITY };
