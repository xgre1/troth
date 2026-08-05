#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SessionStart — stamps session boot in telemetry AND surfaces the
// troth-specific tools the model should prefer. Fired once per session
// so we don't burn tokens on the same hint every turn.
//
// Mind addition: also load latest mind-state snapshot for this cwd and
// inject a brief orientation summary so the post-compact / fresh agent
// knows the world state without re-explanation.

import { createRequire } from 'node:module';
import { readStdinJson, emit, log } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let state; // fail-open: bare marketplace clone has no node_modules
try { state = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let mindState; // fail-open: bare marketplace clone has no node_modules
try { mindState = require(pluginRoot + '/../shared-core/mind-state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let resolveAgentId; // fail-open: bare marketplace clone has no node_modules
try { ({ resolveAgentId } = require(pluginRoot + '/../shared-core/agent-id.js')); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
log('SessionStart', {
  session_id: payload.session_id,
  metadata: { reason: payload.reason }
});

// Steer the model toward the troth-cache MCP tools. Without this, it
// defaults to the built-in Read/Grep on every call and the cache — while
// still populating via hooks — never hard-serves anything, so the
// token-saving never lands. One short note at session start is cheap
// context relative to the savings when re-retrievals hit.
const tip =
  '[troth/cache] Two cached retrieval tools are available in this session:\n' +
  '  • cached_read(file_path) — equivalent to Read, serves from cache when the file hash matches disk. 0 backend tokens on hit.\n' +
  '  • cached_grep(pattern, path?, glob?) — equivalent to Grep, memoized per (pattern+path+glob).\n' +
  'Prefer these over the built-in Read / Grep when you may re-retrieve the same content across turns or across sessions. First-time calls fall through to real execution and populate the cache automatically; you never lose correctness, only gain speed on repeats.';

// Mind mind orientation — load latest mind_snapshot for this cwd, format
// as a short orientation block. Failure-tolerant: if substrate is empty
// or the load throws, we just skip injection and the existing cache tip
// goes out alone.
let orientation = '';
try {
  const cwd = payload.cwd || process.cwd();
  const rows = state.queryActions({
    type: 'mind_snapshot',
    cwd,
    limit: 1,
    order: 'desc'
  }) || [];
  if (rows.length > 0) {
    const rec = actionRec.fromRow(rows[0]);
    const ms = rec && rec.output && rec.output.mind_state;
    if (ms) {
      orientation = mindState.formatOrientation(ms);
      // Mind fix: write a mind_retrieval event so salience
      // scoring sees the usage signal. Without this every load_orientation
      // through the hook path was invisible to the salience math, so
      // recency was the only term that ever moved.
      try {
        const projectIds = (Array.isArray(ms.active_projects) ? ms.active_projects : [])
          .map((p) => p && p.id).filter(Boolean);
        if (projectIds.length > 0) {
          const ev = mindState.buildRetrievalEventRecord({
            id: require('crypto').randomUUID(),
            timestamp: Date.now(),
            agent_id: 'session-start',
            cwd,
            snapshot_id: rec.id,
            project_ids: projectIds
          });
          if (ev) state.recordAction(ev, actionRec.toSearchText(ev));
        }
      } catch (e2) {
        log('SessionStart.mind.retrieval_error', {
          reason: 'retrieval_write_threw',
          metadata: { message: String(e2 && e2.message || e2) }
        });
      }
    }
  }
} catch (e) {
  log('SessionStart.mind.error', { reason: 'mind_load_threw', metadata: { message: String(e && e.message || e) } });
}

// Auto-resume block — when compaction triggered this SessionStart
// (payload.reason === 'compact'), surface the substrate's view of
// "what we were just doing" so the new agent picks up without needing
// the user to say "check this". Sources:
//   1. Last 5 substrate decision records (last 2h) — current focus,
//      open questions, recent flagged issues
//   2. Last 3 unresolved items: pending revisions, anchor suggestions,
//      drift alerts. The new agent sees them and surfaces to the user.
//   3. Most recent assistant turn excerpt (truncated) — what we were
//      just talking about
let autoResume = '';
try {
  const reason = payload.reason || '';
  // Always include for compact + resume; skip on cold startup unless
  // there's something genuinely fresh.
  const wantResume = reason === 'compact' || reason === 'resume';
  if (wantResume) {
    const cwdNow = payload.cwd || process.cwd();
    const sinceTs = Date.now() - 2 * 60 * 60 * 1000;   // last 2h
    const lines = [];

    // 1. Recent decision records (drift, revisions, anchor suggestions).
    // was `stateModule.queryActions` — undefined symbol;
    // the import at line 15 is `state`, not `stateModule`. The try/catch
    // swallowed the ReferenceError so the auto-resume block silently
    // never fired post-compact. Now using the correct binding.
    const recentDecisions = state.queryActions({
      type: 'decision', cwd: cwdNow, limit: 20, order: 'desc'
    }) || [];
    const flagged = [];
    for (const row of recentDecisions) {
      if (row.timestamp < sinceTs) continue;
      let inp; try { inp = JSON.parse(row.input); } catch (_) { continue; }
      let out; try { out = JSON.parse(row.output); } catch (_) { continue; }
      const kind = inp && inp.kind;
      if (['degradation_alert', 'revision_proposed', 'anchor_suggested', 'insight_surfaced', 'mind_decision', 'compact_handoff'].includes(kind)) {
        flagged.push({ kind, summary: out && (out.summary || out.reason || out.proposed_anchor || out.proposed_statement) });
      }
    }
    if (flagged.length) {
      lines.push('Substrate observed since the last compact:');
      for (const f of flagged.slice(0, 5)) {
        lines.push('  • [' + f.kind + '] ' + (f.summary || '').slice(0, 140));
      }
    }

    // 2. Last assistant exchange — terse "what we were saying"
    try {
      const dialogue = require(pluginRoot + '/../shared-core/dialogue-memory.js');
      // Voice agent has no workspace scope of its own — its job is to
      // recall what the user did across surfaces (terminal sessions in
      // any cwd, prior voice turns). Terminal sessions stay
      // workspace-scoped (cwd filter) so the orientation block is
      // relevant to the cwd the user just launched claude in. Watcher
      // writes turns with cwd=NULL, so terminal cwd filter naturally
      // excludes the global watcher pool — that's fine for terminal.
      const turnsCwd = (process.env.TROTH_VOICE_MODE === '1') ? null : cwdNow;
      const turnsLimit = (process.env.TROTH_VOICE_MODE === '1') ? 6 : 3;
      // Substrate-as-mind: read across the whole partner brain on
      // session start — every surface (cli/voice/proxy mirror) wrote
      // into the same brain, so the resume block must surface the
      // most recent exchange regardless of which surface produced it.
      // agent_id intentionally omitted → principal default ('partner').
      // same_cwd: the injected continuity window is per-PROJECT. Without
      // it, two parallel sessions on different repos cross-bled their
      // threads. Explicit recall tools
      // remain global.
      const turns = dialogue.recentTurns({ cwd: turnsCwd, limit: turnsLimit, same_cwd: true });
      if (turns && turns.length) {
        const last = turns[turns.length - 1];
        lines.push('');
        lines.push('Most recent exchange (' + new Date(last.ts).toLocaleString() + '):');
        if (last.user_text)      lines.push('  user: ' + String(last.user_text).slice(0, 200).replace(/\n+/g, ' '));
        if (last.assistant_text) lines.push('  assistant: ' + String(last.assistant_text).slice(0, 240).replace(/\n+/g, ' '));
      }
    } catch (_) {}

    if (lines.length) {
      autoResume =
        '[troth/auto-resume] Recovering work from before ' + reason + '.\n' +
        lines.join('\n') +
        '\n\nContinue from here. Use troth_query_actions or troth_search_actions if you need more detail.';
    }
  }
} catch (e) {
  log('SessionStart.auto_resume.error', { reason: 'auto_resume_threw', metadata: { message: String(e && e.message || e) } });
}

// the mind layer — drift detection (Property #6) + spontaneous deliberation
// (Property #3). Opt-in: cfg.deliberator_enabled = true. Runs ONE tick per
// session-start (cheap) so the new agent sees its own drift signals from
// recent activity in the orientation block. Long-running interval ticks
// are deferred to a separate daemon path; per-session feels right for
// solo-dev workflow.
let driftBlock = '';
try {
  const cfgMod    = require(pluginRoot + '/../shared-core/transport-config.js');
  const enabled   = !!cfgMod.get('deliberator_enabled');
  if (enabled) {
    const cwdNow = payload.cwd || process.cwd();
    const { Deliberator } = require(pluginRoot + '/../shared-core/deliberator.js');
    const engram = require(pluginRoot + '/../shared-core/engram.js');

    // Tick once. agent_id 'troth-deliberator' so writes are scoped + the
    // engram isolation guard accepts them.
    new Deliberator({
      agent_id: 'troth-deliberator',
      cwd:      cwdNow,
      user_id:  process.env.USER || 'default'
    }).tick({ enabled: true });

    // Surface recent drift signals (last 24h) so the agent sees them
    // before its first response. Cap at 3 — orientation block must stay
    // under ~2KB.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const driftRows = engram.listEngrams({
      agent_id: 'troth-deliberator',
      cwd:      cwdNow,
      scope:    'system:drift',
      limit:    10,
      order:    'desc'
    }) || [];
    const recent = driftRows.filter((r) => (r.ts || 0) >= since).slice(0, 3);
    if (recent.length) {
      const lines = ['[troth/drift] Self-detected drift in recent activity:'];
      for (const r of recent) {
        const stmt = String(r.statement || '').slice(0, 220).replace(/\n+/g, ' ');
        if (stmt) lines.push('  • ' + stmt);
      }
      lines.push('  (Reflect on these before continuing — ' +
                 'tunnel-vision / sycophancy / repetition flags fire when the ' +
                 'window crosses a threshold; not every tick means broken work.)');
      driftBlock = lines.join('\n');
    }
  }
} catch (e) {
  log('SessionStart.drift.error', {
    reason: 'drift_block_threw',
    metadata: { message: String(e && e.message || e) }
  });
}

// PSW — Daily background-worker tick at session start.
//
// shared-core/background-worker.js exports startWorker (long-running
// daemon, used by bin/troth-entity.js) AND runDueTasks (one-shot,
// cadence-debounced via substrate decision records). Pre-fix: the
// daily tasks (identity_extract, procedure_compile, engram_gc,
// anchor_suggest, dormant_review, orchestration_review) only ran
// when the user had the standalone troth-entity daemon up — which the
// typical Claude Code workflow does not. Result: the Phase F identity
// pool stayed empty, Phase C compiled procedures never accumulated.
//
// Post-fix: every Claude Code session boot fires runDueTasks. The
// substrate's own debounce (background_task_run decision records,
// per-cwd, 14-day lookback) ensures each daily task fires at most
// once per 24h regardless of how many sessions the user starts. Tasks
// with cadence < 12h (drift_scan/state_summary) are skipped here —
// those want a real daemon, not a single hook fire.
//
// Bounded:
//   - per-cycle wall budget (5s default from background-worker)
//   - min_cadence_ms = 12h (only daily/weekly tasks)
//   - cwd-scoped (matches session)
//   - TROTH_BG_TICK_DISABLE=1 short-circuits for debug / opt-out
//   - never breaks the hook — failures swallowed
// Voice mode bypass: the voice app's spawned `claude` CLI subprocess is
// purely a conversational responder and should not block its boot on
// background substrate maintenance. With this gate, the voice agent's
// SessionStart returns fast (~10s of ms instead of seconds), unblocking
// the first voice turn. Terminal claude sessions still run the bg tick
// same as before — so daily maintenance keeps firing on real work
// surfaces. Identified  as the cause of voice silent-freeze.
let bgTickResult = null;
if (process.env.TROTH_BG_TICK_DISABLE !== '1' && process.env.TROTH_VOICE_MODE !== '1') {
  try {
    const bg = require(pluginRoot + '/../shared-core/background-worker.js');
    const ar = require(pluginRoot + '/../shared-core/action-record.js');
    const cwdNow = payload.cwd || process.cwd();
    const userId = process.env.USER || 'default';
    const agentId = resolveAgentId();

    // Submit shim — wraps event into an ActionRecord and persists.
    // Background-worker tasks emit { type, input, output }; we fill
    // the substrate-required fields and route through state.recordAction.
    function submit(ev) {
      if (!ev || !ev.type) return;
      const rec = {
        id: ar.uuidv7(),
        timestamp: Date.now(),
        type: ev.type,
        agent_id: agentId,
        cwd: cwdNow,
        user_id: userId,
        input: ev.input || {},
        output: ev.output || {}
      };
      const v = ar.validate(rec);
      if (!v.ok) return;
      state.recordAction(rec, ar.toSearchText(rec));
    }

    bgTickResult = await bg.runDueTasks({
      submit,
      getView: () => ({
        mind: { active_projects: [] },
        substrate_ctx: { agent_id: agentId, user_id: userId, cwd: cwdNow }
      }),
      // taskProcedureCompile sources tool_call patterns from the agent
      // that owns Edit/Bash/Read calls — in Claude Code's PostToolUse
      // wiring that's `claude-code`, not the operator agent_id (which
      // only owns dialogue.turn). Without this override the detector
      // scans an empty pool and never accumulates compiled_procedure
      // records. Identified by substrate-resolved-fraction bench.
      agent_id_overrides: { procedure_compile: 'claude-code' }
    });
  } catch (e) {
    log('SessionStart.bg_tick.error', {
      reason: 'bg_tick_threw',
      metadata: { message: String(e && e.message || e) }
    });
  }
}

// Voice-mode proactive-greeting directive. The voice subprocess sets
// TROTH_VOICE_MODE=1 (set by the desktop app). Without this
// directive the LLM reads the orientation/drift blocks above but treats a
// generic user opener ("γεια", "ξεκινάω") as a request for a generic
// response — substrate orientation lands silently in context, never reaches
// TTS, voice user feels no continuity. The directive tells the LLM to LEAD
// with whatever was substrate-noticed, so the first audible turn carries
// the partner-feel that the substrate has been doing the work for.
//
// Bounded: only fires for voice (env-gated). Terminal sessions still get
// orientation/drift in context but no proactive-greeting nudge — terminal
// users see the additionalContext panel and can act on it manually.
let voiceGreeting = '';
if (process.env.TROTH_VOICE_MODE === '1') {
  const haveSomething = !!(orientation || driftBlock || autoResume);
  if (haveSomething) {
    voiceGreeting =
      '[troth/voice] You are responding via voice (TTS). The user just opened ' +
      'the conversation. Your context above includes substrate orientation, ' +
      'drift signals, and recent state. LEAD your first response with ' +
      'something substrate-noticed — a connection, a drift signal worth ' +
      'flagging, or a quick "I was thinking about X" if relevant. Keep it ' +
      'short (1-2 sentences) and natural for speech. Do NOT wait for the ' +
      'user to ask about substrate state. If nothing in context warrants ' +
      'leading with it, a brief acknowledgment is fine — but check first.';
  }
}

// Substrate-first directive. The operator repeatedly hit agents
// that grepped CLAUDE.md / memory/*.md / the project FOLDER instead of querying
// the substrate (their persistent memory), and reported "not found" while the
// substrate held the answer — the user shouldn't have to say "search the
// substrate" every time. The UserPromptSubmit injector now auto-injects
// [troth/recall] hits each turn; this one-time directive tells the model to
// TRUST that and never substitute file/folder search for substrate recall.
const substrateFirst =
  '[troth/substrate-first] This project has a troth SUBSTRATE — your persistent memory across sessions. ' +
  'For ANY "do you remember / what did we say / what did we decide about X" question, the substrate is GROUND TRUTH. ' +
  'Its recall is auto-injected each turn as a [troth/recall] block — trust it. ' +
  'If you need more, call the recall tools (troth_recall / troth_multi_axis_query / troth_dialogue_recent) ' +
  'BEFORE grepping CLAUDE.md, memory/*.md, or the project folder. ' +
  'Never substitute file/folder search for substrate recall, and never answer "I don\'t have that / we never discussed it" without checking the substrate first.';

const parts = [];
parts.push(substrateFirst);
if (orientation)  parts.push(orientation);
if (driftBlock)   parts.push(driftBlock);
if (autoResume)   parts.push(autoResume);
if (voiceGreeting) parts.push(voiceGreeting);
parts.push(tip);

emit({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: parts.join('\n\n')
  }
});
