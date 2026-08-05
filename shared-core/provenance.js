// SPDX-License-Identifier: AGPL-3.0-only
// Provenance / citations.
//
// Every claim the substrate makes about the world or about itself
// should be traceable to WHAT it knows from. Without this, the mind
// is a fluent assertion engine that the operator must trust on faith.
// With this, every claim carries footnotes: which engrams support it,
// which files were read, which URLs were fetched.
//
// Design principle: the mind OWNS its claims. Citations are part of how the
// mind expresses itself, not a UI feature bolted on. Same idea as
// W3C PROV-O wasDerivedFrom — every fact has a derivation chain.
//
// Distinct from engram.recordEngram's existing `provenance` field
// (file_path / codelens_entity / source_module / lines) which captures
// PHYSICAL provenance (where the engram came from in the codebase).
// This module captures CLAIM-level provenance (which sources support
// the assertion).
//
// Storage:
//   engram output.source_refs: [
//     { kind: 'engram', id: 'uuid', preview?: '...'   },  // substrate self-reference
//     { kind: 'file',   path: '/abs/path', lines?: [a,b] },
//     { kind: 'url',    url: 'https://...', fetched_at? },
//     { kind: 'tool',   tool: 'api_call', service?: '...', status?: 200 }
//   ]
//
// Verification:
//   verifySources(refs) checks each ref resolves:
//     - engram: state.queryActions returns the row
//     - file:   fs.existsSync + readable
//     - url:    on web_allowlist OR previously fetched (substrate
//                 audit row exists)
//     - tool:   noop (tools either ran or didn't — can't re-verify
//                 cheaply; flagged as 'unverifiable_kind')
//
// design grounding:
//   - W3C PROV-O wasDerivedFrom / wasGeneratedBy / wasAttributedTo
//   - Reflexion (Shinn 2303.11366 §3): verbal feedback + grounded
//     references improves agent self-correction
//   - design R17: structural verification (claim with no resolvable
//     refs is structurally distinct from claim with resolvable refs)
//   - design R23: provenance lives on the engram; never UPDATE
//   - Constitutional AI (Bai 2212.08073): principle-based critique
//     can require source-ref presence as a principle

'use strict';

const fs    = require('fs');
const state = require('./state.js');

const VALID_KINDS = new Set(['engram', 'file', 'url', 'tool']);
const MAX_REFS_PER_CLAIM = 12;

function _validateRef(ref) {
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'ref_not_object' };
  if (!VALID_KINDS.has(ref.kind))      return { ok: false, reason: 'invalid_kind', got: ref.kind };
  if (ref.kind === 'engram' && (!ref.id || typeof ref.id !== 'string')) {
    return { ok: false, reason: 'engram_id_required' };
  }
  if (ref.kind === 'file' && (!ref.path || typeof ref.path !== 'string')) {
    return { ok: false, reason: 'file_path_required' };
  }
  if (ref.kind === 'url' && (!ref.url || typeof ref.url !== 'string' || ref.url.indexOf('http') !== 0)) {
    return { ok: false, reason: 'url_required' };
  }
  if (ref.kind === 'tool' && (!ref.tool || typeof ref.tool !== 'string')) {
    return { ok: false, reason: 'tool_required' };
  }
  return { ok: true };
}

// Validate a list of refs. Returns
//   { ok, refs: validated[], errors: [{index, ref, reason}] }
// Caller decides whether to fail closed on any error.
function validateRefs(refs) {
  if (!Array.isArray(refs)) return { ok: false, refs: [], errors: [{reason: 'refs_not_array'}] };
  const out = [];
  const errors = [];
  for (let i = 0; i < refs.length; i++) {
    if (out.length >= MAX_REFS_PER_CLAIM) {
      errors.push({ index: i, reason: 'too_many_refs', max: MAX_REFS_PER_CLAIM });
      break;
    }
    const v = _validateRef(refs[i]);
    if (!v.ok) {
      errors.push({ index: i, ref: refs[i], reason: v.reason });
      continue;
    }
    out.push(refs[i]);
  }
  return { ok: errors.length === 0, refs: out, errors };
}

// Resolve a single ref. Returns
//   { kind, resolves: bool, detail?, ... }
function _resolveOne(ref) {
  if (ref.kind === 'engram') {
    try {
      const rows = state.queryActions({ type: 'commitment', limit: 1000 }) || [];
      const found = rows.find(r => r.id === ref.id);
      return { kind: 'engram', id: ref.id, resolves: !!found };
    } catch (_) {
      return { kind: 'engram', id: ref.id, resolves: false, detail: 'query_error' };
    }
  }
  if (ref.kind === 'file') {
    try {
      const exists = fs.existsSync(ref.path);
      if (!exists) return { kind: 'file', path: ref.path, resolves: false, detail: 'not_found' };
      const stat = fs.statSync(ref.path);
      return { kind: 'file', path: ref.path, resolves: stat.isFile(), size: stat.size };
    } catch (e) {
      return { kind: 'file', path: ref.path, resolves: false, detail: String(e && e.message || e) };
    }
  }
  if (ref.kind === 'url') {
    // We don't re-fetch here (would be costly + slow). Resolution
    // proxy: is the host on the operator's web_allowlist? If yes, the
    // URL was at least theoretically reachable when the claim was made.
    // Caller can re-fetch separately if they need stronger verification.
    try {
      const url = new (require('url').URL)(ref.url);
      const webAllow = require('./tools/web-allowlist.js');
      const allowed = typeof webAllow.isAllowed === 'function'
        ? webAllow.isAllowed(url.hostname)
        : true;  // can't decide → optimistic
      return { kind: 'url', url: ref.url, resolves: !!allowed, host: url.hostname };
    } catch (e) {
      return { kind: 'url', url: ref.url, resolves: false, detail: 'bad_url' };
    }
  }
  if (ref.kind === 'tool') {
    // Tool refs are records of "I called this tool" — not re-verifiable
    // without re-running the tool (expensive, may be non-idempotent).
    // Treat as opaquely-resolved; mark unverifiable_kind so caller
    // knows.
    return { kind: 'tool', tool: ref.tool, resolves: true, detail: 'unverifiable_kind' };
  }
  return { kind: ref.kind, resolves: false, detail: 'unknown_kind' };
}

// Verify all refs. Returns
//   { ok, total, resolved, unresolved, per_ref: [{...resolution}] }
function verifySources(refs) {
  if (!Array.isArray(refs)) return { ok: false, total: 0, resolved: 0, unresolved: 0, per_ref: [] };
  const per = refs.map(_resolveOne);
  const resolved = per.filter(r => r.resolves).length;
  return {
    ok: resolved === refs.length,
    total: refs.length,
    resolved,
    unresolved: refs.length - resolved,
    per_ref: per
  };
}

// Convenience: write an engram WITH source_refs embedded into the
// output blob (via extra_output). Validates refs first; on validation
// failure returns null (caller MUST handle).
//
//   opts: same as engram.recordEngram +
//     opts.source_refs: [refs]      (required)
//     opts.fail_closed_on_invalid:  bool (default true) — when true,
//                                   any invalid ref aborts the write
//
// Returns { ok, engram_id?, validation }
function recordWithProvenance(opts) {
  opts = opts || {};
  const validation = validateRefs(opts.source_refs || []);
  if (!validation.ok && opts.fail_closed_on_invalid !== false) {
    return { ok: false, validation, reason: 'invalid_source_refs' };
  }
  const engram = require('./engram.js');
  const id = engram.recordEngram(Object.assign({}, opts, {
    extra_output: Object.assign(
      {},
      opts.extra_output || {},
      { source_refs: validation.refs }
    )
  }));
  if (!id) return { ok: false, reason: 'engram_record_failed', validation };
  return { ok: true, engram_id: id, validation };
}

module.exports = {
  validateRefs,
  verifySources,
  recordWithProvenance,
  VALID_KINDS,
  MAX_REFS_PER_CLAIM,
  // exposed for tests
  _validateRef,
  _resolveOne
};
