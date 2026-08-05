// SPDX-License-Identifier: AGPL-3.0-only
// OpenAPI ingest.
//
// Parses an OpenAPI 3.x spec (JSON or pre-parsed object) into one
// substrate chunk per operation: operationId + method + path + summary
// + parameters + request/response schema digest. Chameleon ingests
// each chunk under scope='docs:openapi:<service>'.
//
// At planning time, partner runs:
//   chameleon_query('how do I create a Supabase project', {scope:'docs:openapi:supabase'})
// → semantic match returns the operation chunk → partner calls api_call
//   with the matched path + body shape.
//
// Design principle: docs are part of the mind's procedural / semantic memory,
// retrieved through the same recall surface (no parallel doc store).
//
// design grounding:
//   - design R23 append-only: each chunk is a new engram, ingest
//     is additive; re-ingest with same scope produces parallel chunks
//     (caller responsibility to clean prior scope if desired)
//   - design substrate-as-mind: one recall surface
//   - OpenAPI 3.x spec (OAI/OpenAPI-Specification): standard JSON shape
//
// v1 scope:
//   - OpenAPI 3.x only (3.0 + 3.1 share enough structure)
//   - JSON input (operator pre-converts YAML if needed)
//   - Chunks per-operation; parameters listed but not deeply expanded
//   - Per-operation chunk size cap 1800 chars (keeps embedding cost
//     bounded; recall-time match still works on first 1800 chars)
//   - No schema-deref (refs left as $ref strings — fine for semantic
//     retrieval, partner can ask api_call to test request shape)
//
// Out of scope (v2):
//   - YAML parsing (use a CLI tool / pre-convert)
//   - Deep $ref expansion (substantial; bloats chunks)
//   - Swagger 2.0 (older format; ask operator to convert via swagger-cli)
//   - Delta ingest (re-ingest replaces; needs scope-cleanup helper)

'use strict';

const chameleon = require('./chameleon.js');

const CHUNK_CHAR_CAP = 1800;
const SUPPORTED_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function _summarizeParam(p) {
  if (!p) return '';
  const where = p.in || '?';
  const required = p.required ? ' (required)' : '';
  const type = (p.schema && (p.schema.type || (p.schema.$ref && '$ref'))) || 'any';
  const desc = p.description ? ' — ' + String(p.description).slice(0, 100) : '';
  return where + ':' + (p.name || '?') + ':' + type + required + desc;
}

function _summarizeRequestBody(rb) {
  if (!rb || !rb.content) return null;
  const types = Object.keys(rb.content).slice(0, 3);
  const required = rb.required ? ' (required)' : '';
  return 'requestBody' + required + ' [' + types.join(',') + ']';
}

function _summarizeResponses(responses) {
  if (!responses) return '';
  return Object.keys(responses).slice(0, 5).join('/');
}

// Build chunks. One chunk per operation. Returns
//   [{ operationId, method, path, text }]
function buildChunks(spec) {
  const out = [];
  if (!spec || typeof spec !== 'object' || !spec.paths) return out;
  const info = spec.info || {};
  const baseHint = (info.title || '') + ' ' + (info.version || '');

  for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of SUPPORTED_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const operationId = op.operationId || (method + '_' + pathStr.replace(/[^a-z0-9]+/gi, '_'));
      const lines = [];
      lines.push('OPERATION: ' + operationId);
      lines.push('METHOD: ' + method.toUpperCase() + ' ' + pathStr);
      if (op.summary) lines.push('SUMMARY: ' + String(op.summary).slice(0, 200));
      if (op.description) lines.push('DESC: ' + String(op.description).slice(0, 400));
      const allParams = [].concat(pathItem.parameters || [], op.parameters || []);
      if (allParams.length) {
        lines.push('PARAMS:');
        for (const p of allParams.slice(0, 15)) lines.push('  - ' + _summarizeParam(p));
      }
      const rb = _summarizeRequestBody(op.requestBody);
      if (rb) lines.push('BODY: ' + rb);
      const resps = _summarizeResponses(op.responses);
      if (resps) lines.push('RESPONSES: ' + resps);
      if (Array.isArray(op.tags) && op.tags.length) lines.push('TAGS: ' + op.tags.join(','));
      if (baseHint.trim()) lines.push('SOURCE: ' + baseHint.trim());

      let text = lines.join('\n');
      if (text.length > CHUNK_CHAR_CAP) text = text.slice(0, CHUNK_CHAR_CAP);
      out.push({ operationId, method: method.toUpperCase(), path: pathStr, text });
    }
  }
  return out;
}

// Ingest a parsed OpenAPI spec under scope='docs:openapi:<service>'.
// Each operation becomes one chameleon chunk (which itself becomes
// one or more engrams depending on its size).
//
//   opts.spec      — parsed OpenAPI 3.x object (caller parses JSON)
//   opts.service   — service name (key for scope + retrieval)
//   opts.agent_id  — required for engram authorship
//   opts.cwd, opts.user_id
//   opts.source    — provenance, default 'ingest:openapi:<service>'
async function ingestOpenAPI(opts) {
  opts = opts || {};
  if (!opts.spec || typeof opts.spec !== 'object') {
    return { ok: false, error: 'spec_required (parsed OpenAPI 3.x object)' };
  }
  if (typeof opts.service !== 'string' || !opts.service) {
    return { ok: false, error: 'service_required' };
  }
  if (!opts.agent_id) return { ok: false, error: 'agent_id_required' };

  const scope = 'docs:openapi:' + opts.service;
  const chunks = buildChunks(opts.spec);
  if (chunks.length === 0) {
    return { ok: false, error: 'no_operations_found', scope };
  }

  // Concatenate chunks separated by clear delimiters so chameleon.chunkText
  // doesn't try to re-split mid-operation. Pass title=service for context.
  const text = chunks.map(c => c.text).join('\n\n---\n\n');

  const res = await chameleon.ingestDocument({
    agent_id:    opts.agent_id,
    user_id:     opts.user_id || 'default',
    cwd:         opts.cwd     || null,
    scope,
    text,
    title:       opts.service + ' OpenAPI',
    source:      opts.source || ('ingest:openapi:' + opts.service),
    embedding_host: opts.embedding_host,
    // Chunk_chars >= per-operation cap so each operation stays atomic;
    // overlap small to avoid duplicating context across operation boundaries.
    chunk_chars: opts.chunk_chars   || (CHUNK_CHAR_CAP + 200),
    chunk_overlap: opts.chunk_overlap || 100
  });

  return Object.assign({}, res, { scope, operations: chunks.length });
}

module.exports = {
  ingestOpenAPI,
  buildChunks,
  CHUNK_CHAR_CAP,
  SUPPORTED_METHODS,
  // exposed for tests
  _summarizeParam,
  _summarizeRequestBody,
  _summarizeResponses
};
