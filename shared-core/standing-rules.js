// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// The harness inlines a hook's context only up to a size it does not
// publish. Measured 2026-09-03: every output above about 21 KB was written to
// a file with a 2 KB preview, so the model read two rules of fifty-six while
// the organ believed it bound all of them. The block fits a budget that
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

function renderStandingRules(state, opts) {
  opts = opts || {};
  let rows = [];
  try { rows = state.listOperatorLessons({ limit: 100, cwd: opts.cwd || null }) || []; }
  catch (_) { return null; }
  if (!rows.length) return null;

  const dead = supersededIds(rows);
  const budget = Number.isFinite(opts.budget_chars) ? opts.budget_chars : MAX_CHARS;
  const toks = promptTokens(opts.prompt);
  const rank = (r) => (r && r.scope === 'project' ? 0 : 1);
  const ts = (r) => Number(r && (r.ts || r.timestamp || r.created_at)) || 0;
  // This project's rules first; then the rules the prompt's own words touch;
  // then the newest. The order decides what survives the budget.
  rows = rows.filter((r) => !dead.has(r.id))
    .map((r) => ({ r, hit: overlap(r && r.text, toks) }))
    .sort((a, b) => rank(a.r) - rank(b.r) || b.hit - a.hit || ts(b.r) - ts(a.r))
    .map((x) => x.r);

  const seen = new Set();
  const lines = [];
  let omitted = 0, chars = 0;
  for (const r of rows) {
    const full = String((r && r.text) || '').replace(/\s+/g, ' ').trim();
    if (!full) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const line = '  · ' + clipRule(full, RULE_CHARS) + (r.scope === 'project' ? '  [this project]' : '');
    if (chars + line.length > budget) { omitted++; continue; }
    chars += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return null;

  const foot = omitted
    ? '\n  (' + omitted + ' more rule' + (omitted === 1 ? '' : 's') + ' hold this turn too; read them with rule_list when a task touches how work is done)'
    : '';
  return {
    text: '[troth/STANDING-RULES] ' + (lines.length + omitted) + ' rules the operator set. They hold for ' +
          'this turn whether or not it looks related' + (omitted ? ' (' + lines.length + ' shown)' : '') + ':\n' + lines.join('\n') + foot,
    count: lines.length, superseded: dead.size, omitted
  };
}

module.exports = { renderStandingRules, supersededIds, clipRule, MAX_CHARS, RULE_CHARS };
