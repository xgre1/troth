#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// PreCompact — the hook that turns the Virtual Agent Runtime (Layer 5)
// from theory into practice.
//
// Claude Code fires PreCompact when context pressure triggers the native
// compact-YYYYMMDD summarizer. Without intervention, that summarizer
// LOSSILY compresses the whole transcript: pinned state, active plans,
// in-flight decisions — all flattened to a paragraph, specifics dropped.
//
// This hook inverts that flow. It calls runtime.onBeforeCompact() which:
//   1. Keeps pinned pages + MRU within 70% of the working-set budget.
//   2. Evicts the rest as type='compact' ActionRecords (logged, not
//      summarized — content stays queryable in the substrate).
//   3. Emits an additionalContext block describing the retained
//      manifest so the model sees pointer+summary lines instead of
//      a lossy paragraph.
//
// Research: Pichay arxiv 2603.09023 (demand paging for LLM context)
// proved 93% context reduction in live production by distinguishing
// evicted-still-queryable from lost-forever. This is our implementation
// of that pattern at the agent level.
//
// See the substrate design notes Layer 5 and
// the substrate design notes.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readStdinJson, allow, log } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let state; // fail-open: bare marketplace clone has no node_modules
try { state = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let runtime; // fail-open: bare marketplace clone has no node_modules
try { runtime = require(pluginRoot + '/../shared-core/runtime.js'); } catch (_) { console.log('{}'); process.exit(0); }
let ws; // fail-open: bare marketplace clone has no node_modules
try { ws = require(pluginRoot + '/../shared-core/working-set.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let mindState; // fail-open: bare marketplace clone has no node_modules
try { mindState = require(pluginRoot + '/../shared-core/mind-state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let dialogue; // fail-open: bare marketplace clone has no node_modules
try { dialogue = require(pluginRoot + '/../shared-core/dialogue-memory.js'); } catch (_) { console.log('{}'); process.exit(0); }
let resolveAgentId; // fail-open: bare marketplace clone has no node_modules
try { ({ resolveAgentId } = require(pluginRoot + '/../shared-core/agent-id.js')); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const session_id = payload.session_id || null;
const cwd        = payload.cwd || process.cwd();

// PreCompact is fired per Claude Code event. If there's no session id
// we let the native compactor run unaltered — we only intervene when
// we have a substrate session to protect.
if (!session_id) { allow(); }

// Ensure the session exists in working-set state (it may not have been
// explicitly opened if the plugin was loaded mid-session). Open lazily
// so the first compact after install still benefits.
if (!ws.getSession(session_id)) {
  ws.openSession(state, { session_id, agent_id: 'claude-code', cwd });
}

// Run the before-compact lifecycle. This records a type='compact'
// ActionRecord, preserves pinned pages, and reports kept/dropped counts.
let result;
try {
  result = runtime.onBeforeCompact(state, session_id, {
    budget_tokens: payload.budget_tokens
  });
} catch (e) {
  log('PreCompact.error', { session_id, reason: 'runtime_threw', metadata: { message: e.message } });
  // On error, fall through to the native compactor — we never block a
  // compact the agent needs to recover context. Better lossy than stuck.
  allow();
}

log('PreCompact.onBeforeCompact', {
  session_id,
  decision: 'swap_working_set',
  reason: 'substrate_managed',
  metadata: {
    kept:    (result && result.kept) || 0,
    dropped: (result && result.dropped) || 0
  }
});

// mind layer — persist a refreshed mind-state snapshot before
// compaction so the post-compact agent boots with up-to-date world-state.
// MUST run BEFORE addContext below: addContext() emits + exits the
// process, so any work after it is never reached. View computation is
// minimal in v0.1: latest snapshot + most-recent intent record drives
// current_intent. Failures are non-fatal — we never block compaction.
try {
  // Mind state is unified per cwd — no agent_id filter on read so
  // CLI-bootstrapped snapshots are visible to recompute.
  const view = mindState.recomputeFromSubstrate(state, { cwd });
  if (view && view.mind_state) {
    const built = mindState.buildSnapshotRecord({
      id: require('crypto').randomUUID(),
      timestamp: Date.now(),
      agent_id: 'claude-code',
      cwd,
      mind_state: view.mind_state,
      trigger: 'pre_compact',
      prev_snapshot_id: view.prev_snapshot_id
    });
    if (built.ok) {
      const validation = actionRec.validate(built.record);
      if (validation.ok) {
        const writtenId = state.recordAction(built.record, actionRec.toSearchText(built.record));
        log('PreCompact.mind.persist', {
          session_id,
          decision: writtenId ? 'persisted' : 'write_failed',
          metadata: { snapshot_id: writtenId, intents_seen: view.intents_seen, prev: view.prev_snapshot_id }
        });
      } else {
        log('PreCompact.mind.error', { session_id, reason: 'action_record_invalid', metadata: { errors: validation.errors } });
      }
    } else {
      log('PreCompact.mind.error', { session_id, reason: 'snapshot_build_failed', metadata: { errors: built.errors } });
    }
  }
} catch (e) {
  log('PreCompact.mind.error', { session_id, reason: 'mind_persist_threw', metadata: { message: String(e && e.message || e) } });
}

// Phase 0.5 — Compact handoff decision.
//
// PreCompact cannot use hookSpecificOutput.additionalContext (CC schema
// rejects hookEventName 'PreCompact' silently — the previous addContext
// call here was dead code since). The cross-compact bridge
// is the substrate: write a `decision` ActionRecord with kind
// 'compact_handoff'; SessionStart's auto-resume allowlist surfaces it
// to the post-compact agent on first turn, no schema dance needed.
//
// Captured signal:
//   last user/assistant exchange (so the new agent knows what was
//     just being discussed without re-asking)
//   uncommitted git changes per-repo (so the new agent doesn't
//     blow them away — this has cost real work before)
//   working-set kept/dropped counts + manifest text (queryable
//     pointer for the new agent to fault in if needed)
//
// All wrapped in try/catch — never block compaction on telemetry.
try {
  const manifestOut = runtime.buildManifest(session_id);
  const lines = [];
  let lastUser = '';
  let lastAssistant = '';

  // Last exchange via dialogue-mirror. Reads across the whole partner
  // brain (agent_id omitted, principal default 'partner') so the
  // pre-compact summary captures whichever surface produced the most
  // recent exchange — claude-code, cli, voice, anything.
  try {
    const turns = dialogue.recentTurns({ cwd, limit: 1, same_cwd: true });
    if (turns && turns.length) {
      lastUser      = String(turns[0].user_text      || '').slice(0, 240).replace(/\s+/g, ' ');
      lastAssistant = String(turns[0].assistant_text || '').slice(0, 280).replace(/\s+/g, ' ');
    }
  } catch (_) { /* dialogue empty / mirror disabled */ }

  // in-flight reasoning preservation.
  //
  // The plain last-exchange snapshot loses the multi-turn REASONING CHAIN:
  // open questions, hypotheses under test, "X vs Y" evaluations. Post-
  // compact, the partner sees the last exchange but not "we were halfway
  // through deciding A or B and Z was the next thing to verify."
  //
  // Substrate-native fix: scan the last 10 dialogue turns for explicit
  // open-question / hypothesis markers. Inline them in the handoff
  // summary so they surface via the existing pathway (compact_handoff
  // engram → session-start auto-resume + entity-prefix <compact_handoff>
  // block). No new scope, no new prefix surface. Reuses what's there.
  //
  // Patterns (high-precision, low recall — better to miss than to
  // surface trivia):
  //   - "should we X" / "do we X" / "can we X"
  //   - "X vs Y" / "X or Y" (explicit alternative framing)
  //   - "considering X" / "evaluating X" / "deciding between"
  //   - "open question:" / "the question is" / "unclear if"
  //   - "I'm not sure" / "not sure if" (operator-stated uncertainty)
  //   - "what about X" / "what if X"
  let openQuestions = [];
  try {
    const recentTurns = dialogue.recentTurns({ cwd, limit: 12, same_cwd: true }) || [];
    const PATTERNS = [
      /\b(?:should|do|can|could|would|might) (?:we|i|you)\b[^.!?\n]{6,140}\?/gi,
      /\b(?:considering|evaluating|deciding between|weighing)\b[^.!?\n]{6,120}/gi,
      /\bopen question:?\s+[^.!?\n]{6,120}/gi,
      /\b(?:the question is|unclear if|not sure (?:if|whether))\b[^.!?\n]{6,120}/gi,
      /\bwhat (?:about|if)\b[^.!?\n]{6,120}\??/gi,
      /\b[a-z][a-z0-9_-]{2,30}\s+(?:vs|or)\s+[a-z][a-z0-9_-]{2,30}\b/gi
    ];
    const seen = new Set();
    for (const turn of recentTurns) {
      for (const text of [turn.user_text, turn.assistant_text]) {
        if (!text || typeof text !== 'string') continue;
        for (const re of PATTERNS) {
          const matches = String(text).match(re);
          if (!matches) continue;
          for (const m of matches) {
            const clean = m.replace(/\s+/g, ' ').trim().slice(0, 140);
            const key = clean.toLowerCase();
            if (seen.has(key)) continue;
            if (clean.length < 8) continue;
            seen.add(key);
            openQuestions.push(clean);
            if (openQuestions.length >= 4) break;
          }
          if (openQuestions.length >= 4) break;
        }
        if (openQuestions.length >= 4) break;
      }
      if (openQuestions.length >= 4) break;
    }
  } catch (_) { /* extraction is best-effort; never block compaction */ }

  // Uncommitted-files snapshot. Bounded to top 20 so a noisy worktree
  // doesn't bloat the record. `git status --porcelain` is fast and
  // non-mutating; we only run it inside a git repo.
  let dirty = [];
  try {
    const out = execSync('git status --porcelain', {
      cwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (out) dirty = out.split('\n').slice(0, 20);
  } catch (_) { /* not a repo / git missing — skip */ }

  // WHERE the work sits: branch name and the last few commits.
  //
  // The dirty list says what has changed and never said what it changed
  // FROM. A post-compact agent that knows the files but not the branch has
  // to ask, and asking is the thing this record exists to prevent. Two more
  // cheap non-mutating reads, same guard as above.
  let branch = '', recentCommits = [];
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (_) { /* not a repo / detached / git missing */ }
  try {
    const out = execSync('git log --oneline -5', {
      cwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (out) recentCommits = out.split('\n').slice(0, 5);
  } catch (_) { /* no history yet */ }

  if (lastUser)      lines.push('Last user: ' + lastUser);
  if (lastAssistant) lines.push('Last assistant: ' + lastAssistant);
  if (branch)        lines.push('Branch: ' + branch + (recentCommits.length ? ' @ ' + recentCommits[0] : ''));
  if (dirty.length)  lines.push('Uncommitted (' + dirty.length + '): ' + dirty.slice(0, 6).join(' | '));
  // Phase I — in-flight reasoning: surface open questions / hypotheses
  // detected in the last ~12 turns. Capped at 4 items, each ≤140 chars,
  // so the total stays well under the 800-char summary budget. Inlined
  // here so existing surfacing pathways (session-start auto-resume +
  // entity-prefix <compact_handoff> block from Phase A) carry them
  // without any new mechanism.
  if (openQuestions.length) {
    lines.push('In-flight reasoning (' + openQuestions.length + '): ' + openQuestions.join(' | '));
  }
  const summary = lines.join(' || ').slice(0, 1200)
    || 'compact triggered, no recent dialogue or dirty files captured';

  const handoffRec = {
    id: require('crypto').randomUUID(),
    timestamp: Date.now(),
    type: 'decision',
    agent_id: 'claude-code',
    session_id,
    cwd,
    input: {
      kind: 'compact_handoff',
      trigger: payload.trigger || payload.reason || 'pre_compact',
      kept: (result && result.kept) || 0,
      dropped: (result && result.dropped) || 0
    },
    output: {
      decision: 'handoff_recorded',
      summary,
      last_user: lastUser,
      last_assistant: lastAssistant,
      uncommitted: dirty,
      branch,
      recent_commits: recentCommits,
      manifest_excerpt: (manifestOut && manifestOut.text)
        ? String(manifestOut.text).slice(0, 1200)
        : ''
    }
  };
  const v = actionRec.validate(handoffRec);
  if (v.ok) {
    state.recordAction(handoffRec, actionRec.toSearchText(handoffRec));
    log('PreCompact.handoff.persist', {
      session_id,
      decision: 'persisted',
      metadata: { handoff_id: handoffRec.id, dirty_count: dirty.length, has_dialogue: !!(lastUser || lastAssistant) }
    });
    // B4 — two-row pattern. Per W3C PROV-O (Activity vs Entity)
    // + Fowler event-sourcing: the decision row above records WHAT HAPPENED
    // (the compaction event, the audit trail). It does NOT participate in
    // future-self recall — type='decision' isn't queried by engram retrieval.
    // The handoff MEMO — what the partner is leaving for its post-compact
    // self — must be a recall-addressable engram. We write it via
    // recordEngram with scope='handoff:<session_id>' so the engram.js
    // audience derivation auto-fires (audience='substrate_internal',
    // memory_class='operational'). Post-compact session-start can FTS
    // over scope LIKE 'handoff:%' to surface it.
    try {
      const engram = require('../../shared-core/engram.js');
      const today = new Date().toISOString().slice(0, 10);
      engram.recordEngram({
        agent_id:   'claude-code',
        user_id:    'default',
        cwd,
        statement:  summary,
        source:     'pre-compact-hook',
        scope:      'handoff:' + today + ':' + (session_id || 'no-session'),
        salience:   1.5,
        parent_id:  handoffRec.id,
        // Bulk handoff — skip auto_verify pool comparison (these are
        // operator-deliberate continuity notes, not factual claims).
        auto_verify: false
      });
    } catch (e) {
      log('PreCompact.handoff.engram_error', {
        session_id,
        reason: 'engram_write_failed',
        metadata: { message: String(e && e.message || e) }
      });
    }
  } else {
    log('PreCompact.handoff.error', { session_id, reason: 'invalid_record', metadata: { errors: v.errors } });
  }
} catch (e) {
  log('PreCompact.handoff.error', {
    session_id,
    reason: 'handoff_threw',
    metadata: { message: String(e && e.message || e) }
  });
}

// Native compactor still runs. Pinned pages safe in substrate; the
// handoff decision will surface in the next session's auto-resume.
allow();
