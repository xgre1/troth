// SPDX-License-Identifier: AGPL-3.0-only
// Active project + per-scope hierarchical budgets.
//
// Active projects are pre-authorized work scopes that let the partner
// advance work tick-by-tick without per-action operator approval. The
// operator seals an active_project engram naming purpose, scope,
// budget, milestones, expected completion. Partner emits intents that
// reference this project; STVC enforces the project's budget envelope.
//
// Budget model:
//   - Capability engrams carry budget_usd + budget_window_ms (added
//     here to the schema convention; backward-compatible since fields
//     are nullable).
//   - Each observation engram from a dispatched intent CAN carry
//     extra_output.cost_usd (adapter reports cost; substrate believes
//     adapter, audit chain catches lies later).
//   - STVC `budget_remaining_in_scope` computes running spend by
//     summing observation cost_usd within budget_window_ms, refuses
//     the next intent if budget exhausted.
//
// Hierarchical: capability scope hierarchy = budget hierarchy.
//   capability:stripe:*                    budget 100 USD/mo
//     capability:stripe:read:customers     budget  20 USD/mo (subset)
//     capability:stripe:read:balance       budget  10 USD/mo (subset)
// Per-scope budget consults the most-specific matching capability;
// looser capabilities can also impose a cap that the more specific
// inherits implicitly (sub-capability budget cannot exceed parent's).
//
// Engram shape (active_project):
//   class: commitment (engram default)
//   scope: 'active_project:<short_name>'
//   source_authority: 'operator_confirmed' (signed)
//   extra_output: {
//     purpose:              one-line description
//     scope_pattern:        capability-glob this project authorizes
//                           partner to advance within
//     budget_usd:           total project budget
//     budget_window_ms:     window for budget reset
//     expected_completion:  unix ms
//     status:               'active' | 'paused' | 'completed' | 'cancelled'
//     milestones:           [{name, due_ms, completed:bool}]
//   }

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');

const ACTIVE_PROJECT_SCOPE_PREFIX = 'active_project:';

// Write an active_project engram. MUST be operator_confirmed + signed
// (partner cannot mint its own project authority).
function writeActiveProject(opts) {
  opts = opts || {};
  if (!opts.short_name || typeof opts.short_name !== 'string') {
    return { ok: false, error: 'short_name_required' };
  }
  if (!opts.signature) {
    return { ok: false, error: 'signature_required',
             detail: 'active_project is operator-tier — sign via opKey.unlock(passphrase).sign(canonicalEngramBody({...}))' };
  }
  const scope = ACTIVE_PROJECT_SCOPE_PREFIX + opts.short_name;
  const extra_output = {
    purpose:             opts.purpose ? String(opts.purpose).slice(0, 500) : null,
    scope_pattern:       opts.scope_pattern || null,
    budget_usd:          (typeof opts.budget_usd === 'number' && opts.budget_usd > 0)
                           ? opts.budget_usd : null,
    budget_window_ms:    (typeof opts.budget_window_ms === 'number' && opts.budget_window_ms > 0)
                           ? opts.budget_window_ms : null,
    expected_completion: (typeof opts.expected_completion === 'number')
                           ? opts.expected_completion : null,
    status:              opts.status || 'active',
    milestones:          Array.isArray(opts.milestones) ? opts.milestones : []
  };
  if (opts.extra_output && typeof opts.extra_output === 'object') {
    Object.assign(extra_output, opts.extra_output);
  }
  const id = engram.recordEngram({
    agent_id:         opts.agent_id || 'operator',
    user_id:          opts.user_id  || 'operator',
    cwd:              opts.cwd      || null,
    statement:        opts.statement || ('active_project ' + opts.short_name),
    source:           opts.source   || 'operator via writeActiveProject',
    source_authority: 'operator_confirmed',
    scope,
    signature:        opts.signature,
    extra_output,
    auto_verify:      false
  });
  if (!id) return { ok: false, error: 'active_project_write_refused' };
  return { ok: true, id, scope };
}

// Sum cost_usd across observation engrams whose observed_intent's
// scope matches scopeGlob within window. Used by the STVC predicate
// to enforce budget.
//
// scopeGlob: 'capability:stripe:*' or 'capability:stripe:read:customers'
// window_ms: positive number, observations older than (now - window_ms)
//   are excluded.
function spendInScope(scopeGlob, window_ms) {
  if (!scopeGlob) return 0;
  const since = Date.now() - (window_ms || 30 * 24 * 60 * 60 * 1000);
  try {
    const pool = engram.listEngrams({
      principal: null, audience: 'all', scope: 'observation', limit: 1000
    }) || [];
    let sum = 0;
    for (const obs of pool) {
      if (typeof obs.ts === 'number' && obs.ts < since) continue;
      const observedScope = obs.observed_scope ||
        (obs.output && obs.output.observed_scope) || null;
      if (!observedScope) continue;
      if (!_scopeMatches(scopeGlob, observedScope)) continue;
      // cost_usd lives in observation extra_output.result.cost_usd (if
      // the adapter reports it) OR top-level extra_output.cost_usd.
      // The projection currently surfaces neither, so we read raw.
      const cost = _extractCost(obs);
      if (typeof cost === 'number' && cost > 0) sum += cost;
    }
    return sum;
  } catch (_) { return 0; }
}

// scopeGlob 'capability:stripe:*' MATCHES the analogue 'intent:stripe:*'
// translate both sides into a comparable form.
function _scopeMatches(capScopeGlob, observedScope) {
  // observedScope is an intent scope; trim 'intent:' prefix.
  if (typeof observedScope !== 'string') return false;
  const obsTail = observedScope.indexOf('intent:') === 0
    ? observedScope.slice('intent:'.length) : observedScope;
  // capScopeGlob is a capability scope; trim 'capability:' prefix.
  const capTail = (typeof capScopeGlob === 'string' && capScopeGlob.indexOf('capability:') === 0)
    ? capScopeGlob.slice('capability:'.length) : capScopeGlob;
  if (capTail === obsTail) return true;
  if (typeof capTail === 'string' && capTail.endsWith('*')) {
    return obsTail.indexOf(capTail.slice(0, -1)) === 0;
  }
  return false;
}

function _extractCost(obs) {
  // listEngrams projection doesn't surface cost_usd. Fall back to raw.
  try {
    const state = require('./state.js');
    if (!state.getAction) return null;
    const raw = state.getAction(obs.id);
    if (!raw) return null;
    const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
    if (!out) return null;
    if (typeof out.cost_usd === 'number') return out.cost_usd;
    if (out.result && typeof out.result.cost_usd === 'number') return out.result.cost_usd;
    return null;
  } catch (_) { return null; }
}

// STVC predicate: budget_remaining_in_scope. Refuses an intent whose
// scope's resolving capability is over budget within window.
//
// Predicate body: { kind: 'budget_remaining_in_scope' }
// Silent pass for non-intent scopes.
function predicate(_pred, ctx) {
  const r = ctx.proposed || {};
  const out = (r.output && typeof r.output === 'object') ? r.output : null;
  const scope = (out && out.scope) || r.scope || null;
  if (typeof scope !== 'string' || scope.indexOf('intent:') !== 0) return null;
  const capRef = (out && out.capability_ref) || r.capability_ref || null;
  if (!capRef) return null;   // capability_covers_intent handles the missing-ref case
  // Resolve capability + budget.
  let capBudget = null;
  let capWindow = null;
  let capScope = null;
  try {
    const pool = engram.listEngrams({
      principal: null, audience: 'all', limit: 2000
    }) || [];
    const cap = pool.find(e => e.id === capRef);
    if (!cap) return null;     // capability_covers_intent will catch
    capScope = cap.scope;
    // Budget fields not projected; pull raw.
    const state = require('./state.js');
    if (state.getAction) {
      const raw = state.getAction(cap.id);
      if (raw) {
        const o = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
        if (o) {
          if (typeof o.budget_usd === 'number')      capBudget = o.budget_usd;
          if (typeof o.budget_window_ms === 'number') capWindow = o.budget_window_ms;
        }
      }
    }
  } catch (_) { return null; }
  if (typeof capBudget !== 'number' || capBudget <= 0) return null;   // no budget defined → pass
  const window_ms = capWindow || 30 * 24 * 60 * 60 * 1000;
  const spent = spendInScope(capScope, window_ms);
  if (spent >= capBudget) {
    return 'budget_exhausted: scope=' + capScope + ' spent=' + spent.toFixed(2) +
           ' budget=' + capBudget.toFixed(2) + ' window_ms=' + window_ms;
  }
  return null;
}

// Substrate-thesis rule: "operator's
// conversation IS authorization". An operator chat turn with directive
// shape proposes a DRAFT active_project at llm_inferred tier (no
// signature) with status='draft'. The heartbeat doesn't pick it up
// (idle-pursuit filter on status==='active'). Operator confirms via
// confirmDraft(draft_id, signer) which writes a NEW active_project at
// operator_confirmed tier with status='active', using the existing
// session-cached signer (no fresh passphrase). The draft engram stays
// in substrate as an audit trail of the conversational origin.
//
// Call site: substrate's dialogue ingestion path (auto-engram.js or
// equivalent) invokes proposeFromDialogue on each operator turn. This
// module decides whether to write a draft; classifier in
// operator-dialogue-classifier.js does the recognition.
function proposeFromDialogue(operatorText, opts) {
  opts = opts || {};
  const classifier = require('./operator-dialogue-classifier.js');
  const cls = classifier.classify(operatorText, opts);
  if (!cls.detected || !cls.proposed_short_name || !cls.proposed_purpose) {
    return { ok: false, error: 'classifier_did_not_detect_authorization_shape', classifier_result: cls };
  }
  const scope = ACTIVE_PROJECT_SCOPE_PREFIX + cls.proposed_short_name;
  const extra_output = {
    purpose:             cls.proposed_purpose,
    scope_pattern:       opts.scope_pattern || null,
    budget_usd:          (typeof opts.budget_usd === 'number' && opts.budget_usd > 0) ? opts.budget_usd : null,
    budget_window_ms:    (typeof opts.budget_window_ms === 'number' && opts.budget_window_ms > 0) ? opts.budget_window_ms : null,
    expected_completion: null,
    status:              'draft',
    milestones:          [],
    classifier:          {
      confidence: cls.confidence,
      verb: cls.verb,
      subject: cls.subject,
      reasons: cls.reasons,
      origin_text: String(operatorText).slice(0, 500)
    }
  };
  const id = engram.recordEngram({
    agent_id:         opts.agent_id || 'l4-classifier',
    user_id:          opts.user_id  || 'operator',
    cwd:              opts.cwd      || null,
    statement:        'draft active_project: ' + cls.proposed_purpose,
    source:           'operator_dialogue_classifier',
    source_authority: 'llm_inferred',
    scope,
    extra_output,
    auto_verify:      false
  });
  if (!id) return { ok: false, error: 'draft_write_refused' };
  return { ok: true, id, scope, short_name: cls.proposed_short_name, purpose: cls.proposed_purpose, classifier_result: cls };
}

// Confirm a draft active_project: load the draft, build the same shape
// at operator_confirmed tier, sign with the (typically session-cached)
// signer, write via writeActiveProject. Returns { ok, id, scope } of
// the activated project. Substrate-thesis: this is the one-tap
// conversion of operator intent into authorization, using the session
// cache from operator-key so no passphrase prompt is needed.
function confirmDraft(draftEngramId, signer, opts) {
  opts = opts || {};
  if (!draftEngramId) return { ok: false, error: 'draft_engram_id_required' };
  if (!signer || typeof signer.sign !== 'function') return { ok: false, error: 'unlocked_signer_required' };
  let body = null;
  try {
    const state = require('./state.js');
    if (!state.getAction) return { ok: false, error: 'state_module_missing_getAction' };
    const raw = state.getAction(draftEngramId);
    if (!raw) return { ok: false, error: 'draft_not_found: ' + draftEngramId };
    body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
  } catch (e) {
    return { ok: false, error: 'draft_load_failed: ' + (e && e.message || e) };
  }
  if (!body || typeof body !== 'object') return { ok: false, error: 'draft_body_missing' };
  if (typeof body.scope !== 'string' || body.scope.indexOf(ACTIVE_PROJECT_SCOPE_PREFIX) !== 0) {
    return { ok: false, error: 'engram_is_not_an_active_project_scope' };
  }
  if (body.status !== 'draft') {
    return { ok: false, error: 'engram_not_in_draft_status: ' + body.status };
  }
  const shortName = body.scope.slice(ACTIVE_PROJECT_SCOPE_PREFIX.length);
  // Build the operator-tier shape. Preserve classifier provenance + any
  // operator overrides supplied in opts.
  const newExtra = {
    purpose:             opts.purpose || body.purpose || null,
    scope_pattern:       opts.scope_pattern !== undefined ? opts.scope_pattern : (body.scope_pattern || null),
    budget_usd:          (typeof opts.budget_usd === 'number') ? opts.budget_usd : (body.budget_usd || null),
    budget_window_ms:    (typeof opts.budget_window_ms === 'number') ? opts.budget_window_ms : (body.budget_window_ms || null),
    expected_completion: (typeof opts.expected_completion === 'number') ? opts.expected_completion : (body.expected_completion || null),
    status:              'active',
    milestones:          Array.isArray(opts.milestones) ? opts.milestones : (Array.isArray(body.milestones) ? body.milestones : []),
    confirmed_from_draft: draftEngramId,
    classifier:           body.classifier || null
  };
  const canon = opKey.canonicalEngramBody({
    statement:        'active_project ' + shortName,
    scope:            body.scope,
    source_authority: 'operator_confirmed',
    extra_output:     newExtra
  });
  return writeActiveProject({
    short_name:          shortName,
    purpose:             newExtra.purpose,
    scope_pattern:       newExtra.scope_pattern,
    budget_usd:          newExtra.budget_usd,
    budget_window_ms:    newExtra.budget_window_ms,
    expected_completion: newExtra.expected_completion,
    milestones:          newExtra.milestones,
    extra_output:        newExtra,
    signature:           signer.sign(canon),
    statement:           'active_project ' + shortName,
    agent_id:            opts.agent_id || 'operator',
    user_id:             opts.user_id  || 'operator'
  });
}

// Cancel an active_project (draft OR active) by writing a new
// operator-signed engram at the same scope with status='cancelled'.
// Idempotent — calling on an already-cancelled scope writes another
// cancellation marker (cheap; supersession chain preserves audit).
function cancelProject(scopeOrId, signer, opts) {
  opts = opts || {};
  if (!signer || typeof signer.sign !== 'function') return { ok: false, error: 'unlocked_signer_required' };
  // Resolve: accept either an engram id OR a scope string. If it
  // looks like 'active_project:foo', treat as scope; else look up by id.
  let scope = null;
  let shortName = null;
  let body = null;
  try {
    const state = require('./state.js');
    if (typeof scopeOrId === 'string' && scopeOrId.indexOf(ACTIVE_PROJECT_SCOPE_PREFIX) === 0) {
      scope = scopeOrId;
      shortName = scope.slice(ACTIVE_PROJECT_SCOPE_PREFIX.length);
      // Find the most recent engram for this scope to preserve body fields.
      const pool = engram.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];
      const match = pool.find(e => e.scope === scope);
      if (match && state.getAction) {
        const raw = state.getAction(match.id);
        if (raw) body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
      }
    } else {
      // Lookup by id.
      if (!state.getAction) return { ok: false, error: 'state_module_missing_getAction' };
      const raw = state.getAction(scopeOrId);
      if (!raw) return { ok: false, error: 'engram_not_found: ' + scopeOrId };
      body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
      if (!body || typeof body.scope !== 'string') return { ok: false, error: 'engram_body_missing_scope' };
      if (body.scope.indexOf(ACTIVE_PROJECT_SCOPE_PREFIX) !== 0) return { ok: false, error: 'engram_is_not_an_active_project' };
      scope = body.scope;
      shortName = scope.slice(ACTIVE_PROJECT_SCOPE_PREFIX.length);
    }
  } catch (e) {
    return { ok: false, error: 'lookup_failed: ' + (e && e.message || e) };
  }
  if (!scope || !shortName) return { ok: false, error: 'scope_not_resolved' };

  const newExtra = {
    purpose:             (body && body.purpose) || null,
    scope_pattern:       (body && body.scope_pattern) || null,
    budget_usd:          (body && body.budget_usd) || null,
    budget_window_ms:    (body && body.budget_window_ms) || null,
    expected_completion: (body && body.expected_completion) || null,
    status:              'cancelled',
    cancelled_reason:    opts.reason || null,
    milestones:          (body && Array.isArray(body.milestones)) ? body.milestones : []
  };
  const canon = opKey.canonicalEngramBody({
    statement:        'active_project ' + shortName + ' (cancelled)',
    scope:            scope,
    source_authority: 'operator_confirmed',
    extra_output:     newExtra
  });
  return writeActiveProject({
    short_name:          shortName,
    purpose:             newExtra.purpose,
    scope_pattern:       newExtra.scope_pattern,
    budget_usd:          newExtra.budget_usd,
    budget_window_ms:    newExtra.budget_window_ms,
    expected_completion: newExtra.expected_completion,
    milestones:          newExtra.milestones,
    status:              'cancelled',
    extra_output:        newExtra,
    signature:           signer.sign(canon),
    statement:           'active_project ' + shortName + ' (cancelled)',
    agent_id:            opts.agent_id || 'operator',
    user_id:             opts.user_id  || 'operator'
  });
}

// Compact substrate-state snapshot for operator activity surfaces.
// Read-only; reads from engram store + active-project recall; safe to
// call frequently from a polling UI. Returns shapes the Tauri Activity
// tab consumes; CLI `troth activity --json` emits the same shape.
function activitySnapshot(opts) {
  opts = opts || {};
  const limitRecent = Math.max(1, Math.min(50, opts.limit_recent || 10));
  try {
    const pool = engram.listEngrams({ principal: null, audience: 'all', limit: 500 }) || [];

    // Active projects: not cancelled / not completed, hydrated.
    const projects = [];
    const drafts = [];
    const state = require('./state.js');
    for (const ap of pool) {
      if (!ap || typeof ap.scope !== 'string') continue;
      if (ap.scope.indexOf(ACTIVE_PROJECT_SCOPE_PREFIX) !== 0) continue;
      let body = null;
      try {
        if (state.getAction) {
          const raw = state.getAction(ap.id);
          if (raw) body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
        }
      } catch (_) {}
      if (!body) continue;
      const entry = {
        id: ap.id,
        scope: ap.scope,
        short_name: ap.scope.slice(ACTIVE_PROJECT_SCOPE_PREFIX.length),
        purpose: body.purpose || ap.statement || null,
        status: body.status || 'active',
        ts: ap.ts || ap.timestamp || null,
        classifier: body.classifier || null
      };
      if (entry.status === 'draft') drafts.push(entry);
      else if (entry.status === 'active') projects.push(entry);
    }
    // Dedupe projects by scope, newest wins (supersession via repeated writes).
    const projectsByScope = {};
    for (const p of projects) {
      if (!projectsByScope[p.scope] || (p.ts || 0) > (projectsByScope[p.scope].ts || 0)) {
        projectsByScope[p.scope] = p;
      }
    }
    const dedupedProjects = Object.values(projectsByScope);
    const projectsByDraftScope = {};
    for (const d of drafts) {
      if (!projectsByDraftScope[d.scope] || (d.ts || 0) > (projectsByDraftScope[d.scope].ts || 0)) {
        projectsByDraftScope[d.scope] = d;
      }
    }
    // A draft is "open" only if no active engram for the same scope exists
    // (i.e. it wasn't promoted or cancelled yet).
    const openDrafts = Object.values(projectsByDraftScope).filter(d => {
      const moreRecent = pool.find(e =>
        e.scope === d.scope &&
        e.source_authority === 'operator_confirmed' &&
        (e.ts || 0) > (d.ts || 0)
      );
      return !moreRecent;
    });

    // Recent meaningful events: intents + observations + operator_surface
    // engrams ordered DESC by ts, capped. Each event also carries its
    // grounded_in ARRAY so callers can correlate it back to the active
    // project that grounds it (substrate-thesis-correct linkage — the
    // frozen Intent schema uses grounded_in for the project ref, NOT a
    // separate active_project_ref field). Observations inherit the
    // grounded_in of their parent intent via observes_intent traversal.
    const projectIdSet = new Set(dedupedProjects.map(p => p.id));
    const intentsById  = new Map();
    for (const e of pool) {
      if (e && typeof e.scope === 'string' && e.scope.indexOf('intent:') === 0) {
        intentsById.set(e.id, e);
      }
    }
    const events = [];
    for (const e of pool) {
      if (!e || typeof e.scope !== 'string') continue;
      let kind = null;
      if (e.scope.indexOf('intent:') === 0)  kind = 'intent';
      else if (e.scope === 'observation')    kind = 'observation';
      else if (e.scope.indexOf('operator_surface') === 0) kind = 'operator_surface';
      else if (e.scope.indexOf('refusal_reason') === 0)   kind = 'refusal';
      if (!kind) continue;
      // Project correlation via grounded_in. Two paths:
      //   - intent: read its own grounded_in array
      //   - observation: traverse observes_intent → parent intent's grounded_in
      let groundedIn = Array.isArray(e.grounded_in) ? e.grounded_in : [];
      if (kind === 'observation' && e.observes_intent) {
        const parent = intentsById.get(e.observes_intent);
        if (parent && Array.isArray(parent.grounded_in)) {
          groundedIn = parent.grounded_in;
        }
      }
      const matchedProjectIds = groundedIn.filter(id => projectIdSet.has(id));
      events.push({
        id: e.id,
        kind,
        scope: e.scope,
        statement: e.statement,
        ts: e.ts || e.timestamp || null,
        project_ids: matchedProjectIds   // [] when not grounded in any active project
      });
    }
    events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const recent = events.slice(0, limitRecent);

    // Now-state: derive a simple summary.
    let now_state = 'idle';
    if (openDrafts.length > 0) now_state = 'waiting_for_operator';
    else if (dedupedProjects.length > 0) now_state = 'has_active_project';

    return {
      now_state,
      generated_at_ts: Date.now(),
      active_projects: dedupedProjects,
      open_drafts: openDrafts,
      recent_events: recent
    };
  } catch (e) {
    return {
      now_state: 'error',
      error: e && e.message || String(e),
      generated_at_ts: Date.now(),
      active_projects: [],
      open_drafts: [],
      recent_events: []
    };
  }
}

// List all draft active_projects awaiting operator confirmation.
function listDrafts() {
  try {
    const state = require('./state.js');
    const pool = engram.listEngrams({
      principal: null, audience: 'all', limit: 500
    }) || [];
    const out = [];
    for (const ap of pool) {
      if (!ap || typeof ap.scope !== 'string') continue;
      if (ap.scope.indexOf(ACTIVE_PROJECT_SCOPE_PREFIX) !== 0) continue;
      if (ap.source_authority !== 'llm_inferred') continue;
      let body = null;
      try {
        if (state.getAction) {
          const raw = state.getAction(ap.id);
          if (raw) body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
        }
      } catch (_) {}
      if (!body || body.status !== 'draft') continue;
      out.push({
        id:         ap.id,
        scope:      ap.scope,
        short_name: ap.scope.slice(ACTIVE_PROJECT_SCOPE_PREFIX.length),
        purpose:    body.purpose,
        classifier: body.classifier || null,
        ts:         ap.ts || ap.timestamp || null
      });
    }
    return out;
  } catch (_) { return []; }
}

module.exports = {
  writeActiveProject,
  proposeFromDialogue,
  confirmDraft,
  cancelProject,
  listDrafts,
  activitySnapshot,
  spendInScope,
  predicate,
  ACTIVE_PROJECT_SCOPE_PREFIX
};
