#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// LoopBreaker — catches the "Claude is hitting the same failing command over
// and over" failure mode. Hashes every tool call (tool + normalized args) and
// counts how often the same hash appeared in this session's recent window.
//
//   prior=0..1 → allow silently
//   prior=2..3 → allow + inject nudge ("Loop detected, try a different angle")
//   prior≥4    → deny ("Stop repeating; change approach")
//
// Research: AttnRoute (Building Efficient LLM Proxy Architectures §1.3).
// Session scoping + recent-window via state.db so the signal doesn't leak
// across sessions or accumulate forever.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readStdinJson, allow, ask, addContext, log, state, recordAction, featureEnabled } from './_lib.mjs';

// Read path — pull cross-session precedent so we detect
// "this shape of loop happened in another session too" not only
// "same call N times this session".
const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const query = require(pluginRoot + '/../shared-core/query.js');

const WINDOW_MS     = 10 * 60 * 1000; // 10-minute rolling window

// Per-tool thresholds. The  hard-task benchmark
// exposed that a single
// { nudge_at: 2, deny_at: 4 } threshold over-indexes on catching
// degenerate Edit loops and incorrectly kills legitimate Read-based
// exploration on multi-file tasks. Split the thresholds by tool.
//
//   Edit / Write / MultiEdit / NotebookEdit — deny hard at 4 repeats.
//     These are the real "agent is stuck" failure mode. Keep original
//     behaviour.
//   Read / Grep / Glob — exploration tools. Never deny. Nudge once at
//     5 repeats so a real loop still surfaces, but legitimate
//     re-inspection of a file during multi-step planning is allowed.
//   Anything else (Bash, MCP, Task, etc.) — original edit-class
//     thresholds, because repeat bash-same-command IS usually a loop.
function thresholdsFor(toolName) {
  if (/^Edit|Write|MultiEdit|NotebookEdit$/.test(toolName)) {
    return { nudge_at: 2, deny_at: 4, allow_deny: true };
  }
  if (/^Read|Grep|Glob$/.test(toolName)) {
    return { nudge_at: 5, deny_at: Infinity, allow_deny: false };
  }
  return { nudge_at: 2, deny_at: 4, allow_deny: true };
}

function normalize(tool, input) {
  // Strip volatile fields so "same call" is recognised even if line numbers
  // or whitespace differ. Sort keys for stable hashing.
  const keep = { tool };
  if (!input || typeof input !== 'object') { keep.args = input; }
  else {
    const ordered = {};
    for (const k of Object.keys(input).sort()) {
      const v = input[k];
      if (typeof v === 'string') ordered[k] = v.trim().replace(/\s+/g, ' ');
      else ordered[k] = v;
    }
    keep.args = ordered;
  }
  return createHash('sha1').update(JSON.stringify(keep)).digest('hex').slice(0, 16);
}

const payload = await readStdinJson();
const session = payload.session_id || 'unknown';
const tool    = payload.tool_name || '';
const input   = payload.tool_input || {};

if (!session || session === 'unknown') { allow(); }

const hash = normalize(tool, input);
const prior = state.countRecentToolCallHashes(session, hash, WINDOW_MS);
const { nudge_at: NUDGE_AT, deny_at: DENY_AT, allow_deny } = thresholdsFor(tool);

// Record the current call AFTER counting so `prior` reflects history.
try { state.recordToolCallHash(session, hash); } catch {}

if (allow_deny && prior >= DENY_AT) {
  log('PreToolUse.loopbreaker', {
    session_id: session, tool, decision: 'deny', reason: 'loop_exceeded',
    metadata: { hash, prior }
  });
  recordAction({
    type: 'decision',
    session_id: session, cwd: payload.cwd,
    input: { kind: 'loopbreaker', tool, hash, prior },
    output: { decision: 'deny', reason: 'loop_exceeded', confidence: 1.0 }
  });
  state.recordSavings('loopbreaker_denied', 1, session, tool + ' blocked after ' + prior + ' repeats');
  // persist a reflexion lesson so next turn's injector warns
  // the model to change approach. Fingerprint prevents spam from the
  // same loop-trigger recurring after a short cooldown.
  try {
    state.recordLesson(
      session,
      payload.cwd || process.cwd(),
      'loopbreaker',
      hash,
      'A ' + tool + ' call was blocked after repeating ' + (prior + 1) + ' times. ' +
      'Do not retry with identical arguments — diagnose the failure first, then change approach.'
    );
  } catch (e) { /* swallow */ }
  // P16.5 I1 — avoided_path record for the negative-precedent surfacer.
  if (featureEnabled('negative_knowledge')) {
    try {
      const avoided = require(pluginRoot + '/../shared-core/avoided.js');
      avoided.recordAvoidance(state, {
        session_id: session, cwd: payload.cwd,
        reason_kind: 'loopbreaker',
        signals: [tool, hash],
        avoidance_text: 'Loop detected: ' + tool + ' call was blocked after ' + (prior + 1) + ' identical repeats',
        suggest_instead: 'change tool args or approach before retrying ' + tool
      });
    } catch (e) { /* never break the hook */ }
  }
  ask('Loop detected — the same ' + tool + ' call has fired ' + (prior + 1) + ' times this session. Change your approach before retrying.');
}

if (prior >= NUDGE_AT) {
  log('PreToolUse.loopbreaker', {
    session_id: session, tool, decision: 'nudge', reason: 'loop_warning',
    metadata: { hash, prior }
  });
  recordAction({
    type: 'decision',
    session_id: session, cwd: payload.cwd,
    input: { kind: 'loopbreaker', tool, hash, prior },
    output: { decision: 'nudge', reason: 'loop_warning' }
  });

  // Substrate READ: look for lessons recorded by loopbreaker
  // in OTHER sessions within the same project. Cross-session precedent
  // is a stronger signal than a single-session repeat.
  let crossSessionNote = '';
  try {
    const lessons = query.getLessons(state, { cwd: payload.cwd, limit: 20 }) || [];
    const matching = lessons.filter(l =>
      l.input && l.input.source === 'loopbreaker' &&
      l.input.fingerprint === hash && l.session_id !== session
    );
    if (matching.length > 0) {
      crossSessionNote =
        ' Also: this exact tool+args shape triggered the same block in ' +
        matching.length + ' prior session(s). The approach has failed repeatedly — the problem is the plan, not the execution.';
    }
  } catch (_) {}

  addContext('[troth/loopbreaker] Notice: the same ' + tool + ' call has fired ' + (prior + 1) + ' times in the last 10 minutes. If the previous attempts failed, change approach instead of retrying with the same arguments.' + crossSessionNote);
}

log('PreToolUse.loopbreaker', {
  session_id: session, tool, decision: 'allow',
  metadata: { hash, prior }
});
recordAction({
  type: 'decision',
  session_id: session, cwd: payload.cwd,
  input: { kind: 'loopbreaker', tool, hash, prior },
  output: { decision: 'allow' }
});
allow();
