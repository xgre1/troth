// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// The harness inlines a hook's context only up to a size it does not
// publish: above about 21 KB the output goes to a file with a 2 KB preview,
// and the model reads the preview. The block fits a budget that
// leaves room for the recall and identity blocks beside it; a rule is shown
// by its opening sentences, and the full text stays one rule_list away.
const MAX_CHARS = 6000;
const RULE_CHARS = 280;

// A rule's opening: cut at the last sentence end inside the allowance, else
// at the last space, with a mark that more follows.
function clipRule(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf('! '));
  if (stop >= max * 0.5) return head.slice(0, stop + 1) + ' …';
  const sp = head.lastIndexOf(' ');
  return head.slice(0, sp > max * 0.6 ? sp : max) + ' …';
}

// The words of the prompt, for ranking: a rule whose own words the prompt
// touches comes before one that does not. Short words and numbers carry
// nothing.
function promptTokens(prompt) {
  const out = new Set();
  for (const w of String(prompt || '').toLowerCase().split(/[^a-z\u0370-\u03ff0-9_]+/)) if (w.length >= 4) out.add(w);
  return out;
}
function overlap(text, toks) {
  if (!toks.size) return 0;
  let n = 0;
  const seen = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z\u0370-\u03ff0-9_]+/)) {
    if (w.length >= 4 && toks.has(w) && !seen.has(w)) { seen.add(w); n++; }
  }
  return n;
}
const SUPERSEDES_RE = /SUPERSEDES\s+rule\s+([0-9a-f][0-9a-f-]{7,})/i;

function supersededIds(rows) {
  const dead = new Set();
  for (const r of rows) {
    const m = String((r && r.text) || '').match(SUPERSEDES_RE);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    for (const other of rows) {
      if (other === r) continue;
      const id = String((other && other.id) || '').toLowerCase();
      if (id && id.indexOf(prefix) === 0) dead.add(other.id);
    }
  }
  return dead;
}

// The rules in the order they are read: superseded ones dropped, duplicates
// folded, this project's first, then the ones the prompt's own words touch,
// then the newest. Both the per-prompt block and rule_list read this order.
function rankRules(rows, opts) {
  opts = opts || {};
  const dead = supersededIds(rows);
  const toks = promptTokens(opts.prompt);
  const rank = (r) => (r && r.scope === 'project' ? 0 : 1);
  const ts = (r) => Number(r && (r.ts || r.timestamp || r.created_at)) || 0;
  const seen = new Set();
  const out = [];
  const ordered = rows.filter((r) => r && !dead.has(r.id))
    .map((r) => ({ r, hit: overlap(r && r.text, toks) }))
    .sort((a, b) => rank(a.r) - rank(b.r) || b.hit - a.hit || ts(b.r) - ts(a.r));
  for (const x of ordered) {
    const full = String((x.r && x.r.text) || '').replace(/\s+/g, ' ').trim();
    if (!full) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ row: x.r, text: full, hit: x.hit });
  }
  return { rules: out, superseded: dead.size };
}

function renderStandingRules(state, opts) {
  opts = opts || {};
  let rows = [];
  try { rows = state.listOperatorLessons({ limit: 100, cwd: opts.cwd || null }) || []; }
  catch (_) { return null; }
  if (!rows.length) return null;

  const budget = Number.isFinite(opts.budget_chars) ? opts.budget_chars : MAX_CHARS;
  const ranked = rankRules(rows, { prompt: opts.prompt });
  const lines = [];
  let omitted = 0, chars = 0;
  for (const { row, text } of ranked.rules) {
    const line = '  · ' + clipRule(text, RULE_CHARS) + (row.scope === 'project' ? '  [this project]' : '');
    if (chars + line.length > budget) { omitted++; continue; }
    chars += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return null;

  const foot = omitted
    ? '\n  (' + omitted + ' more rule' + (omitted === 1 ? '' : 's') + ' hold this turn too; when a task touches how work is done, ask rule_list with the topic)'
    : '';
  return {
    text: '[troth/STANDING-RULES] ' + (lines.length + omitted) + ' rules the operator set. They hold for ' +
          'this turn whether or not it looks related' + (omitted ? ' (' + lines.length + ' shown)' : '') + ':\n' + lines.join('\n') + foot,
    count: lines.length, superseded: ranked.superseded, omitted
  };
}

// The rules on a topic, for the tool: the same order as the block, whole
// text for the rules that fit the budget and an opening line for the rest,
// each with its scope and the day it was set. What does not fit is counted.
const LIST_CHARS = 8000;
const LIST_LIMIT = 20;
function listRulesFor(state, opts) {
  opts = opts || {};
  let rows = [];
  try { rows = state.listOperatorLessons({ limit: 100, cwd: opts.cwd || null }) || []; }
  catch (_) { rows = []; }
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit || LIST_LIMIT, 10) || LIST_LIMIT));
  const budget = Number.isFinite(opts.budget_chars) ? opts.budget_chars : LIST_CHARS;
  const ranked = rankRules(rows, { prompt: opts.topic });
  const items = [];
  let chars = 0, omitted = 0, clipped = 0;
  for (const { row, text } of ranked.rules) {
    if (items.length >= limit) { omitted++; continue; }
    const when = row.timestamp ? new Date(Number(row.timestamp)).toISOString().slice(0, 10) : null;
    let shown = text;
    if (chars + shown.length > budget) {
      shown = clipRule(text, RULE_CHARS);
      if (chars + shown.length > budget) { omitted++; continue; }
      clipped++;
    }
    chars += shown.length;
    items.push({ id: row.id, when, scope: row.scope === 'project' ? 'this project' : 'general', text: shown });
  }
  const out = { count: ranked.rules.length, shown: items.length, omitted, clipped, superseded_dropped: ranked.superseded, items };
  if (omitted || clipped) out.note = (omitted ? omitted + ' more rule' + (omitted === 1 ? '' : 's') + ' not shown' : '') + (omitted && clipped ? '; ' : '') + (clipped ? clipped + ' shown by their opening only' : '') + '. Ask again with a narrower topic for the rest.';
  return out;
}

module.exports = { renderStandingRules, listRulesFor, rankRules, supersededIds, clipRule, MAX_CHARS, RULE_CHARS, LIST_CHARS, LIST_LIMIT };
