// SPDX-License-Identifier: AGPL-3.0-only
// cas-do.js — content-addressed-store dispatcher adapter.
//
// Maps substrate `intent:cas:do` intents onto the immutable blob store
// (cas.js). Follows the universal-executor contract (see ../dispatcher.js):
//   module.exports = { scope_match, param_schema, irreversibility_class,
//                      async dispatch(intent, capability, ctx) -> {ok,result?,error?} }
//
// On a `put`, the adapter records an `artifact` engram — the substrate-side
// metadata record for the blob ({cid, kind, mime, produced_by_intent_id,
// parent_cids, branch_id, size_bytes, ts}). The blob is the body; the engram
// is the queryable, versioned, GC-able handle. Mutation = a NEW artifact
// engram with parent_cids -> previous; there is no in-place update.
//
// The dispatcher itself writes the observation engram (success/failure of the
// intent); the artifact engram written here is a distinct, durable workspace
// record, not an observation.

'use strict';

const cas    = require('../cas.js');
const engram = require('../engram.js');

const ADAPTER_SCOPE = 'intent:cas:do';
const ALLOWED_OPS   = new Set(['put', 'get', 'has', 'refcount']);

function _validate(payload) {
  if (!payload || typeof payload !== 'object') return 'payload required';
  if (!payload.op) return 'payload.op required';
  if (!ALLOWED_OPS.has(payload.op)) return 'payload.op not allowed: ' + payload.op;
  if (payload.op === 'put' && payload.content === undefined) return 'payload.content required for put';
  if ((payload.op === 'get' || payload.op === 'has' || payload.op === 'refcount') && !payload.hash) {
    return 'payload.hash required for ' + payload.op;
  }
  return null;
}

// Record the artifact engram for a freshly-stored (or deduped) blob. The cid
// and any parent_cids are embedded in the statement so cas.casRefcount can
// count references via the public listEngrams projection.
function _recordArtifact(hash, size, payload, producedByIntentId) {
  const parents = Array.isArray(payload.parent_cids)
    ? payload.parent_cids.filter(c => cas.isValidHash(c))
    : [];
  const statement = 'artifact ' + hash + (parents.length ? ' parents=' + parents.join(',') : '');
  try {
    return engram.recordEngram({
      agent_id:         'cas',
      user_id:          'operator',
      cwd:              null,
      statement,
      source:           'cas-do.put',
      source_authority: 'llm_inferred',
      scope:            'artifact',
      memory_class:     'semantic',
      salience:         1.0,
      auto_verify:      false,
      extra_output: {
        cid:                  hash,
        kind:                 payload.kind || 'blob',
        mime:                 payload.mime || 'application/octet-stream',
        produced_by_intent_id: producedByIntentId || null,
        parent_cids:          parents,
        branch_id:            payload.branch_id || 'branch:main',
        size_bytes:           size,
        ts:                   Date.now()
      }
    });
  } catch (_) {
    // CAS storage already succeeded; failing to record the metadata engram
    // must not fail the put. The blob is content-addressed and recoverable.
    return null;
  }
}

async function dispatch(intent, capability, ctx) {
  ctx = ctx || {};
  const payload = (intent && intent.payload) || {};
  const invalid = _validate(payload);
  if (invalid) return { ok: false, error: 'cas_invalid: ' + invalid };

  const producedByIntentId = (intent && intent.id) || ctx._intent_engram_id || null;

  try {
    switch (payload.op) {
      case 'put': {
        const { hash, size, created } = cas.casPut(payload.content, payload.encoding);
        const artifact_engram_id = _recordArtifact(hash, size, payload, producedByIntentId);
        return { ok: true, result: { hash, size, created, artifact_engram_id } };
      }
      case 'get': {
        const content = cas.casGet(payload.hash, payload.encoding);
        if (content === null) return { ok: false, error: 'cas_not_found' };
        return { ok: true, result: { hash: payload.hash, content,
                                     encoding: payload.encoding === 'base64' ? 'base64' : 'utf8' } };
      }
      case 'has':
        return { ok: true, result: { hash: payload.hash, has: cas.casHas(payload.hash) } };
      case 'refcount':
        return { ok: true, result: { hash: payload.hash, refcount: cas.casRefcount(payload.hash) } };
    }
  } catch (e) {
    return { ok: false, error: 'cas_op_failed: ' + (e && e.message || e) };
  }
}

module.exports = {
  scope_match: ADAPTER_SCOPE,
  param_schema: { op: 'string', content: 'string?', encoding: 'string?', hash: 'string?',
                  kind: 'string?', mime: 'string?', parent_cids: 'array?', branch_id: 'string?' },
  irreversibility_class: 'low',   // blobs are immutable + content-addressed; put is append-only/idempotent
  dispatch,
  _validate,
  ALLOWED_OPS
};
