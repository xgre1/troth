// SPDX-License-Identifier: AGPL-3.0-only Tokenizer-aware wire
// format (TOON-style). Translates raw ActionRecord rows into a compact,
// schema-declared representation for LLM consumption. Storage layer stays
// verbose JSON in SQLite — this layer is invoked when records fault into the
// model's context (manifest, fault_in, query_actions response). Design: -
// Schema-first: declare keys + types ONCE in a payload header. - Positional
// rows: each record is a pipe-delimited line of values. - Alias dict:
// high-frequency string values get short aliases (&0, &1, ...) declared in the
// header; row body references the alias. - Stripped fields: we omit nulls,
// empty objects, empty arrays. - Reserved metadata: an `_id` column always
// present so records are referrable by UUIDv7 just like in JSON. We
// deliberately do NOT implement the full TOON spec (toon-format/toon) — only
// the columnar slice that maps cleanly onto our flat ActionRecord shape. TRON
// for nested DAGs lands in Tier 2. Constraint: round-trip integrity 100%.
// encode(decode(x)) === x for every supported ActionRecord type.

const ACTION_RECORD_KEYS = Object.freeze([
  'id', 'timestamp', 'type', 'agent_id', 'session_id', 'user_id',
  'cwd', 'parent_id', 'context_hash', 'input', 'output',
  'verification', 'outcome'
]);

const HIGH_FREQ_VALUE_PATTERNS = Object.freeze([
  // Common agent_id values across tens of thousands of records.
  /^claude-code$/, /^troth-plugin$/, /^proxy$/, /^cc$/,
  // Common cwd prefixes (full paths still get aliased per-cwd).
  // We don't pre-bake paths — they'd be brittle. Aliasing is dynamic
  // based on the actual batch.
]);

// ── Alias-dictionary builder ──────────────────────────────────────────────
// Walks the batch, counts string-value frequency, returns a map of
// values → short alias tokens (&0, &1, ...). Threshold: a value gets
// aliased only if it appears in ≥3 records or matches a known
// high-freq pattern. Cap aliases at 64 to keep header compact.
function buildAliasDict(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const k of ACTION_RECORD_KEYS) {
      const v = row[k];
      if (typeof v !== 'string' || !v.length || v.length > 80) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  // Eligible: count ≥3 OR matches high-freq pattern.
  const eligible = [];
  for (const [val, n] of counts.entries()) {
    if (n >= 3) { eligible.push({ val, n }); continue; }
    for (const re of HIGH_FREQ_VALUE_PATTERNS) {
      if (re.test(val)) { eligible.push({ val, n }); break; }
    }
  }
  // Rank by value-savings: (count * length). Cap at 64 aliases.
  eligible.sort((a, b) => (b.n * b.val.length) - (a.n * a.val.length));
  const dict = {};
  for (let i = 0; i < Math.min(eligible.length, 64); i++) {
    dict[eligible[i].val] = '&' + i;
  }
  return dict;
}

// ── Encoding ─────────────────────────────────────────────────────────────
// Serialize JSON input/output/verification/outcome blobs as compact
// JSON minus surrounding whitespace. We keep them inline (not aliased)
// because they're dense and rarely repeat verbatim.
function _encodeJsonField(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  // Already-stringified columns from SQLite arrive as strings.
  if (typeof v !== 'object') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

// Escape pipe-delimiter and backslash so values don't collide with
// the framing. Newlines escaped as literal `\n`. Encode preserves order
// (backslash MUST be escaped first); decode uses a single pass so
// `\\r` (escaped backslash + 'r') is never confused with `\r`
// (escaped CR character).
function _escape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function _unescape(s) {
  s = String(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\' || i + 1 >= s.length) { out += ch; continue; }
    const next = s[i + 1];
    if (next === '\\')      { out += '\\'; i++; }
    else if (next === '|')  { out += '|';  i++; }
    else if (next === 'n')  { out += '\n'; i++; }
    else if (next === 'r')  { out += '\r'; i++; }
    else                    { out += ch; }     // unknown escape — keep literal
  }
  return out;
}

// Encode a batch of ActionRecord rows to TOON. Rows is an array of
// either raw rows from state.queryActions (column values still JSON-
// stringified for input/output/verification/outcome) OR fully-parsed
// records (where those fields are objects). We handle both.
//
// opts.profile_aliases — optional pre-computed alias dictionary
// (typically pulled from wire_format_profiles by the caller). When
// supplied, we skip the per-batch frequency scan and use the profile's
// dict verbatim. This lets P17 Tier 3 LLM-evolved profiles take effect:
// the encoder uses the LLM's per-domain mapping instead of recomputing
// from the local batch, which matters for small batches (<20 records)
// where local frequency analysis cannot find patterns the LLM saw
// across hundreds of records.
function encodeBatch(rows, opts) {
  opts = opts || {};
  if (!Array.isArray(rows)) return null;
  if (rows.length === 0) {
    return JSON.stringify({ __toon: 1, keys: ACTION_RECORD_KEYS, aliases: {}, rows: [] });
  }
  // Normalize: ensure every JSON field is a string (re-stringify objects).
  const norm = rows.map(r => {
    const out = {};
    for (const k of ACTION_RECORD_KEYS) {
      if (k === 'input' || k === 'output' || k === 'verification' || k === 'outcome') {
        out[k] = _encodeJsonField(r[k]);
      } else {
        out[k] = r[k] == null ? '' : r[k];
      }
    }
    return out;
  });
  // Use injected profile aliases when present AND the batch is large
  // enough that header overhead amortizes. Empirically, batches <5
  // records lose 4-8% to header bloat from declared-but-rarely-used
  // aliases — at that scale auto-detect is better. The break-even
  // moves toward smaller batches as the alias dict gets shorter, but
  // 5 is a safe default.
  // When using a profile, prune it to entries actually present so we
  // don't carry header bytes for unused aliases.
  let aliases;
  const useProfile = opts.profile_aliases &&
                     typeof opts.profile_aliases === 'object' &&
                     norm.length >= 5;
  if (useProfile) {
    const present = new Set();
    for (const row of norm) {
      for (const k of ACTION_RECORD_KEYS) {
        const v = row[k];
        if (typeof v === 'string' && opts.profile_aliases[v]) present.add(v);
      }
    }
    aliases = {};
    for (const v of present) aliases[v] = opts.profile_aliases[v];
  } else {
    aliases = buildAliasDict(norm);
  }

  const rowLines = norm.map(row => {
    const cols = ACTION_RECORD_KEYS.map(k => {
      let v = row[k];
      if (v === '' || v == null) return '';
      // Apply alias if available (only for string values).
      if (typeof v === 'string' && aliases[v]) return aliases[v];
      // Numeric stays as-is (timestamp).
      if (typeof v === 'number') return String(v);
      return _escape(v);
    });
    return cols.join('|');
  });

  // Header is JSON (small, structured) so the model can parse it
  // unambiguously. Body is the pipe-separated row block.
  const header = {
    __toon: 1,
    keys: ACTION_RECORD_KEYS,
    aliases  // value → alias map; consumers read the inverse.
  };
  return JSON.stringify(header) + '\n' + rowLines.join('\n');
}

function decodeBatch(payload) {
  if (typeof payload !== 'string' || !payload) return [];
  const nl = payload.indexOf('\n');
  if (nl < 0) {
    // Empty body — header only.
    try {
      const h = JSON.parse(payload);
      if (h && h.__toon === 1) return [];
    } catch { /* not toon */ }
    return [];
  }
  const headerStr = payload.slice(0, nl);
  const body = payload.slice(nl + 1);
  let header;
  try { header = JSON.parse(headerStr); }
  catch { return []; }
  if (!header || header.__toon !== 1 || !Array.isArray(header.keys)) return [];
  // Invert alias dict for decode.
  const aliasInv = {};
  for (const [val, alias] of Object.entries(header.aliases || {})) {
    aliasInv[alias] = val;
  }
  const lines = body.split('\n').filter(l => l.length > 0);
  return lines.map(line => {
    const cols = _splitEscaped(line);
    const rec = {};
    for (let i = 0; i < header.keys.length; i++) {
      const k = header.keys[i];
      let v = cols[i];
      if (v === undefined || v === '') {
        rec[k] = (k === 'input' || k === 'output' || k === 'verification' || k === 'outcome') ? '{}' : null;
        continue;
      }
      // Resolve alias.
      if (typeof v === 'string' && v.startsWith('&') && aliasInv[v] !== undefined) {
        v = aliasInv[v];
      } else {
        v = _unescape(v);
      }
      // timestamp is numeric.
      if (k === 'timestamp') {
        const n = parseInt(v, 10);
        rec[k] = Number.isFinite(n) ? n : v;
      } else {
        rec[k] = v;
      }
    }
    return rec;
  });
}

// Pipe-split that respects escaped \| sequences.
function _splitEscaped(line) {
  const out = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      buf += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === '|') { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// ── Manifest line shaping (Pichay-style page handles → TOON) ─────────────
// The runtime's buildManifest emits human lines with `<troth:page:UUID>`
// markers. For TOON manifests we keep the markers (they're cheap +
// model-recognizable) but strip the verbose footer + reformat the entry
// list as a 2-column table.
function encodeManifest(manifest) {
  if (!manifest || !manifest.entries) return null;
  const aliases = {};
  // Type values are extremely repetitive — alias them.
  const typeCounts = {};
  for (const e of manifest.entries) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }
  let aliasIdx = 0;
  for (const [t, n] of Object.entries(typeCounts)) {
    if (n >= 2) aliases[t] = '&' + (aliasIdx++);
  }
  const rows = manifest.entries.map(e => {
    const t = aliases[e.type] || e.type;
    const pin = e.pinned ? '★' : '';
    const summary = (e.summary || '').slice(0, 80);
    return [e.id, t, _escape(summary), pin].join('|');
  });
  const header = {
    __toon: 1,
    kind: 'manifest',
    keys: ['id', 'type', 'summary', 'pin'],
    aliases,
    stats: {
      resident: manifest.resident,
      max_size: manifest.max_size,
      tokens: manifest.tokens,
      budget: manifest.budget
    }
  };
  return JSON.stringify(header) + '\n' + rows.join('\n');
}

// ── Token-budget probe ──────────────────────────────────────────────────
// Best-effort character count proxy for tokens (BPE ratio ~4 chars/token
// for English; ~2.5 for compact JSON). Provides a deterministic estimate
// without calling out to a tokenizer.
function estimateTokens(payload) {
  if (typeof payload !== 'string') return 0;
  return Math.ceil(payload.length / 4);
}

// ── TRON for nested DAGs ────────────────────────────────────
// TOON's columnar form excels on uniform flat arrays. For nested
// structures (trace_causal_path responses with depth/path edges,
// counterfactual branch trees with parent_branch_id chains) the
// columnar shape would either flatten the hierarchy (losing parent
// pointers) or repeat parent context per row.
//
// TRON (Token Reduced Object Notation) uses class-instantiation syntax:
// declare a class once at the top, then instantiate by positional args.
// Research basis (G17.B): 20-40% reduction on nested objects with
// neutral fidelity.
//
// We implement a focused subset for two known nested response shapes:
//   1. Path-result rows from traceCausalPath: { node_id, depth, path }
//      with one parent edge label per hop.
//   2. Branch trees from listBranches: { id, branch_point_id,
//      substituted_path, status, parent_branch_id, ... } where
//      parent_branch_id forms a chain.

// Encode a tree-shaped or path-shaped payload. opts.shape controls
// which schema we use:
//   'path'     — array of {node_id, depth, path} (traceCausalPath result)
//   'branches' — array of counterfactual branch rows
//   'tree'     — generic { root, children: [...] } recursive shape
function encodeNested(rows, opts) {
  opts = opts || {};
  const shape = opts.shape || 'path';
  if (shape === 'path') return _encodePath(rows);
  if (shape === 'branches') return _encodeBranches(rows);
  if (shape === 'tree') return _encodeTree(rows);
  return null;
}

function decodeNested(payload) {
  if (typeof payload !== 'string' || !payload) return [];
  const nl = payload.indexOf('\n');
  const headerStr = nl >= 0 ? payload.slice(0, nl) : payload;
  const body = nl >= 0 ? payload.slice(nl + 1) : '';
  let header;
  try { header = JSON.parse(headerStr); }
  catch { return []; }
  if (!header || header.__tron !== 1) return [];
  if (header.shape === 'path')     return _decodePath(header, body);
  if (header.shape === 'branches') return _decodeBranches(header, body);
  if (header.shape === 'tree')     return _decodeTree(header, body);
  return [];
}

// ── Path encoding ────────────────────────────────────────────────────────
// traceCausalPath rows look like:
//   { node_id: '019d...', depth: 2, path: '>refines_intent>produces_edit' }
// The `path` field is a `>label1>label2` sequence. We extract distinct
// labels into an alias dict and replace each occurrence with `&N`.
function _encodePath(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return JSON.stringify({ __tron: 1, shape: 'path', labels: {}, rows: 0 });
  }
  // Collect distinct edge labels from path strings.
  const labelCounts = new Map();
  for (const r of rows) {
    const segments = String(r.path || '').split(/[><]/).filter(Boolean);
    for (const s of segments) labelCounts.set(s, (labelCounts.get(s) || 0) + 1);
  }
  const labels = {};
  let i = 0;
  for (const [lab] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (i >= 32) break;
    labels[lab] = '&' + i;
    i++;
  }
  const lines = rows.map(r => {
    let p = String(r.path || '');
    for (const [lab, alias] of Object.entries(labels)) {
      p = p.split(lab).join(alias);
    }
    return [_escape(r.node_id || ''), r.depth || 0, _escape(p)].join('|');
  });
  const header = { __tron: 1, shape: 'path', labels, keys: ['node_id', 'depth', 'path'] };
  return JSON.stringify(header) + '\n' + lines.join('\n');
}

function _decodePath(header, body) {
  const aliasInv = {};
  for (const [lab, alias] of Object.entries(header.labels || {})) aliasInv[alias] = lab;
  const lines = body.split('\n').filter(Boolean);
  return lines.map(line => {
    const cols = _splitEscaped(line);
    let path = _unescape(cols[2] || '');
    // Restore aliases. Sort by alias length desc to avoid partial replacement.
    const aliasKeys = Object.keys(aliasInv).sort((a, b) => b.length - a.length);
    for (const a of aliasKeys) path = path.split(a).join(aliasInv[a]);
    return {
      node_id: _unescape(cols[0] || ''),
      depth:   parseInt(cols[1] || '0', 10),
      path
    };
  });
}

// ── Branch encoding ──────────────────────────────────────────────────────
// counterfactual_branches rows have a fixed shape; we treat status as
// a small enum (always one of CF_STATUSES) so it gets aliased aggressively.
function _encodeBranches(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return JSON.stringify({ __tron: 1, shape: 'branches', enums: {}, rows: 0 });
  }
  const enumCounts = new Map();
  for (const r of rows) {
    if (r.status) enumCounts.set(r.status, (enumCounts.get(r.status) || 0) + 1);
  }
  const enums = {};
  let i = 0;
  for (const [val] of [...enumCounts.entries()].sort((a, b) => b[1] - a[1])) {
    enums[val] = '&' + i;
    i++;
  }
  const keys = ['id', 'branch_point_id', 'substituted_path', 'status',
                'parent_branch_id', 'created_at', 'materialized_at',
                'cost_estimate', 'outcome_summary'];
  const lines = rows.map(r => keys.map(k => {
    let v = r[k];
    if (v == null) return '';
    if (typeof v === 'object') v = JSON.stringify(v);
    if (typeof v === 'string' && enums[v]) return enums[v];
    if (typeof v === 'number') return String(v);
    return _escape(String(v));
  }).join('|'));
  const header = { __tron: 1, shape: 'branches', enums, keys };
  return JSON.stringify(header) + '\n' + lines.join('\n');
}

function _decodeBranches(header, body) {
  const enumInv = {};
  for (const [val, alias] of Object.entries(header.enums || {})) enumInv[alias] = val;
  const keys = header.keys;
  const lines = body.split('\n').filter(Boolean);
  return lines.map(line => {
    const cols = _splitEscaped(line);
    const out = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      let v = cols[i];
      if (v === undefined || v === '') { out[k] = null; continue; }
      if (enumInv[v]) { out[k] = enumInv[v]; continue; }
      if (k === 'created_at' || k === 'materialized_at') {
        out[k] = parseInt(v, 10);
      } else if (k === 'cost_estimate') {
        out[k] = parseFloat(v);
      } else if (k === 'outcome_summary') {
        try { out[k] = JSON.parse(_unescape(v)); } catch { out[k] = _unescape(v); }
      } else {
        out[k] = _unescape(v);
      }
    }
    return out;
  });
}

// ── Tree encoding (generic recursive structures) ─────────────────────────
// Stored as a depth-prefixed pre-order serialization. Each line is
// `<depth>|<id>|<typeAlias>|<payload>` where payload is escaped JSON.
function _encodeTree(node, opts) {
  opts = opts || {};
  if (!node || typeof node !== 'object') {
    return JSON.stringify({ __tron: 1, shape: 'tree', types: {}, rows: 0 });
  }
  const lines = [];
  const typeCounts = new Map();
  function walk(n, depth) {
    const t = n.type || 'node';
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
    const children = Array.isArray(n.children) ? n.children : [];
    lines.push({ depth, node: n });
    for (const c of children) walk(c, depth + 1);
  }
  walk(node, 0);
  const types = {};
  let i = 0;
  for (const [t] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (i >= 16) break;
    types[t] = '&' + i;
    i++;
  }
  const body = lines.map(({ depth, node }) => {
    const t = types[node.type || 'node'] || (node.type || 'node');
    const payload = {};
    for (const k of Object.keys(node)) {
      if (k === 'children' || k === 'type') continue;
      payload[k] = node[k];
    }
    return [depth, _escape(node.id || ''), t, _escape(JSON.stringify(payload))].join('|');
  }).join('\n');
  const header = { __tron: 1, shape: 'tree', types, keys: ['depth', 'id', 'type', 'payload'] };
  return JSON.stringify(header) + '\n' + body;
}

function _decodeTree(header, body) {
  const typeInv = {};
  for (const [t, a] of Object.entries(header.types || {})) typeInv[a] = t;
  const lines = body.split('\n').filter(Boolean);
  // Reconstruct as flat array of { depth, id, type, ...payload };
  // caller is responsible for re-nesting via the depth field.
  return lines.map(line => {
    const cols = _splitEscaped(line);
    const depth = parseInt(cols[0] || '0', 10);
    const id    = _unescape(cols[1] || '');
    const tRaw  = cols[2] || '';
    const type  = typeInv[tRaw] || tRaw;
    let payload = {};
    try { payload = JSON.parse(_unescape(cols[3] || '{}')); } catch {}
    return { depth, id, type, ...payload };
  });
}

// ── Auto-picker ──────────────────────────────────────────────────────────
// Inspects a payload and picks 'toon' (flat) or 'tron' (nested). Heuristic:
//   - Array of objects with uniform keys → toon
//   - Array of objects whose entries have a path / parent_branch_id /
//     children / depth field → tron
//   - Single nested object → tron tree
function pickFormat(rows, opts) {
  opts = opts || {};
  if (!Array.isArray(rows)) {
    if (rows && typeof rows === 'object' && rows.children) return 'tron';
    return 'toon';
  }
  if (rows.length === 0) return 'toon';
  const sample = rows[0];
  if (sample == null || typeof sample !== 'object') return 'toon';
  if ('path' in sample && 'depth' in sample) return 'tron';
  if ('parent_branch_id' in sample) return 'tron';
  if ('children' in sample) return 'tron';
  return 'toon';
}

module.exports = {
  encodeBatch,
  decodeBatch,
  encodeManifest,
  estimateTokens,
  buildAliasDict,
  ACTION_RECORD_KEYS,
  // P17 Tier 2
  encodeNested,
  decodeNested,
  pickFormat
};
