// SPDX-License-Identifier: AGPL-3.0-only
// loop-detector.js — multi-step loop detection for the L4 agentic layer.
//
// foundation step (the design): the step engine already caps single-step
// iteration via step_definitions.max_iterations. What it does NOT catch is
// the multi-step cycle: A → B → A → B repeating, where each individual
// step's max_iterations is satisfied but the macro behavior is a loop.
// Classic agent failure mode (Devin, AutoGPT, OpenHands all hit it).
//
// Detector runs as part of the validation gate before each proposed
// transition. Reads the parent_id chain back N transitions, computes a
// signature per record (already stored in action_records.transition_signature,
// shipped in initial milestone / state.js schema v2), counts frequencies in the
// window, and returns an escalation level when any signature exceeds the
// threshold.
//
// API:
//   computeSignature(transition) → string
//   detect(opts) → { detected, signature, count, action }
//     opts = { record_id, goal_id?, config? }
//     action ∈ 'none' | 'warn' | 'escalate' | 'abort'
//
// The detector is PURE READ — it never mutates substrate. The coordinator
// receives the action and decides what to do (log warning, escalate to
// user, hard-abort + reflection post-mortem).
//
// Config defaults match the the design spec:
//   window_size           20   how far back to scan
//   repeat_threshold      4    signature count that triggers detection
//   escalation_threshold  2    detection-count threshold to ask the user
//   hard_abort_threshold  3    detection-count threshold to kill the loop

const crypto = require('crypto');
const state  = require('./state.js');

const DEFAULT_CONFIG = Object.freeze({
  window_size:          20,
  repeat_threshold:     4,
  escalation_threshold: 2,
  hard_abort_threshold: 3,
  // In-memory (per-turn) tail-dominance criterion — see detectInMemory.
  tail_size:            8,   // how many trailing transitions define "what the turn is DOING now"
  tail_min:             6,   // don't judge dominance on fewer transitions than this
  hammer_threshold:     10   // absolute ceiling: one signature this many times in the window is stuck regardless
});

// Compute the canonical signature for a transition. Three inputs make a
// transition "the same step": the named step in the goal_class's step_defs,
// the tool invoked, and the resource the tool targeted (file path, URL,
// row id — whatever uniquely identifies the side-effect target).
//
// Hash so the value is index-friendly + storage-friendly (40 hex chars).
// SHA-1 chosen for speed; loop detection is not security-sensitive — we
// only care about equality, not collision resistance from an adversary.
function computeSignature(t) {
  if (!t || typeof t !== 'object') return null;
  const step     = String(t.step_name      || '');
  const tool     = String(t.tool_invoked   || '');
  const resource = String(t.target_resource|| '');
  // Empty inputs would all hash to the same value — refuse to emit a
  // signature when there's nothing to distinguish on. Callers should
  // skip detection for these (step engine handles its own iter caps).
  if (!step && !tool && !resource) return null;
  return crypto.createHash('sha1')
    .update(step + '\0' + tool + '\0' + resource)
    .digest('hex');
}

// Walk parent_id chain back from a starting record, collecting up to
// `limit` rows. Each row brings its already-stored transition_signature
// (computed at write time by the caller or backfilled here when missing).
//
// Walks one row per query — for window_size=20 this is 20 round-trips,
// trivially fast on local SQLite. Could batch via recursive CTE later if
// the window ever needs to grow into the hundreds.
function walkParentChain(startId, limit) {
  if (!startId) return [];
  const chain = [];
  let cursorId = startId;
  let safety = limit * 2; // avoid infinite loop on cyclical parent_id (corrupt data)
  while (cursorId && chain.length < limit && safety-- > 0) {
    const row = state.getAction(cursorId);
    if (!row) break;
    chain.push(row);
    cursorId = row.parent_id || null;
  }
  return chain;
}

// Count detections recorded against this goal so escalation level can be
// derived. We don't have a goal_detections table yet (would be in (milestone)
// when goal-class-registry lands); for now we count repeated detections
// in the same parent chain by re-scanning. Conservative — under-counts if
// the goal has multiple parallel branches, which biases toward 'warn' not
// 'abort'. Safer side to err on.
function countPriorDetections(chain, signature) {
  let n = 0;
  for (const row of chain) {
    let out;
    try {
      out = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {});
    } catch (_) { continue; }
    if (out && out._loop_detected_signature === signature) n++;
  }
  return n;
}

// Public entry point. Given a record id (the proposed-or-just-applied
// transition), decide whether the chain ending at it is a loop and what
// action the coordinator should take.
function detect(opts) {
  opts = opts || {};
  const config = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
  const startId = opts.record_id;
  if (!startId) {
    return { detected: false, action: 'none', reason: 'no_record_id' };
  }
  const chain = walkParentChain(startId, config.window_size);
  if (!chain.length) {
    return { detected: false, action: 'none', reason: 'no_chain' };
  }
  // Tally signatures across the window.
  const counts = new Map();
  for (const row of chain) {
    const sig = row.transition_signature;
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  // Find the worst offender. Ties broken by first-seen so we report the
  // signature the operator likely recognizes ("this same call kept firing").
  let worstSig = null;
  let worstCount = 0;
  for (const [sig, count] of counts) {
    if (count > worstCount) { worstSig = sig; worstCount = count; }
  }
  if (worstCount < config.repeat_threshold) {
    return { detected: false, action: 'none', signature: worstSig, count: worstCount };
  }
  // Loop. Decide action by counting how many times THIS signature has
  // already triggered detection on the same chain — i.e. the operator's
  // already been warned about this exact loop, time to escalate.
  const priorDetections = countPriorDetections(chain, worstSig);
  let action = 'warn';
  if (priorDetections >= config.hard_abort_threshold - 1) action = 'abort';
  else if (priorDetections >= config.escalation_threshold - 1) action = 'escalate';
  return {
    detected:          true,
    signature:         worstSig,
    count:             worstCount,
    prior_detections:  priorDetections,
    action,
    window_inspected:  chain.length,
    config
  };
}

// In-memory loop detection for callers that hold a sequence of transitions
// in-process and haven't written them to substrate yet (canonical example:
// composeAgentic's local trace array, where each iteration's tool dispatch
// is a transition but the action_record isn't written until the wrapping
// caller decides the turn is finished).
//
// Same algorithm as detect() — signature frequencies in a window — but the
// input is a plain array of {step_name, tool_invoked, target_resource}
// transitions, oldest-first. priorDetections is the count of prior
// detection events on the same signature passed in via opts.priorDetections
// (caller tracks across iterations so escalation can advance turn-to-turn).
function detectInMemory(opts) {
  opts = opts || {};
  const config = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
  const transitions = Array.isArray(opts.transitions) ? opts.transitions : [];
  if (!transitions.length) {
    return { detected: false, action: 'none', reason: 'no_transitions' };
  }
  // TAIL-DOMINANCE. The old criterion — any signature seen
  // repeat_threshold times anywhere in the trailing window — flagged HEALTHY
  // turns: legitimate check calls (an `ls` between steps, a re-read of an
  // unchanged file) repeat identically while productive work continues around
  // them, and a 20-deep window happily accumulates 4 of them (burn-in
  // fresh multi-file tasks aborted at 11-20 tool calls while the
  // work was landing on disk). A turn is looping only when repetition is what
  // it is DOING right now — the recent TAIL is dominated by at most two
  // signatures (pure A-A-A or A-B-A-B ping-pong) with nothing novel — or when
  // one signature is hammered outright (absolute ceiling over the window).
  const window = transitions.slice(-config.window_size);
  const counts = new Map();
  for (const t of window) {
    const sig = computeSignature(t);
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  let worstSig = null;
  let worstCount = 0;
  for (const [sig, count] of counts) {
    if (count > worstCount) { worstSig = sig; worstCount = count; }
  }
  const tail = transitions.slice(-config.tail_size);
  const tailCounts = new Map();
  for (const t of tail) {
    const sig = computeSignature(t);
    if (!sig) continue;
    tailCounts.set(sig, (tailCounts.get(sig) || 0) + 1);
  }
  const perSigFloor = Math.max(2, config.repeat_threshold - 1);
  const tailDominated = tail.length >= config.tail_min
    && tailCounts.size > 0 && tailCounts.size <= 2
    && Array.from(tailCounts.values()).every((c) => c >= perSigFloor);
  const hammered = worstCount >= config.hammer_threshold;
  if (!tailDominated && !hammered) {
    return { detected: false, action: 'none', signature: worstSig, count: worstCount };
  }
  const priorDetections = typeof opts.priorDetections === 'number' ? opts.priorDetections : 0;
  let action = 'warn';
  if (priorDetections >= config.hard_abort_threshold - 1) action = 'abort';
  else if (priorDetections >= config.escalation_threshold - 1) action = 'escalate';
  return {
    detected:         true,
    signature:        worstSig,
    count:            worstCount,
    prior_detections: priorDetections,
    action,
    window_inspected: window.length,
    config
  };
}

module.exports = {
  computeSignature,
  detect,
  detectInMemory,
  DEFAULT_CONFIG,
  // Exposed for tests that need to bypass the full coordinator wiring.
  _walkParentChain:        walkParentChain,
  _countPriorDetections:   countPriorDetections
};
