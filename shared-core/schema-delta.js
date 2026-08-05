// SPDX-License-Identifier: AGPL-3.0-only
// schema-delta — Schema-Accelerated Delta Memory from
// the substrate design work.
//
// What it does: when an incoming sequence of actions matches a known
// `compiled_procedure` schema above a similarity threshold, the
// substrate stops creating new dense semantic embeddings for that
// sequence. Instead it writes a small delta record pointing at the
// master schema with only the specific parameter overrides
// (file paths, args). Per the paper: target ≥90% token footprint
// reduction on the matched repeated work.
//
// Falsifiability spec: 50 identical boilerplate file creations.
// System should recognize the topology by file 3 (the third
// occurrence is enough for ≥2-session compiled_procedure detection
// to have fired), then represent the next 47 as parameter deltas
// rather than 47 fresh dense records.
//
// Grounded in Tse et al. schema-cell findings (the design work): prior
// knowledge frameworks accelerate encoding of new structurally
// related information; the substrate does the same with sub-graph
// matching against compiled procedures.
//
// What we DO:
//   1. signaturesFromActions(actions) — same shape as PRWF's
//      actionSignature, applied to a sequence
//   2. matchingSchema({actions, schemas, threshold}) — scan the
//      compiled_procedure pool, compute sequence-overlap similarity
//      with each schema's template, return the best ≥ threshold (or
//      null). Default threshold 0.80 per paper.
//   3. compressToDelta(actions, schema) — returns
//      `{schema_ref, parameter_overrides, original_count}` —
//      the lightweight representation
//   4. expandFromDelta(delta, schema) — reverses compression for
//      audit / retrieval; returns reconstructed step plan
//
// What we DO NOT do:
//   Modify state.recordAction. Wiring is opt-in: callers feed
//     candidate sequences through matchingSchema before deciding
//     whether to bulk-write or delta-write.
//   Use real graph isomorphism. The paper notes "sub-graph
//     isomorphism is computationally heavy" — we use simple
//     sequence-overlap as the prototype scope, matching the
//     procedure-matcher's approach.

const compiler = require('./procedure-compiler.js');
const matcher  = require('./procedure-matcher.js');

const DEFAULT_THRESHOLD = 0.80;

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// Extract a tool-name signature sequence from a list of actions.
// Mirrors procedure-compiler.toolNameOf so detected procedures
// match the same vocabulary.
function signaturesFromActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const a of actions) {
    if (!a || a.type !== 'tool_call') continue;
    const inp = (typeof a.input === 'string') ? safeJson(a.input) : a.input;
    const name = inp && inp.tool_name;
    if (!name) continue;
    if (!compiler.isSkillCandidateTool(name)) continue;
    out.push(name);
  }
  return out;
}

// Sequence overlap = (longest common contiguous subsequence length)
// / max(template length, candidate length). Bounded 0..1. Simple,
// deterministic, fast — adequate for the prototype scope.
function sequenceOverlap(template, candidate) {
  if (!Array.isArray(template) || !Array.isArray(candidate)) return 0;
  if (!template.length || !candidate.length) return 0;
  let best = 0;
  for (let i = 0; i <= candidate.length - 1; i++) {
    let run = 0;
    for (let j = 0; j < template.length && i + j < candidate.length; j++) {
      if (template[j] === candidate[i + j]) run++;
      else break;
    }
    if (run > best) best = run;
  }
  return best / Math.max(template.length, candidate.length);
}

// Match a candidate action sequence against a list of schema rows.
// Each schema row is a compiled_procedure ActionRecord. Returns the
// best-scoring schema with score ≥ threshold (or null).
function matchingSchema(opts) {
  opts = opts || {};
  const actions = Array.isArray(opts.actions) ? opts.actions : [];
  const schemas = Array.isArray(opts.schemas) ? opts.schemas : [];
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  if (!actions.length || !schemas.length) return null;

  const candidate = signaturesFromActions(actions);
  if (!candidate.length) return null;

  let best = null;
  for (const row of schemas) {
    const out = safeJson(row.output) || {};
    if (out.status === 'deprecated') continue;
    const template = Array.isArray(out.template) ? out.template : [];
    const tplSig = template.map(s => s && (s.tool || s.tool_name)).filter(Boolean);
    if (!tplSig.length) continue;
    const score = sequenceOverlap(tplSig, candidate);
    if (score < threshold) continue;
    if (!best || score > best.score) {
      best = { schema: row, score, template_signature: tplSig };
    }
  }
  return best;
}

// Compress a matched sequence into a delta record. Captures only
// what differs from the schema (parameter overrides like file paths
// and args), not the full action list.
function compressToDelta(actions, match) {
  if (!Array.isArray(actions) || !match || !match.schema) {
    return { ok: false, reason: 'missing_actions_or_match' };
  }
  const overrides = [];
  let i = 0;
  for (const a of actions) {
    if (!a || a.type !== 'tool_call') continue;
    const inp = (typeof a.input === 'string') ? safeJson(a.input) : a.input;
    const tool = inp && inp.tool_name;
    if (!tool) continue;
    // Strip the tool_name (already in schema); keep only args.
    const args = (inp && inp.args) || {};
    if (Object.keys(args).length) {
      overrides.push({ step_index: i, tool, args });
    }
    i++;
  }
  return {
    ok: true,
    schema_ref: match.schema.id,
    schema_score: match.score,
    parameter_overrides: overrides,
    original_count: actions.length,
    delta_size: overrides.length
  };
}

// Reverse the compression: walk the schema's template and apply
// any parameter overrides at matching step indices. Returns the
// reconstructed step plan (`[{step_index, tool, args}]`).
function expandFromDelta(delta, schema) {
  if (!delta || !schema) return [];
  const out = safeJson(schema.output) || {};
  const template = Array.isArray(out.template) ? out.template : [];
  const overridesByIdx = new Map();
  for (const o of (delta.parameter_overrides || [])) {
    overridesByIdx.set(o.step_index, o);
  }
  return template.map((step, i) => {
    const tool = step.tool || step.tool_name;
    const baseArgs = Object.assign({}, step.args || {});
    const ovr = overridesByIdx.get(i);
    const args = ovr ? Object.assign(baseArgs, ovr.args || {}) : baseArgs;
    return { step_index: i, tool, args };
  });
}

module.exports = {
  signaturesFromActions,
  sequenceOverlap,
  matchingSchema,
  compressToDelta,
  expandFromDelta,
  DEFAULT_THRESHOLD
};
