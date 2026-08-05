#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Chameleon Protocol v0.1 — Reference adapter for Claude Code session JSONLs.
//
// Phase 2 of the implementation roadmap. Validates `event_stream`
// data_shape end-to-end (Phase 1 covered `text`).
//
// Source: each .jsonl file under <root> is treated as a contiguous
// event log. Each line is one event. Common fields observed in the
// wild: type, sessionId, uuid, timestamp, parentUuid, message, cwd,
// gitBranch, requestId, toolUseResult.
//
// Transport: stdio + newline-delimited JSON-RPC 2.0 (spec §2.1).
//
// Invocation:
//   node adapters/chameleon-claude-jsonl.mjs --root <jsonl-dir>
//                                            [--source-id <id>]
//                                            [--since <unix-ms>]
//
// Implements (per spec):
//   • chameleon/initialize          — handshake (§2.2)
//   • chameleon/initialized         — notification
//   • chameleon/describe            — manifest with sha256 hash
//   • chameleon/get_schema          — real JSON Schema for event shape
//   • chameleon/discover/begin/question/answer/complete (§3.3)
//   • chameleon/read                — event_stream pipeline (§4)
//   • chameleon/health
//
// Manifest:
//   source_kind:   "event_stream"
//   data_shape:    "event_stream"
//   capabilities:  ["read", "static", "schema_introspect"]
//   refresh:       { strategy: "static" }

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// ── CLI args ──────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
function argVal(flag) { const i = ARGV.indexOf(flag); return i >= 0 ? ARGV[i + 1] : null; }

const ROOT      = resolve(argVal('--root') || process.cwd());
const SOURCE_ID = argVal('--source-id') || ('claude-jsonl-' + basename(ROOT));
const SINCE_MS  = parseInt(argVal('--since') || '0', 10);

// ── Constants ─────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '0.1';

// JSON Schema describing the event shape. Returned via chameleon/get_schema.
// Substrate-side validation runs every record against this (per Threat Model
// Layer 3) before writing into the event_stream pipeline.
const EVENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'chameleon://' + SOURCE_ID + '/schema',
  title: 'Claude Code session.jsonl event',
  type: 'object',
  properties: {
    type:           { type: 'string',   description: 'event_kind discriminator' },
    sessionId:      { type: 'string',   description: 'parent session UUID' },
    uuid:           { type: 'string',   description: 'event UUID (canonical id)' },
    timestamp:      { type: 'string',   description: 'ISO-8601 event timestamp' },
    parentUuid:     { type: ['string', 'null'] },
    cwd:            { type: 'string' },
    gitBranch:      { type: 'string' },
    message:        { type: 'object',   description: 'opaque payload, varies by type' },
    requestId:      { type: 'string' },
    toolUseResult:  { type: 'object' },
    isSidechain:    { type: 'boolean' }
  },
  required: ['type'],          // only `type` is strictly mandatory in the wild
  additionalProperties: true   // tolerant — Claude Code adds new fields over time
};

// ── Manifest construction ─────────────────────────────────────────────────

function buildManifest() {
  const m = {
    chameleon_version: PROTOCOL_VERSION,
    source_id:         SOURCE_ID,
    source_kind:       'event_stream',
    display_name:      `Claude Code session log (${basename(ROOT)})`,
    owner:             { tenant_id: process.env.CHAMELEON_TENANT_ID || 'local',
                         actor_id:  process.env.USER || 'local' },
    capabilities:      ['read', 'static', 'schema_introspect'],
    refresh:           { strategy: 'static' },
    acl:               { policy_ref: 'chameleon:acl/v1/role-based' },
    data_shape:        'event_stream',
    schema_uri:        `chameleon://${SOURCE_ID}/schema`,
    manifest_hash:     '',
    attestation_hash:  ''
  };
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

// L1+L2+L3 priors handle most of the schema (we ship a real JSON Schema!).
// Two residual questions for filtering preference. Knee fires after 2.
const DIALOG_QUESTIONS = [
  { id: 'q-event-type-filter', kind: 'multiple_choice',
    prompt: 'Which event kinds should I include in the substrate?',
    options: ['all', 'assistant+user only', 'tool-related only', 'permission/system events excluded'],
    eig: 0.55 },
  { id: 'q-sidechain', kind: 'multiple_choice',
    prompt: 'Include sub-agent (sidechain) events?',
    options: ['yes', 'no — main agent only', 'sidechain only'],
    eig: 0.28 }
];
const KNEE_THRESHOLD = 0.10;
const dialogs = new Map();

// ── Event walker ──────────────────────────────────────────────────────────

function listJsonlFiles() {
  const out = [];
  let entries;
  try { entries = readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const full = join(ROOT, ent.name);
    try {
      const st = statSync(full);
      if (st.size > 0) out.push({ path: full, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out;
}

function parseEvents(file) {
  const records = [];
  let raw;
  try { raw = readFileSync(file.path, 'utf8'); } catch { return records; }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    // Substrate-side schema validation: at minimum `type` must be present.
    if (!evt.type || typeof evt.type !== 'string') continue;
    // Apply --since filter (optional).
    let evtTs = 0;
    if (evt.timestamp) {
      const t = Date.parse(evt.timestamp);
      if (!Number.isNaN(t)) evtTs = t;
    }
    if (SINCE_MS && evtTs && evtTs < SINCE_MS) continue;
    records.push({
      id:           evt.uuid || randomUUID(),
      source_id:    SOURCE_ID,
      source_kind:  'event_stream',
      source_path:  basename(file.path),
      event_kind:   evt.type,
      ts:           evtTs || file.mtime,
      session_id:   evt.sessionId || null,
      parent_id:    evt.parentUuid || null,
      payload:      evt,
      confidence:   confidenceFor(evt)
    });
  }
  return records;
}

// Confidence per spec §9.4. event_stream is the cleanest case — if the line
// parsed as JSON and has `type` + (`uuid` or auto-generated id) + (`timestamp`
// or fallback to mtime), we have full coverage.
function confidenceFor(evt) {
  let s = 0.34;                                                // type present (guard above ensures)
  if (evt.uuid && evt.timestamp)              s += 0.33;       // canonical-id + temporal anchoring
  if (evt.sessionId || evt.parentUuid)        s += 0.33;       // causal anchor
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
    // event_stream IS structured — return the real JSON Schema. Substrate
    // will validate every event against this before commit (Threat Model L3).
    return { schema: EVENT_SCHEMA };
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
      resolved_fields:         ['event_kind', 'ts', 'session_id', 'parent_id', 'payload'],
      quarantined_fields:      [],
      under_specified:         false,
      seed_examples_requested: false
    };
  },

  'chameleon/read': () => {
    const files = listJsonlFiles();
    let records = [];
    for (const f of files) records = records.concat(parseEvents(f));
    return { records, count: records.length, source_id: SOURCE_ID };
  },

  'chameleon/health': () => ({ status: 'ok', source_id: SOURCE_ID, root: ROOT })
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
