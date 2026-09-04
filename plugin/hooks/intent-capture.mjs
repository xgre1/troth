#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// UserPromptSubmit hook that extracts a structured intent
// from the user's prompt and writes it as type='intent' ActionRecord.
//
// Default OFF. Opt in via env TROTH_CAPTURE_INTENT=1.
//
// Runs BEFORE injector.mjs in the UserPromptSubmit chain so that this
// hook's recordAction (with chain_role:'root') becomes the parent of
// injector's downstream decision write — and of every PreToolUse /
// PostToolUse hook in the same turn. That's what lets us auto-create
// produces_edit / satisfies edges from intent → edit later in
// post-action-recall.mjs.
//
// Critically: this hook never emits additionalContext. The intent is
// captured silently. Surfacing happens via the runtime's working-set
// manifest on subsequent turns. Pushing intent text into the prompt
// would re-create the MemGPT-style bloat P13 just eliminated.

import { createRequire } from 'node:module';
import { readStdinJson, allow, recordAction, log, featureEnabled } from './_lib.mjs';

if (!featureEnabled('capture_intent')) { allow(); }

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const extractor = require(pluginRoot + '/../shared-core/intent-extract.js');

const payload = await readStdinJson();
const cwd     = payload.cwd || process.cwd();
const prompt  = payload.user_prompt || payload.prompt || '';
const session = payload.session_id || null;

if (!prompt.trim() || prompt.startsWith('/')) { allow(); }

const result = extractor.extractIntent(prompt);

// Confidence threshold — below this we don't write. The number is the
// research-cited 80% precision target translated to a per-record gate:
// at confidence 0.6 the precision on the smoke fixture is comfortably
// above 80%; at <0.6 the records get noisy.
const MIN_CONFIDENCE = parseFloat(process.env.TROTH_INTENT_MIN_CONF || '0.6');

if (!result.ok || result.confidence < MIN_CONFIDENCE) {
  log('UserPromptSubmit.intent_capture', {
    session_id: session,
    decision: 'skipped',
    reason: result.reason || ('low_confidence_' + result.confidence.toFixed(2)),
    metadata: { confidence: result.confidence, reason: result.reason }
  });
  allow();
}

// Write the intent as the new turn root. injector.mjs runs after us and
// also writes chain_role:'root'; the LAST root-write in the same turn
// wins (since the chain file is overwritten). That's the desired
// behavior — injector's decision becomes the per-turn root for
// PreToolUse/PostToolUse correlation, while our intent record lives
// upstream of injector's root via parent_id wiring (we set chain_role
// here so OUR id becomes the immediate parent of injector's write
// before injector overwrites the root).
const id = recordAction({
  type: 'intent',
  session_id: session,
  cwd,
  chain_role: 'root',
  input: result.intent.input,
  output: result.intent.output,
  outcome: {
    time_to_action_ms: null,        // filled when first downstream action runs
    satisfied:         null,         // filled by satisfies edge in post-action-recall
    supersedes_intent_id: null
  }
});

log('UserPromptSubmit.intent_capture', {
  session_id: session,
  decision: 'captured',
  reason: 'confidence_' + result.confidence.toFixed(2),
  metadata: {
    intent_id:  id ? id.slice(0, 8) : null,
    confidence: result.confidence,
    has_constraint: !!(result.intent.input.constraint && result.intent.input.constraint.length),
    has_criteria:   !!result.intent.input.acceptance_criteria,
    has_alts:       !!(result.intent.output.alternatives_considered && result.intent.output.alternatives_considered.length),
    goal_preview:   result.intent.input.goal.slice(0, 80)
  }
});

// Pure capture — no additionalContext.
allow();
