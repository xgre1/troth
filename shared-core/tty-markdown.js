// SPDX-License-Identifier: AGPL-3.0-only
// tty-markdown.js — a reply rendered for the terminal.
//
// Headings, paragraphs, lists (nested, numbered, task), fenced code with its
// language, tables, quotes, rules, and inline bold / italic / code / links,
// wrapped to a width with hanging indents. No dependency, no full parser: a
// line-based block reader and an inline tokenizer, enough for what an engine
// writes back. Colour comes from the caller's palette so the module stays
// pure; without a palette the text is styled with plain ANSI attributes, and
// with tty:false it is returned exactly as it came.
'use strict';

const RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }
function visibleWidth(s) { return stripAnsi(s).length; }

const PLAIN = {
  text:   (s) => s,
  strong: (s) => '\x1b[1m' + s + RESET,
  em:     (s) => '\x1b[3m' + s + RESET,
  code:   (s) => '\x1b[7m' + s + RESET,
  head:   (s, level) => (level <= 2 ? '\x1b[1m' : '\x1b[1;2m') + s + RESET,
  dim:    (s) => '\x1b[2m' + s + RESET,
  link:   (s) => '\x1b[4m' + s + RESET,
  bullet: (s) => '\x1b[2m' + s + RESET,
  codeLine: (s) => s,
  strike: (s) => '\x1b[9m' + s + RESET
};

// ── inline ──────────────────────────────────────────────────────────────
// A line becomes segments {t, k}: k is 'text' | 'strong' | 'em' | 'code' |
// 'link' | 'strike'. Code wins over everything inside it.
function tokenizeInline(line) {
  const segs = [];
  let i = 0;
  const push = (t, k) => { if (t) segs.push({ t, k }); };
  while (i < line.length) {
    const rest = line.slice(i);
    let m;
    if ((m = rest.match(/^`([^`\n]+?)`/))) { push(m[1], 'code'); i += m[0].length; continue; }
    if ((m = rest.match(/^\*\*([^*\n]+?)\*\*/)) || (m = rest.match(/^__([^_\n]+?)__/))) { push(m[1], 'strong'); i += m[0].length; continue; }
    if ((m = rest.match(/^~~([^~\n]+?)~~/))) { push(m[1], 'strike'); i += m[0].length; continue; }
    if ((m = rest.match(/^\[([^\]\n]+?)\]\(([^)\s]+)\)/))) {
      push(m[1], 'link');
      if (m[2] !== m[1]) push(' (' + m[2] + ')', 'dim');
      i += m[0].length; continue;
    }
    const prevOk = i === 0 || /[\s(\[{"'"“‘]/.test(line[i - 1]);
    if (prevOk && ((m = rest.match(/^\*([^*\n]+?)\*(?![\w*])/)) || (m = rest.match(/^_([^_\n]+?)_(?![\w_])/)))) {
      push(m[1], 'em'); i += m[0].length; continue;
    }
    // plain run up to the next candidate marker
    const next = rest.slice(1).search(/[`*_~\[]/);
    const take = next < 0 ? rest.length : next + 1;
    push(rest.slice(0, take), 'text');
    i += take;
  }
  return segs;
}

function styleSeg(seg, P) {
  switch (seg.k) {
    case 'strong': return P.strong(seg.t);
    case 'em':     return P.em(seg.t);
    case 'code':   return P.code(seg.t);
    case 'link':   return P.link(seg.t);
    case 'strike': return P.strike(seg.t);
    case 'dim':    return P.dim(seg.t);
    default:       return P.text(seg.t);
  }
}

// Wrap styled segments into lines of at most `width` visible columns. A
// break happens at a space; a single token longer than the width is cut.
function wrapSegments(segs, width, P) {
  const lines = [];
  let cur = '', curW = 0;
  const flush = () => { lines.push(cur); cur = ''; curW = 0; };
  for (const seg of segs) {
    const words = seg.t.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      const isSpace = /^\s+$/.test(w);
      if (isSpace) {
        if (curW === 0) continue;
        if (curW + 1 > width) { flush(); continue; }
        cur += styleSeg({ t: ' ', k: seg.k === 'code' ? 'code' : 'text' }, P); curW += 1;
        continue;
      }
      let word = w;
      while (word.length) {
        const room = width - curW;
        if (word.length <= room) {
          cur += styleSeg({ t: word, k: seg.k }, P); curW += word.length; word = '';
        } else if (curW > 0) {
          // trailing space already counted; drop it visually by flushing
          flush();
        } else {
          cur += styleSeg({ t: word.slice(0, width), k: seg.k }, P); curW = width; word = word.slice(width);
          flush();
        }
      }
    }
  }
  if (curW > 0 || !lines.length) lines.push(cur);
  return lines.map((l) => l.replace(/\s+$/, ''));
}

function wrapInline(text, width, P) {
  return wrapSegments(tokenizeInline(text), Math.max(8, width), P);
}

// ── blocks ──────────────────────────────────────────────────────────────
const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEAD_RE  = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE    = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM_RE  = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTableLine(l) { return /^\s*\|.*\|\s*$/.test(l); }
function splitCells(l) {
  const s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map((c) => c.trim());
}

function renderTable(rows, width, P) {
  const cells = rows.map(splitCells);
  const ncols = Math.max.apply(null, cells.map((r) => r.length));
  const colW = new Array(ncols).fill(0);
  for (const r of cells) for (let c = 0; c < ncols; c++) colW[c] = Math.max(colW[c], visibleWidth(stripMarkers(r[c] || '')));
  // Fit: every column at most its share of the width, never under 4.
  const gutter = 3;
  let total = colW.reduce((a, b) => a + b, 0) + gutter * (ncols - 1);
  if (total > width) {
    const share = Math.max(4, Math.floor((width - gutter * (ncols - 1)) / ncols));
    for (let c = 0; c < ncols; c++) colW[c] = Math.min(colW[c], share);
  }
  const bar = P.dim('│');
  const line = (r, isHead) => {
    const parts = [];
    for (let c = 0; c < ncols; c++) {
      const raw = r[c] || '';
      const styled = isHead ? P.strong(stripMarkers(raw)) : inlineOneLine(raw, P);
      let vis = visibleWidth(styled);
      let out = styled;
      if (vis > colW[c]) { out = cutVisible(styled, colW[c] - 1) + P.dim('…'); vis = colW[c]; }
      parts.push(out + ' '.repeat(Math.max(0, colW[c] - vis)));
    }
    return parts.join(' ' + bar + ' ');
  };
  const out = [line(cells[0], true)];
  out.push(P.dim(colW.map((w) => '─'.repeat(w)).join('─┼─')));
  for (let r = 1; r < cells.length; r++) out.push(line(cells[r], false));
  return out;
}

function stripMarkers(s) {
  return tokenizeInline(String(s)).map((x) => x.t).join('');
}
function inlineOneLine(s, P) {
  return tokenizeInline(String(s)).map((x) => styleSeg(x, P)).join('');
}
function cutVisible(s, w) {
  let out = '', vis = 0, i = 0;
  while (i < s.length && vis < w) {
    if (s[i] === '\x1b') { const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i)); if (m) { out += m[0]; i += m[0].length; continue; } }
    out += s[i]; i++; vis++;
  }
  return out + RESET;
}

function bulletFor(marker, depth) {
  if (/^\d/.test(marker)) return marker.replace(/\)$/, '.');
  return ['•', '◦', '▪'][Math.min(2, depth)];
}

function render(text, opts) {
  opts = opts || {};
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (opts.tty === false) return src;
  const P = Object.assign({}, PLAIN, opts.palette || {});
  const width = Math.max(20, opts.width || 80);
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ').replace(/\s+/g, ' ').trim();
    for (const l of wrapInline(joined, width, P)) out.push(l);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    // fenced code
    if ((m = line.match(FENCE_RE))) {
      flushPara();
      const fence = m[1], lang = m[2];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].match(FENCE_RE) && lines[i].trim().startsWith(fence))) { body.push(lines[i]); i++; }
      i++; // closing fence (or end)
      const w = Math.min(width, Math.max(24, body.reduce((a, l) => Math.max(a, l.length), 0) + 2));
      const label = lang ? ' ' + lang + ' ' : '';
      blank();
      out.push(P.dim('┄' + label + '┄'.repeat(Math.max(1, w - label.length - 1))));
      for (const l of body) out.push(P.codeLine('  ' + l, w));
      out.push(P.dim('┄'.repeat(w)));
      out.push('');
      continue;
    }
    // blank line ends a paragraph
    if (!line.trim()) { flushPara(); blank(); i++; continue; }
    // heading
    if ((m = line.match(HEAD_RE))) {
      flushPara(); blank();
      const level = m[1].length;
      out.push(P.head(stripMarkers(m[2]), level));
      i++; continue;
    }
    // rule
    if (HR_RE.test(line)) { flushPara(); blank(); out.push(P.dim('─'.repeat(Math.min(width, 32)))); out.push(''); i++; continue; }
    // table
    if (isTableLine(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushPara(); blank();
      const rows = [line];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) { rows.push(lines[i]); i++; }
      for (const l of renderTable(rows, width, P)) out.push(l);
      out.push('');
      continue;
    }
    // quote
    if ((m = line.match(QUOTE_RE))) {
      flushPara();
      const q = [];
      while (i < lines.length && (m = lines[i].match(QUOTE_RE))) { q.push(m[1]); i++; }
      const joined = q.join(' ').replace(/\s+/g, ' ').trim();
      for (const l of wrapInline(joined, width - 2, P)) out.push(P.dim('▎ ') + P.em(stripAnsi(l)));
      continue;
    }
    // list item, with lazy continuation lines
    if ((m = line.match(ITEM_RE))) {
      flushPara();
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
      let body = m[3];
      let glyph = bulletFor(m[2], depth);
      let tm;
      if ((tm = body.match(/^\[([ xX])\]\s+(.*)$/))) { glyph = tm[1] === ' ' ? '☐' : '☑'; body = tm[2]; }
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].match(ITEM_RE) && !lines[i].match(HEAD_RE) && !lines[i].match(FENCE_RE) && !isTableLine(lines[i]) && !lines[i].match(QUOTE_RE)) {
        body += ' ' + lines[i].trim(); i++;
      }
      const indent = '  '.repeat(depth);
      const hang = ' '.repeat(glyph.length + 1);
      const wrapped = wrapInline(body, width - indent.length - hang.length, P);
      out.push(indent + P.bullet(glyph) + ' ' + wrapped[0]);
      for (let k = 1; k < wrapped.length; k++) out.push(indent + hang + wrapped[k]);
      continue;
    }
    // paragraph line
    para.push(line.trim());
    i++;
  }
  flushPara();
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.join('\n');
}

module.exports = { render, tokenizeInline, wrapInline, stripAnsi, visibleWidth, PLAIN };
