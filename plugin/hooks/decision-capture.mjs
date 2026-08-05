#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Mind layer — Q-DECISION-PATTERNS heuristic capture.
//
// UserPromptSubmit hook. Runs the decision-patterns detector against the
// current user prompt + the prior assistant turn (read from the session
// transcript when available). When a decision is detected, writes a
// `mind_decision` ActionRecord so the next recompute folds it into the
// active project's key_decisions.
//
// Default OFF. Opt in via env TROTH_DECISION_CAPTURE=1.
//
// This closes the long-deferred Q-DECISION-PATTERNS gap: without it,
// every decision required manual `troth mind decision` invocation —
// friction that left mind state empty in real-world use.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readStdinJson, allow, recordAction, log, featureEnabled } from './_lib.mjs';

// Default OFF (changed  after measured 0/7 capture rate on
// real Claude Code prompts — chat-style "P1: lock X" / "ok do it"
// language doesn't appear in normal coding workflow). Keep available
// behind explicit opt-in for users with deliberation-heavy workflows
// (spec writing, design docs). The v2 intent-stream detector
// (intent-decisions.mjs) is the workhorse capture path.
if (!featureEnabled('decision_capture')) { allow(); }

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let stateModule; // fail-open: bare marketplace clone has no node_modules
try { stateModule = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let detector; // fail-open: bare marketplace clone has no node_modules
try { detector = require(pluginRoot + '/../shared-core/decision-patterns.js'); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const cwd     = payload.cwd || process.cwd();
const prompt  = payload.user_prompt || payload.prompt || '';
const session = payload.session_id || null;
const transcriptPath = payload.transcript_path || null;

if (!prompt.trim() || prompt.startsWith('/')) { allow(); }

// Pull active projects from the latest mind_snapshot for project resolution.
let projects = [];
try {
  const snaps = stateModule.queryActions({
    type: 'mind_snapshot', cwd, limit: 1, order: 'desc'
  }) || [];
  if (snaps.length > 0) {
    const rec = actionRec.fromRow(snaps[0]);
    const ms = rec && rec.output && rec.output.mind_state;
    if (ms && Array.isArray(ms.active_projects)) {
      projects = ms.active_projects.map(p => ({ id: p.id, name: p.name || p.id }));
    }
  }
} catch (e) {
  log('UserPromptSubmit.decision_capture.snap_error', {
    session_id: session, metadata: { message: String(e && e.message || e) }
  });
}

// Read the prior assistant turn from the transcript when Claude Code
// passes one. We only need the LAST assistant message — bounded read of
// the last ~32KB is plenty for a single turn.
let priorAssistant = '';
if (transcriptPath) {
  try {
    const buf = readFileSync(transcriptPath, 'utf8');
    const tail = buf.length > 32768 ? buf.slice(-32768) : buf;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim();
      if (!ln) continue;
      let d;
      try { d = JSON.parse(ln); } catch { continue; }
      if (d.type !== 'assistant') continue;
      const msg = d.message || d;
      const c = msg && msg.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        text = c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
      }
      if (text && text.trim()) { priorAssistant = text; break; }
    }
  } catch (e) {
    log('UserPromptSubmit.decision_capture.transcript_error', {
      session_id: session, metadata: { message: String(e && e.message || e) }
    });
  }
}

// Dedup against recent mind_decisions in this cwd (last 50, last 24h).
// Keeps the substrate from accumulating duplicates when the user repeats
// a commit phrase across turns.
const recentSummaries = new Set();
try {
  const recentRows = stateModule.queryActions({
    type: 'decision', cwd, kind: 'mind_decision',
    since: Date.now() - 24 * 60 * 60 * 1000,
    limit: 50, order: 'desc'
  }) || [];
  for (const r of recentRows) {
    const rec = actionRec.fromRow(r);
    const sum = rec && rec.input && rec.input.signals && rec.input.signals.summary;
    if (sum) recentSummaries.add(String(sum).toLowerCase().replace(/\s+/g, ' ').slice(0, 100));
  }
} catch { /* dedup is best-effort */ }

const detected = detector.detectDecision({
  prompt,
  prior_assistant: priorAssistant,
  projects,
  recent_summaries: recentSummaries
});

if (!detected) {
  log('UserPromptSubmit.decision_capture', {
    session_id: session, decision: 'no_match',
    reason: 'no_pattern',
    metadata: { prompt_preview: prompt.slice(0, 80) }
  });
  allow();
}

if (!detected.project_id) {
  log('UserPromptSubmit.decision_capture', {
    session_id: session, decision: 'skipped_no_project',
    reason: detected.kind,
    metadata: {
      summary_preview: detected.summary.slice(0, 80),
      projects_seen: projects.length
    }
  });
  allow();
}

const id = recordAction({
  type: 'decision',
  session_id: session,
  cwd,
  input: {
    kind: 'mind_decision',
    signals: {
      project_id: detected.project_id,
      summary: detected.summary,
      rationale: detected.rationale || ('(auto-captured ' + detected.kind + ' tier, conf=' + detected.confidence.toFixed(2) + ')')
    }
  },
  output: {
    decision: 'recorded',
    reason: 'decision_capture_heuristic',
    confidence: detected.confidence
  }
});

log('UserPromptSubmit.decision_capture', {
  session_id: session, decision: 'captured',
  reason: detected.kind,
  metadata: {
    record_id: id ? id.slice(0, 8) : null,
    project_id: detected.project_id,
    summary_preview: detected.summary.slice(0, 80),
    confidence: detected.confidence
  }
});

allow();
