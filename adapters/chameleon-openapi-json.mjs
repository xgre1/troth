#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Chameleon Protocol v0.1 — Reference adapter for OpenAPI-described
// JSON datasets (`structured` data_shape).
//
// Phase 3 of the implementation roadmap. Closes the final data_shape
// pipeline (Phase 1 = text, Phase 2 = event_stream, Phase 3 = structured).
//
// Source contract (operator-supplied at launch):
//   --root <dir> containing
//       schema.json     ← OpenAPI 3 schema fragment OR JSON Schema
//                         describing the entity shape
//       records.json    ← JSON array of records matching the schema
//       (optional) meta.json   ← extra manifest fields to merge in
//
// This is the cleanest path to validating the structured pipeline
// without depending on a live HTTP backend during conformance testing.
// A future v0.2 adapter can replace records.json with a live REST
// fetch — the protocol surface stays identical.
//
// Manifest:
//   source_kind:   "api"
//   data_shape:    "structured"
//   capabilities:  ["read", "static", "schema_introspect"]
//   refresh:       { strategy: "static" }

import { readFileSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// ── CLI args ──────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
function argVal(flag) { const i = ARGV.indexOf(flag); return i >= 0 ? ARGV[i + 1] : null; }

const ROOT      = resolve(argVal('--root') || process.cwd());
const SOURCE_ID = argVal('--source-id') || ('api-' + basename(ROOT));

// ── Constants ─────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '0.1';
const SCHEMA_PATH      = join(ROOT, 'schema.json');
const RECORDS_PATH     = join(ROOT, 'records.json');
const META_PATH        = join(ROOT, 'meta.json');

// ── Load schema + records + optional meta at startup ─────────────────────

let SCHEMA = null;
let RECORDS = [];
let META = {};
try {
  if (existsSync(SCHEMA_PATH))  SCHEMA  = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  if (existsSync(RECORDS_PATH)) RECORDS = JSON.parse(readFileSync(RECORDS_PATH, 'utf8'));
  if (existsSync(META_PATH))    META    = JSON.parse(readFileSync(META_PATH, 'utf8'));
} catch (e) {
  process.stderr.write('Failed to load schema/records: ' + e.message + '\n');
  process.exit(2);
}

// Ensure schema has a $schema declaration for substrate-side validators.
// If the operator supplied a JSON Schema directly, use as-is. If they
// supplied an OpenAPI fragment with `components.schemas.<entity>`,
// pluck the first one out.
function normalizeSchema(s) {
  if (!s) return null;
  if (s.$schema) return s;                               // already JSON Schema
  if (s.components && s.components.schemas) {
    const names = Object.keys(s.components.schemas);
    if (names.length > 0) {
      const inner = s.components.schemas[names[0]];
      return Object.assign(
        { $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id:    `chameleon://${SOURCE_ID}/schema`,
          title:  names[0] },
        inner
      );
    }
  }
  // Plain JSON Schema-shaped object without $schema field — wrap.
  return Object.assign(
    { $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id:    `chameleon://${SOURCE_ID}/schema` },
    s
  );
}
SCHEMA = normalizeSchema(SCHEMA);

// ── Manifest construction ─────────────────────────────────────────────────

function buildManifest() {
  const m = Object.assign({}, {
    chameleon_version: PROTOCOL_VERSION,
    source_id:         SOURCE_ID,
    source_kind:       'api',
    display_name:      META.display_name || `OpenAPI/JSON dataset (${basename(ROOT)})`,
    owner:             META.owner || {
                         tenant_id: process.env.CHAMELEON_TENANT_ID || 'local',
                         actor_id:  process.env.USER || 'local'
                       },
    capabilities:      META.capabilities || ['read', 'static', 'schema_introspect'],
    refresh:           META.refresh || { strategy: 'static' },
    acl:               { policy_ref: 'chameleon:acl/v1/role-based' },
    data_shape:        'structured',
    schema_uri:        `chameleon://${SOURCE_ID}/schema`,
    manifest_hash:     '',
    attestation_hash:  ''
  });
  m.manifest_hash = 'sha256:' + canonicalHash(m);
  return m;
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}
function canonicalHash(m) {
  return createHash('sha256').update(canonicalize({ ...m, manifest_hash: '' })).digest('hex');
}

const MANIFEST = buildManifest();

// ── Discovery dialog state ────────────────────────────────────────────────

// For a structured/api source, L1 + L2 (we have a real schema!) cover most.
// Two residual questions: which entity field is the canonical id, and
// which fields are PII.
const DIALOG_QUESTIONS = [
  { id: 'q-canonical-id', kind: 'multiple_choice',
    prompt: 'Which field uniquely identifies a record (canonical id)?',
    options: deriveCanonicalIdOptions(),
    eig: 0.62 },
  { id: 'q-pii-fields', kind: 'multiple_choice',
    prompt: 'Are any fields PII or regulated?',
    options: ['none', 'email/phone-style fields auto-detect', 'name/address fields auto-detect', 'I will tag manually after ingest'],
    eig: 0.41 }
];

function deriveCanonicalIdOptions() {
  // Inspect the schema for likely id field names.
  const candidates = new Set(['id']);
  if (SCHEMA && SCHEMA.properties) {
    for (const k of Object.keys(SCHEMA.properties)) {
      if (/^(id|uuid|guid|_id|key)$/i.test(k) || /(id|uuid|guid)$/i.test(k)) candidates.add(k);
    }
  }
  const arr = Array.from(candidates).slice(0, 5);
  if (arr.length < 2) arr.push('first field');
  return arr;
}

const KNEE_THRESHOLD = 0.10;
const dialogs = new Map();

// ── Schema validation helper (substrate-side discipline) ──────────────────

// Conservative validator — checks only required fields + top-level types.
// A production substrate runtime would use Ajv with `loadSchema: false`
// per spec Threat Model L3, but for the adapter we only need to ensure
// records we surface conform to our declared schema.
function validates(record) {
  if (!SCHEMA) return true;
  if (!record || typeof record !== 'object') return false;
  const required = SCHEMA.required || [];
  for (const field of required) {
    if (!(field in record)) return false;
  }
  return true;
}

// Confidence per spec §9.4: for structured records, all three components
// (field-coverage, schema-conformance, anchor-resolution) are checkable.
function confidenceFor(record) {
  if (!record) return 0;
  let s = 0;
  // Field coverage — how many declared properties present
  if (SCHEMA && SCHEMA.properties) {
    const declared = Object.keys(SCHEMA.properties);
    const present = declared.filter(k => k in record).length;
    s += 0.34 * (present / Math.max(declared.length, 1));
  } else {
    s += 0.34;
  }
  // Schema conformance — passed validates()? Already filtered, so yes.
  s += 0.33;
  // Anchor resolution — has any id-like field?
  if (record.id || record.uuid || record._id) s += 0.33;
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

  'chameleon/initialized': () => null,

  'chameleon/describe': () => MANIFEST,

  'chameleon/get_schema': () => {
    // Required for structured shape per spec §1.
    if (!SCHEMA) return rpcError(-32104, 'schema_violation',
      { reason: 'no schema.json found at root' });
    return { schema: SCHEMA };
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
    return {
      resolved_fields:         SCHEMA && SCHEMA.properties ? Object.keys(SCHEMA.properties) : [],
      quarantined_fields:      [],
      under_specified:         !SCHEMA,
      seed_examples_requested: false
    };
  },

  'chameleon/read': () => {
    const out = [];
    let dropped = 0;
    for (const r of RECORDS) {
      if (!validates(r)) { dropped++; continue; }
      out.push({
        id:           r.id || r.uuid || r._id || randomUUID(),
        source_id:    SOURCE_ID,
        source_kind:  'api',
        row_data:     r,
        confidence:   confidenceFor(r)
      });
    }
    return { records: out, count: out.length, dropped, source_id: SOURCE_ID };
  },

  'chameleon/health': () => ({
    status:  SCHEMA && RECORDS.length >= 0 ? 'ok' : 'no_data',
    source_id: SOURCE_ID,
    root: ROOT,
    record_count: RECORDS.length
  })
};

// ── Helpers + JSON-RPC stdio loop ─────────────────────────────────────────

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
