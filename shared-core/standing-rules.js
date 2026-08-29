// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const MAX_CHARS = 40000;
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
  const rank = (r) => (r && r.scope === 'project' ? 0 : 1);
  rows = rows.filter((r) => !dead.has(r.id)).sort((a, b) => rank(a) - rank(b));

  const seen = new Set();
  const lines = [];
  let omitted = 0, chars = 0;
  for (const r of rows) {
    const full = String((r && r.text) || '').replace(/\s+/g, ' ').trim();
    if (!full) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const line = '  · ' + full + (r.scope === 'project' ? '  [this project]' : '');
    if (chars + line.length > MAX_CHARS) { omitted++; continue; }
    chars += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return null;

  const foot = omitted ? '\n  (' + omitted + ' omitted for size — full list: rule_list)' : '';
  return {
    text: '[troth/STANDING-RULES] ' + lines.length + ' rules the operator set. They hold for ' +
          'this turn whether or not it looks related:\n' + lines.join('\n') + foot,
    count: lines.length, superseded: dead.size, omitted
  };
}

module.exports = { renderStandingRules, supersededIds };
