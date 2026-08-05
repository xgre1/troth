#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Mind layer — DMN-style proactive cross-project surfacing.
//
// On UserPromptSubmit, scan the latest mind_snapshot for projects OTHER
// than the one matched by the current prompt, looking for decisions /
// open_questions whose tokens overlap with the current message. When
// found, push a short addContext snippet so the agent has cross-project
// awareness without explicitly querying.
//
// Default OFF. Opt in via env TROTH_DMN_PUSH=1.
//
// Rate limited: at most 1 DMN push per N consecutive turns (default 3)
// to avoid noise. State tracked via the substrate itself — we read the
// last `mind_dmn_push` decision record for this cwd and skip if it's
// recent enough.
//
// Pure capture pattern: writes a `decision` ActionRecord with
// kind=mind_dmn_push for auditability, then addContexts the snippet.

import { createRequire } from 'node:module';
import { readStdinJson, allow, addContext, log, featureEnabled } from './_lib.mjs';

if (!featureEnabled('dmn_push')) { allow(); }

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let stateModule; // fail-open: bare marketplace clone has no node_modules
try { stateModule = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let mindState; // fail-open: bare marketplace clone has no node_modules
try { mindState = require(pluginRoot + '/../shared-core/mind-state.js'); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const cwd     = payload.cwd || process.cwd();
const prompt  = payload.user_prompt || payload.prompt || '';
const session = payload.session_id || null;

if (!prompt.trim() || prompt.startsWith('/')) { allow(); }

// Rate-limit: skip if a DMN push fired recently in this cwd.
const RATE_LIMIT_MS = parseInt(process.env.TROTH_DMN_PUSH_RATELIMIT_MS || '60000', 10);
try {
  const recentDecisions = stateModule.queryActions({
    type: 'decision',
    cwd,
    since: Date.now() - RATE_LIMIT_MS,
    limit: 20,
    order: 'desc'
  }) || [];
  for (const row of recentDecisions) {
    const rec = actionRec.fromRow(row);
    if (rec && rec.input && rec.input.kind === 'mind_dmn_push') {
      log('UserPromptSubmit.dmn_push', {
        session_id: session,
        decision: 'rate_limited',
        reason: 'recent_push_within_window',
        metadata: { window_ms: RATE_LIMIT_MS, last: rec.id ? rec.id.slice(0, 8) : null }
      });
      allow();
    }
  }
} catch (e) {
  log('UserPromptSubmit.dmn_push.error', { session_id: session, reason: 'ratelimit_check_threw',
    metadata: { message: String(e && e.message || e) } });
}

// Load latest mind_snapshot.
const snapRows = stateModule.queryActions({
  type: 'mind_snapshot',
  cwd,
  limit: 1,
  order: 'desc'
}) || [];
if (snapRows.length === 0) { allow(); }

const snapRec = actionRec.fromRow(snapRows[0]);
const ms = snapRec && snapRec.output && snapRec.output.mind_state;
if (!ms) { allow(); }

// Determine the current task's project (the "self" in DMN terms — to
// exclude from cross-project scan).
const taskSig = mindState.deriveTaskSignature(prompt, ms);
const currentProjectId = (taskSig && taskSig.project_id) || null;

// Find cross-project relevance.
const hits = mindState.findCrossProjectRelevance({
  mind_state: ms,
  current_project_id: currentProjectId,
  message: prompt
});
if (!hits || hits.length === 0) {
  log('UserPromptSubmit.dmn_push', {
    session_id: session,
    decision: 'no_hits',
    reason: 'no_cross_project_overlap'
  });
  allow();
}

// Format snippet.
const snippet = mindState.formatCrossProjectRelevance(hits);
if (!snippet) { allow(); }

// Write a record for auditability + rate limiting.
try {
  const rec = {
    id: require('crypto').randomUUID(),
    timestamp: Date.now(),
    type: 'decision',
    agent_id: 'claude-code',
    cwd,
    input: {
      kind: 'mind_dmn_push',
      signals: {
        current_project_id: currentProjectId,
        hit_project_ids: hits.map((h) => h.project_id),
        prompt_preview: prompt.slice(0, 80)
      }
    },
    output: {
      decision: 'pushed',
      reason: 'cross_project_relevance',
      confidence: Number((hits[0].max_overlap / 10).toFixed(2)) // rough proxy
    },
    verification: {},
    outcome: {}
  };
  const v = actionRec.validate(rec);
  if (v.ok) {
    stateModule.recordAction(rec, actionRec.toSearchText(rec));
    log('UserPromptSubmit.dmn_push', {
      session_id: session,
      decision: 'pushed',
      reason: 'cross_project_overlap',
      metadata: {
        record_id: rec.id.slice(0, 8),
        hit_projects: hits.map((h) => h.project_id),
        max_overlap: hits[0].max_overlap
      }
    });
  }
} catch (e) {
  log('UserPromptSubmit.dmn_push.error', { session_id: session, reason: 'audit_write_threw',
    metadata: { message: String(e && e.message || e) } });
}

// addContext exits — must be the LAST hook action.
addContext(snippet);
