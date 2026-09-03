// SPDX-License-Identifier: AGPL-3.0-only
// Mind layer — mind-state schema + validator.
//
// The mind state is a portable working-context object: active projects,
// current focus, recent decisions, intentions, collaborators, constraints.
// NOT persona, NOT voice — factual world-state about the user's work.
//
// Persistence: each persist call writes one ActionRecord of type
// 'mind_snapshot' (append-only, per Q5 of paper 05). Latest snapshot for
// a user is the current mind state. Older snapshots remain queryable.
//
// This module is PURE DATA LAYER — no DB writes, no side effects. Validation
// and shape helpers only. Persistence lives in state.js via action_records.
//
const SCHEMA_VERSION = '0.1';
const PROTOCOL_VERSION = 'mind-2026-04-29';

// ── Empty mind state for first-run / cold start ─────────────────────────
function emptyMindState(user_id) {
  return {
    schema_version: SCHEMA_VERSION,
    snapshot_at: new Date().toISOString(),
    user_id: String(user_id || 'anonymous'),
    current_focus: '',
    active_projects: [],
    current_intent: null,
    ongoing_threads: [],
    decisions_explicitly_rejected: []
  };
}

// ── Validation ──────────────────────────────────────────────────────────
// Returns { ok, errors }. Errors are structured objects so callers can
// react programmatically (drop / surface / repair) rather than parse
// free-form strings. Same convention as shared-core/action-record.js.
function validate(state) {
  const errors = [];
  if (!state || typeof state !== 'object') {
    return { ok: false, errors: [{ kind: 'not_object' }] };
  }

  // Required top-level fields
  for (const f of ['schema_version', 'snapshot_at', 'user_id']) {
    if (state[f] === undefined || state[f] === null) {
      errors.push({ kind: 'missing_top_level', field: f });
    }
  }

  if (typeof state.schema_version !== 'string') {
    errors.push({ kind: 'bad_schema_version', got: state.schema_version });
  }
  if (typeof state.snapshot_at !== 'string') {
    errors.push({ kind: 'bad_snapshot_at', got: state.snapshot_at });
  }
  if (typeof state.user_id !== 'string' || !state.user_id) {
    errors.push({ kind: 'bad_user_id', got: state.user_id });
  }

  // current_focus: optional string
  if (state.current_focus !== undefined && state.current_focus !== null) {
    if (typeof state.current_focus !== 'string') {
      errors.push({ kind: 'bad_current_focus', got: typeof state.current_focus });
    }
  }

  // active_projects: array of project objects
  if (!Array.isArray(state.active_projects)) {
    errors.push({ kind: 'active_projects_not_array' });
  } else {
    for (let i = 0; i < state.active_projects.length; i++) {
      const p = state.active_projects[i];
      if (!p || typeof p !== 'object') {
        errors.push({ kind: 'project_not_object', index: i });
        continue;
      }
      for (const f of ['id', 'name']) {
        if (typeof p[f] !== 'string' || !p[f]) {
          errors.push({ kind: 'project_missing_field', index: i, field: f });
        }
      }
      // Optional fields: stage, current_focus, audience strings; arrays for
      // key_decisions, open_questions, constraints, collaborators.
      if (p.key_decisions !== undefined && !Array.isArray(p.key_decisions)) {
        errors.push({ kind: 'key_decisions_not_array', index: i });
      }
      if (p.open_questions !== undefined && !Array.isArray(p.open_questions)) {
        errors.push({ kind: 'open_questions_not_array', index: i });
      }
      if (p.constraints !== undefined && !Array.isArray(p.constraints)) {
        errors.push({ kind: 'constraints_not_array', index: i });
      }
      if (p.collaborators !== undefined && !Array.isArray(p.collaborators)) {
        errors.push({ kind: 'collaborators_not_array', index: i });
      }
    }
  }

  // current_intent: nullable object with task_signature
  if (state.current_intent !== undefined && state.current_intent !== null) {
    if (typeof state.current_intent !== 'object') {
      errors.push({ kind: 'current_intent_not_object' });
    } else {
      const sig = state.current_intent.task_signature;
      if (sig !== undefined && sig !== null) {
        if (typeof sig !== 'object') {
          errors.push({ kind: 'task_signature_not_object' });
        } else {
          if (sig.domain !== undefined && typeof sig.domain !== 'string') {
            errors.push({ kind: 'task_signature_bad_domain' });
          }
          if (sig.subgoal !== undefined && typeof sig.subgoal !== 'string') {
            errors.push({ kind: 'task_signature_bad_subgoal' });
          }
          // project_id: string or null
          if (sig.project_id !== undefined && sig.project_id !== null
              && typeof sig.project_id !== 'string') {
            errors.push({ kind: 'task_signature_bad_project_id' });
          }
        }
      }
    }
  }

  // ongoing_threads, decisions_explicitly_rejected: arrays
  if (state.ongoing_threads !== undefined && !Array.isArray(state.ongoing_threads)) {
    errors.push({ kind: 'ongoing_threads_not_array' });
  }
  if (state.decisions_explicitly_rejected !== undefined
      && !Array.isArray(state.decisions_explicitly_rejected)) {
    errors.push({ kind: 'decisions_rejected_not_array' });
  }

  return { ok: errors.length === 0, errors };
}

// ── Build a mind_snapshot ActionRecord ──────────────────────────────────
// Wraps a mind state into the substrate's append-only ActionRecord shape
// so it can be persisted via state.recordAction().
function buildSnapshotRecord({ id, timestamp, agent_id, cwd, mind_state, trigger, prev_snapshot_id }) {
  const v = validate(mind_state);
  if (!v.ok) return { ok: false, errors: v.errors };
  const record = {
    id,
    timestamp: timestamp || Date.now(),
    type: 'mind_snapshot',
    agent_id: agent_id || 'unknown',
    cwd: cwd || null,
    input: {
      schema_version: mind_state.schema_version,
      trigger: trigger || 'manual',
      prev_snapshot_id: prev_snapshot_id || null
    },
    output: {
      mind_state,
      summary: shortSummary(mind_state)
    },
    verification: {
      schema_valid: { ok: true, schema_version: mind_state.schema_version }
    }
  };
  return { ok: true, record };
}

// One-line summary for indexing / search. Not load-bearing; informational.
function shortSummary(state) {
  const proj = (state.active_projects || []).map(p => p.name).join(', ');
  const focus = state.current_focus || '';
  return ('focus=' + focus.slice(0, 80) + ' projects=[' + proj.slice(0, 120) + ']').slice(0, 240);
}

// ── Format a mind state as session-start orientation text ────────────────
// Used by the SessionStart hook to inject context for a fresh agent.
// Output is markdown-ish, deliberately short (target <2K tokens for v0.1).
// Returns empty string for empty mind states (cold-start) so the caller
// can decide not to inject anything.
function formatOrientation(state) {
  if (!state) return '';
  const projects = Array.isArray(state.active_projects) ? state.active_projects : [];
  const focus = (state.current_focus || '').trim();
  const intent = state.current_intent || null;
  const threads = Array.isArray(state.ongoing_threads) ? state.ongoing_threads : [];

  // Cold-start: nothing meaningful to show. Skip orientation entirely.
  if (!focus && projects.length === 0 && !intent && threads.length === 0) return '';

  const lines = ['[troth/mind] Session orientation (loaded from latest snapshot):'];
  if (focus) lines.push('  Current focus: ' + focus);

  if (projects.length) {
    lines.push('  Active projects:');
    for (const p of projects.slice(0, 10)) {
      const parts = [p.name || p.id || '?'];
      if (p.stage) parts.push('stage=' + p.stage);
      if (p.current_focus) parts.push('next=' + String(p.current_focus).slice(0, 80));
      lines.push('    - ' + parts.join('; '));
      // Surface top decisions inline so the agent sees the "why" at session
      // start without needing a fault-in. key_decisions is pre-sorted by
      // salience in recomputeFromSubstrate; cap at 2 per project + 100
      // chars each to keep the orientation block under the ~2K target.
      const decisions = Array.isArray(p.key_decisions) ? p.key_decisions : [];
      for (const d of decisions.slice(0, 2)) {
        const summary = d && d.summary ? String(d.summary).slice(0, 100) : null;
        if (summary) lines.push('        · ' + summary);
      }
      if (decisions.length > 2) {
        lines.push('        (+' + (decisions.length - 2) + ' more decisions — fault-in for full list)');
      }
    }
    if (projects.length > 10) lines.push('    (+' + (projects.length - 10) + ' more — fault-in if relevant)');
  }

  if (intent && (intent.what || intent.why)) {
    if (intent.what) lines.push('  Working on: ' + String(intent.what).slice(0, 200));
    if (intent.why)  lines.push('  Why: '         + String(intent.why ).slice(0, 200));
  }

  if (threads.length) {
    lines.push('  Open threads:');
    for (const t of threads.slice(0, 5)) {
      const topic = t && t.topic ? String(t.topic).slice(0, 80) : '(unnamed)';
      const last  = t && t.last_state ? ' — ' + String(t.last_state).slice(0, 100) : '';
      lines.push('    - ' + topic + last);
    }
  }

  const rejected = Array.isArray(state.decisions_explicitly_rejected)
    ? state.decisions_explicitly_rejected : [];
  if (rejected.length) {
    lines.push('  Already rejected (do not re-litigate):');
    for (const d of rejected.slice(0, 5)) {
      const what = d && d.what ? String(d.what).slice(0, 80) : '(unspecified)';
      lines.push('    - ' + what);
    }
  }

  return lines.join('\n');
}

// ── Salience scoring (V0.2 reconsolidation / decay) ─────────────────────
// Pure function. Combines recency and usage into a single salience score
// per decision. Higher score = stays in active key_decisions; lower
// score = falls off the cap.
//
//   salience = ln(retrievalCount + 1) + recency_bonus
//   recency_bonus = max(0, 1 - age_days / DECAY_HALFLIFE_DAYS)
//
// Properties:
//   - Brand-new unused decision: salience ≈ 1 (rides recency_bonus)
//   - 5-retrieval decision regardless of age: salience ≥ ln(6) ≈ 1.79
//   - Old (>30 day) unused decision: salience = 0 (falls to bottom)
//   - High-retrieval old decision: salience driven by ln() — stays alive
//
// "Retrieval" is tracked per-project (we write retrieval-events when
// load_orientation / surface fire, see writeRetrievalEvent). Decisions
// inherit their project's retrieval count as a proxy — coarse but
// captures the "is this domain still active?" signal.
const DECAY_HALFLIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function scoreDecisionSalience(opts) {
  opts = opts || {};
  const recordedAt = typeof opts.recorded_at === 'number' ? opts.recorded_at : 0;
  const retrievalCount = typeof opts.retrievalCount === 'number' ? opts.retrievalCount : 0;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ageDays = Math.max(0, (now - recordedAt) / DAY_MS);
  const recencyBonus = Math.max(0, 1 - ageDays / DECAY_HALFLIFE_DAYS);
  const usageScore = Math.log((retrievalCount > 0 ? retrievalCount : 0) + 1);
  return usageScore + recencyBonus;
}

// ── Salience scoreboard helper ─────────────────────────────────────────
// Returns top-K live (non-superseded) decisions across projects with
// salience scores attached, for read-only observability surfaces (UI
// scoreboard, CLI listings). View-only — no writes; same append-only
// contract as recomputeFromSubstrate.
//
// Output rows include: decision_id, project_id, project_name, summary,
// rationale, recorded_at, retrievalCount, salience, age_days.
//
// Signature: getSalienceTopK(stateModule, { cwd, k, agent_id })
function getSalienceTopK(stateModule, opts) {
  opts = opts || {};
  const cwd = opts.cwd || null;
  const agent_id = opts.agent_id || null;
  const k = Math.max(1, Math.min(200, parseInt(opts.k || 20, 10)));
  const actionRec = require('./action-record');
  const now = Date.now();

  // Project name lookup from latest snapshot (so UI can show "Project: X").
  const projectNameById = new Map();
  const snapRows = stateModule.queryActions({
    type: 'mind_snapshot', cwd, agent_id, limit: 1, order: 'desc'
  }) || [];
  if (snapRows.length) {
    const rec = actionRec.fromRow(snapRows[0]);
    const ms = rec && rec.output && rec.output.mind_state;
    const projects = ms && Array.isArray(ms.active_projects) ? ms.active_projects : [];
    for (const p of projects) {
      if (p && p.id) projectNameById.set(p.id, p.name || p.id);
    }
  }

  // Pull mind_decision and mind_retrieval events SEPARATELY using the
  // queryActions `kind` filter. Two surgical queries beat one fat query
  // that returns thousands of unrelated decisions and gets clipped by
  // the 1000-row LIMIT in high-volume substrates.
  const since = now - (DECAY_HALFLIFE_DAYS * DAY_MS);
  const decisionRows = stateModule.queryActions({
    type: 'decision', cwd, since, kind: 'mind_decision', limit: 1000, order: 'asc'
  }) || [];
  const retrievalRows = stateModule.queryActions({
    type: 'decision', cwd, since, kind: 'mind_retrieval', limit: 1000, order: 'asc'
  }) || [];

  const decisions = [];
  const supersededIds = new Set();
  const retrievalCountByProject = new Map();
  for (const row of decisionRows) {
    const rec = actionRec.fromRow(row);
    if (!rec || !rec.input) continue;
    const sig = rec.input.signals || {};
    const projectId = sig.project_id;
    if (!projectId) continue;
    const supersedes = Array.isArray(sig.supersedes)
      ? sig.supersedes
      : (sig.supersedes ? [sig.supersedes] : []);
    for (const sId of supersedes) {
      if (typeof sId === 'string' && sId) supersededIds.add(sId);
    }
    decisions.push({
      decision_id: rec.id,
      project_id: projectId,
      summary: sig.summary || '(unsummarized)',
      rationale: sig.rationale || '',
      recorded_at: rec.timestamp || 0,
      supersedes
    });
  }
  for (const row of retrievalRows) {
    const rec = actionRec.fromRow(row);
    if (!rec || !rec.input) continue;
    const sig = rec.input.signals || {};
    const pids = Array.isArray(sig.project_ids) ? sig.project_ids : [];
    for (const pid of pids) {
      retrievalCountByProject.set(pid, (retrievalCountByProject.get(pid) || 0) + 1);
    }
  }

  const live = decisions.filter((d) => !supersededIds.has(d.decision_id));
  const scored = live.map((d) => {
    const rc = retrievalCountByProject.get(d.project_id) || 0;
    return {
      decision_id: d.decision_id,
      project_id: d.project_id,
      project_name: projectNameById.get(d.project_id) || d.project_id,
      summary: d.summary,
      rationale: d.rationale,
      recorded_at: d.recorded_at,
      retrievalCount: rc,
      age_days: Math.max(0, (now - d.recorded_at) / DAY_MS),
      salience: scoreDecisionSalience({
        recorded_at: d.recorded_at, retrievalCount: rc, now
      })
    };
  });
  scored.sort((a, b) => b.salience - a.salience);
  return scored.slice(0, k);
}

// ── Equivalence check ignoring metadata-only differences ────────────────
// Two mind states are "meaningfully equivalent" if their content fields
// match — ignoring snapshot_at (changes every recompute) and any other
// timestamps that move with each persist. Used by Stop / pre-compact
// hooks to skip no-op writes; without this we would bloat the substrate
// with N near-identical mind_snapshots per session.
//
// Returns true when the two states have the same content. Returns false
// for any genuine difference (project added/removed/changed, decisions
// added, intent updated, threads changed, rejected list changed).
function hasMeaningfulChanges(prev, next) {
  if (!prev || !next) return true;            // Treat missing prev as "changed"
  const stripVolatile = (s) => {
    const copy = JSON.parse(JSON.stringify(s));
    delete copy.snapshot_at;
    return copy;
  };
  return JSON.stringify(stripVolatile(prev)) !== JSON.stringify(stripVolatile(next));
}

// ── Minimal view computation from substrate intent records ──────────────
// Take the latest snapshot (or empty fallback) and merge in any new
// intent records written since that snapshot's timestamp. The only
// content update for v0.1 is `current_intent`: most recent intent record
// becomes the working `what` / `why`. Project-level decision capture
// (Q2's heuristic + manual override) is left to a later iteration.
//
// This function is the seed of view computation per Q5 (append-only
// substrate, view computed at read time). It returns a NEW mind_state
// object — does not mutate inputs. Caller decides whether to persist.
//
// Signature: recomputeFromSubstrate(state, { cwd, agent_id, user_id })
//   state    — shared-core/state.js module (provides queryActions)
//   cwd      — optional working-directory filter for intent records
//   agent_id — optional writing-agent filter
//   user_id  — used as default for empty fallback only
function recomputeFromSubstrate(stateModule, opts) {
  opts = opts || {};
  const cwd = opts.cwd || null;
  const agent_id = opts.agent_id || null;
  const user_id = opts.user_id || 'default';
  const actionRec = require('./action-record');

  // Load latest snapshot for this cwd (matches load_orientation logic).
  const snapRows = stateModule.queryActions({
    type: 'mind_snapshot',
    cwd,
    agent_id,
    limit: 1,
    order: 'desc'
  }) || [];

  // Base: latest mind_state if any, else empty.
  let base;
  let prevSnapshotId = null;
  let prevTimestamp = 0;
  if (snapRows.length > 0) {
    const rec = actionRec.fromRow(snapRows[0]);
    if (rec && rec.output && rec.output.mind_state) {
      // Deep-clone via JSON to avoid mutating the row.
      base = JSON.parse(JSON.stringify(rec.output.mind_state));
      prevSnapshotId = rec.id;
      prevTimestamp = rec.timestamp || 0;
    }
  }
  if (!base) base = emptyMindState(user_id);

  // Query intent records since the last snapshot. If no prev snapshot,
  // use the last 24h as a reasonable bounded window.
  const since = prevTimestamp || (Date.now() - 24 * 60 * 60 * 1000);
  const intentRows = stateModule.queryActions({
    type: 'intent',
    cwd,
    since,
    limit: 50,
    order: 'desc'
  }) || [];

  // The most recent DELIBERATE intent shapes the current_intent's `what` /
  // `why`: a goal read from a verb and its object or set on purpose, one
  // line, short. A fallback intent is the message itself and says nothing
  // about what the work is.
  const deliberate = intentRows.map((r) => actionRec.fromRow(r)).find((rec) => {
    const inp = rec && rec.input;
    if (!inp || inp.extraction === 'fallback_no_verb') return false;
    const g = inp.goal == null ? '' : String(inp.goal);
    return g.length > 0 && g.length <= 200 && g.indexOf('\n') === -1;
  }) || null;
  if (deliberate) {
    const top = deliberate;
    const goal = top && top.input && top.input.goal;
    const constraint = top && top.input && top.input.constraint;
    if (goal || constraint) {
      base.current_intent = base.current_intent || {};
      if (goal)       base.current_intent.what = String(goal).slice(0, 400);
      if (constraint) base.current_intent.why  = String(constraint).slice(0, 400);
      // task_signature derivation (domain/project_id/subgoal) deferred
      // to a later iteration — needs richer signal than a single intent.
    }
  }

  // current_focus from the rule-templated engram that background-worker's
  // `purpose_refresh` task writes every 5 min idle (scope:
  // 'system:current_focus:<projectId>', audience: substrate_internal).
  // mind_state is the materialized view layer; the engram is the source
  // of truth. Reading it here keeps purpose_refresh as the single writer
  // and prevents the dashboard from showing the stale "no focus pinned
  // yet · /goal sets one" message when the substrate IS in fact tracking
  // a focus automatically. First line of the summary ("project: X") is
  // dropped — operator already knows what project they're in; the rest
  // (thesis / open / recent) is the substance.
  if (cwd) {
    try {
      const engram = require('./engram.js');
      const projectId = require('./project-id.js').resolveProjectId(cwd);
      if (projectId && projectId !== '__ephemeral__') {
        const focusRows = engram.listEngrams({
          principal: null,
          audience: 'substrate_internal',
          scope: 'system:current_focus:' + projectId,
          limit: 1,
        }) || [];
        if (focusRows.length > 0 && focusRows[0].statement) {
          // Skip the "project: ..." prefix line so the focus reads as a
          // status summary, not a redundant project tag.
          const lines = String(focusRows[0].statement).split('\n')
            .filter((l) => l && !/^project:\s/i.test(l));
          if (lines.length > 0) {
            base.current_focus = lines.join(' · ').slice(0, 400);
          }
        }
      }
    } catch (_) { /* engram pool may not be initialized in tests; ignore */ }
  }

  // Q2 manual override arm — fold mind_decision events written via
  // troth/mind/record_decision into the appropriate project's
  // key_decisions. Append-only substrate stores them as type='decision'
  // with input.kind='mind_decision'. Cap each project at MAX_DECISIONS
  // most recent to keep token footprint bounded (Q-DECAY work eventually
  // replaces this naive cap with salience-based pruning).
  //
  // V0.2 reconsolidation: when decision A supersedes B, B is marked
  // dead — filtered out from active key_decisions. Both records remain
  // in the substrate (append-only); reconsolidation is a VIEW-time
  // pruning, not a destructive write. Caller can still page-fault any
  // superseded record by id if they need it.
  const MAX_DECISIONS_PER_PROJECT = 10;
  // Surgical kind-filtered query so high-volume substrates (5000+
  // decisions in 30d from loopbreaker / ast_validate / etc.) don't push
  // recent mind_decisions past the LIMIT cap.
  //
  // Window: 30-day decay half-life, NOT `since` (= last snapshot ts).
  // mind_decisions accumulate append-only; if a snapshot is written
  // without folding (e.g. set-project before the decision was recorded,
  // or two snapshots in quick succession with decisions in between),
  // we still want every live decision in the salience window — not
  // just the deltas since the last snapshot.
  const decaySince = Date.now() - (DECAY_HALFLIFE_DAYS * DAY_MS);
  const decisionRows = stateModule.queryActions({
    type: 'decision',
    cwd,
    since: decaySince,
    kind: 'mind_decision',
    limit: 1000,
    order: 'asc'
  }) || [];
  const mindDecisionsByProject = new Map();
  const supersededIds = new Set(); // decision_ids declared dead by some newer decision
  for (const row of decisionRows) {
    const rec = actionRec.fromRow(row);
    if (!rec || !rec.input) continue;
    const sig = rec.input.signals || {};
    const projectId = sig.project_id;
    if (!projectId) continue;
    const supersedes = Array.isArray(sig.supersedes)
      ? sig.supersedes
      : (sig.supersedes ? [sig.supersedes] : []);
    for (const sId of supersedes) {
      if (typeof sId === 'string' && sId) supersededIds.add(sId);
    }
    if (!mindDecisionsByProject.has(projectId)) {
      mindDecisionsByProject.set(projectId, []);
    }
    mindDecisionsByProject.get(projectId).push({
      decision_id: rec.id,
      summary: sig.summary || '(unsummarized)',
      rationale: sig.rationale || '',
      supersedes,
      recorded_at: rec.timestamp
    });
  }
  // V0.2 — Read retrieval-events and count per-project retrievals
  // within the decay half-life window. Used to score decisions by
  // salience instead of pure chronology. Also pick up the latest
  // distillation per project. Two surgical kind-filtered queries
  // (instead of one fat type='decision' pull) so heavy substrate
  // traffic doesn't clip recent mind events past the LIMIT cap.
  // (decaySince hoisted above to share with the decision query.)
  const retrievalEventRows = stateModule.queryActions({
    type: 'decision', cwd, since: decaySince, kind: 'mind_retrieval',
    limit: 1000, order: 'asc'
  }) || [];
  const distillationRows = stateModule.queryActions({
    type: 'decision', cwd, since: decaySince, kind: 'mind_distillation',
    limit: 1000, order: 'asc'
  }) || [];
  const retrievalCountByProject = new Map();
  const latestDistillationByProject = new Map();
  for (const row of retrievalEventRows) {
    const rec = actionRec.fromRow(row);
    if (!rec || !rec.input) continue;
    const sig = rec.input.signals || {};
    const projectIds = Array.isArray(sig.project_ids) ? sig.project_ids : [];
    for (const pid of projectIds) {
      retrievalCountByProject.set(pid, (retrievalCountByProject.get(pid) || 0) + 1);
    }
  }
  for (const row of distillationRows) {
    const rec = actionRec.fromRow(row);
    if (!rec || !rec.input) continue;
    const pid = rec.input.signals && rec.input.signals.project_id;
    const summary = rec.output && rec.output.summary;
    if (pid && summary) {
      const prev = latestDistillationByProject.get(pid);
      if (!prev || (rec.timestamp || 0) > (prev.timestamp || 0)) {
        latestDistillationByProject.set(pid, {
          timestamp: rec.timestamp,
          summary,
          distillation_id: rec.id
        });
      }
    }
  }

  // Merge into base.active_projects[*].key_decisions; filter superseded;
  // sort by salience (recency + retrieval); cap at MAX per project.
  if (Array.isArray(base.active_projects)) {
    const now = Date.now();
    for (const p of base.active_projects) {
      if (!p || !p.id) continue;
      const captured = mindDecisionsByProject.get(p.id) || [];
      const existing = Array.isArray(p.key_decisions) ? p.key_decisions : [];
      // Merge; new captures appended, dedupe by decision_id.
      const seen = new Set(existing.map((d) => d && d.decision_id).filter(Boolean));
      const merged = existing.slice();
      for (const c of captured) {
        if (!seen.has(c.decision_id)) {
          merged.push(c);
          seen.add(c.decision_id);
        }
      }
      // Filter dead (superseded by some newer decision).
      const live = merged.filter((d) => d && !supersededIds.has(d.decision_id));
      // Score each by salience and sort descending. Decisions inherit
      // the project's retrieval count — coarse but captures domain
      // activity (see scoreDecisionSalience comment).
      const projRetrievals = retrievalCountByProject.get(p.id) || 0;
      const scored = live.map((d) => ({
        d,
        salience: scoreDecisionSalience({
          recorded_at: typeof d.recorded_at === 'number' ? d.recorded_at : 0,
          retrievalCount: projRetrievals,
          now
        })
      }));
      scored.sort((a, b) => b.salience - a.salience);
      p.key_decisions = scored.slice(0, MAX_DECISIONS_PER_PROJECT).map((s) => s.d);

      // Surface latest distillation if present.
      const distill = latestDistillationByProject.get(p.id);
      if (distill) {
        p.distilled_summary = distill.summary;
        p.distilled_at = new Date(distill.timestamp).toISOString();
        p.distillation_id = distill.distillation_id;
      }
    }
  }

  base.snapshot_at = new Date().toISOString();
  return {
    mind_state: base,
    prev_snapshot_id: prevSnapshotId,
    intents_seen: intentRows.length,
    decisions_seen: mindDecisionsByProject.size > 0
      ? Array.from(mindDecisionsByProject.values()).reduce((s, arr) => s + arr.length, 0)
      : 0
  };
}

// ── Focused re-orientation block for a topic shift event ────────────────
// Used by the salience switch hook when a topic shift fires: produces
// a SHORT addContext snippet (target <500 tokens) listing only the
// project the shift focused on, with its decisions, open questions, and
// constraints. Caller already has the full orientation from session
// start; this is a delta surface for "agent, here's what matters NOW."
// Returns empty string when there's nothing focused enough to surface.
function formatTopicShiftReorientation(shaped_state, shape_info) {
  if (!shaped_state || !shape_info || !shape_info.matched) return '';
  const projects = Array.isArray(shaped_state.active_projects) ? shaped_state.active_projects : [];
  const hot = projects.find((p) => p && !p._cold);
  if (!hot) return '';

  const lines = ['[troth/mind] Topic shift detected — context re-focused:'];
  const id = hot.name || hot.id;
  const stage = hot.stage ? ' (' + hot.stage + ')' : '';
  lines.push('  Project: ' + id + stage);
  if (hot.current_focus) lines.push('  Current focus: ' + String(hot.current_focus).slice(0, 200));
  if (hot.audience)      lines.push('  Audience: ' + String(hot.audience).slice(0, 120));

  const decisions = Array.isArray(hot.key_decisions) ? hot.key_decisions : [];
  if (decisions.length) {
    lines.push('  Recent decisions:');
    for (const d of decisions.slice(0, 5)) {
      const summary = d && d.summary ? String(d.summary).slice(0, 120) : '(unsummarized)';
      lines.push('    - ' + summary);
    }
  }

  const open = Array.isArray(hot.open_questions) ? hot.open_questions : [];
  if (open.length) {
    lines.push('  Open questions:');
    for (const q of open.slice(0, 5)) {
      lines.push('    - ' + String(q).slice(0, 120));
    }
  }

  const constraints = Array.isArray(hot.constraints) ? hot.constraints : [];
  if (constraints.length) {
    lines.push('  Constraints to respect:');
    for (const c of constraints.slice(0, 5)) {
      lines.push('    - ' + String(c).slice(0, 120));
    }
  }

  return lines.join('\n');
}

// ── Hot/cold shaping per Q3 ──────────────────────────────────────────────
// Take a mind_state and a task_signature. Return a shaped copy where:
//   - Project(s) matching the signature stay HOT (full detail).
//   - Non-matching projects become COLD (name + stage + current_focus
//     only — key_decisions, open_questions, constraints, collaborators
//     stripped).
// Matching rule for v0.1 (simplest path): exact match on project_id. If
// signature.project_id is null/undefined OR no project matches, ALL
// projects stay hot — caller gets the same data shape as load_orientation.
//
// Pure function — does not mutate input. Returns { mind_state, shape_info }
// where shape_info reports counts for observability.
// ── DMN-style cross-project relevance scan ──────────────────────────────
// Given a mind_state, the project the agent is currently focused on,
// and the user's current message, scan OTHER active projects for
// decisions / open_questions that share keyword overlap with the
// current message. Returns at most `topK` cross-project hits, each a
// short note suitable for addContext re-orientation.
//
// Pure function — no IO, no driver, no LLM. Word-overlap based, same
// dependency-free approach as topic-shift / deriveTaskSignature.
//
// Returns array of { project_id, project_name, hits: [{kind, text}] }.
// Empty array means no relevant cross-project context found.
function findCrossProjectRelevance(opts) {
  opts = opts || {};
  const mindState = opts.mind_state || {};
  const currentProjectId = opts.current_project_id || null;
  const message = typeof opts.message === 'string' ? opts.message : '';
  const topK = typeof opts.topK === 'number' ? opts.topK : 2;
  const minOverlap = typeof opts.minOverlap === 'number' ? opts.minOverlap : 2;

  const projects = Array.isArray(mindState.active_projects) ? mindState.active_projects : [];
  if (projects.length === 0 || !message.trim()) return [];

  const STOP = new Set([
    'the','a','an','of','and','to','for','on','in','is','are','was','were',
    'be','been','being','have','has','had','do','does','did','will','would',
    'should','could','can','may','might','this','that','these','those',
    'with','from','by','at','as','it','its','my','our','your','their',
    'i','we','you','they','he','she','them','us','him','her',
    'lets','let','now','then','also','just','about','here','there'
  ]);
  const tokenize = (text) => (typeof text === 'string' ? text : '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t && t.length >= 2 && !STOP.has(t));

  const messageTokens = new Set(tokenize(message));
  if (messageTokens.size === 0) return [];

  function countOverlap(text) {
    let count = 0;
    for (const t of tokenize(text)) if (messageTokens.has(t)) count++;
    return count;
  }

  const results = [];
  for (const p of projects) {
    if (!p || !p.id) continue;
    if (p.id === currentProjectId) continue; // Skip current project — it's already in surface

    const hits = [];
    const decisions = Array.isArray(p.key_decisions) ? p.key_decisions : [];
    for (const d of decisions) {
      const text = (d && (d.summary || (d.input && d.input.signals && d.input.signals.summary))) || '';
      const ov = countOverlap(text);
      if (ov >= minOverlap) {
        hits.push({ kind: 'decision', text: String(text).slice(0, 200), overlap: ov });
      }
    }
    const openQs = Array.isArray(p.open_questions) ? p.open_questions : [];
    for (const q of openQs) {
      const text = typeof q === 'string' ? q : '';
      const ov = countOverlap(text);
      if (ov >= minOverlap) {
        hits.push({ kind: 'open_question', text: String(text).slice(0, 200), overlap: ov });
      }
    }
    if (hits.length > 0) {
      // Sort by overlap descending; cap at 3 hits per project.
      hits.sort((a, b) => b.overlap - a.overlap);
      results.push({
        project_id: p.id,
        project_name: p.name || p.id,
        max_overlap: hits[0].overlap,
        hits: hits.slice(0, 3)
      });
    }
  }

  // Sort projects by their highest-overlap hit, take topK.
  results.sort((a, b) => b.max_overlap - a.max_overlap);
  return results.slice(0, topK);
}

// ── Format DMN cross-project relevance as addContext snippet ─────────────
function formatCrossProjectRelevance(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const lines = ['[troth/mind] Cross-project relevance (DMN push):'];
  for (const r of hits) {
    lines.push('  ' + (r.project_name || r.project_id) + ':');
    for (const h of r.hits) {
      const tag = h.kind === 'decision' ? 'decision' : 'open question';
      lines.push('    - (' + tag + ') ' + h.text);
    }
  }
  return lines.join('\n');
}

// ── Heuristic task signature derivation from prompt text ─────────────────
// Given a freeform prompt and a mind state with known projects, return
// the best-guess task_signature for the prompt: the project whose name
// appears most strongly in the prompt's tokens, plus a rough domain
// classifier and the prompt as subgoal. Returns null when nothing
// matches confidently — caller should NOT make up a signature.
//
// Matching is dependency-free word overlap: more shared distinctive
// tokens between prompt and project.name → stronger match. Stop tokens
// (the/a/an/of/and/to/for/on/in) are filtered out so common words don't
// dominate. If no project's overlap exceeds zero, returns null.
function deriveTaskSignature(prompt, mind_state) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const projects = (mind_state && Array.isArray(mind_state.active_projects))
    ? mind_state.active_projects : [];
  if (projects.length === 0) return null;

  const STOP = new Set([
    'the','a','an','of','and','to','for','on','in','is','are','was','were',
    'be','been','being','have','has','had','do','does','did','will','would',
    'should','could','can','may','might','this','that','these','those',
    'with','from','by','at','as','it','its','my','our','your','their',
    'i','we','you','they','he','she','them','us','him','her',
    'lets','let','now','then','also','just','about','here','there'
  ]);
  const tokenize = (text) => text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t && t.length >= 2 && !STOP.has(t));

  const promptTokens = new Set(tokenize(prompt));
  if (promptTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const p of projects) {
    if (!p || !p.id || !p.name) continue;
    const projectTokens = tokenize(p.name);
    if (projectTokens.length === 0) continue;
    let overlap = 0;
    for (const t of projectTokens) if (promptTokens.has(t)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = p;
    }
  }
  if (!best) return null;

  // Rough domain heuristic: scan for keyword classes. Used downstream
  // by ranking; absent keywords default to "code" since this is a
  // coding-agent substrate.
  const lower = prompt.toLowerCase();
  let domain = 'code';
  if (/\b(market|launch|copy|cta|landing|seo|audience|customer)\b/.test(lower)) domain = 'marketing';
  else if (/\b(test|spec|verify|qa|coverage)\b/.test(lower))                    domain = 'testing';
  else if (/\b(design|wireframe|figma|ui|ux|layout)\b/.test(lower))             domain = 'design';
  else if (/\b(deploy|release|ship|prod|infra|kube)\b/.test(lower))             domain = 'ops';

  return {
    domain,
    project_id: best.id,
    subgoal: prompt.slice(0, 120)
  };
}

function shapeForTask(state, task_signature) {
  const out = JSON.parse(JSON.stringify(state || {}));
  const sig = task_signature || {};
  const targetProjectId = sig.project_id || null;

  let hotCount = 0;
  let coldCount = 0;
  let intentScopeFiltered = false;

  if (Array.isArray(out.active_projects) && targetProjectId) {
    out.active_projects = out.active_projects.map((p) => {
      if (!p || typeof p !== 'object') return p;
      if (p.id === targetProjectId) {
        hotCount++;
        return p; // HOT — full detail preserved
      }
      coldCount++;
      // COLD form — strip detail-heavy fields. Keep id, name, stage,
      // current_focus, audience as identifying skeleton. Page-fault by
      // project id later if agent needs full detail.
      return {
        id: p.id,
        name: p.name,
        stage: p.stage || null,
        current_focus: p.current_focus || null,
        audience: p.audience || null,
        _cold: true
      };
    });
  } else {
    // No targeting → everything stays hot.
    if (Array.isArray(out.active_projects)) hotCount = out.active_projects.length;
  }

  // Scope-isolate current_intent. Caller asked for a specific project scope;
  // an intent recorded under a different (or absent) project scope is
  // cross-context and must not bleed into this task's mind_state. Without
  // this filter, mind_surface returns whatever the latest intent happened
  // to be — including intents from unrelated conversations — causing the
  // consumer to act on context that does not apply.
  if (targetProjectId && out.current_intent) {
    const intentSig = (out.current_intent && out.current_intent.task_signature) || {};
    const intentProjectId = intentSig.project_id || null;
    if (intentProjectId !== targetProjectId) {
      out.current_intent = null;
      intentScopeFiltered = true;
    }
  }

  return {
    mind_state: out,
    shape_info: {
      task_signature: sig,
      hot_projects: hotCount,
      cold_projects: coldCount,
      matched: targetProjectId !== null && hotCount > 0,
      intent_scope_filtered: intentScopeFiltered
    }
  };
}

// ── Distillation (Auto-Dream-style scheduled summarization) ─────────────
// Periodically (or on demand), consolidate a project's recent intent
// records + mind_decision events into a compact `distilled_summary`
// string. Uses an INJECTED LLM driver — substrate code never makes API
// calls directly. Tests pass deterministic mocks; production passes a
// real driver (proxy callFlash, Anthropic SDK, etc.).
//
// Trigger eligibility (enforced by caller, not here): rate-limited by
// last-distillation timestamp + count of new mind_decisions since then.
//
// Pure function in the sense that it builds the prompt + parses the
// driver's response; the actual API call happens via the driver.
//
// Returns { ok, summary, used_decision_ids, prompt } on success or
// { ok: false, reason } on failure / skip.
async function distillProject(opts) {
  opts = opts || {};
  const project = opts.project;
  const decisions = Array.isArray(opts.decisions) ? opts.decisions : [];
  const intents = Array.isArray(opts.intents) ? opts.intents : [];
  if (!project || !project.id) return { ok: false, reason: 'missing_project' };
  if (decisions.length + intents.length < 1) return { ok: false, reason: 'no_signal' };
  if (typeof opts.driver !== 'function') return { ok: false, reason: 'no_driver' };

  // Format the prompt. Keep tight — distillation is a heavy operation,
  // we want the output to fit in 1-2 paragraphs (~200 tokens).
  const decisionLines = decisions.slice(-25).map((d, i) => {
    const sum = (d.summary || d.input && d.input.signals && d.input.signals.summary || '').slice(0, 200);
    const why = (d.rationale || d.input && d.input.signals && d.input.signals.rationale || '').slice(0, 200);
    return '  ' + (i + 1) + '. ' + sum + (why ? ' (because: ' + why + ')' : '');
  });
  const intentLines = intents.slice(-15).map((i, idx) => {
    const goal = (i.goal || i.input && i.input.goal || '').slice(0, 200);
    return '  ' + (idx + 1) + '. ' + goal;
  });
  const prompt = [
    'Project: ' + (project.name || project.id),
    'Stage: ' + (project.stage || 'unknown'),
    'Current focus: ' + (project.current_focus || 'unspecified'),
    '',
    'Recent decisions:',
    decisionLines.length ? decisionLines.join('\n') : '  (none recorded)',
    '',
    'Recent intents:',
    intentLines.length ? intentLines.join('\n') : '  (none recorded)',
    '',
    'Task: write a 2-3 sentence distilled_summary capturing the durable',
    'learnings from this project — what we know works, what we have',
    'rejected, what consistent patterns appear. No fluff. Output ONLY',
    'the summary, no preamble.'
  ].join('\n');

  let response;
  try {
    response = await opts.driver({ prompt, project_id: project.id });
  } catch (e) {
    return { ok: false, reason: 'driver_threw', detail: String(e && e.message || e) };
  }
  const summary = typeof response === 'string'
    ? response.trim()
    : (response && typeof response.summary === 'string' ? response.summary.trim() : '');
  if (!summary) return { ok: false, reason: 'empty_summary' };

  return {
    ok: true,
    summary: summary.slice(0, 800),
    used_decision_ids: decisions.map((d) => d.decision_id || (d && d.id)).filter(Boolean),
    prompt
  };
}

// ── HTTP driver factory for distillProject ──────────────────────────────
// Returns a function suitable as `driver` for distillProject when an
// OpenAI-compatible endpoint is configured. Zero deps — uses Node's
// built-in http/https. Same shape as shared-core/identity.js's
// queryPersona client; kept inline so distillation works without the
// (now-deprecated) Layer B identity HTTP module.
//
// Env-based config:
//   TROTH_MIND_DISTILL_ENDPOINT — base URL (e.g. http://localhost:11434)
//   TROTH_MIND_DISTILL_MODEL    — model name (default: qwen2.5:7b)
//   TROTH_MIND_DISTILL_TIMEOUT  — milliseconds (default 30000)
//
// Returns null if endpoint is unset (caller should treat as "no driver
// available"). The factory is sync; the returned driver is async.
function makeHttpDistillDriverFromEnv(envOverride) {
  const env = envOverride || process.env;
  const endpoint = env.TROTH_MIND_DISTILL_ENDPOINT;
  if (!endpoint) return null;
  const model   = env.TROTH_MIND_DISTILL_MODEL   || 'qwen2.5:7b';
  const timeout = parseInt(env.TROTH_MIND_DISTILL_TIMEOUT, 10) || 30000;

  const http  = require('http');
  const https = require('https');
  const { URL } = require('url');

  return function driver(args) {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: args.prompt }],
      max_tokens: 256,
      temperature: 0.3,
      stream: false
    });
    let url;
    try { url = new URL('/v1/chat/completions', endpoint); }
    catch (e) { return Promise.reject(new Error('bad_endpoint_url')); }

    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('http_status_' + res.statusCode));
          }
          try {
            const parsed = JSON.parse(chunks);
            const text = parsed && parsed.choices && parsed.choices[0]
              && parsed.choices[0].message && parsed.choices[0].message.content;
            if (typeof text !== 'string' || !text.trim()) {
              return reject(new Error('empty_completion'));
            }
            resolve(text.trim());
          } catch (e) { reject(new Error('parse_error')); }
        });
      });
      req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => reject(e));
      req.write(body);
      req.end();
    });
  };
}

// ── Build a distillation-event ActionRecord ─────────────────────────────
// Caller passes the result of distillProject (or hand-built equivalent)
// and gets back a writable type='decision' record with kind='mind_distillation'.
function buildDistillationEventRecord(opts) {
  opts = opts || {};
  const projectId = opts.project_id;
  const summary = typeof opts.summary === 'string' ? opts.summary : '';
  if (!projectId || !summary) return { ok: false, errors: [{ kind: 'missing_field' }] };
  const record = {
    id: opts.id || (typeof require === 'function' ? require('crypto').randomUUID() : ''),
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    type: 'decision',
    agent_id: opts.agent_id || 'distill',
    cwd: opts.cwd || null,
    input: {
      kind: 'mind_distillation',
      signals: {
        project_id: projectId,
        used_decision_ids: Array.isArray(opts.used_decision_ids) ? opts.used_decision_ids : []
      }
    },
    output: {
      decision: 'distilled',
      reason: 'scheduled_distillation',
      summary: summary.slice(0, 800)
    },
    verification: {},
    outcome: {}
  };
  return { ok: true, record };
}

// ── Archive-event factory + helper ──────────────────────────────────────
// Append-only soft archival. We never delete substrate records; instead
// we write a `decision` event with kind='mind_archive' that points at
// an obsolete snapshot id. Query/listing helpers consult these tombstones
// and exclude archived ids from their results. Original records stay
// available for explicit page-fault, audit, and recovery.
function buildArchiveEventRecord(opts) {
  opts = opts || {};
  const archivedSnapshotId = opts.archived_snapshot_id;
  if (!archivedSnapshotId) return { ok: false, errors: [{ kind: 'missing_archived_snapshot_id' }] };
  const reason = typeof opts.reason === 'string' ? opts.reason : 'compact';
  const record = {
    id: opts.id || (typeof require === 'function' ? require('crypto').randomUUID() : ''),
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    type: 'decision',
    agent_id: opts.agent_id || 'archive',
    cwd: opts.cwd || null,
    input: {
      kind: 'mind_archive',
      signals: {
        archived_snapshot_id: archivedSnapshotId,
        reason
      }
    },
    output: {
      decision: 'archived',
      reason
    },
    verification: {},
    outcome: {}
  };
  return { ok: true, record };
}

// Return the Set of snapshot ids that have been archived in the cwd.
// Pure read; cheap to call in tight loops because typical tombstone
// counts are small. Returns an empty Set when no tombstones exist.
function getArchivedSnapshotIds(stateModule, cwd) {
  if (!stateModule || typeof stateModule.queryActions !== 'function') return new Set();
  const actionRecord = require('./action-record');
  const rows = stateModule.queryActions({
    type: 'decision',
    cwd,
    limit: 1000,
    order: 'desc'
  }) || [];
  const out = new Set();
  for (const row of rows) {
    const rec = actionRecord.fromRow(row);
    if (!rec || !rec.input) continue;
    if (rec.input.kind !== 'mind_archive') continue;
    const id = rec.input.signals && rec.input.signals.archived_snapshot_id;
    if (id) out.add(id);
  }
  return out;
}

// ── Build a retrieval-event ActionRecord ────────────────────────────────
// Used by load_orientation / surface to record that the agent (or hook)
// just pulled mind state for a set of projects. Counts feed back into
// salience scoring during the next recompute.
function buildRetrievalEventRecord(opts) {
  opts = opts || {};
  const projectIds = Array.isArray(opts.project_ids) ? opts.project_ids.filter(Boolean) : [];
  const reason = typeof opts.reason === 'string' ? opts.reason : 'mind_load';
  const record = {
    id: opts.id || (typeof require === 'function' ? require('crypto').randomUUID() : ''),
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    type: 'decision',
    agent_id: opts.agent_id || 'unknown',
    cwd: opts.cwd || null,
    input: {
      kind: 'mind_retrieval',
      signals: {
        snapshot_id: opts.snapshot_id || null,
        project_ids: projectIds
      }
    },
    output: {
      decision: 'retrieved',
      reason
    },
    verification: {},
    outcome: {}
  };
  return record;
}

module.exports = {
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
  DECAY_HALFLIFE_DAYS,
  emptyMindState,
  validate,
  buildSnapshotRecord,
  buildRetrievalEventRecord,
  buildDistillationEventRecord,
  buildArchiveEventRecord,
  getArchivedSnapshotIds,
  distillProject,
  makeHttpDistillDriverFromEnv,
  formatOrientation,
  formatTopicShiftReorientation,
  recomputeFromSubstrate,
  hasMeaningfulChanges,
  shapeForTask,
  deriveTaskSignature,
  findCrossProjectRelevance,
  formatCrossProjectRelevance,
  scoreDecisionSalience,
  getSalienceTopK,
  // Exported for tests only.
  _internal: { shortSummary }
};
