// SPDX-License-Identifier: AGPL-3.0-only
// Verification primitives — unified interface for checking the correctness
// of an ActionRecord's output before it's trusted downstream.
//
// The atom of the substrate is ActionRecord. Verification is what makes a
// record trustable: an edit that produced broken syntax must carry that fact;
// a tool call that failed must carry its exit code; a decision that blocked
// must carry its reason.
//
// Every verifier implements the same shape:
//
//   run(input, output) -> { ok, errors?, details? }
//
// - `ok`: boolean. True = verification passed. False = failed. Null/undefined
//   should be interpreted as "not applicable" by callers (prefer `skipped`).
// - `errors`: structured list when ok=false. Always arrays of objects, never
//   free-form strings — so callers can react programmatically.
// - `details`: optional extra info (line/column, command output, etc.).
// - `skipped`: boolean. True when the verifier intentionally didn't run
//   (e.g., ast for rust file — we don't parse rust). Never block on skipped.
//
// The verifiers here wrap existing troth primitives; the interface is the
// value. This slice ships the wrapper; domain-specific verifiers (tests/types)
// land later phases when we wire test-runner integrations.
//
// See the substrate design notes.

const astValidate = require('./ast-validate');
const hashline    = require('./hashline');

// ── AST verification ──────────────────────────────────────────────────────
// Structural safety: can the tree-sitter parser accept this content? Covers
// JS, TS, TSX, JSX, PY, JSON. Skips gracefully for unsupported extensions
// (rust, go, markdown, plain text, etc.) — skipped != failed.
function verifyAST(filePath, content) {
  if (!filePath || content === undefined || content === null) {
    return { ok: false, skipped: false, errors: [{ kind: 'missing_input' }] };
  }
  const res = astValidate.validate(filePath, content);
  if (res.skipped) return { ok: null, skipped: true };
  if (res.ok)       return { ok: true,  skipped: false };
  return {
    ok: false,
    skipped: false,
    errors: (res.errors || []).map(e => ({ ...e, kind: 'parse_error' }))
  };
}

// ── Content hash verification ─────────────────────────────────────────────
// For edits that reference lines by hash (hashline), check that the current
// file state matches what the edit's input claims. Catches stale edits where
// the file drifted between read and write.
function verifyContentHash(content, expectedRefs) {
  if (typeof content !== 'string' || !Array.isArray(expectedRefs) || !expectedRefs.length) {
    return { ok: null, skipped: true };
  }
  const errors = [];
  for (const ref of expectedRefs) {
    const r = hashline.validateRef(content, ref);
    if (!r.ok) {
      errors.push({ kind: 'hash_mismatch', pos: ref, reason: r.reason, expected: r.expected, got: r.got });
    }
  }
  return errors.length
    ? { ok: false, skipped: false, errors }
    : { ok: true, skipped: false };
}

// ── Test result verification ──────────────────────────────────────────────
// Pluggable: caller supplies { passed, failed, ids } from whatever runner
// they used (pytest, jest, vitest, go test, ...). We normalize the shape
// rather than invoke a runner. Phase B or later ships actual runners.
function verifyTests(result) {
  if (!result || typeof result !== 'object') {
    return { ok: null, skipped: true };
  }
  const passed = parseInt(result.passed || 0, 10);
  const failed = parseInt(result.failed || 0, 10);
  if (passed + failed === 0) {
    return { ok: null, skipped: true };
  }
  return failed === 0
    ? { ok: true,  skipped: false, details: { passed, failed } }
    : { ok: false, skipped: false, errors: [{ kind: 'tests_failed', passed, failed, ids: result.ids || [] }] };
}

// ── Type check verification ───────────────────────────────────────────────
// Same pluggable pattern: caller supplies { errors: [...] } from tsc, mypy,
// pyright, etc. Normalized to our shape.
function verifyTypes(result) {
  if (!result || typeof result !== 'object') {
    return { ok: null, skipped: true };
  }
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length === 0 && result.ok !== false) {
    return { ok: true, skipped: false };
  }
  return {
    ok: false,
    skipped: false,
    errors: errors.map(e => ({ kind: 'type_error', ...e }))
  };
}

// ── Human approval (manual sign-off) ──────────────────────────────────────
// Explicit audit-trail verification for sensitive actions. Callers record
// who approved and when; this just validates shape.
function verifyHuman(approval) {
  if (!approval || typeof approval !== 'object') {
    return { ok: null, skipped: true };
  }
  if (!approval.approved_by || !approval.approved_at) {
    return { ok: false, skipped: false, errors: [{ kind: 'incomplete_approval' }] };
  }
  return { ok: true, skipped: false, details: approval };
}

// ── Composite verification ────────────────────────────────────────────────
// Run a set of verifiers and return an ActionRecord.verification object with
// each slot populated. Caller picks which verifiers are relevant for the
// action type (see TYPES registry in action-record.js).
//
// Usage:
//   const v = composite({
//     ast:          () => verifyAST(path, newContent),
//     content_hash: () => verifyContentHash(oldContent, hashlineRefs),
//     tests:        () => verifyTests(testRunnerResult)
//   });
//   record.verification = v;
function composite(slots) {
  const result = {};
  if (!slots || typeof slots !== 'object') return result;
  for (const key of Object.keys(slots)) {
    const fn = slots[key];
    try {
      const out = typeof fn === 'function' ? fn() : fn;
      if (out !== undefined) result[key] = out;
    } catch (e) {
      result[key] = {
        ok: false,
        skipped: false,
        errors: [{ kind: 'verifier_exception', message: String(e && e.message || e) }]
      };
    }
  }
  return result;
}

// ── Aggregate readout ─────────────────────────────────────────────────────
// Collapses a composite verification to a single verdict: PASS if every
// non-skipped slot is ok:true; FAIL if any is ok:false; PARTIAL if all
// slots skipped (no verification possible). Callers use this for gating
// decisions (block edit on FAIL, allow on PASS, flag PARTIAL for review).
function verdict(verification) {
  if (!verification || typeof verification !== 'object') return 'partial';
  let anyOk = false, anyFail = false;
  for (const slot of Object.keys(verification)) {
    const v = verification[slot];
    if (!v || typeof v !== 'object') continue;
    if (v.skipped) continue;
    if (v.ok === true) anyOk = true;
    if (v.ok === false) anyFail = true;
  }
  if (anyFail) return 'fail';
  if (anyOk)   return 'pass';
  return 'partial';
}

module.exports = {
  // Individual verifiers
  verifyAST,
  verifyContentHash,
  verifyTests,
  verifyTypes,
  verifyHuman,
  // Composition + aggregation
  composite,
  verdict
};
