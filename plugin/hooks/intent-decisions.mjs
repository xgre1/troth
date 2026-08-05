#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Mind layer — intent-stream decision capture (v2).
//
// Stop hook. After a turn ends, scans the recent intent records for
// supersession events (one intent contradicts an earlier one) and
// durability-confirmation events (an old intent that wasn't superseded
// and produced follow-up activity). Writes mind_decision events.
//
// Default OFF. Opt in via env TROTH_INTENT_DECISIONS=1.
//
// Why Stop and not UserPromptSubmit:
//   - Intents need time to settle. A confirmation only makes sense once
//     the user has moved past the intent (next turn or later).
//   - Stop runs once per turn, after the agent has done its work — the
//     natural moment to evaluate "was this intent confirmed by action?"
//   - Reduces redundant scans (UserPromptSubmit fires per prompt; Stop
//     fires per turn boundary).

import { createRequire } from 'node:module';
import { readStdinJson, allow, recordAction, log, featureEnabled } from './_lib.mjs';

if (!featureEnabled('intent_decisions')) { allow(); }

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let stateModule; // fail-open: bare marketplace clone has no node_modules
try { stateModule = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let intentDec; // fail-open: bare marketplace clone has no node_modules
try { intentDec = require(pluginRoot + '/../shared-core/intent-decisions.js'); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const cwd     = payload.cwd || process.cwd();
const session = payload.session_id || null;

// Tunables (env-overridable for experimentation without code changes).
const WINDOW_MS    = parseInt(process.env.TROTH_INTENT_DEC_WINDOW_MS    || '1800000', 10); // 30m
const PROMOTE_MS   = parseInt(process.env.TROTH_INTENT_DEC_PROMOTE_MS   || '900000',  10); // 15m
// 0.10 default: intent-extract aggressively trims goals (strips verbs +
// stopwords) so post-extract token overlap runs much lower than raw
// prompt overlap. Combined with marker presence, 0.10 is enough signal.
const OVERLAP_MIN  = parseFloat(process.env.TROTH_INTENT_DEC_OVERLAP   || '0.10');

// Pull recent intents for this cwd (within window + promote tail).
// We need promote_age extra so confirmations have something to evaluate.
const since = Date.now() - Math.max(WINDOW_MS, PROMOTE_MS) * 4;
const intentRows = stateModule.queryActions({
  type: 'intent', cwd, since, limit: 200, order: 'asc'
}) || [];
const intents = intentRows.map(r => actionRec.fromRow(r)).filter(Boolean);

// Project resolution from latest snapshot. Same logic as v1 hook.
let projects = [];
let projectId = null;
try {
  const snaps = stateModule.queryActions({
    type: 'mind_snapshot', cwd, limit: 1, order: 'desc'
  }) || [];
  if (snaps.length > 0) {
    const rec = actionRec.fromRow(snaps[0]);
    const ms = rec && rec.output && rec.output.mind_state;
    if (ms && Array.isArray(ms.active_projects)) {
      projects = ms.active_projects.map(p => ({ id: p.id, name: p.name || p.id }));
      if (projects.length === 1) projectId = projects[0].id;
    }
  }
} catch (e) {
  log('Stop.intent_decisions.snap_error', {
    session_id: session, metadata: { message: String(e && e.message || e) }
  });
}

// Dedup against intent ids that have already been promoted in this cwd.
// The detector accepts a Set of captured ids so it skips them.
const captured = new Set();
try {
  const recentDecisions = stateModule.queryActions({
    type: 'decision', cwd, kind: 'mind_decision',
    since: Date.now() - 24 * 60 * 60 * 1000,
    limit: 500, order: 'desc'
  }) || [];
  for (const r of recentDecisions) {
    const rec = actionRec.fromRow(r);
    const sourceIid = rec && rec.input && rec.input.signals && rec.input.signals.source_intent_id;
    if (sourceIid) captured.add(sourceIid);
  }
} catch { /* dedup is best-effort */ }

const candidates = intentDec.detectFromIntents(intents, {
  window_ms: WINDOW_MS,
  promote_after_ms: PROMOTE_MS,
  overlap_threshold: OVERLAP_MIN,
  captured_intent_ids: captured
});

if (candidates.length === 0) {
  log('Stop.intent_decisions', {
    session_id: session, decision: 'no_candidates',
    reason: 'no_match',
    metadata: { intents_seen: intents.length }
  });
  allow();
}

let written = 0, skipped = 0;
for (const c of candidates) {
  // Resolve project. Single-project shortcut covers most live setups; if
  // multiple projects, attempt name-vote against the intent goal text.
  let pid = projectId;
  if (!pid && projects.length > 1) {
    const goal = (c.summary || '').toLowerCase();
    let best = null, bestN = 0;
    for (const p of projects) {
      const needle = String(p.name || p.id).toLowerCase();
      if (needle.length < 3) continue;
      let n = 0, idx = 0;
      while ((idx = goal.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
      if (n > bestN) { best = p; bestN = n; }
    }
    pid = best ? best.id : null;
  }
  if (!pid) { skipped++; continue; }

  const id = recordAction({
    type: 'decision',
    session_id: session,
    cwd,
    input: {
      kind: 'mind_decision',
      signals: {
        project_id: pid,
        summary: c.summary,
        rationale: c.rationale || '',
        source_intent_id: c.intent_id,
        capture_tier: c.kind, // 'super_chosen' | 'super_rejected' | 'confirm'
        supersedes: c.supersedes && c.supersedes.length ? c.supersedes : undefined
      }
    },
    output: {
      decision: 'recorded',
      reason: 'intent_stream_' + c.kind
    }
  });
  if (id) written++; else skipped++;
}

log('Stop.intent_decisions', {
  session_id: session, decision: 'captured',
  reason: 'intent_stream',
  metadata: {
    intents_seen: intents.length,
    candidates: candidates.length,
    written, skipped,
    window_ms: WINDOW_MS, promote_ms: PROMOTE_MS, overlap_min: OVERLAP_MIN
  }
});

allow();
