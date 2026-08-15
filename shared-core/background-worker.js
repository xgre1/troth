// SPDX-License-Identifier: AGPL-3.0-only
// Background Worker — C6 of Substrate-as-Entity v0.1.
//
// Runs inside the cognitive runtime daemon. While the entity is idle,
// this worker performs the deliberate-without-language work that gives
// the entity its "always thinking" property: contradiction detection,
// dormant commitment review, mind snapshot consolidation. None of these
// require an LLM — they are deterministic substrate operations.
//
// Designed to be cheap. Each task runs at a configurable cadence; the
// worker yields between tasks so the cognitive loop's foreground
// responsiveness is unaffected. Hard cap on per-cycle wall time means
// a slow task can never block the runtime.
//
// Tasks are pure functions: (substrateView) → { events: [], notes: [] }.
// Events emitted go through the runtime's event submission path so they
// land in L1 like any other action.

const DEFAULT_IDLE_THRESHOLD_MS = 60 * 1000;       // act after 1 min idle
const DEFAULT_TICK_MS           = 30 * 1000;       // re-check every 30 s
const DEFAULT_PER_CYCLE_BUDGET  = 5 * 1000;        // 5 s wall budget

// ── Built-in deliberation tasks ─────────────────────────────────────────

const taskContradictionScan = {
  name: 'contradiction_scan',
  cadence_ms: 5 * 60 * 1000,        // every 5 minutes when idle
  run: function (view) {
    // Looks for active commitments whose statements directly negate one
    // another. Naive textual heuristic — substrate flags candidates,
    // human resolves. Works without an LLM.
    const commitments = collectActiveCommitments(view.mind);
    const conflicts = [];
    for (let i = 0; i < commitments.length; i++) {
      for (let j = i + 1; j < commitments.length; j++) {
        if (likelyContradicts(commitments[i], commitments[j])) {
          conflicts.push({ a: commitments[i].id, b: commitments[j].id });
        }
      }
    }
    if (conflicts.length === 0) return { events: [], notes: ['no contradictions detected'] };
    return {
      events: conflicts.map((pair) => ({
        type: 'tool_call',
        input: {
          tool_name: 'background_worker.contradiction_flagged',
          args: pair
        },
        output: { status: 'flagged' }
      })),
      notes: ['flagged ' + conflicts.length + ' contradiction candidate(s)']
    };
  }
};

const taskDormantReview = {
  name: 'dormant_commitment_review',
  cadence_ms: 24 * 60 * 60 * 1000,  // daily
  run: function (view) {
    const commitments = collectActiveCommitments(view.mind);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    const dormant = commitments.filter((c) => {
      const lastTouched = c.last_touched_at || c.created_at || 0;
      return typeof lastTouched === 'number' && lastTouched < cutoff;
    });
    if (!dormant.length) return { events: [], notes: ['no dormant commitments'] };
    return {
      events: [{
        type: 'tool_call',
        input: {
          tool_name: 'background_worker.dormant_surfaced',
          args: { ids: dormant.map((c) => c.id) }
        },
        output: { status: 'surfaced' }
      }],
      notes: ['surfaced ' + dormant.length + ' dormant commitment(s) for review']
    };
  }
};

// Periodic substrate-health heartbeat. Counts engrams, scopes, recent
// dialogue turns, and emits a "state" event the host can render. Uses
// notify_always:true so the notification surface fires even when no
// L1 events were produced (signal-of-life value, not just findings).
const taskStateSummary = {
  name: 'state_summary',
  cadence_ms: 5 * 60 * 1000,        // every 5 minutes when idle
  run: function (view) {
    let engram_count = 0;
    let dialogue_count = 0;
    const scopes = new Map();
    try {
      const engram = require('./engram.js');
      const chameleon = require('./chameleon.js');
      const dialogueMemory = require('./dialogue-memory.js');
      const ctx = (view && view.substrate_ctx) || {};
      if (ctx.agent_id) {
        const all = engram.listEngrams({ agent_id: ctx.agent_id, cwd: ctx.cwd, limit: 1000 });
        engram_count = all.length;
        for (const sc of chameleon.listScopes({ agent_id: ctx.agent_id, cwd: ctx.cwd })) {
          scopes.set(sc.scope, sc.count);
        }
        const turns = dialogueMemory.recentTurns({ agent_id: ctx.agent_id, cwd: ctx.cwd, limit: 50 });
        dialogue_count = turns.length;
      }
    } catch (_) { /* best-effort substrate read */ }
    return {
      events: [{
        type: 'tool_call',
        input:  { tool_name: 'background_worker.state_summary', args: { engrams: engram_count, dialogue_turns: dialogue_count, scopes: Array.from(scopes.entries()) } },
        output: { status: 'recorded' }
      }],
      notes: ['engrams=' + engram_count + ' dialogue=' + dialogue_count + ' scopes=' + scopes.size],
      notify_always: true
    };
  }
};

// G3 — idle drift scan. Pulls recent assistant replies from
// dialogue-memory, scores each against active identity directions, and
// records a `degradation_alert` (type='decision', input.kind='degradation_alert')
// per drifting reply. The scan is async (embedding calls), so it runs
// inside the worker's per-cycle wall budget — drift alerts arrive
// within one tick of the offending reply.
//
// Cadence is intentionally aggressive (every 60s when idle) so a
// degraded reply surfaces before the user's next turn arrives. Only
// scans replies the worker hasn't seen yet (cursor by reply id stored
// in lastRun.dialogue_cursor, which the runtime tracks below).
const taskDriftScan = {
  name: 'drift_scan',
  cadence_ms: 60 * 1000,         // every 1 min when idle
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    if (!ctx.agent_id) return { events: [], notes: ['drift_scan: no agent_id in view'] };
    let dialogue, drift, commitments;
    try {
      dialogue    = require('./dialogue-memory.js');
      drift       = require('./drift-detector.js');
    } catch (_) { return { events: [], notes: ['drift_scan: required module missing'] }; }
    // Source the active commitment set from view.mind (same projection
    // surface ruleHonorRefusal + ruleStructuralDisagreement use). Without
    // commitments, drift detection has no reference frame.
    commitments = [];
    if (view && view.mind && Array.isArray(view.mind.active_projects)) {
      for (const p of view.mind.active_projects) {
        if (!p || !Array.isArray(p.constraints)) continue;
        for (const c of p.constraints) {
          if (c && (c.commitment_type === 'anchor' || c.commitment_type === 'refusal')) {
            commitments.push(c);
          }
        }
      }
    }
    if (!commitments.length) return { events: [], notes: ['drift_scan: no anchor/refusal commitments yet'] };
    const turns = dialogue.recentTurns({ agent_id: ctx.agent_id, cwd: ctx.cwd, limit: 20 });
    if (!turns || !turns.length) return { events: [], notes: ['drift_scan: no recent dialogue'] };
    // Process the most recent N un-scanned assistant replies. We track
    // already-scanned IDs in module-private state so the same reply
    // doesn't get re-scored every tick.
    const events = [];
    let scanned = 0, drifts = 0;
    for (const t of turns) {
      const replyId = t.id || (t.timestamp + ':' + (t.assistant_text || '').length);
      if (taskDriftScan._seen.has(replyId)) continue;
      taskDriftScan._seen.add(replyId);
      scanned++;
      try {
        const verdict = await drift.scoreReply(t.assistant_text || '', { commitments });
        if (verdict.degraded) {
          drifts++;
          const alertId = drift.recordDriftAlert({
            agent_id: ctx.agent_id, cwd: ctx.cwd, user_id: ctx.user_id,
            parent_id: t.id || null,
            reply_text: t.assistant_text,
            anchor_violations: verdict.anchor_violations,
            refusal_violations: verdict.refusal_violations
          });
          events.push({
            type: 'tool_call',
            input:  { tool_name: 'background_worker.drift_alert', args: { alert_id: alertId, reply_id: t.id } },
            output: { status: 'recorded' }
          });
        }
      } catch (_) { /* embedding host down etc — best-effort */ }
    }
    // Cap _seen so a long-running daemon doesn't accumulate IDs forever.
    if (taskDriftScan._seen.size > 5000) {
      const arr = Array.from(taskDriftScan._seen);
      taskDriftScan._seen = new Set(arr.slice(-2000));
    }
    return {
      events,
      notes: ['drift_scan: scanned=' + scanned + ' drifts=' + drifts],
      notify_always: scanned > 0
    };
  }
};
taskDriftScan._seen = new Set();

// G8 — engram garbage collection. Runs once per day per agent: applies
// salience decay, tombstones below-threshold engrams, consolidates
// near-duplicates, caps total count. Without this, the engram corpus
// grows unbounded and stale entries flood the [troth/identity]
// injection slot. Conservative defaults — `min_salience: 0.15`,
// `max_count: 5000`, soft tombstone (no hard DELETE).
const taskEngramGc = {
  name: 'engram_gc',
  cadence_ms: 24 * 60 * 60 * 1000,   // daily
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    if (!ctx.agent_id) return { events: [], notes: ['engram_gc: no agent_id in view'] };
    let gc;
    try { gc = require('./engram-gc.js'); }
    catch (_) { return { events: [], notes: ['engram_gc: module missing'] }; }
    try {
      const r = await gc.gcAgent({
        agent_id: ctx.agent_id,
        cwd:      ctx.cwd,
        user_id:  ctx.user_id || 'default',
        dry_run:  false,
        hard_delete: false,
        verbose:  false
      });
      const events = (r.evicted_count > 0 || r.consolidated_count > 0) ? [{
        type: 'tool_call',
        input:  { tool_name: 'background_worker.engram_gc',
                  args: { evicted: r.evicted_count, consolidated: r.consolidated_count, surviving: r.surviving_count } },
        output: { status: 'completed' }
      }] : [];
      return {
        events,
        notes: ['engram_gc: starting=' + r.starting_count +
                ' decayed=' + r.decayed_count +
                ' evicted=' + r.evicted_count +
                ' consolidated=' + r.consolidated_count +
                ' surviving=' + r.surviving_count],
        notify_always: false
      };
    } catch (e) {
      return { events: [], notes: ['engram_gc threw: ' + (e && e.message || e)] };
    }
  }
};

// Tier 1 / Item A — pattern detector. Scans recent drift alerts +
// rejected revisions, suggests new anchor commitments when patterns
// emerge. Substrate observes its own struggles and asks operator
// "should we tighten this position into an explicit anchor?".
// Daily cadence — cheap (no embeddings, just SQL grouping).
const taskAnchorSuggest = {
  name: 'anchor_suggest',
  cadence_ms: 24 * 60 * 60 * 1000,   // daily
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    if (!ctx.agent_id) return { events: [], notes: ['anchor_suggest: no agent_id in view'] };
    let mod;
    try { mod = require('./anchor-suggester.js'); }
    catch (_) { return { events: [], notes: ['anchor_suggest: module missing'] }; }
    try {
      const suggestions = mod.scanForSuggestions({ agent_id: ctx.agent_id });
      let written = 0;
      const events = [];
      for (const s of suggestions) {
        const id = mod.recordSuggestion({ agent_id: ctx.agent_id, cwd: ctx.cwd, user_id: ctx.user_id, suggestion: s });
        if (id) {
          written++;
          events.push({
            type: 'tool_call',
            input: { tool_name: 'background_worker.anchor_suggested',
                     args: { suggestion_id: id, heuristic: s.heuristic, occurrences: s.occurrences } },
            output: { status: 'recorded' }
          });
        }
      }
      return {
        events,
        notes: ['anchor_suggest: scanned + wrote ' + written + ' suggestion(s)'],
        notify_always: written > 0
      };
    } catch (e) {
      return { events: [], notes: ['anchor_suggest threw: ' + (e && e.message || e)] };
    }
  }
};

// Phase F — populate the identity engram pool from observed dialogue.
// Pre-fix: agent_id='identity' had zero records and no writer (verified
//). Property #4 of the core design note ("memory as identity,
// always present") could not fire from a dedicated identity surface.
// This task scans recent dialogue.turn corpus, extracts conservative
// candidate identity facts (self-stated preferences, explicit identity
// statements, project context, recurring tool mentions), filters to
// facts repeated across ≥2 distinct day-buckets (Trace2Skill threshold),
// and writes survivors as engrams under agent_id='identity'.
//
// Conservative by design: high-precision regex patterns, low-recall.
// Per Agent 4 audit: no LIWC personality inference, no
// stylometric trait projection, no demographic stereotypes, no single-
// mention claims. Better to emit nothing than emit noise.
//
// Daily cadence — extraction is read-heavy (last 200 turns) but cheap
// in CPU and emits at most a handful of writes per run.
const taskIdentityExtract = {
  name: 'identity_extract',
  // autonomous step — DISABLED.
  // The regex auto-write path is retired (see identity-extract.js
  // seedFromDialogue comment). Cadence bumped from 24h to a no-op so
  // the daily wakeup logs the deprecation instead of doing work. Will
  // be deleted entirely once reflection-tick backfill ships
  // and we've verified no scheduler still hardcodes this task name.
  cadence_ms: 24 * 60 * 60 * 1000,
  run: async function (_view) {
    return {
      events: [],
      notes: ['identity_extract: DEPRECATED — regex auto-write retired by L4 integration point; use update_identity tool (llm_inferred) or wait for Phase 3 reflection-tick backfill']
    };
  }
};

// The procedure-compile and schema-delta tasks lived here. Measured before
// retirement: four months of daily runs produced 348 distinct "procedures"
// of which five were test fixtures repeated 239 times each and the rest
// trivial two-step shapes; the schema-delta pass never emitted a single
// row. Learning that nothing reads is load, not memory.

// PLR graduation phase 2 — periodic reviewer that converts
// reconsolidation_candidate observations (emitted by the Stop hook
// reconsolidation-watch.mjs) into actual reconsolidate() supersede
// writes when consensus passes a high-confidence gate.
//
// Why background, not inline in the hook: the original Brain-as-
// the substrate design work calls for "autonomous overwrite within 10
// minutes" — a periodic task at this cadence meets the time window
// while keeping the safety property the hook chose: enough evidence
// must accumulate before any superseding write lands. Single-turn
// Jaccard signal is too noisy; consensus across multiple turns is the
// gate. Without a corrected new_statement (the hook only detects
// contradiction, not the truth), we write the superseder at
// tier='flagged' so the injector skips both prior and superseder —
// the substrate forgets the wrong fact without claiming a new one.
const taskReconsolidationReview = {
  name: 'reconsolidation_review',
  cadence_ms: 6 * 60 * 60 * 1000,   // 6 hours — within the paper's 10-min window in spirit, but cheaper
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    let lr;
    try { lr = require('./lability-reconsolidation.js'); }
    catch (_) { return { events: [], notes: ['plr_review: module missing'] }; }
    const stateMod = require('./state.js');
    const ar = require('./action-record.js');
    const lookbackMs = 24 * 60 * 60 * 1000;   // 24h of candidates
    const since = Date.now() - lookbackMs;

    let candidates = [];
    try {
      candidates = stateMod.queryActions({
        type: 'decision', cwd: ctx.cwd || null, since, limit: 500, order: 'desc'
      }) || [];
    } catch (e) {
      return { events: [], notes: ['plr_review: queryActions threw: ' + (e && e.message || e)] };
    }

    // Group candidates by targeted engram_id; track distinct turns +
    // contradiction kinds per group. excerpts holds prior-statement
    // slices (what the substrate believed); contradicting_excerpts holds
    // assistant-turn slices (what disagreed with the prior). Both feed
    // the Phase 3 corrected-fact extractor below.
    const groups = new Map();
    for (const row of candidates) {
      let inp; try { inp = (typeof row.input === 'string') ? JSON.parse(row.input) : row.input; } catch (_) { continue; }
      if (!inp || inp.kind !== 'reconsolidation_candidate') continue;
      const sig = inp.signals || {};
      const eid = sig.engram_id;
      if (!eid) continue;
      let g = groups.get(eid);
      if (!g) { g = { eid, votes: 0, distinct_ts: new Set(), kinds: new Set(), excerpts: [], contradicting_excerpts: [] }; groups.set(eid, g); }
      g.votes++;
      g.distinct_ts.add(Math.floor((row.timestamp || 0) / 60000));   // minute-bucket
      if (sig.contradiction_kind) g.kinds.add(sig.contradiction_kind);
      let outp; try { outp = (typeof row.output === 'string') ? JSON.parse(row.output) : row.output; } catch (_) { outp = null; }
      if (outp && outp.prior_statement_excerpt) g.excerpts.push(outp.prior_statement_excerpt);
      if (outp && outp.contradicting_text_excerpt) g.contradicting_excerpts.push(outp.contradicting_text_excerpt);
    }

    // Consensus gate: two-tier — polarity_flip gets the original
    // 3-vote / 2-turn threshold (strong contradiction signal);
    // topic_mismatch needs 6 votes / 3 turns (noisier signal,
    // requires stronger consensus).: prior gate required
    // polarity_flip exclusively which left lifetime.supersedes=0 in
    // production despite legitimate topic-drift contradictions
    // accumulating. Two-tier gate keeps safety (topic_mismatch alone
    // never triggers from a single noise spike) while operationalizing
    // the reconsolidation chain mechanism.
    const MIN_VOTES_POLARITY  = 3;
    const MIN_TURNS_POLARITY  = 2;
    const MIN_VOTES_TOPIC     = 6;
    const MIN_TURNS_TOPIC     = 3;
    const executed = [];
    const skipped = [];
    for (const g of groups.values()) {
      const isPolarity = g.kinds.has('polarity_flip');
      const minVotes = isPolarity ? MIN_VOTES_POLARITY : MIN_VOTES_TOPIC;
      const minTurns = isPolarity ? MIN_TURNS_POLARITY : MIN_TURNS_TOPIC;
      if (g.votes < minVotes || g.distinct_ts.size < minTurns) {
        skipped.push({
          eid: g.eid, votes: g.votes, turns: g.distinct_ts.size,
          reason: isPolarity ? 'polarity_consensus_below_threshold' : 'topic_consensus_below_threshold'
        });
        continue;
      }
      // Skip engrams that are themselves already part of a supersession
      // chain (don't reconsolidate a reconsolidation).
      let prior; try { prior = stateMod.getAction && stateMod.getAction(g.eid); } catch (_) { prior = null; }
      if (!prior) { skipped.push({ eid: g.eid, reason: 'prior_not_found' }); continue; }
      let priorOut; try { priorOut = (typeof prior.output === 'string') ? JSON.parse(prior.output) : prior.output; } catch (_) { priorOut = null; }
      if (!priorOut) { skipped.push({ eid: g.eid, reason: 'prior_output_unparseable' }); continue; }
      if (priorOut.tier === 'flagged') { skipped.push({ eid: g.eid, reason: 'already_flagged' }); continue; }
      if (priorOut.lifetime && priorOut.lifetime.supersedes) { skipped.push({ eid: g.eid, reason: 'already_in_chain' }); continue; }

      // Phase 3 corrected-fact path (opt-in via TROTH_PLR_PHASE3=1
      // until production-validated). When enabled AND a driver is
      // configured AND the evidence is rich enough, ask an LLM to
      // extract the corrected fact from the contradicting excerpts.
      // On any failure → fall through to the safe phase-1 flagged
      // template below, preserving "retire-the-prior, don't claim a
      // new fact" semantics.
      const phase3Enabled = process.env.TROTH_PLR_PHASE3 === '1';
      const driver = phase3Enabled
        ? (typeof lr.makeReconsolidationDriverFromEnv === 'function'
            ? lr.makeReconsolidationDriverFromEnv()
            : null)
        : null;
      let priorStmt = (typeof prior.output === 'string')
        ? (function () { try { return (JSON.parse(prior.output) || {}).statement || ''; } catch (_) { return ''; } })()
        : (prior.output && prior.output.statement) || '';
      let correctedStatement = null;
      let extractMode = 'flag_only';
      if (driver && priorStmt && g.contradicting_excerpts && g.contradicting_excerpts.length) {
        try {
          const r = await lr.extractCorrectedStatement({
            prior_statement: priorStmt,
            contradicting_excerpts: g.contradicting_excerpts,
            driver
          });
          if (r && r.ok && r.corrected_statement) {
            correctedStatement = r.corrected_statement;
            extractMode = 'phase3_corrected';
          } else {
            extractMode = 'flag_only_extract_failed:' + (r && r.reason || 'unknown');
          }
        } catch (_) {
          extractMode = 'flag_only_extract_threw';
        }
      }

      // Build the supersede statement: phase-3 corrected fact when
      // available, else phase-1 flagged template (paper-aligned overwrite,
      // safety-aligned non-claim).
      const stamp = new Date().toISOString().slice(0, 10);
      const newStatement = correctedStatement
        ? correctedStatement
        : ('[reconsolidated ' + stamp + '] prior contradicted by '
            + g.votes + ' action(s) across ' + g.distinct_ts.size + ' distinct turn(s); '
            + 'no corrected fact provided by the contradiction signal — flagged so the injector stops surfacing the prior.');

      let resultId;
      try {
        resultId = lr.reconsolidate({
          state: stateMod, prior_engram: prior, new_statement: newStatement,
          // Flag-only path: the successor is a META-LINE ("[reconsolidated …]
          // prior contradicted by N actions"), NOT a fact — it exists only to
          // carry the supersedes pointer. It MUST be tier='flagged' so recall
          // and the identity envelope skip it (both exclude flagged); at the
          // default 'working' it leaked as a recallable "identity fact" (audit
          // bug #8). The phase-3 corrected fact IS the new canonical statement,
          // so it stays 'working' and surfaces normally.
          tier: correctedStatement ? 'working' : 'flagged',
          agent_id: ctx.agent_id || prior.agent_id || null,
          cwd: ctx.cwd || prior.cwd || null,
          user_id: ctx.user_id || prior.user_id || 'default',
          reason: correctedStatement
            ? 'consensus_contradiction_review:phase3_corrected'
            : 'consensus_contradiction_review'
        });
      } catch (e) { resultId = null; }
      if (!resultId) { skipped.push({ eid: g.eid, reason: 'reconsolidate_returned_null' }); continue; }

      executed.push({
        eid: g.eid, new_id: resultId,
        votes: g.votes, turns: g.distinct_ts.size,
        mode: extractMode,
        corrected: !!correctedStatement
      });
    }

    const events = [];
    let phase3Hits = 0;
    for (const e of executed) {
      if (e.corrected) phase3Hits++;
      events.push({
        type: 'tool_call',
        input: {
          tool_name: 'background_worker.reconsolidation_executed',
          args: {
            engram_id: e.eid, new_id: e.new_id,
            votes: e.votes, distinct_turns: e.turns,
            mode: e.mode, corrected: !!e.corrected
          }
        },
        output: { status: 'completed' }
      });
    }
    return {
      events,
      notes: ['plr_review: candidates=' + candidates.length +
              ' groups=' + groups.size +
              ' executed=' + executed.length +
              ' phase3=' + phase3Hits +
              ' skipped=' + skipped.length],
      notify_always: executed.length > 0
    };
  }
};


// G11 — substrate backup automation. Weekly export of L1 state via
// substrate-backup.exportArchive. Keeps last 4 bundles in
// ~/.troth/backups/, prunes older. Zero-cost ACID snapshot — SQLite
// online backup is safe while substrate keeps writing.
const taskBackup = {
  name: 'substrate_backup',
  cadence_ms: 7 * 24 * 60 * 60 * 1000,   // weekly
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    let backup, fs2, path2, os2;
    try {
      backup = require('./substrate-backup.js');
      fs2 = require('fs'); path2 = require('path'); os2 = require('os');
    } catch (_) { return { events: [], notes: ['backup: module missing'] }; }
    const dir = path2.join(process.env.HOME || os2.homedir(), '.troth', 'backups');
    // pid suffix: two workers racing the same lease window (login burst)
    // must never write the same bundle path — worst case is two backups,
    // never one corrupted by interleaved writers.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + process.pid;
    const bundle = path2.join(dir, 'substrate-' + stamp);
    try {
      const r = backup.exportArchive({ out_path: bundle });
      // Prune — keep last 4
      try {
        const all = fs2.readdirSync(dir)
          .filter(n => n.startsWith('substrate-'))
          .map(n => ({ n, ts: fs2.statSync(path2.join(dir, n)).mtimeMs }))
          .sort((a, b) => b.ts - a.ts);
        for (const old of all.slice(4)) {
          fs2.rmSync(path2.join(dir, old.n), { recursive: true, force: true });
        }
      } catch (_) {}
      return {
        events: [{
          type: 'tool_call',
          input:  { tool_name: 'background_worker.substrate_backup', args: { bundle } },
          output: { status: r.ok ? 'completed' : 'failed' }
        }],
        notes: ['backup: ' + (r.ok ? 'wrote bundle ' + bundle : 'failed: ' + (r.error || 'unknown'))],
        notify_always: true
      };
    } catch (e) {
      return { events: [], notes: ['backup threw: ' + (e && e.message || e)] };
    }
  }
};

// orchestration review — surveys recent market_run /
// market_winner / role_worker_spawned decisions, looks for patterns
// (e.g. "qwen wins on bug-fix tasks", "frontend role times out under
// claude-haiku"), and proposes role-registry tweaks. Cheap SQL group-by
// on action_records; no embeddings. Daily cadence.
const taskOrchestrationReview = {
  name: 'orchestration_review',
  cadence_ms: 24 * 60 * 60 * 1000,   // daily
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    let state;
    try { state = require('./state.js'); }
    catch (_) { return { events: [], notes: ['orchestration_review: state missing'] }; }
    try {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
      const wins = state.queryActions({
        type: 'decision', limit: 200, since,
        agent_id: 'race-supervisor'
      }) || [];
      const orches = state.queryActions({
        type: 'decision', limit: 200, since,
        agent_id: 'orchestrator'
      }) || [];
      const totalRuns  = wins.filter(r =>
        r && r.input && r.input.kind === 'market_run').length;
      const totalWins  = wins.filter(r =>
        r && r.input && r.input.kind === 'market_winner').length;
      const totalSpawns = orches.filter(r =>
        r && r.input && r.input.kind === 'role_worker_spawned').length;
      if (!totalRuns && !totalSpawns) {
        return { events: [], notes: ['orchestration_review: no race/orchestrate activity in 7d'] };
      }
      // Provider win-rate from market_winner records.
      const providerWins = {};
      for (const w of wins) {
        if (!w.input || w.input.kind !== 'market_winner') continue;
        const p = w.input.winner_provider;
        if (!p) continue;
        providerWins[p] = (providerWins[p] || 0) + 1;
      }
      return {
        events: [{
          type: 'tool_call',
          input:  { tool_name: 'background_worker.orchestration_review',
                    args: { runs: totalRuns, wins: totalWins, spawns: totalSpawns,
                            providerWins } },
          output: { status: 'completed' }
        }],
        notes: ['orchestration_review: 7d runs=' + totalRuns +
                ' wins=' + totalWins +
                ' role_spawns=' + totalSpawns +
                (Object.keys(providerWins).length ?
                  ' provider_wins=' + JSON.stringify(providerWins) : '')],
        notify_always: false
      };
    } catch (e) {
      return { events: [], notes: ['orchestration_review threw: ' + (e && e.message || e)] };
    }
  }
};

// graduate — DMN spontaneous activation.
// Scans recent action_records, finds disconnected pairs with high
// token similarity, persists hypothesis decision records. Daily
// cadence; cheap (Jaccard, no embeddings).
const taskHypothesisGeneration = {
  name: 'hypothesis_generation',
  cadence_ms: 24 * 60 * 60 * 1000,
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    if (!ctx.agent_id) return { events: [], notes: ['hypothesis_generation: no agent_id in view'] };
    let hg, state;
    try {
      hg = require('./hypothesis-generator.js');
      state = require('./state.js');
    } catch (_) { return { events: [], notes: ['hypothesis_generation: module missing'] }; }
    try {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
      const candidates = hg.findHypotheses({
        state, agent_id: ctx.agent_id, cwd: ctx.cwd,
        since, lookback: 100, threshold: 0.50
      });
      let written = 0;
      const events = [];
      for (const c of candidates) {
        const id = hg.recordHypothesis({
          state, candidate: c,
          agent_id: ctx.agent_id, cwd: ctx.cwd, user_id: ctx.user_id || 'default'
        });
        if (id) {
          written++;
          events.push({
            type: 'tool_call',
            input: { tool_name: 'background_worker.hypothesis_recorded',
                     args: { hypothesis_id: id, similarity: c.similarity, a_id: c.a_id, b_id: c.b_id } },
            output: { status: 'recorded' }
          });
        }
      }
      return {
        events,
        notes: ['hypothesis_generation: candidates=' + candidates.length + ' written=' + written],
        notify_always: written > 0
      };
    } catch (e) {
      return { events: [], notes: ['hypothesis_generation threw: ' + (e && e.message || e)] };
    }
  }
};

// taskPurposeRefresh.
// Refreshes a single 'system:current_focus' engram every 5 min idle.
// Reads (project_thesis + open goals + active commitments + recent
// decisions) and composes a short rule-templated summary: what we're
// working on, why per thesis, next step, what we avoid. Substrate-
// internal scope so it doesn't pollute model_visible recall directly;
// entity binary prefix provider mounts it explicitly via a
// <current_focus> block on every turn.
//
// Rule-templated (not LLM-generated) per substrate-as-mind discipline:
// the summary is deterministic concat of substrate-state fields, no
// faculty call. If you want richer prose, the LLM can re-read the raw
// engrams via troth_engram_search.
//
// Older current_focus engrams auto-superseded via existing PLR pattern
// (Step A's listEngrams filter hides them from default view).
const taskPurposeRefresh = {
  name: 'purpose_refresh',
  cadence_ms: 5 * 60 * 1000,   // 5 min idle
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    const cwd = ctx.cwd || process.cwd();
    let projectId;
    try {
      projectId = require('./project-id.js').resolveProjectId(cwd);
    } catch (_) { projectId = '__ephemeral__'; }
    if (projectId === '__ephemeral__') {
      return { events: [], notes: ['purpose_refresh: ephemeral cwd, skipped'] };
    }
    const engram = require('./engram.js');
    const state  = require('./state.js');
    const ar     = require('./action-record.js');
    // Read substrate state — all read-only.
    let thesisCount = 0, openGoals = [], recentDecisions = [];
    try {
      const allIdentity = engram.listEngrams({ audience: 'model_visible', limit: 50 }) || [];
      thesisCount = allIdentity.filter(e =>
        e && e.scope === 'project_thesis:' + projectId).length;
    } catch (_) {}
    try {
      const tg = require('./typed-goal.js');
      openGoals = (tg.listGoals({ status: 'open', limit: 3 }) || []).map(g => g.statement);
    } catch (_) {}
    try {
      const rows = state.queryActions({ type: 'decision', cwd, limit: 5, order: 'desc' }) || [];
      recentDecisions = rows.map(r => {
        let o; try { o = typeof r.input === 'string' ? JSON.parse(r.input) : r.input; } catch (_) { o = {}; }
        return (o && o.kind) ? o.kind : null;
      }).filter(Boolean);
    } catch (_) {}
    // Compose. Short, structured.
    const lines = [];
    lines.push('project: ' + projectId);
    if (thesisCount > 0) lines.push('thesis: loaded (' + thesisCount + ' anchor(s))');
    // Names the command that exists. `troth thesis set` was never a command in
    // any release — the orientation the partner reads at the top of a session
    // was instructing its operator to run something the product does not have.
    else lines.push('thesis: NONE for this project — operator can pin one with /goal <statement>');
    if (openGoals.length) {
      lines.push('open: ' + openGoals.slice(0, 3).map(g => String(g).slice(0, 100)).join(' | '));
    } else {
      lines.push('open: (no goals)');
    }
    if (recentDecisions.length) lines.push('recent: ' + recentDecisions.join(','));
    const summary = lines.join('\n');
    // Find any previous current_focus for this project to mark as superseded.
    let prevId = null;
    try {
      const prev = engram.listEngrams({ audience: 'substrate_internal', limit: 20, include_superseded: false }) || [];
      const match = prev.find(e => e && e.scope === 'system:current_focus:' + projectId);
      if (match) prevId = match.id;
    } catch (_) {}
    // Unchanged orientation = no write. Every refresh used to record a fresh
    // snapshot regardless, so a quiet project accumulated an identical row per
    // cycle and the Mind page read as a page of clones — five timestamps, one
    // sentence. The supersession chain only carries information when the text
    // changed.
    if (prevId) {
      try {
        const prevRow = engram.listEngrams({ audience: 'substrate_internal', limit: 20, include_superseded: false })
          .find(e => e && e.id === prevId);
        if (prevRow && String(prevRow.statement || '').trim() === summary.trim()) {
          return { events: [], notes: ['purpose_refresh: unchanged, not rewritten (project=' + projectId + ')'] };
        }
      } catch (_) {}
    }
    const id = engram.recordEngram({
      agent_id:    ctx.agent_id || 'background-worker',
      cwd, user_id: ctx.user_id || 'default',
      statement:   summary,
      scope:       'system:current_focus:' + projectId,
      source:      'background_worker.purpose_refresh',
      audience:    'substrate_internal',
      memory_class:'operational',
      parent_id:   prevId,
      // If a prior current_focus exists, this write supersedes it (Step A's
      // listEngrams filter will hide the older one from default reads).
      extra_output: prevId ? { lifetime: { supersedes: prevId, reason: 'periodic_refresh' } } : undefined,
      auto_verify: false
    });
    if (!id) return { events: [], notes: ['purpose_refresh: write failed'] };
    return {
      events: [],
      notes: ['purpose_refresh: project=' + projectId + ' thesis=' + thesisCount +
              ' openGoals=' + openGoals.length + ' recentDecisions=' + recentDecisions.length]
    };
  }
};

// taskWorkingMemoryConsolidation.
//
// Real cognition consolidates salient working-memory moments to long-term
// during attention spikes / sleep. The substrate's dialogue.turn rows are
// working memory; without consolidation, anything more than 3 turns back
// disappears from the prefix unless it happened to become a commitment.
//
// This task scans recent dialogue turns and auto-promotes high-emphasis
// moments (CAPS, intensifiers, repetition, profanity — same heuristic
// engram.detectEmphasis uses at write-time) to scope='consolidated:dialogue'
// engrams. Source authority = 'plr_evolved' (substrate-derived from
// operator's own words, not regex extraction; not direct operator action
// via update_identity tool either — sits between).
//
// Watermark: written as a substrate_internal engram with
// scope='system:wm_consolidation:watermark'. Read at task start to find
// last-processed timestamp; written at task end with the latest dialogue
// ts processed. Idempotent: re-running with the same watermark is a no-op.
const taskWorkingMemoryConsolidation = {
  name: 'wm_consolidation',
  cadence_ms: 10 * 60 * 1000,   // 10 min — slower than purpose_refresh,
                                // gives turns time to accumulate
  run: async function (view) {
    const ctx = (view && view.substrate_ctx) || {};
    const engram = require('./engram.js');
    const state  = require('./state.js');
    // Find watermark — last processed dialogue ts.
    let watermark = 0;
    try {
      const marks = engram.listEngrams({ audience: 'substrate_internal', limit: 10 }) || [];
      const lastMark = marks
        .filter(e => e && e.scope === 'system:wm_consolidation:watermark')
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
      if (lastMark && lastMark.statement) {
        const m = lastMark.statement.match(/processed_through:\s*(\d+)/);
        if (m) watermark = parseInt(m[1], 10) || 0;
      }
    } catch (_) {}
    // Fallback: if no watermark, look back 1 hour to avoid first-run
    // mass-promotion of weeks of dialogue.
    if (!watermark) watermark = Date.now() - 60 * 60 * 1000;
    // Pull dialogue.turn rows newer than watermark.
    let turns = [];
    try {
      const rows = state.queryActions({
        type: 'tool_call',
        limit: 200,
        order: 'desc'
      }) || [];
      turns = rows
        .filter(r => {
          if (!r || r.timestamp <= watermark) return false;
          let inp;
          try { inp = typeof r.input === 'string' ? JSON.parse(r.input) : r.input; }
          catch (_) { return false; }
          return inp && inp.tool_name === 'dialogue.turn';
        });
    } catch (_) { turns = []; }
    if (!turns.length) {
      return { events: [], notes: ['wm_consolidation: no new turns since ' + new Date(watermark).toISOString()] };
    }
    // Dedup guard. This loop previously had a comment
    // promising "skip if substantially-duplicate fragment was already
    // promoted" but NO code implementing it, and it writes with
    // auto_verify:false (engram.js:156) which disables engram-verify's
    // Jaccard dedup — so every tick re-promoted the SAME emphasized
    // fragment. Live DB showed one fragment promoted 12× (scope
    // consolidated:dialogue). Grounded in our ingested research
    // (AI-Memory-Consolidation-Implementation-Details.md §3.4: an identical
    // assertion is a storage NO-OP, not a new row). We dedup on the exact
    // promoted statement, seeded from BOTH the existing consolidated:dialogue
    // pool (catches prior-run copies — the watermark resets per run) AND
    // this batch. Exact-match (not embedding) is the right tool here: the
    // promoted statement is deterministically 'operator emphasized: '+fragment,
    // so identical user emphasis yields a byte-identical statement.
    const _seenPromoted = new Set();
    try {
      const existingPromoted = engram.listEngrams({
        scope: 'consolidated:dialogue', limit: 500
      }) || [];
      for (const e of existingPromoted) {
        const s = e && e.statement;
        if (s) _seenPromoted.add(String(s).trim());
      }
    } catch (_) { /* best-effort; empty set just means no prior-run dedup */ }

    // Score each turn's user_text on emphasis; promote if >= 0.3.
    let promoted = 0;
    let skippedDup = 0;
    let latestTs = watermark;
    for (const row of turns) {
      latestTs = Math.max(latestTs, row.timestamp);
      let inp;
      try { inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input; }
      catch (_) { continue; }
      const userText = (inp && inp.args && inp.args.user_text) || '';
      if (!userText || userText.length < 12) continue;
      const boost = engram.detectEmphasis(userText);
      if (boost < 0.3) continue;
      const fragment = String(userText).slice(0, 280).trim();
      const promotedStatement = 'operator emphasized: ' + fragment;
      // NO-OP if this exact emphasized statement is already promoted (prior
      // run or earlier in this batch). Prevents the duplicate-spam pile-up.
      if (_seenPromoted.has(promotedStatement)) { skippedDup++; continue; }
      _seenPromoted.add(promotedStatement);
      const wrote = engram.recordEngram({
        agent_id: ctx.agent_id || 'background-worker',
        cwd: row.cwd || ctx.cwd || null,
        user_id: row.user_id || ctx.user_id || 'default',
        statement: promotedStatement,
        scope: 'consolidated:dialogue',
        source: 'background_worker.wm_consolidation',
        source_authority: 'plr_evolved',
        // detectEmphasis runs again inside recordEngram — final salience
        // is 1.0 + boost. Caller's salience here would be additive; we
        // intentionally pass undefined so the write-time emphasis stamp
        // is the single source of truth.
        auto_verify: false
      });
      if (wrote) promoted++;
    }
    // Update watermark.
    try {
      engram.recordEngram({
        agent_id: ctx.agent_id || 'background-worker',
        statement: 'processed_through: ' + latestTs,
        //  renamed from 'system:wm_consolidation:watermark'.
        // The 'system:' prefix doesn't match engram.js:_isInternal (which
        // keys on 'internal:'), so the watermark was routed to
        // model_visible/episodic and leaked into /context as
        // "processed_through: <ms>" — pure bookkeeping noise the partner
        // surfaced as a memory. 'internal:' routes it to
        // substrate_internal/operational where it belongs.
        scope: 'internal:wm_watermark',
        source: 'background_worker.wm_consolidation',
        source_authority: 'plr_evolved',
        auto_verify: false,
        salience: 0.1
      });
    } catch (_) {}
    return {
      events: [],
      notes: ['wm_consolidation: scanned=' + turns.length + ' promoted=' + promoted + ' skipped_dup=' + skippedDup +
              ' watermark→' + new Date(latestTs).toISOString()]
    };
  }
};

// taskEmbeddingBackfill.
//
// Walks engrams missing embeddings (engram_embeddings JOIN miss),
// embeds in small batches, stores in the cache table. Background-only,
// fail-silent: if embedding_host is down or returns errors, the task
// records the issue in notes and exits without affecting any other
// substrate path. Cadence is conservative (15 min idle) because
// embedding calls have meaningful latency and we don't want to spam
// the host.
//
// Why a background task vs synchronous-at-write-time:
//   recordEngram is on the hot write path (every commitment, dialogue
//   turn, etc). Embedding in-process there would add ~11ms+ per write and
//   tie writes to model availability. Background backfill is the standard
//   substrate-as-mind pattern (taskDriftScan, taskEngramGc, etc).

// Clean per-class semantic text for a recallable record. Mirrors what each
// recall.recall class surfaces (commitment→statement, lesson→text, dialogue
// turn→user+assistant, procedure→name+triggers) so the vector matches what
// recall ranks on. Deliberately NOT toSearchText (that prepends type/agent_id/
// cwd metadata which would pollute the embedding).
function embedTextForRow(row) {
  let out = {}, inp = {};
  try { out = typeof row.output === 'string' ? JSON.parse(row.output) : (row.output || {}); } catch (_) {}
  try { inp = typeof row.input === 'string'  ? JSON.parse(row.input)  : (row.input  || {}); } catch (_) {}
  if (out && out.statement) return String(out.statement);          // commitment / identity / anchor
  if (out && out.text)      return String(out.text);               // lesson (semantic)
  if (inp && inp.tool_name === 'dialogue.turn') {                  // episodic turn
    const u = (inp.args && inp.args.user_text) || '';
    const a = (out && out.assistant_text) || '';
    const t = (u + ' ' + a).trim();
    if (t) return t;
  }
  if (out && out.name) {                                           // compiled_procedure
    const trig = Array.isArray(out.trigger_keywords) ? out.trigger_keywords.join(' ')
               : (out.trigger_keywords || '');
    return (out.name + ' ' + trig).trim();
  }
  return '';
}

// Per-process quarantine for rows the drain already tried and failed —
// whitespace-only text the SQL embeddable-predicate cannot see, an embed
// that returned null while its batch-mates succeeded, a setEmbedding
// refusal. Retried at most once per process lifetime (the Set dies with
// the process), so a deterministic bad row costs one attempt instead of
// wedging every idle cycle on the same stone.
const _embedQuarantine = new Set();

function collectEmbedWork(rows) {
  const work = []; let dropped = 0;
  for (const row of rows) {
    const text = embedTextForRow(row);
    if (!text) { _embedQuarantine.add(row.id); dropped++; continue; }
    work.push({ id: row.id, statement: text });
  }
  return { work: work, dropped: dropped };
}

const taskEmbeddingBackfill = {
  name: 'embedding_backfill',
  // Short cadence so it keeps draining the backlog across idle windows; once
  // the index is fully populated this is a single cheap "no missing" query.
  // The outer loop only runs tasks after idleThresholdMs of no foreground
  // activity, so this never competes with the operator.
  cadence_ms: 30 * 1000,
  run: async function (view) {
    const state    = require('./state.js');
    const embedder = require('./local-embedder.js');
    // Time-budgeted drain: embed in chunks until the backlog is empty OR this
    // run has spent ~10s, then yield. ~90 texts/sec on CPU (faster on Metal)
    // → a ~128K first-run index drains over a series of idle windows. The
    // embedder runs in-process (no host); first run blocks on the one-time
    // model download (background/idle — acceptable). Absent dependency →
    // embed returns null and we stop quietly (recall stays lexical).
    const RUN_BUDGET_MS = 10 * 1000;
    const CHUNK = 128;
    // The imported archive (docs:chats) drains AFTER the recall pool, at a
    // smaller cap: recall quality is the product promise, the archive is
    // depth. Bounded so the old cost fear (that justified excluding the
    // archive entirely) stays controlled — an import done before the embed
    // host was warm now heals over idle cycles instead of staying
    // keyword-only forever (field-hit 2026-08-09, a real user's ~1000-chunk
    // import held 39 vectors).
    const ARCHIVE_CHUNK = 64;
    const t0 = Date.now();
    let embedded = 0, failed = 0, scanned = 0, more = false;
    let quarantined = 0;
    while (Date.now() - t0 < RUN_BUDGET_MS) {
      // Scan the FULL recallable corpus (episodic/semantic/identity/procedural),
      // not just commitment-engrams — recall's pool is dominated by episodic +
      // semantic, which must have vectors or semantic rerank stays blind.
      // Pass MODEL_ID → also re-embeds rows from a PREVIOUS model (swap migration).
      let rows = state.listRecallableMissingEmbeddings(CHUNK, embedder.MODEL_ID)
        .filter(function (r) { return !_embedQuarantine.has(r.id); });
      let cap = CHUNK;
      let picked = collectEmbedWork(rows);
      if (!picked.work.length) {
        // The recall lane is drained OR holds only quarantined residue —
        // either way the archive lane gets its turn NOW. Before this
        // fall-through, residue at the head of the recall lane starved the
        // archive forever (the frozen "still embedding" dashboards, field
        // report 2026-08-09).
        rows = state.listArchiveMissingEmbeddings(ARCHIVE_CHUNK)
          .filter(function (r) { return !_embedQuarantine.has(r.id); });
        cap = ARCHIVE_CHUNK;
        picked = collectEmbedWork(rows);
      }
      scanned += rows.length;
      quarantined += picked.dropped;
      const work = picked.work;
      if (!work.length) { more = false; break; }
      more = rows.length === cap;
      // Documents are embedded raw (role:'document'); the query side adds the
      // Qwen3 Instruct/Query wrapper. wait:true — the backfill may load the model.
      const vecs = await embedder.embedBatch(work.map(w => w.statement), { role: 'document' });
      let anyOk = false;
      for (let i = 0; i < work.length; i++) {
        const vec = vecs[i];
        if (Array.isArray(vec) && vec.length) {
          anyOk = true;
          const ok = state.setEmbedding(work[i].id, vec, { model: embedder.MODEL_ID });
          if (ok) { embedded++; } else { failed++; quarantined++; _embedQuarantine.add(work[i].id); }
        } else {
          failed++;
        }
      }
      // Embedder unavailable (node-llama-cpp missing or still downloading):
      // a whole chunk came back null → stop this run, try again next cadence.
      // NOTHING is quarantined for that — a cold embedder is not the rows'
      // fault; per-row nulls inside an otherwise-successful batch ARE.
      if (!anyOk) {
        return { events: [], notes: ['embedding_backfill: embedder not ready (downloading/unavailable) — staying lexical this cycle'] };
      }
      for (let i = 0; i < work.length; i++) {
        if (!(Array.isArray(vecs[i]) && vecs[i].length)) { quarantined++; _embedQuarantine.add(work[i].id); }
      }
    }
    if (scanned === 0) {
      return { events: [], notes: ['embedding_backfill: no missing embeddings'] };
    }
    return {
      events: [],
      notes: ['embedding_backfill: embedded=' + embedded + ' failed=' + failed +
              (quarantined ? ' quarantined=' + quarantined : '') +
              ' this_run' + (more ? ' (more remaining)' : ' (backlog drained)')]
    };
  }
};

// taskImportSync — the FLOW half of chat-history import (the manual button/
// CLI is the BOOTSTRAP half). Once an operator has imported a source ONCE
// (their standing consent marker in the ingest ledger), new sessions of
// that same source keep flowing in on idle cycles — raw archive only:
// chunking + local embedding cost nothing and leave the machine never.
// The distill half calls a model through the proxy and spends real quota,
// so it stays on the explicit button/CLI where the operator presses it.
// Never a new source uninvited; TROTH_IMPORT_SYNC=0 or config
// import_auto=false turns the task off entirely. Spawns the SAME importer
// CLI the button spawns (idempotent by provenance prefix) so "import"
// keeps meaning ONE thing on every surface.
const taskImportSync = {
  name: 'import_sync',
  cadence_ms: 15 * 60 * 1000,
  run: async function () {
    const fs = require('fs');
    const os = require('os');
    const cp = require('child_process');
    const path = require('path');
    if (process.env.TROTH_IMPORT_SYNC === '0') {
      return { events: [], notes: ['import_sync: disabled by env'] };
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.troth', 'config.json'), 'utf8'));
      if (cfg && cfg.import_auto === false) {
        return { events: [], notes: ['import_sync: disabled by config (import_auto=false)'] };
      }
    } catch (_) { /* no config — default on */ }
    const ch = require('./chameleon.js');
    const prior = ch.listIngestedSourcesPrefix('docs:chats') || [];
    const ROOTS = {
      'claude-cli': path.join(os.homedir(), '.claude', 'projects'),
      'codex': path.join(os.homedir(), '.codex', 'sessions')
    };
    const due = [];
    for (const src of Object.keys(ROOTS)) {
      if (!fs.existsSync(ROOTS[src])) continue;
      // Consent: a human imported this source at least once before.
      if (!prior.some(function (s) { return String(s).indexOf('import:' + src + ':') === 0; })) continue;
      due.push(src);
    }
    if (!due.length) {
      return { events: [], notes: ['import_sync: nothing consented yet (first import stays a human act)'] };
    }
    if (process.env.TROTH_IMPORT_SYNC_DRY === '1') {
      return { events: [], notes: ['import_sync: dry — would sync ' + due.join(',')] };
    }
    const notes = [];
    for (const src of due) {
      try {
        const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'troth-import-chats.js'), '--source', src], {
          encoding: 'utf8', timeout: 10 * 60 * 1000,
          env: process.env
        });
        const lines = String(r.stdout || '').trim().split('\n');
        let res = null;
        try { res = JSON.parse(lines[lines.length - 1]).result; } catch (_) {}
        notes.push('import_sync ' + src + ': ' + (res
          ? ('sessions=' + (res.sessions || 0) + ' skipped=' + (res.skipped || 0) + (res.repaired ? ' repaired=' + res.repaired : ''))
          : ('exit=' + r.status)));
      } catch (e) {
        notes.push('import_sync ' + src + ': failed — ' + (e && e.message || e));
      }
    }
    return { events: [], notes: notes };
  }
};

// taskLedgerPrune — the maintenance ledger's own hygiene (the policy and
// the two-predicate safety live in state.pruneBackgroundRunLedger).
const taskLedgerPrune = {
  name: 'ledger_prune',
  cadence_ms: 24 * 60 * 60 * 1000,
  run: async function () {
    const state = require('./state.js');
    try {
      const n = state.pruneBackgroundRunLedger(7 * 24 * 60 * 60 * 1000);
      const u = state.pruneUsageLedger(30 * 24 * 60 * 60 * 1000);
      // Vectors whose memory is already dead. The garbage collector now takes
      // them at the moment it kills an engram; this clears whatever earlier
      // runs left behind — 711 vectors on this substrate when first measured
      // (1.1% of the index, ~13ms of a 164ms dense scan).
      let vec = { tombstoned: 0, orphaned: 0 };
      try { if (typeof state.pruneDeadEmbeddings === 'function') vec = state.pruneDeadEmbeddings(5000); } catch (_) {}
      const vecNote = (vec.tombstoned || vec.orphaned)
        ? ' + ' + (vec.tombstoned + vec.orphaned) + ' vectors of deleted memories'
        : '';
      // The session-lessons delivery queue. Grew monotonically for four months
      // before this line existed; anything durable was mirrored at write time.
      let sl = 0;
      try { if (typeof state.pruneSessionLessons === 'function') sl = state.pruneSessionLessons(); } catch (_) {}
      const slNote = sl ? ' + ' + sl + ' delivered session lessons' : '';
      return { events: [], notes: ['ledger_prune: removed ' + n + ' aged background_task_run rows (most-recent per task kept)' + (u ? ' + ' + u + ' usage rows past 30d' : '') + vecNote + slNote] };
    } catch (e) {
      return { events: [], notes: ['ledger_prune: ' + (e && e.message || e)] };
    }
  }
};

// Did the work survive? The substrate records every change and, until this
// task existed, never learned the answer: 21,188 edit records, 0 outcome
// events (measured 2026-08-11). action-outcome.js has been able to answer it
// since it was written and had no caller — this is the first observer it
// named, the one that links a change to the commit that kept it.
//
// Runs on the idle worker rather than a hook because it shells out to git,
// and the operator's tool calls already carry 488ms of hook time.
const taskOutcomeFold = {
  name: 'outcome_fold',
  cadence_ms: 6 * 60 * 60 * 1000,
  run: async function () {
    const state = require('./state.js');
    try {
      const fold = require('./outcome-fold.js');
      const r = fold.foldOnce(state, { limit: 100 });
      if (!r.scanned) return { events: [], notes: ['outcome_fold: nothing settled to fold'] };
      return { events: [], notes: ['outcome_fold: ' + r.linked + ' change(s) linked to the commit that kept them' +
        ' · ' + r.uncommitted + ' not yet committed · ' + r.unversioned + ' outside version control' +
        ' (of ' + r.scanned + ' scanned)'] };
    } catch (e) {
      return { events: [], notes: ['outcome_fold: ' + (e && e.message || e)] };
    }
  }
};

// The reservoir of what the partner has seen. The proxy queues a pointer the
// moment a document is read; this turns pointers into recallable passages.
//
// Runs often (15 min) but small (8 documents), because the cost is embedding
// — 51ms per 800 characters, measured — and the point of putting it here is
// that the operator never waits for it.
const taskKnowledgeDrain = {
  name: 'knowledge_drain',
  cadence_ms: 15 * 60 * 1000,
  run: async function () {
    const state = require('./state.js');
    try {
      const drain = require('./knowledge-drain.js');
      const r = await drain.drainOnce(state, {});
      if (!r.scanned) return { events: [], notes: ['knowledge_drain: nothing new was seen'] };
      return { events: [], notes: ['knowledge_drain: kept ' + r.ingested + ' document(s) as ' + r.chunks +
        ' passages (· ' + (r.reasons||0) + ' with the reason they were opened) · ' + r.already + ' already held · ' + r.gone + ' gone · ' + r.skipped + ' skipped' +
        ' (of ' + r.scanned + ' queued)'] };
    } catch (e) {
      return { events: [], notes: ['knowledge_drain: ' + (e && e.message || e)] };
    }
  }
};

//  reshape: taskProjectBootstrap REMOVED — file convention
// (.troth-config/) was external-config-on-top-of-substrate. Substrate
// carries thesis content directly via operator_confirmed identity
// engrams (no file ingest layer).
// taskPurposeRefresh KEPT because the substrate_internal current_focus
// engram it writes is useful as a snapshot the PreCompact hook reads.
// It's not surfaced as its own prefix block — operator can recall it
// via troth_engram_search when interested.
// autonomous-mode step — dormancy warning. Reads inheritance_directive's
// dormancy_threshold_ms + presence freshness. If presence is within
// 20% of the threshold (i.e. 80% of the way to silent dead-man-switch
// trip), writes an operator_surface engram at notify-tier so the
// operator sees "your partner is about to lock itself" BEFORE the
// substrate goes dormant. De-dupes against any unconsumed warning in
// the last 6h so a stale operator doesn't get spammed.
const taskDormancyWarn = {
  name: 'dormancy_warn',
  cadence_ms: 60 * 60 * 1000,   // 1h — adjust via override if needed
  run: async function (view) {
    const deps = (view && view._deps) || {};
    let presence, bootstrap, surface, eng;
    try {
      presence  = deps.presence  || require('./presence.js');
      bootstrap = deps.bootstrap || require('./bootstrap.js');
      surface   = deps.surface   || require('./operator-surface.js');
      eng       = deps.engram    || require('./engram.js');
    } catch (_) {
      return { events: [], notes: ['dormancy_warn: required module missing'] };
    }
    let directive;
    try { directive = bootstrap.getActiveInheritanceDirective(); }
    catch (_) { directive = null; }
    if (!directive) {
      return { events: [], notes: ['dormancy_warn: no inheritance_directive (no dead-man-switch armed)'] };
    }
    const threshold = directive.dormancy_threshold_ms || (30 * 24 * 60 * 60 * 1000); // 30d fallback
    const fresh = presence.presenceFreshness(threshold);
    if (!fresh) {
      return { events: [], notes: ['dormancy_warn: presenceFreshness returned null'] };
    }
    // age_ms only present when proof exists. No proof = already dormant by definition.
    const ageMs = (typeof fresh.age_ms === 'number') ? fresh.age_ms : threshold;
    const warnAt = Math.floor(threshold * 0.8);
    if (ageMs < warnAt) {
      return { events: [], notes: [
        'dormancy_warn: presence fresh (age=' + Math.floor(ageMs/1000) + 's, warn_at=' + Math.floor(warnAt/1000) + 's)'
      ] };
    }
    // De-dupe — skip if any operator_surface dormancy_warning in last 6h.
    try {
      const recent = eng.listEngrams({
        principal: null, audience: 'all', scope: 'operator_surface', limit: 50
      }) || [];
      const sixH = Date.now() - 6 * 60 * 60 * 1000;
      const alreadyWarned = recent.some(r =>
        r && r.ts > sixH &&
        ((r.extra_output && r.extra_output.surface_kind === 'dormancy_warning')
         || (r.surface_kind === 'dormancy_warning'))
      );
      if (alreadyWarned) {
        return { events: [], notes: ['dormancy_warn: already-warned in last 6h — silenced'] };
      }
    } catch (_) { /* projection variance — fall through and emit */ }

    const r = surface.recordOperatorSurface({
      urgency: 'notify',
      surface_kind: 'dormancy_warning',
      subject: 'Partner approaching dormancy threshold',
      body: 'Presence proof is ' + Math.floor(ageMs / 1000) + 's old; dead-man-switch fires at ' +
            Math.floor(threshold / 1000) + 's. Run `troth presence` to refresh.',
      agent_id: 'background-worker'
    });
    const events = (r && r.ok) ? [{
      type: 'tool_call',
      input: { tool_name: 'dormancy_warn.surface_written', args: { age_ms: ageMs, threshold_ms: threshold } },
      output: { status: 'completed' }
    }] : [];
    return {
      events,
      notes: ['dormancy_warn: ' + (r && r.ok ? 'warned (engram=' + r.id + ')' : 'write_failed: ' + (r && r.error))],
      notify_always: !!(r && r.ok)
    };
  }
};

// autonomous-mode step — periodic WAL replication. Calls wal-replicate.runOnce
// against TROTH_WAL_DEST env (no-op if unset). 1h cadence default;
// vessels with stricter RPO override down to 5-10 min via env.
const taskWalReplicate = {
  name: 'wal_replicate',
  cadence_ms: 60 * 60 * 1000,
  run: async function (view) {
    const dest = process.env.TROTH_WAL_DEST || '';
    if (!dest) {
      return { events: [], notes: ['wal_replicate: TROTH_WAL_DEST unset — no-op'] };
    }
    const deps = (view && view._deps) || {};
    let wal;
    try { wal = deps.wal || require('./wal-replicate.js'); }
    catch (_) { return { events: [], notes: ['wal_replicate: module missing'] }; }
    try {
      const r = await wal.runOnce({ dest });
      const events = r.ok ? [{
        type: 'tool_call',
        input: { tool_name: 'wal_replicate.backup_completed', args: { dest: r.dest, bytes: r.bytes } },
        output: { status: 'completed' }
      }] : [];
      return {
        events,
        notes: ['wal_replicate: ' + (r.ok ? 'ok (' + r.bytes + 'B → ' + r.dest + ')' : 'failed: ' + (r.error || 'unknown'))],
        notify_always: r.ok
      };
    } catch (e) {
      return { events: [], notes: ['wal_replicate threw: ' + (e && e.message || e)] };
    }
  }
};

// Cadence ledger reader shared by BOTH runners. The scheduler used to keep
// lastRun only in memory, so every restart re-ran everything — four "weekly"
// backups in a day, each a synchronous copy of a multi-GB state.db.
function hydrateLastRunFromRecords(cwd, stateOverride) {
  const lastRun = new Map();
  try {
    // Tests and embedders inject their own state module; the ledger reader
    // honours it the way the runners always did.
    const stateMod = stateOverride || require('./state.js');
    const since = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const rows = stateMod.queryActions({
      type: 'decision', cwd, since, limit: 500, order: 'desc'
    }) || [];
    for (const row of rows) {
      let inp; try { inp = JSON.parse(row.input); } catch (_) { continue; }
      if (!inp || inp.kind !== 'background_task_run' || !inp.task) continue;
      if (!lastRun.has(inp.task)) lastRun.set(inp.task, row.timestamp);
    }
  } catch (_) { /* empty map — genuinely first run */ }
  return lastRun;
}

const DEFAULT_TASKS = [taskContradictionScan, taskDormantReview, taskStateSummary, taskDriftScan, taskEngramGc, taskAnchorSuggest, taskIdentityExtract, taskReconsolidationReview, taskBackup, taskOrchestrationReview, taskHypothesisGeneration, taskPurposeRefresh, taskWorkingMemoryConsolidation, taskEmbeddingBackfill, taskDormancyWarn, taskWalReplicate, taskImportSync, taskLedgerPrune, taskOutcomeFold, taskKnowledgeDrain];
// Closed-extension worker tasks (guarded optional require — absent in the open build).
try { const _ext = require('./core-ext.js'); if (Array.isArray(_ext.workerTasks)) DEFAULT_TASKS.push(..._ext.workerTasks); } catch (_) {}

// ── Worker factory ─────────────────────────────────────────────────────

function startWorker(opts) {
  opts = opts || {};
  const submit = opts.submit;
  const getView = opts.getView;
  if (typeof submit !== 'function' || typeof getView !== 'function') {
    throw new Error('background-worker: opts.submit and opts.getView are required');
  }
  const tasks = Array.isArray(opts.tasks) && opts.tasks.length ? opts.tasks : DEFAULT_TASKS;
  // Use ?? so an explicit 0 (caller wants zero idle threshold or
  // immediate tick) is honored; `||` would coerce 0 to the default.
  const idleThresholdMs = opts.idle_threshold_ms != null ? opts.idle_threshold_ms : DEFAULT_IDLE_THRESHOLD_MS;
  const tickMs          = opts.tick_ms           != null ? opts.tick_ms           : DEFAULT_TICK_MS;
  const perCycleBudget  = opts.per_cycle_budget_ms != null ? opts.per_cycle_budget_ms : DEFAULT_PER_CYCLE_BUDGET;
  // autonomous-mode step — per-task cadence overrides. The default DEFAULT_TASKS
  // ships conservative 12h cadences for the L4 reflection tasks
  // (dispatch_pending / schedule_fire / reactor_match) so a sleepy
  // substrate doesn't burn provider quota. Vessel deployments
  // (Configuration B / C in the autonomy quickstart) want tight cadences so
  // validated intents actually dispatch within seconds, not hours.
  // Map shape: { task_name: cadence_ms_override }. Empty = no override.
  const taskCadenceOverrides = (opts.task_cadence_overrides && typeof opts.task_cadence_overrides === 'object')
    ? opts.task_cadence_overrides : {};
  // Optional rich-notification surface: substrate emits a structured
  // notification per task firing, beyond the L1 events. Hosts use this
  // to render "the substrate just noticed X" without polling L1.
  // Signature: notify({task, events, notes, elapsed_ms, ts})
  const notify = typeof opts.notify === 'function' ? opts.notify : null;
  // Cross-process lease: when true, a due task is skipped if ANY process
  // recorded a run of it within its cadence (the background_task_run ledger
  // IS the lease). This is what lets the proxy's maintenance worker and the
  // entity daemon's full worker coexist without double-draining one queue —
  // whichever fires first wins the window, the other sees the fresh row.
  const crossLease = opts.cross_process_lease === true;

  // Hydrated, not born empty: restarts inherit what already ran.
  const lastRun = hydrateLastRunFromRecords(opts.cwd || (opts.substrate_ctx && opts.substrate_ctx.cwd) || process.cwd(), opts.state);
  let running = true;
  let timer = null;
  let lastFgActivity = Date.now();

  function noteForegroundActivity() { lastFgActivity = Date.now(); }

  async function tick() {
    if (!running) return;
    // The operator's pause, honoured by every process that could pick this
    // work up. Checked here rather than at startup because a pause has to
    // land on a worker that is ALREADY running — the whole point is a button,
    // not a restart. One stat per tick; the file is absent on every machine
    // where nobody has pressed it.
    let _gate = null;
    try { _gate = require('./maintenance-gate.js').isPaused(); } catch (_) { _gate = null; }
    if (_gate && _gate.paused) {
      timer = setTimeout(tick, tickMs);
      return;
    }
    const idleFor = Date.now() - lastFgActivity;
    if (idleFor < idleThresholdMs) {
      timer = setTimeout(tick, tickMs);
      return;
    }
    const cycleStart = Date.now();
    let view;
    try { view = getView(); } catch (e) { view = null; }
    if (view) {
      for (const task of tasks) {
        if (Date.now() - cycleStart > perCycleBudget) break;
        const last = lastRun.get(task.name) || 0;
        const cadence = (typeof taskCadenceOverrides[task.name] === 'number' && taskCadenceOverrides[task.name] > 0)
          ? taskCadenceOverrides[task.name]
          : task.cadence_ms;
        if (Date.now() - last < cadence) continue;
        if (crossLease) {
          try {
            const led = require('./state.js').lastBackgroundRun(task.name, cadence);
            if (led && led.timestamp) { lastRun.set(task.name, led.timestamp); continue; }
          } catch (_) { /* ledger unreadable — run rather than stall */ }
        }
        const taskStart = Date.now();
        let result;
        try { result = await Promise.resolve(task.run(view)); }
        catch (e) { result = { events: [], notes: ['task threw: ' + (e && e.message || e)] }; }
        lastRun.set(task.name, Date.now());
        // The same ledger runDueTasks writes — a restart reads this back.
        try {
          submit({
            type: 'decision',
            input: { kind: 'background_task_run', task: task.name, signals: { scheduler: true } },
            output: { decision: 'ran', reason: 'startWorker', notes: (result && result.notes || []).slice(0, 4).join(' | ').slice(0, 500) }
          });
        } catch (_) { /* best-effort */ }
        const elapsed = Date.now() - taskStart;
        if (result && Array.isArray(result.events)) {
          for (const ev of result.events) {
            try { submit(ev); } catch (_) { /* runtime stopped or rejected; skip */ }
          }
        }
        // G7 — auto-surface high-priority events as insights. Each event
        // goes through insight-surfacer.priorityFor → recordInsight; the
        // surfacer handles threshold + per-hour throttle + L1 write.
        // Best-effort — surfacer failures never break the worker loop.
        if (result && Array.isArray(result.events) && result.events.length) {
          try {
            const surfacer = require('./insight-surfacer.js');
            const ctx = (view && view.substrate_ctx) || {};
            if (ctx.agent_id) {
              for (const ev of result.events) {
                const r = surfacer.recordInsight({
                  agent_id: ctx.agent_id, cwd: ctx.cwd, user_id: ctx.user_id,
                  source_event: ev,
                  reason: 'auto_surfaced_from_' + task.name
                });
                // Silent on below_threshold / throttled — that's normal.
              }
            }
          } catch (_) { /* surfacer module load or write failure — skip */ }
        }
        if (notify && result && (result.events && result.events.length || (result.notify_always === true))) {
          try {
            notify({
              task:       task.name,
              events:     result.events || [],
              notes:      result.notes  || [],
              elapsed_ms: elapsed,
              ts:         Date.now()
            });
          } catch (_) { /* notification surface is best-effort */ }
        }
      }
    }
    if (running) timer = setTimeout(tick, tickMs);
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Boot — with a small first-tick jitter. Login starts several workers at
  // once (the launchd proxy, the app's proxy, the entity daemon), and
  // perfectly synchronized first cycles all see an empty lease and fire
  // the same task before any of them has written its ledger row. A few
  // desynchronized seconds make the lease real; capped so tight test
  // ticks (40ms) stay tight.
  timer = setTimeout(tick, tickMs + Math.floor(Math.random() * Math.min(tickMs, 15000)));

  return { stop, noteForegroundActivity, _tasks: tasks };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function collectActiveCommitments(mind) {
  const out = [];
  if (!mind || !Array.isArray(mind.active_projects)) return out;
  for (const p of mind.active_projects) {
    if (!p || !Array.isArray(p.constraints)) continue;
    for (const c of p.constraints) {
      if (c && typeof c === 'object' && c.id) out.push(c);
    }
  }
  return out;
}

function likelyContradicts(a, b) {
  // Cheap heuristic: same subject, opposite polarity. Picks up the
  // obvious cases where one commitment says "always X" and another says
  // "never X". The substrate's job is to flag for review, not to be
  // semantically perfect — false positives are surfaced, not enforced.
  const sa = String(a.statement || '').toLowerCase();
  const sb = String(b.statement || '').toLowerCase();
  if (!sa || !sb) return false;
  const negPair = (
    (sa.includes(' always ') && sb.includes(' never ')) ||
    (sa.includes(' never ')  && sb.includes(' always ')) ||
    (sa.includes(' must ')   && sb.includes(' must not ')) ||
    (sa.includes(' must not ') && sb.includes(' must '))
  );
  if (!negPair) return false;
  // Require some shared content beyond the polarity word.
  const overlap = sharedTokens(sa, sb);
  return overlap >= 2;
}

function sharedTokens(a, b) {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'be', 'to', 'of', 'in', 'and', 'or']);
  const ta = new Set(a.split(/\W+/).filter((t) => t && !stop.has(t)));
  let n = 0;
  for (const t of b.split(/\W+/)) {
    if (!t || stop.has(t)) continue;
    if (ta.has(t)) n++;
  }
  return n;
}

// ── One-shot scheduler ─────────────────────────────────────────────────
// runDueTasks(opts) — single pass over DEFAULT_TASKS (or opts.tasks),
// runs only the ones whose cadence_ms has elapsed since the last
// recorded firing. Cadence is persisted via type='decision',
// input.kind='background_task_run' records keyed by task name +
// substrate_ctx.cwd, so the debounce survives across calls without an
// in-memory daemon — necessary for callers like the SessionStart hook
// that fire briefly and exit.
//
// startWorker stays the right answer for long-running daemons (the
// troth-entity binary). runDueTasks is the right answer for hosts
// that already have their own event loop (Claude Code plugin, proxy
// HTTP server, voice subprocess) and just want due daily tasks to
// actually fire instead of lying dormant until someone runs the
// standalone daemon.
//
// Defaults to min_cadence_ms = 12h so callers like SessionStart only
// run daily/weekly tasks, never the 60s drift-scan or 5min state-
// summary (those want a real long-running worker; calling them once
// from a hook produces stale signals).
async function runDueTasks(opts) {
  opts = opts || {};
  const submit = opts.submit;
  const getView = opts.getView;
  if (typeof submit !== 'function' || typeof getView !== 'function') {
    throw new Error('background-worker.runDueTasks: opts.submit and opts.getView are required');
  }
  const tasks = Array.isArray(opts.tasks) && opts.tasks.length ? opts.tasks : DEFAULT_TASKS;
  const stateMod = opts.state || require('./state.js');
  const minCadence = opts.min_cadence_ms != null ? opts.min_cadence_ms : (12 * 60 * 60 * 1000);
  const perCycleBudget = opts.per_cycle_budget_ms != null ? opts.per_cycle_budget_ms : DEFAULT_PER_CYCLE_BUDGET;

  // Same pause, second door. A one-shot scheduler that ignored it would let
  // every SessionStart hook quietly restart the work the operator just
  // stopped — a pause honoured by one runner out of two is not a pause.
  try {
    const g = require('./maintenance-gate.js').isPaused();
    if (g && g.paused) return { ran: [], skipped: [{ task: '*', reason: 'paused_by_operator' }], errors: [], paused: true };
  } catch (_) { /* unreadable gate means running, never stalled */ }

  let view;
  try { view = getView(); } catch (_) { view = null; }
  if (!view) return { ran: [], skipped: [], errors: ['getView_returned_null'] };
  const ctx = (view.substrate_ctx) || {};

  // Per-task agent_id overrides — for the case where different tasks
  // need to source data from different agent buckets in the same tick.
  // Concrete trigger: dialogue.turn rows live under the operator agent_id
  // (correct for taskIdentityExtract) while real tool_calls live under
  // 'claude-code'. Tests PSW4 covers the override path.
  const agentOverrides = opts.agent_id_overrides || {};

  // One ledger, one reader — shared with the long-running scheduler.
  const lastRun = hydrateLastRunFromRecords(ctx.cwd, opts.state);

  const ran = [];
  const skipped = [];
  const errors = [];
  const cycleStart = Date.now();

  for (const task of tasks) {
    if (Date.now() - cycleStart > perCycleBudget) {
      skipped.push({ task: task.name, reason: 'cycle_budget_exceeded' });
      continue;
    }
    if (typeof task.cadence_ms === 'number' && task.cadence_ms < minCadence) {
      skipped.push({ task: task.name, reason: 'below_min_cadence' });
      continue;
    }
    const last = lastRun.get(task.name) || 0;
    if (Date.now() - last < (task.cadence_ms || 0)) {
      skipped.push({ task: task.name, reason: 'within_cadence', last_run: last });
      continue;
    }

    // Per-task view: clone + override substrate_ctx.agent_id when
    // an override is configured for this task. Otherwise the original
    // view is reused unmodified (the common path).
    let taskView = view;
    if (agentOverrides[task.name]) {
      taskView = Object.assign({}, view);
      taskView.substrate_ctx = Object.assign({}, ctx, { agent_id: agentOverrides[task.name] });
    }

    let result;
    try { result = await Promise.resolve(task.run(taskView)); }
    catch (e) {
      errors.push({ task: task.name, error: (e && e.message) || String(e) });
      result = { events: [], notes: ['threw'] };
    }

    if (result && Array.isArray(result.events)) {
      for (const ev of result.events) {
        try { submit(ev); } catch (_) { /* submit shim may reject; skip */ }
      }
    }
    // Always record the run — debounces the cadence check on next call
    // EVEN when the underlying task produced zero events (e.g. no
    // identity facts crossed the stability threshold this scan).
    try {
      submit({
        type: 'decision',
        input: {
          kind: 'background_task_run',
          task: task.name,
          signals: { event_count: (result && result.events || []).length }
        },
        output: { decision: 'ran', reason: 'runDueTasks' }
      });
    } catch (_) { /* substrate write best-effort */ }

    ran.push({
      task: task.name,
      events: (result && result.events || []).length,
      notes: (result && result.notes) || []
    });
  }

  return { ran, skipped, errors };
}

module.exports = {
  startWorker,
  hydrateLastRunFromRecords,
  runDueTasks,
  DEFAULT_TASKS,
  tasks: {
    contradictionScan: taskContradictionScan,
    dormantReview:     taskDormantReview,
    stateSummary:      taskStateSummary,
    driftScan:         taskDriftScan,
    engramGc:          taskEngramGc,
    anchorSuggest:     taskAnchorSuggest,
    identityExtract:   taskIdentityExtract,
    backup:            taskBackup,
    hypothesisGeneration: taskHypothesisGeneration,
    dormancyWarn:      taskDormancyWarn,
    walReplicate:      taskWalReplicate,
    embeddingBackfill: taskEmbeddingBackfill,
    importSync:        taskImportSync,
    ledgerPrune:       taskLedgerPrune,
    // Both of these were written, tested and scheduled — into DEFAULT_TASKS,
    // which only the entity daemon runs. In the topology the operator
    // actually has (Claude Code + proxy) nothing referenced them, so the
    // document queue had no reader and edits were never linked to the commit
    // that kept them. The suite passed because it asserted membership in
    // DEFAULT_TASKS and never asked which list the running process uses.
    knowledgeDrain:    taskKnowledgeDrain,
    outcomeFold:       taskOutcomeFold
  }
};
