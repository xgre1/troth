#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Chameleon Protocol v0.1 — Reference adapter for filesystem sources.
//
// Phase 1 of the implementation roadmap: re-cast the existing
// `troth knowledge import` semantics as a fully Chameleon-conformant
// adapter so the spec is provably implementable end-to-end.
//
// Transport: stdio + newline-delimited JSON-RPC 2.0 (per spec §2.1).
// Wire format: one message per `\n`-terminated line.
//
// Invocation:
//   node adapters/chameleon-filesystem.mjs --root <dir> [--source-id <id>]
//
// Implements (per spec):
//   • chameleon/initialize          — handshake (§2.2)
//   • chameleon/initialized         — notification (§2.2)
//   • chameleon/describe            — full source manifest (§1)
//   • chameleon/get_schema          — returns null for text shape (§1)
//   • chameleon/discover/begin      — dialog setup (§3.3)
//   • chameleon/discover/question   — bounded interrogation, max 7 (§3.2/3.3)
//   • chameleon/discover/answer     — record answer + EIG decay
//   • chameleon/discover/complete   — finalize, return resolved/quarantined
//   • chameleon/read                — return text chunks (§4 text pipeline)
//   • chameleon/health              — liveness probe
//
// Manifest declaration:
//   source_kind:   "filesystem"
//   data_shape:    "text"
//   capabilities:  ["read", "static", "schema_introspect"]
//   refresh:       { strategy: "static" }
//
// `manifest_hash` is self-computed (RFC 8785-style canonical JSON over
// the manifest with manifest_hash = "" before hashing). Substrate side
// must validate against operator-attested expected hash per spec §1
// integrity-vs-trust note.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, basename, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// ── CLI args ──────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
function argVal(flag) {
  const i = ARGV.indexOf(flag);
  return i >= 0 ? ARGV[i + 1] : null;
}

const ROOT      = resolve(argVal('--root') || process.cwd());
const SOURCE_ID = argVal('--source-id') || ('fs-' + basename(ROOT));
const MAX_CHUNK = parseInt(argVal('--max-chunk') || '2000', 10);

// ── Constants ─────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '0.1';
const SUPPORTED_EXTS   = new Set(['.md', '.markdown', '.txt', '.org']);
const SKIP_DIRS        = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.cache', '__pycache__', '.venv', 'venv', 'target', 'vendor'
]);

// ── Manifest construction ─────────────────────────────────────────────────

function buildManifest() {
  // Construct the manifest with manifest_hash empty, then hash, then write back.
  // Per spec §1: sha256 over canonical JSON with manifest_hash = "".
  const m = {
    chameleon_version: PROTOCOL_VERSION,
    source_id:         SOURCE_ID,
    source_kind:       'filesystem',
    display_name:      `Filesystem (${basename(ROOT)})`,
    owner:             { tenant_id: process.env.CHAMELEON_TENANT_ID || 'local',
                         actor_id:  process.env.USER || 'local' },
    capabilities:      ['read', 'static', 'schema_introspect'],
    refresh:           { strategy: 'static' },
    acl:               { policy_ref: 'chameleon:acl/v1/role-based' },
    data_shape:        'text',
    schema_uri:        `chameleon://${SOURCE_ID}/schema`,
    manifest_hash:     '',
    attestation_hash:  ''   // populated substrate-side at attest time
  };
  m.manifest_hash = 'sha256:' + canonicalHash(m);
  return m;
}

// Canonical JSON serialization for hashing — sorted keys, no whitespace.
// (Approximation of RFC 8785 JCS sufficient for v0.1 substrate validation
// since both sides use the same algorithm.)
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}
function canonicalHash(m) {
  const m2 = { ...m, manifest_hash: '' };
  return createHash('sha256').update(canonicalize(m2)).digest('hex');
}

const MANIFEST = buildManifest();

// ── Discovery dialog state machine ────────────────────────────────────────

// For a filesystem source, L1 + L2 + L3 priors cover most ambiguity.
// Three residual questions, BOED-ordered by EIG. After Q3 the knee fires.
const DIALOG_QUESTIONS = [
  { id: 'q-encoding', kind: 'multiple_choice',
    prompt: 'What text encoding should I assume?',
    options: ['utf8', 'latin1', 'auto-detect'],
    eig: 0.42 },
  { id: 'q-recurse', kind: 'multiple_choice',
    prompt: 'How deep should I recurse into subdirectories?',
    options: ['1 level', '3 levels', 'unlimited'],
    eig: 0.35 },
  { id: 'q-hidden', kind: 'multiple_choice',
    prompt: 'Include hidden files (dotfiles)?',
    options: ['no', 'yes', 'specific extensions only'],
    eig: 0.18 }
];
const KNEE_THRESHOLD = 0.10;
const dialogs = new Map();   // dialog_id → { questions_asked, answers }

// ── File walker ───────────────────────────────────────────────────────────

function walk(dir, out, depth = 0, maxDepth = Infinity) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth + 1 <= maxDepth) walk(full, out, depth + 1, maxDepth);
    } else if (ent.isFile()) {
      if (SUPPORTED_EXTS.has(extname(ent.name).toLowerCase())) {
        try {
          const st = statSync(full);
          if (st.size >= 200 && st.size <= 2_000_000) out.push({ path: full, size: st.size });
        } catch {}
      }
    }
  }
}

// Chunk text per spec §4 text pipeline (markdown by H2; else fixed-size).
function chunkText(text, ext) {
  if (ext === '.md' || ext === '.markdown' || ext === '.org') {
    const parts = text.split(/(?=^##\s)/m).filter(p => p.trim().length > 0);
    const out = [];
    for (const p of parts) {
      if (Buffer.byteLength(p) <= MAX_CHUNK) out.push(p);
      else for (let off = 0; off < p.length; off += MAX_CHUNK) out.push(p.slice(off, off + MAX_CHUNK));
    }
    return out;
  }
  const fixed = [];
  for (let off = 0; off < text.length; off += MAX_CHUNK) fixed.push(text.slice(off, off + MAX_CHUNK));
  return fixed;
}

// Confidence per record per spec §9.4: field-coverage + schema-conformance +
// anchor-resolution. For text, all three are full when text parses + chunks
// are within size bounds. Filesystem rarely has ambiguity here.
function confidenceFor(record) {
  let s = 0.34;            // field coverage (path + text + chunk_index always present)
  if (record.text && record.text.length >= 100) s += 0.33;   // schema conformance
  if (record.text && record.text.length <= MAX_CHUNK)         s += 0.33;   // anchor (no truncation)
  return Math.min(1.0, s);
}

// ── JSON-RPC handlers ─────────────────────────────────────────────────────

const HANDLERS = {
  'chameleon/initialize': (params) => {
    const clientVer = params && params.protocol_version;
    if (clientVer && !clientVer.startsWith('0.1')) {
      return rpcError(-32004, 'unsupported_protocol_version',
        { client: clientVer, supported: '0.1.x' });
    }
    return {
      protocol_version:    PROTOCOL_VERSION,
      server_capabilities: MANIFEST.capabilities,
      source_manifest:     MANIFEST
    };
  },

  'chameleon/initialized': () => null,   // notification — no response

  'chameleon/describe': () => MANIFEST,

  'chameleon/get_schema': () => {
    // Per spec §1: schema_uri is OPTIONAL for text data_shape. We return
    // null to signal "no formal JSON Schema; use text-shape heuristics."
    // The substrate L3 ontology for filesystem will fill in defaults.
    return { schema: null, reason: 'data_shape=text — no formal schema required (§1)' };
  },

  'chameleon/discover/begin': (params) => {
    if (!params || !params.source_id) return rpcError(-32602, 'missing source_id');
    if (params.source_id !== SOURCE_ID) return rpcError(-32602, 'source_id mismatch',
      { expected: SOURCE_ID, got: params.source_id });
    const dialog_id = randomUUID();
    dialogs.set(dialog_id, { asked: 0, answers: {} });
    return { dialog_id, max_questions: 7 };
  },

  'chameleon/discover/question': (params) => {
    const d = dialogs.get(params && params.dialog_id);
    if (!d) return rpcError(-32103, 'dialog_state_error', { reason: 'unknown dialog_id' });
    // Knee detection — once EIG of next question drops below threshold OR
    // we've issued all 3 of our pre-computed questions.
    if (d.asked >= DIALOG_QUESTIONS.length) {
      return { question_id: null, kind: 'knee_detected', eig_score: 0 };
    }
    const q = DIALOG_QUESTIONS[d.asked];
    if (q.eig < KNEE_THRESHOLD) {
      return { question_id: null, kind: 'knee_detected', eig_score: q.eig };
    }
    return { question_id: q.id, kind: q.kind, prompt: q.prompt, options: q.options, eig_score: q.eig };
  },

  'chameleon/discover/answer': (params) => {
    const d = dialogs.get(params && params.dialog_id);
    if (!d) return rpcError(-32103, 'dialog_state_error', { reason: 'unknown dialog_id' });
    d.answers[params.question_id] = params.answer;
    d.asked += 1;
    const nextEig = d.asked < DIALOG_QUESTIONS.length ? DIALOG_QUESTIONS[d.asked].eig : 0;
    return {
      accepted: true,
      next_eig: nextEig,
      terminate_recommended: nextEig < KNEE_THRESHOLD
    };
  },

  'chameleon/discover/complete': (params) => {
    const d = dialogs.get(params && params.dialog_id);
    if (!d) return rpcError(-32103, 'dialog_state_error', { reason: 'unknown dialog_id' });
    dialogs.delete(params.dialog_id);
    // Filesystem: every field is resolved from L1+L2+L3+answers. Nothing
    // quarantined for v0.1. seed_examples not requested.
    return {
      resolved_fields:         ['path', 'text', 'chunk_index', 'chunk_total'],
      quarantined_fields:      [],
      under_specified:         false,
      seed_examples_requested: false
    };
  },

  'chameleon/read': () => {
    const files = [];
    walk(ROOT, files);
    const records = [];
    for (const f of files) {
      let content;
      try { content = readFileSync(f.path, 'utf8'); } catch { continue; }
      const ext = extname(f.path).toLowerCase();
      const chunks = chunkText(content, ext);
      for (let i = 0; i < chunks.length; i++) {
        const rec = {
          id:           randomUUID(),
          source_path:  relative(ROOT, f.path),
          text:         chunks[i],
          chunk_index:  i,
          chunk_total:  chunks.length,
          source_kind:  'filesystem',
          source_id:    SOURCE_ID
        };
        rec.confidence = confidenceFor(rec);
        records.push(rec);
      }
    }
    return { records, count: records.length, source_id: SOURCE_ID };
  },

  'chameleon/health': () => ({ status: 'ok', source_id: SOURCE_ID, root: ROOT })
};

// ── Helpers ───────────────────────────────────────────────────────────────

function rpcError(code, message, data) {
  const err = { code, message };
  if (data) err.data = data;
  return { __error: err };
}

function handle(method, params) {
  const fn = HANDLERS[method];
  if (!fn) return rpcError(-32601, 'method not found: ' + method);
  return fn(params);
}

// ── JSON-RPC stdio loop (per spec §2.1 framing) ──────────────────────────

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let idx;
  while ((idx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, idx);
    inputBuffer = inputBuffer.slice(idx + 1);
    if (line.length > 16 * 1024 * 1024) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32007, message: 'message_too_large' }
      }) + '\n');
      process.exit(2);
    }
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    respond(msg);
  }
});

function respond(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  const send = (payload) => {
    if (isNotification) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }) + '\n');
  };
  try {
    const out = handle(msg.method, msg.params);
    if (out && out.__error) send({ error: out.__error });
    else send({ result: out });
  } catch (e) {
    send({ error: { code: -32603, message: String(e && e.message || e) } });
  }
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
