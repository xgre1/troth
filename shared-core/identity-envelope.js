// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// identity-envelope.js — THE one always-on self-frame composer (single-mind).
//
// The single-mind invariant (the project's core design note): the partner must present ONE
// identity on EVERY surface. Before this, three surfaces disagreed (an internal audit):
//   entity anchors read: commitment_type='anchor', top-N by salience, with
//     NO tier='flagged' exclusion (flagged facts leaked into the self-frame)
//   entity Phase-F read: scope='identity', flagged-excluded, but its own
//     0.3 fail-weak authority default (the same lobotomy as recall, an internal audit
//   proxy injector: scope='identity', flagged-excluded, cap 8, no anchors
// So the partner literally had a different self depending on which mouth spoke.
//
// composeEnvelope() is the one function all surfaces call. Design (Northoff 2006 cognitive modeling
// always-on identity, the memory-layer design (P4/P7); customized to our engram model):
//   1. UNION both identity pools — commitment_type='anchor' AND scope='identity'.
//   2. Exclude tier='flagged' from BOTH (fixes the anchor leak).
//   3. Dedup by normalized statement.
//   4. Rank by salience × authority_weight using the ONE shared authority model
//      (authority-weights.js — fail-neutral, not the old 0.3 default).
//   5. Hard budget (default 8 items) and render the <memory_identity> block.
//
// listEngrams is dependency-injected (the caller passes engram.listEngrams) so
// this is pure + unit-testable and works identically on entity, proxy, plugin.

const { authorityWeightOf } = require('./authority-weights.js');

function _norm(s) { return String(s || '').trim().toLowerCase(); }
function _text(e) { return (e && (e.statement || e.text)) ? String(e.statement || e.text).trim() : ''; }

// Fuzzy dedup key: strip punctuation + stopwords, sort residue. Equivalent
// facts ("we are building X" vs "the project is X") collapse; distinct facts
// stay distinct. Lifted from the entity's Phase-F dedup so this is a true
// superset, not a regression. (audit: 120 identity rows → 6 unique, 95% waste.)
const _STOP = new Set(['the','a','an','is','are','we','i','our','my','this','that','of','to','for','with','on','in']);
function _fuzzyKey(s) {
  return String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !_STOP.has(w))
    .sort()
    .join(' ');
}

// composeEnvelope(opts) — THE one always-on identity surface. opts:
//   listEngrams         (required) — fn(query)→rows; dependency-injected
//   budgetItems=8       — hard cap on item count
//   charBudget=null     — optional hard char cap on the rendered block content
//   itemCharCap=200     — per-item statement truncation
//   anchorLimit=12, identityLimit=50 — read depths
//   projectMatchFactor  — optional fn(engram)→number multiplier (e.g. the
//                         entity's 1.0 in-project / 0.5 out-of-project downweight)
//   fuzzyDedup=true     — stopword-strip dedup (false = exact-norm only)
//   tag='memory_identity' — block tag
//   render=true         — whether to build the block string
//   → { items:[{statement,salience,authW,score,source,cwd}], block }
function composeEnvelope(opts) {
  opts = opts || {};
  const listEngrams = opts.listEngrams;
  if (typeof listEngrams !== 'function') {
    throw new Error('composeEnvelope: listEngrams function is required');
  }
  const budgetItems   = opts.budgetItems   || 8;
  const anchorLimit   = opts.anchorLimit   || 12;
  const identityLimit = opts.identityLimit || 50;
  const itemCharCap   = opts.itemCharCap   || 200;
  const charBudget    = (typeof opts.charBudget === 'number') ? opts.charBudget : null;
  const fuzzyDedup    = opts.fuzzyDedup !== false;
  const tag           = opts.tag || 'memory_identity';
  const pmf           = (typeof opts.projectMatchFactor === 'function') ? opts.projectMatchFactor : null;

  let anchors = [];
  let identity = [];
  try { anchors  = listEngrams({ type: 'commitment', commitment_type: 'anchor', limit: anchorLimit }) || []; } catch (_) {}
  try { identity = listEngrams({ scope: 'identity', limit: identityLimit }) || []; } catch (_) {}

  const seen = new Set();
  const ranked = [];
  // Anchors first so an anchor wins the dedup over a plain identity engram of
  // the same text (anchors are the deliberate self-frame).
  for (const e of [...anchors.map(a => ({ e: a, source: 'anchor' })),
                   ...identity.map(i => ({ e: i, source: 'identity' }))]) {
    const txt = _text(e.e);
    if (!txt) continue;
    if (e.e.tier === 'flagged') continue;           // exclude flagged from BOTH pools
    const key = fuzzyDedup ? _fuzzyKey(txt) : _norm(txt);
    if (seen.has(key)) continue;
    seen.add(key);
    const salience = typeof e.e.salience === 'number' ? e.e.salience : 1.0;
    const authW = authorityWeightOf(e.e.source_authority);
    const projF = pmf ? pmf(e.e) : 1.0;
    ranked.push({ statement: txt, salience, authW, score: salience * authW * projF, source: e.source, cwd: e.e.cwd });
  }

  ranked.sort((a, b) => b.score - a.score);

  // Apply item budget, then optional char budget (item-by-item, like the
  // entity's L2.3 hard push budget).
  const items = [];
  let usedChars = 0;
  for (const r of ranked) {
    if (items.length >= budgetItems) break;
    const capped = r.statement.replace(/\s+/g, ' ').slice(0, itemCharCap);
    if (charBudget !== null && usedChars + capped.length + 2 > charBudget) break;
    items.push(Object.assign({}, r, { statement: capped }));
    usedChars += capped.length + 2; // '- ' + item
  }

  let block = '';
  if (items.length) {
    block = '<' + tag + '>\n' + items.map(i => '- ' + i.statement).join('\n') + '\n</' + tag + '>';
  }
  return { items, block };
}

module.exports = { composeEnvelope, _fuzzyKey };
