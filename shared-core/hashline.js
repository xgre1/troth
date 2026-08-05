// SPDX-License-Identifier: AGPL-3.0-only
// Hashline edit format — hash-anchored line references for LLM edits.
//
// Rationale: the model references lines by a short pseudo-random tag
// (LINE#ID) instead of reproducing old content verbatim. This eliminates
// whitespace/indent/quoting mismatches that plague str_replace and
// apply_patch, and saves ~20% output tokens. Can Bölük showed a +61.6
// point lift on Grok Code Fast 1 (6.7%→68.3%) and 5-14 pt lifts on 14
// of 15 tested models, just by switching edit format.
//
// Reference: https://blog.can.ac/2026/02/12/the-harness-problem/
//            https://github.com/can1357/oh-my-pi
//            https://deepwiki.com/code-yeongyu/oh-my-opencode/9.3-hash-anchored-edit-system
//
// Wire format shown to the model (read_hashlined):
//
//   1#AB|import { foo } from 'bar';
//   2#ZK|
//   3#MQ|function greet(name) {
//   4#YH|  return `hello ${name}`;
//   5#TJ|}
//
// Model emits edits as JSON:
//   { "op": "replace", "pos": "4#YH", "lines": "  return `hi ${name}`;" }
//   { "op": "replace", "pos": "3#MQ", "end": "5#TJ", "lines": ["...", "..."] }
//   { "op": "append",  "pos": "5#TJ", "lines": ["", "export { greet };"] }
//   { "op": "prepend", "pos": "1#AB", "lines": "// header comment" }
//   { "op": "replace", "pos": "4#YH", "lines": null }   // delete single line
//
// Hash algorithm: xxHash32 of the normalized line (CR stripped, trailing
// whitespace trimmed), masked to 8 bits, encoded as 2 characters from a
// 16-char alphabet. Seed is 0 for lines with any alphanumeric character,
// otherwise the line number (reduces collisions for whitespace-only or
// punctuation-only lines). The tag exists to reject stale edits: if the
// file changed between read and apply, the hash won't match and we
// refuse the edit.

// 16-character alphabet. Avoids visually ambiguous chars (I/1/L/0/O, etc.)
// and doesn't collide with common token boundaries. 4 bits per char × 2
// chars = 8 bits of entropy.
const ALPHABET = 'ZPMQVRWSNKTXJBYH';

// ── xxHash32 (pure JS, no external dep) ────────────────────────────────
const PRIME32_1 = 0x9E3779B1;
const PRIME32_2 = 0x85EBCA77;
const PRIME32_3 = 0xC2B2AE3D;
const PRIME32_4 = 0x27D4EB2F;
const PRIME32_5 = 0x165667B1;

function mul32(a, b) {
  // 32-bit integer multiply with overflow wrap. JS multiply on large
  // integers loses precision past 2^53 so we split into 16-bit halves.
  const aHigh = (a >>> 16) & 0xFFFF;
  const aLow  = a & 0xFFFF;
  const bHigh = (b >>> 16) & 0xFFFF;
  const bLow  = b & 0xFFFF;
  return (aLow * bLow + (((aLow * bHigh + aHigh * bLow) & 0xFFFF) << 16)) >>> 0;
}

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function xxHash32(input, seed) {
  seed = (seed || 0) >>> 0;
  const buf = Buffer.from(input, 'utf8');
  const len = buf.length;
  let h32;
  let i = 0;

  if (len >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;
    const limit = len - 16;
    while (i <= limit) {
      v1 = mul32(rotl32((v1 + mul32(buf.readUInt32LE(i), PRIME32_2)) >>> 0, 13), PRIME32_1); i += 4;
      v2 = mul32(rotl32((v2 + mul32(buf.readUInt32LE(i), PRIME32_2)) >>> 0, 13), PRIME32_1); i += 4;
      v3 = mul32(rotl32((v3 + mul32(buf.readUInt32LE(i), PRIME32_2)) >>> 0, 13), PRIME32_1); i += 4;
      v4 = mul32(rotl32((v4 + mul32(buf.readUInt32LE(i), PRIME32_2)) >>> 0, 13), PRIME32_1); i += 4;
    }
    h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    h32 = (seed + PRIME32_5) >>> 0;
  }

  h32 = (h32 + len) >>> 0;
  while (i <= len - 4) {
    h32 = mul32(rotl32((h32 + mul32(buf.readUInt32LE(i), PRIME32_3)) >>> 0, 17), PRIME32_4);
    i += 4;
  }
  while (i < len) {
    h32 = mul32(rotl32((h32 + mul32(buf[i], PRIME32_5)) >>> 0, 11), PRIME32_1);
    i++;
  }

  h32 ^= h32 >>> 15;
  h32 = mul32(h32, PRIME32_2);
  h32 ^= h32 >>> 13;
  h32 = mul32(h32, PRIME32_3);
  h32 ^= h32 >>> 16;
  return h32 >>> 0;
}

// ── Line hash + tag encoding ──────────────────────────────────────────
function normalizeLine(line) {
  // Strip trailing \r (Windows line endings) and trailing whitespace.
  // Leading whitespace is preserved — it's semantically significant in
  // most languages (Python block structure, YAML, Markdown code blocks).
  return line.replace(/\r$/, '').replace(/[ \t]+$/, '');
}

function lineHasAlphanumeric(s) {
  return /[A-Za-z0-9]/.test(s);
}

function encodeTag(hash) {
  const byte = hash & 0xFF;
  return ALPHABET[(byte >> 4) & 0xF] + ALPHABET[byte & 0xF];
}

function computeTag(line, lineNumber) {
  const normalized = normalizeLine(line);
  // Whitespace-only / punctuation-only lines get high collision rates
  // with seed=0 (the tag degenerates to "ZZ" or similar for all blank
  // lines). Use the line number as seed to decorrelate them.
  const seed = lineHasAlphanumeric(normalized) ? 0 : lineNumber;
  const h = xxHash32(normalized, seed);
  return encodeTag(h);
}

// Turn raw file content into the wire format shown to the model:
//   "1#AB|line 1\n2#CD|line 2\n..."
// Tags are always 2 chars; line numbers are 1-indexed. Separator is "|"
// so model replies can reliably split on it without escaping issues in
// JSON strings.
function encodeFile(content) {
  const lines = content.split('\n');
  const out = [];
  const tags = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const tag = computeTag(lines[i], lineNum);
    tags.push(tag);
    out.push(lineNum + '#' + tag + '|' + lines[i]);
  }
  return { decorated: out.join('\n'), tags };
}

// Parse a model-emitted pos string like "42#VK" into {line, tag}.
// Returns null on malformed input.
function parsePos(pos) {
  if (typeof pos !== 'string') return null;
  const m = pos.match(/^(\d+)#([A-Za-z]{2})$/);
  if (!m) return null;
  return { line: parseInt(m[1], 10), tag: m[2] };
}

// Validate a single reference against current file content. Returns
// { ok: true } if the hash matches, or { ok: false, expected, got } if
// the line has drifted.
function validateRef(content, pos) {
  const p = parsePos(pos);
  if (!p) return { ok: false, reason: 'malformed_pos', pos };
  const lines = content.split('\n');
  if (p.line < 1 || p.line > lines.length) {
    return { ok: false, reason: 'out_of_range', pos, line_count: lines.length };
  }
  const actualTag = computeTag(lines[p.line - 1], p.line);
  if (actualTag !== p.tag) {
    return { ok: false, reason: 'hash_mismatch', pos, expected: p.tag, got: actualTag };
  }
  return { ok: true, line: p.line };
}

// Apply a list of edits to `content`. Edits reference line numbers
// AS OF THE ORIGINAL (read-time) content; we sort bottom-up before
// applying so line numbers above each edit stay stable.
//
// Edit shape:
//   { op: 'replace'|'append'|'prepend', pos: 'N#XY', end?: 'M#XY',
//     lines: string | string[] | null }
//
// Returns { ok, content?, errors?, applied: [{ op, from, to }] }.
function applyEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, errors: [{ reason: 'no_edits' }] };
  }

  // Validate all refs up-front. Fail the whole batch on the first bad
  // hash — partial application of hash-anchored edits is unsafe because
  // later edits were indexed off the pre-edit content.
  const errors = [];
  const parsed = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.op !== 'string') {
      errors.push({ index: i, reason: 'bad_edit' });
      continue;
    }
    if (!['replace', 'append', 'prepend'].includes(e.op)) {
      errors.push({ index: i, reason: 'unknown_op', op: e.op });
      continue;
    }
    const from = validateRef(content, e.pos);
    if (!from.ok) { errors.push(Object.assign({ index: i }, from)); continue; }
    let to = from;
    if (e.end) {
      to = validateRef(content, e.end);
      if (!to.ok) { errors.push(Object.assign({ index: i }, to)); continue; }
      if (to.line < from.line) {
        errors.push({ index: i, reason: 'end_before_pos', from: from.line, to: to.line });
        continue;
      }
    }
    parsed.push({ index: i, edit: e, from: from.line, to: to.line });
  }
  if (errors.length) return { ok: false, errors };

  // Bottom-up apply.
  parsed.sort((a, b) => b.from - a.from);
  const lines = content.split('\n');
  const applied = [];

  for (const p of parsed) {
    const payload = p.edit.lines;
    let insert;
    if (payload === null) insert = [];
    else if (typeof payload === 'string') insert = payload.split('\n');
    else if (Array.isArray(payload)) {
      // Normalize — any string in the array that contains \n gets split
      // so the caller doesn't have to flatten manually.
      insert = payload.flatMap(s => typeof s === 'string' ? s.split('\n') : []);
    } else insert = [];

    const fromIdx = p.from - 1;
    const toIdx   = p.to - 1;

    if (p.edit.op === 'replace') {
      lines.splice(fromIdx, toIdx - fromIdx + 1, ...insert);
    } else if (p.edit.op === 'append') {
      // Insert AFTER the anchor.
      lines.splice(toIdx + 1, 0, ...insert);
    } else if (p.edit.op === 'prepend') {
      // Insert BEFORE the anchor.
      lines.splice(fromIdx, 0, ...insert);
    }
    applied.push({ op: p.edit.op, from: p.from, to: p.to, lines_in: insert.length });
  }

  return { ok: true, content: lines.join('\n'), applied };
}

module.exports = {
  // wire format
  encodeFile,
  parsePos,
  computeTag,
  validateRef,
  applyEdits,
  // primitives exposed for tests
  xxHash32,
  normalizeLine,
  ALPHABET,
};
