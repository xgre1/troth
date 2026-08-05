#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Mind layer — UserPromptSubmit hook that scores the current
// user message against recent prompts (substrate intent records), and
// when a topic shift fires, writes a `decision` ActionRecord noting it.
//
// Default OFF. Opt in via env TROTH_TOPIC_SHIFT=1.
//
// Runs in the UserPromptSubmit chain alongside intent-capture.mjs and
// injector.mjs. We do NOT emit additionalContext — surfacing topic
// shifts to the model is handled later by the working-set manifest /
// mind/surface re-fetch. This hook is pure capture: detect the shift,
// record it, exit.
//
// Mechanism (per Q6): weighted score of embedding-drop + intent-change
// signals. Default similarity is dependency-free word overlap; future
// iterations can plug in a real embedding model via similarityFn.

import { createRequire } from 'node:module';
import { readStdinJson, allow, recordAction, log, addContext, featureEnabled } from './_lib.mjs';

if (!featureEnabled('topic_shift')) { allow(); }

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let stateModule; // fail-open: bare marketplace clone has no node_modules
try { stateModule = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let topicShift; // fail-open: bare marketplace clone has no node_modules
try { topicShift = require(pluginRoot + '/../shared-core/topic-shift.js'); } catch (_) { console.log('{}'); process.exit(0); }
let mindState; // fail-open: bare marketplace clone has no node_modules
try { mindState = require(pluginRoot + '/../shared-core/mind-state.js'); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const cwd     = payload.cwd || process.cwd();
const prompt  = payload.user_prompt || payload.prompt || '';
const session = payload.session_id || null;

if (!prompt.trim() || prompt.startsWith('/')) { allow(); }

// Pull the recent intent records for this cwd as the rolling reference
// window. These represent prior user turns; if the current prompt's
// topic has drifted from them, salience switch fires.
const WINDOW_SIZE = parseInt(process.env.TROTH_TOPIC_SHIFT_WINDOW || '5', 10);
const rows = stateModule.queryActions({
  type: 'intent',
  cwd,
  limit: WINDOW_SIZE + 1, // +1 so we can pick the most recent as prev_intent
  order: 'desc'
}) || [];

const recentIntents = rows.map((r) => actionRec.fromRow(r)).filter(Boolean);
const prevIntent = recentIntents[0] || null;
// Older recent messages = prompts from intents 1..N (skip current/most-recent
// which corresponds to the same prompt we're scoring if intent-capture
// already wrote it; use a defensive slice).
const recentMessages = recentIntents
  .slice(1)
  .map((r) => (r.input && r.input.goal) || '')
  .filter(Boolean);

// Synthesize a stand-in current_intent from the live prompt. The real
// intent record may not have been written yet (intent-capture runs in
// the same hook chain but order isn't guaranteed across configurations);
// passing the prompt as a synthesized goal lets topic-shift's intent
// signal fall through to the goal-text comparison and reinforce the
// embedding signal on real shifts.
const syntheticCurrent = { input: { goal: prompt } };

const scored = topicShift.scoreTopicShift({
  current_message: prompt,
  recent_messages: recentMessages,
  prev_intent: prevIntent,
  current_intent: syntheticCurrent,
  window: WINDOW_SIZE
});

if (!scored.fired) {
  log('UserPromptSubmit.topic_shift', {
    session_id: session,
    decision: 'no_shift',
    reason: 'score_' + scored.score.toFixed(2),
    metadata: {
      score: Number(scored.score.toFixed(3)),
      embedding_drop: Number(scored.embedding_drop.toFixed(3)),
      intent_change_signal: scored.intent_change_signal,
      threshold: scored.threshold,
      window: scored.window
    }
  });
  allow();
}

// Shift detected — write a decision ActionRecord so the substrate has
// a queryable record of when topics swapped. The next iteration can
// trigger mind/surface re-fetch off these records.
const id = recordAction({
  type: 'decision',
  session_id: session,
  cwd,
  input: {
    kind: 'topic_shift_detected',
    signals: {
      embedding_drop: Number(scored.embedding_drop.toFixed(3)),
      intent_change: scored.intent_change_signal
    }
  },
  output: {
    decision: 'topic_shift',
    reason: 'salience_switch',
    confidence: Number(scored.score.toFixed(3))
  }
});

log('UserPromptSubmit.topic_shift', {
  session_id: session,
  decision: 'shift_detected',
  reason: 'score_' + scored.score.toFixed(2),
  metadata: {
    record_id: id ? id.slice(0, 8) : null,
    score: Number(scored.score.toFixed(3)),
    embedding_drop: Number(scored.embedding_drop.toFixed(3)),
    intent_change_signal: scored.intent_change_signal,
    threshold: scored.threshold,
    window: scored.window,
    prompt_preview: prompt.slice(0, 80)
  }
});

// Re-orient: try to derive a task signature from the current prompt,
// fetch a hot/cold-shaped mind state for it, and inject a focused
// re-orientation block via addContext. This makes the dynamic delivery
// (P2) actually take effect — the agent gets fresh task-relevant
// context the moment a shift is detected, not just a logged event.
try {
  const snapRows = stateModule.queryActions({
    type: 'mind_snapshot',
    cwd,
    limit: 1,
    order: 'desc'
  }) || [];
  if (snapRows.length > 0) {
    const rec = actionRec.fromRow(snapRows[0]);
    const ms = rec && rec.output && rec.output.mind_state;
    if (ms) {
      const taskSig = mindState.deriveTaskSignature(prompt, ms);
      if (taskSig) {
        const shaped = mindState.shapeForTask(ms, taskSig);
        const reorientation = mindState.formatTopicShiftReorientation(
          shaped.mind_state, shaped.shape_info
        );
        if (reorientation) {
          // addContext emits + exits — must be the LAST hook action.
          addContext(reorientation);
        }
      }
    }
  }
} catch (e) {
  log('UserPromptSubmit.topic_shift.reorient_error', {
    session_id: session,
    metadata: { message: String(e && e.message || e) }
  });
}

// No re-orientation surfaced — silent capture, allow chain to continue.
allow();
