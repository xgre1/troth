// coordinator.js — top-level integrator for autonomous goal pursuit.
//
// The piece that makes slices A and B mean something: takes a goal,
// decides act-vs-ask per transparency level + confidence, dispatches
// step-engine under capability scope + budget cap, runs reflection,
// emits a briefing. The L1+L2 + subsystem + subsystem + substrate walls walls
// flow through here.
//
// (design ref) §4.3 Coordinator entry: handle_inline / delegate / ask_user
// / abort. Decision 2 transparency: show_plan_and_approve for first
// N runs of a goal class, auto-promote to execute_and_brief at ≥8/10
// success.
//
// API:
//   coordinate({ goal_text, goal_class?, goal_id?, ctx, options }) →
//     { decision, briefing?, plan?, reasoning, reflection?, snapshot,
//       goal_class, goal_id? }
//
// decision values:
//   'disabled_by_config'   — l4.enabled=false; coordinator stayed quiet
//   'no_providers'         — l4.enabled=true but verifyCanEnable false
//   'pending_approval'     — transparency=show_plan_and_approve; plan returned
//   'executed'             — work done; briefing returned
//   'execution_failed'     — step-engine aborted (budget/error/loop)
//
// options:
//   force_execute: true — bypass transparency gate (operator pressed go)
//   ask_only:      true — return plan only, never execute even on
//                          execute_and_brief setting (UI prefill case)

const l4cfg     = (function(){try{return require('./l4-config.js')}catch(e){return {isEnabled:()=>false,DEFAULTS:{},getL4Config:()=>({enabled:false}),getBudgetForClass:()=>1000,getTransparencyForClass:()=>'show'}}}());
const classifier = require('./goal-class-classifier.js');
const calibrator = require('./confidence-calibrator.js');
const registry   = require('./goal-class-registry.js');
const budgetMod  = require('./budget-warden.js');
const stepEngine = require('./step-engine.js');
const reflectMod = require('./reflection.js');
const goalStatus = require('./goal-status.js');

// Confidence threshold below which transparency stays at show_plan_and_approve
// even after the auto-promote window. Tunable via l4-config in v2; hardcoded
// at 0.80 per Decision 2 default ("≥8/10 success").
const AUTO_PROMOTE_CONFIDENCE = 0.80;
const AUTO_PROMOTE_MIN_ATTEMPTS = 10;

function _resolveTransparency(goalClass) {
  // Per-class override beats global beats default.
  const configured = l4cfg.getTransparencyForClass(goalClass);
  // Empirical promote check: if global is show_plan_and_approve but the
  // class has ≥10 attempts and ≥0.80 confidence, behave as execute_and_brief.
  // This implements the Decision 2 auto-promotion without operator action.
  if (configured === 'show_plan_and_approve') {
    const stats = calibrator.getStats(goalClass);
    if (stats && stats.attempt_count >= AUTO_PROMOTE_MIN_ATTEMPTS &&
        stats.confidence >= AUTO_PROMOTE_CONFIDENCE) {
      return 'execute_and_brief';
    }
  }
  return configured;
}

function _buildPlan(goalClass) {
  const steps = registry.getClassSteps(goalClass);
  return {
    goal_class: goalClass,
    steps: steps.map(s => ({
      name:          s.step_name,
      order:         s.step_order,
      worker_role:   s.worker_role,
      allowed_tools: s.allowed_tools,
      forbidden_tools: s.forbidden_tools,
      max_iterations: s.max_iterations
    }))
  };
}

// §15.1 — the job PROPOSAL CARD: what the partner shows the operator before
// an autonomous job runs. Scope = the plan's step names; inputs = the union
// of tools those steps may use; tier = which faculty planning/execution will
// actually route to (§15.2 floor included); budget = the class budget;
// readiness = what the partner would still want to know (never hard-blocks).
// User-facing engine line for the job card, in OPERATOR vocabulary. The run
// rides the operator's own provider chain; name the tool-capable head of that
// chain and its fallback so what the card says is what runs ("model: router
// default" told the operator nothing, 2026-07-05). Mirrors the proxy router's
// QUALITY_RANK order. Fail-open to null - the card just omits the line.
function _engineLabel() {
  try {
    const fs = require('fs'); const path = require('path'); const os = require('os');
    const cfg = JSON.parse(fs.readFileSync(path.join((process.env.HOME || os.homedir()), '.troth', 'config.json'), 'utf8'));
    const provs = cfg.providers || {};
    const LABELS = {
      openai_sub: 'ChatGPT (subscription)', anthropic: 'Claude (API)',
      openrouter: 'OpenRouter', google_ai: 'Google Gemini',
      deepseek: 'DeepSeek', alibaba: 'Qwen (Alibaba)'
    };
    const RANK = ['openai_sub', 'anthropic', 'openrouter', 'google_ai', 'deepseek', 'alibaba'];
    const enabled = RANK.filter((n) => provs[n] && provs[n].enabled);
    const localOn = !!(provs.local && provs.local.enabled);
    const head = enabled.length ? LABELS[enabled[0]] : (localOn ? 'Local' : null);
    if (!head) return null;
    const fallback = enabled.length && localOn ? 'Local' : (enabled[1] ? LABELS[enabled[1]] : null);
    return fallback ? head + ' \u00b7 falls back to ' + fallback : head;
  } catch (_) { return null; }
}

function _buildJobCard(goalText, goalClass, plan, classification) {
  let budget = null;
  try { budget = l4cfg.getBudgetForClass(goalClass); } catch (_) {}
  const planningFaculty = l4cfg.getProviderForClass('autonomous-planning') || null;
  const execFaculty = l4cfg.getProviderForClass(goalClass) || null;
  const steps = (plan && plan.steps) || [];
  const inputs = Array.from(new Set(steps.flatMap(s => s.allowed_tools || [])));
  let readiness = null;
  try {
    readiness = require('./autonomy-readiness.js').contextSufficiency({
      goal_text: goalText,
      confidence: classification && typeof classification.confidence === 'number'
        ? classification.confidence : null
    });
  } catch (_) {}
  return {
    goal_text:  goalText.slice(0, 300),
    goal_class: goalClass,
    scope:      steps.map(s => s.name),
    inputs,
    budget_usd: budget,
    model_tier: {
      planning:  planningFaculty || execFaculty || 'router default',
      execution: execFaculty || 'router default'
    },
    engine_label: _engineLabel(),
    readiness
  };
}

function _composeBriefing(execResult, reflection, transparencyLevel) {
  const lines = [];
  lines.push(execResult.briefing);
  if (reflection && reflection.concerns && reflection.concerns.length) {
    lines.push('Reflection — ' + reflection.concerns.length + ' concern(s) [' + reflection.confidence_text + ']:');
    for (const c of reflection.concerns.slice(0, 5)) lines.push('  · ' + c);
  } else if (reflection && reflection.ok) {
    lines.push('Reflection — no concerns [' + reflection.confidence_text + ']');
  }
  if (reflection && reflection.faculty_warning) {
    lines.push('(' + reflection.faculty_warning + ')');
  }
  lines.push('Mode: ' + transparencyLevel);
  return lines.join('\n');
}

async function coordinate(opts) {
  opts = opts || {};
  const goalText = String(opts.goal_text || '').trim();
  const ctx      = opts.ctx || {};
  const options  = opts.options || {};

  if (!goalText) {
    return { decision: 'bad_args', reasoning: 'goal_text required' };
  }

  // Gate 1: master config flag. Coordinator silently no-ops when L4
  // autonomous mode is OFF. Caller (entity / chat / app) treats this
  // as "fall through to normal chat behavior."
  if (!l4cfg.isEnabled()) {
    return {
      decision:  'disabled_by_config',
      reasoning: 'l4.enabled=false. Run: troth config l4 enable',
      goal_class: null
    };
  }

  // Gate 1.5 (#30): operator kill-switch (global_pause). The STVC intent path
  // (writeIntent / dispatcher) already refuses paused intents, but the
  // autonomous WORLDLY-TOOL path (coordinator -> step-engine -> tools) does NOT
  // go through writeIntent — so without this, hitting the emergency brake left
  // tool execution running. Autonomous-only (from_idle_pursuit); fail-CLOSED: a
  // pause-state read error is treated as PAUSED (safer for a kill switch).
  if (ctx && ctx.from_idle_pursuit) {
    let paused = false, pauseReason = '';
    try {
      const gp = require('./global-pause.js');
      if (gp.isPaused()) {
        paused = true;
        const ap = gp.activePause();
        pauseReason = (ap && (ap.reason || (ap.output && ap.output.reason))) || '';
      }
    } catch (_) { paused = true; pauseReason = 'global_pause_module_unavailable'; }
    if (paused) {
      return {
        decision:  'globally_paused',
        reasoning: 'operator global_pause active' + (pauseReason ? (': ' + pauseReason) : '') +
                   ' — autonomous pursuit refused',
        goal_class: null
      };
    }
  }

  // Gate 1.6 (#49): autonomous engine-exhaustion pause. When a prior tick found
  // ALL engines exhausted (rate-limit / out-of-credit / auth), we recorded a
  // resumable pause with an exponential-backoff resume_at. Skip pursuit until it
  // elapses (or the operator resumes) instead of hammering dead providers every
  // tick. Autonomous-ONLY; reactive chat/voice never read this. Fail-OPEN: a read
  // error should let the tick TRY (worst case it re-pauses), never stall autonomy.
  if (ctx && ctx.from_idle_pursuit) {
    try {
      const ap = require('./autonomous-pause.js');
      const st = ap.status();
      if (st.paused) {
        return {
          decision:  'autonomous_paused',
          reasoning: 'engines exhausted (' + st.errorClass + '); autonomous pursuit waiting ~' +
                     st.resumeInMin + 'min before retry (resume or refill in Settings to retry now)',
          goal_class: null
        };
      }
      // Backoff elapsed: tidy the stale marker once, then let this tick retry.
      if (st.expired) { try { ap.clear({ reason: 'backoff_elapsed' }); } catch (_) {} }
    } catch (_) { /* fail-open: never stall autonomy on a pause-read error */ }
  }

  // Gate 2: provider availability. Even when enabled, providers can be
  // disabled in the dashboard. Coordinator refuses to dispatch rather
  // than fail with a 401 mid-task.
  const ver = l4cfg.verifyCanEnable();
  if (!ver.ok) {
    return {
      decision:  'no_providers',
      reasoning: ver.detail,
      goal_class: null
    };
  }

  // Classification — caller may pre-classify; if not, run the regex
  // classifier. Bumps attempt_count via the existing /goal slash flow
  // when caller did that already, so we don't double-count.
  let goalClass = opts.goal_class || null;
  let classification = null;
  if (!goalClass) {
    classification = classifier.classify(goalText);
    goalClass = classification.class || 'chat';
  }

  // Gate 3 (D3): cumulative cost circuit-breaker — AUTONOMOUS path ONLY.
  // Per-task budget-wardens cap a single pursuit; this caps ROLLING spend across
  // ALL pursuits (hourly/daily/weekly/per-domain) so a 30s heartbeat can't bleed
  // the wallet for hours. Read-only over l4_cost_events; on trip it files an
  // operator_request and REFUSES this pursuit, leaving the goal OPEN (no
  // markSatisfied/markAbandoned) so it resumes once the operator lifts the cap or
  // the window rolls over. Scoped to from_idle_pursuit so reactive chat/voice is
  // NEVER gated. Best-effort: a breaker read error must not block autonomy (the
  // D6 run-tracker is the in-process backstop).
  if (ctx && ctx.from_idle_pursuit) {
    try {
      const breaker = require('./cost-circuit-breaker.js');
      const caps = (l4cfg.getL4Config() || {}).cost_caps || {};
      const capsActive = caps && (caps.hourly_usd != null || caps.daily_usd != null ||
        caps.weekly_usd != null || (caps.per_domain && Object.keys(caps.per_domain).length));
      if (capsActive) {
        const bt = breaker.chargeOrTrip({
          caps,
          goal_id:              opts.goal_id || null,
          goal_class:           goalClass,
          class_to_domain:      caps.class_to_domain,
          per_domain_window_ms: caps.per_domain_window_ms
        });
        if (bt && bt.trip) {
          return {
            decision:   'cost_circuit_tripped',
            reasoning:  'cost circuit-breaker tripped (' + (bt.broken || []).join(', ') +
                        ') — pursuit paused; operator approval filed',
            goal_class: goalClass,
            goal_id:    opts.goal_id || null,
            broken:     bt.broken,
            details:    bt.details,
            request_id: bt.request_id
          };
        }
      }
    } catch (_) { /* never block autonomy on a breaker read error; D6 backstops */ }
  }

  // bootstrap subsystem — goal-class bootstrap. When the classifier could not place
  // the goal with confidence (fallback_to_llm=true), do NOT silently route
  // to 'chat' and burn a partner turn on a generic response. File an
  // operator_request{kind:'approval', detail.classify=true} with the top
  // candidates so the operator can pick a class (or invent one) before the
  // partner spends budget. Coordinator returns pending_approval and the
  // dashboard surfaces it as a one-click classification gate. This closes
  // the "I have no idea what kind of goal this is" silent-fallback hole.
  // Trigger conditions:
  //   (a) classifier explicitly flagged fallback_to_llm (best class had a
  //       weak signal — borderline match), OR
  //   (b) zero signal at all (best.score=0 → confidence=0 → routed to
  //       DEFAULT_CLASS by exhaustion).
  // We gate only when this call looks like a real goal pursuit
  // (opts.goal_id set OR from_idle_pursuit), so chitchat turns from
  // troth-chat that happen to score zero ("hello", "thanks") fall
  // through to the chat class normally.
  const _classWasFallback = !!classification && (
    classification.fallback_to_llm === true ||
    (typeof classification.confidence === 'number' && classification.confidence === 0)
  );
  const _gateThisCall = !!(opts.goal_id || (ctx && ctx.from_idle_pursuit));
  if (_classWasFallback && _gateThisCall && !opts.goal_class) {
    // ONE classify-request per goal while it stays pending. The idle ticker
    // re-coordinates the same unclassified goal every tick; without this
    // guard each tick filed a NEW inbox row + a NEW briefing row and the
    // surfaces re-notified forever (the operator's "prints 100 times" CLI
    // spam, reproduced by E2E-2 on 2026-07-04).
    let _alreadyFiled = false;
    try {
      const state = require('./state.js');
      const pending = (state && typeof state.listOperatorRequests === 'function')
        ? (state.listOperatorRequests({ status: 'pending', limit: 200 }) || [])
        : [];
      const gtxt = goalText.slice(0, 600);
      _alreadyFiled = pending.some((r) => r && r.detail && r.detail.classify === true && (
        (opts.goal_id && r.goal_id === opts.goal_id) ||
        (r.detail.goal_text === gtxt)
      ));
    } catch (_) { /* dedup probe best-effort — fall through to filing */ }
    if (_alreadyFiled) {
      return {
        decision:    'pending_approval',
        reasoning:   'classifier_fallback_already_filed',
        goal_class:  classification.class || null,
        classification,
        transparency: _resolveTransparency(classification.class || 'chat'),
        plan:        null,
        briefing:    null, // surfaces already told the operator once
        stats:       calibrator.getStats(classification.class || 'chat')
      };
    }
    try {
      const state = require('./state.js');
      const reg = require('./goal-class-registry.js');
      const knownClasses = reg.listClasses();
      if (state && typeof state.recordOperatorRequest === 'function') {
        state.recordOperatorRequest({
          goal_id:    opts.goal_id || null,
          goal_class: classification.class || 'unknown',
          kind:       'approval',
          urgency:    'normal',
          detail: {
            classify:       true,
            goal_text:      goalText.slice(0, 600),
            suggested_class: classification.class || null,
            confidence:     classification.confidence || 0,
            candidates:     knownClasses,
            matched:        Array.isArray(classification.matched) ? classification.matched.slice(0, 5) : []
          }
        });
      }
    } catch (_) { /* escalation best-effort */ }
    const briefingMsg = 'Goal "' + goalText.slice(0, 120) + '..." did not match any known class with confidence. Filed approval request — operator picks the class (or invents one) from the inbox.';
    try {
      const state = require('./state.js');
      if (state && typeof state.recordBriefing === 'function') {
        state.recordBriefing({
          goal_id:    opts.goal_id || null,
          goal_class: classification.class || 'unknown',
          decision:   'pending_approval',
          briefing:   briefingMsg,
          success:    false,
          classification_text: classification.class + ':' + (classification.confidence || 0) + ':fallback'
        });
      }
    } catch (_) {}
    return {
      decision:    'pending_approval',
      reasoning:   'classifier_fallback',
      goal_class:  classification.class || null,
      classification,
      transparency: _resolveTransparency(classification.class || 'chat'),
      plan:        null,
      briefing:    briefingMsg,
      stats:       calibrator.getStats(classification.class || 'chat')
    };
  }

  // Gate 3: per-class idle-pursuit override. When idle-pursuit triggered
  // this call (ctx.from_idle_pursuit) and the class has idle_pursuit
  // disabled at per-class level, refuse. Operator can disable pursuit
  // on email_send class while leaving research enabled.
  // options.force_execute = the operator explicitly ran THIS job (SS15.1
  // card) — that overrides the per-class idle-pursuit convenience switch,
  // never the safety walls above (kill-switch, pauses, cost caps).
  if (ctx.from_idle_pursuit && !options.force_execute && !l4cfg.isClassIdlePursuitEnabled(goalClass)) {
    return {
      decision:  'class_pursuit_disabled',
      reasoning: 'idle pursuit disabled for class "' + goalClass + '"',
      goal_class: goalClass
    };
  }

  // SS15.4-lite: an operator-paused goal is refused until resumed. The
  // operator's explicit RUN (force_execute) doubles as resume — pressing
  // Run on a paused job is an unambiguous 'go'.
  if (opts.goal_id && !options.ask_only) {
    try {
      const gs = require('./goal-status.js');
      if (gs.isPaused(opts.goal_id)) {
        if (options.force_execute) {
          gs.markResumed({ goal_id: opts.goal_id, agent_id: (ctx && ctx.agent_id) || null, cwd: (ctx && ctx.cwd) || null, reason: 'operator_run' });
        } else {
          return {
            decision:   'goal_paused',
            reasoning:  'goal paused by the operator — resume it (or Run it) to continue',
            goal_class: goalClass,
            goal_id:    opts.goal_id
          };
        }
      }
    } catch (_) { /* a pause read error must never block a pursuit */ }
  }

  const transparency = _resolveTransparency(goalClass);

  // §15.1 partner-first gate: an autonomous job NEVER fires straight off a
  // fresh ask. The FIRST-ever coordinate() touch of a goal (no prior
  // l4_briefings row) returns the proposal CARD as pending_approval — even
  // when the class earned execute_and_brief promotion or the operator
  // configured it. The operator's explicit run arrives as
  // options.force_execute; re-touches of already-briefed goals keep the
  // earned transparency semantics. hasBriefingForGoal fails CLOSED (fresh),
  // so a state error proposes instead of silently executing.
  let freshAsk = false;
  if (!options.force_execute && !options.ask_only && opts.goal_id) {
    try {
      const state = require('./state.js');
      freshAsk = typeof state.hasBriefingForGoal === 'function'
        ? !state.hasBriefingForGoal(opts.goal_id)
        : true;
    } catch (_) { freshAsk = true; }
  }

  // Gate 4: transparency level. show_plan_and_approve → return plan,
  // wait for operator. execute_and_brief → proceed. force_execute
  // overrides (operator already approved via UI). freshAsk (§15.1)
  // forces the proposal step regardless of transparency.
  if (!options.force_execute && (options.ask_only || freshAsk || transparency === 'show_plan_and_approve')) {
    const plan = _buildPlan(goalClass);
    const jobCard = _buildJobCard(goalText, goalClass, plan, classification);
    // briefing subsystem — log even non-executed decisions so the dashboard can
    // show "partner saw goal X, waiting for approval" instead of going
    // silent until operator clicks.
    try {
      const state = require('./state.js');
      if (state && typeof state.recordBriefing === 'function') {
        state.recordBriefing({
          goal_id:    opts.goal_id || null,
          goal_class: goalClass,
          decision:   'pending_approval',
          briefing:   'Goal classified as ' + goalClass + '; waiting for operator approval (transparency=' + transparency + ').',
          success:    false,
          classification_text: classification
            ? (classification.class + ':' + (classification.confidence || 0))
            : null
        });
      }
    } catch (_) {}
    return {
      decision:    'pending_approval',
      reasoning:   options.ask_only
        ? 'caller requested plan-only'
        : freshAsk
          ? 'fresh_ask: first touch of this goal proposes a job card (§15.1); run it explicitly to execute'
          : 'transparency=show_plan_and_approve; auto-promotion not yet reached',
      fresh_ask:   freshAsk,
      goal_class:  goalClass,
      goal_id:     opts.goal_id || null,
      classification,
      transparency,
      plan,
      job_card:    jobCard,
      stats:       calibrator.getStats(goalClass)
    };
  }

  // Gate 4 (D6): run-level budget backstop — a SINGLE in-process wallet for the
  // whole autonomous run (created on the daemon, accumulates ACROSS ticks since
  // the mind survives via B3). Immune to ledger-write failure (Knight-Capital
  // out-of-process pattern): even if l4_cost_events writes fail and D3's rolling
  // check reads $0, this monotonic counter still hard-stops. Refuse before any
  // spend when exhausted; leave the goal OPEN.
  if (ctx && ctx.run_tracker) {
    try { ctx.run_tracker.precheck(); }
    catch (e) {
      if (e instanceof budgetMod.BudgetExceeded) {
        return {
          decision:   'run_budget_exhausted',
          reasoning:  'run-level budget backstop exhausted (' +
                      ((e.detail && e.detail.spent_usd) || '?') + '/' +
                      ((e.detail && e.detail.budget_usd) || '?') +
                      ' usd) — autonomous run paused; restart to reset',
          goal_class: goalClass,
          goal_id:    opts.goal_id || null,
          snapshot:   e.detail || null
        };
      }
      /* unknown error — never block on the backstop itself */
    }
  }

  // Execute path: build budget tracker, run step-engine, run reflection,
  // record attempt outcome to calibrator, return briefing.
  const tracker = budgetMod.makeTracker({
    goal_class: goalClass,
    // cost-event subsystem — persistence: chain charges to the goal so cost_24h can
    // attribute spend. agent_id falls back to a stable string so audit
    // queries can filter "what did the partner spend".
    goal_id:    opts.goal_id || null,
    agent_id:   (ctx && ctx.agent_id) || 'l4-partner'
  });

  // D.2 — per-class provider routing. If operator configured
  // providers_per_class for this class AND caller provided the
  // orchestrators map, pick that provider. Otherwise fall back to
  // ctx.orchestrator (single instance the caller chose).
  let orchestrator = ctx.orchestrator;
  const preferredFaculty = l4cfg.getProviderForClass(goalClass);
  // §15.2 MODEL FLOOR: when the class has no explicit provider, prefer the
  // autonomous-planning faculty over "whatever is first" — the run's
  // planning must never land on the cheap bulk lane by accident. (Per-STEP
  // planning/execution split is a later step-engine change; the ledger
  // tracks it. The job card shows this same resolution, so what the
  // operator approved is what runs.)
  const planningFaculty = l4cfg.getProviderForClass('autonomous-planning');
  if (preferredFaculty && ctx.orchestrators && ctx.orchestrators[preferredFaculty]) {
    orchestrator = ctx.orchestrators[preferredFaculty];
  } else if (planningFaculty && ctx.orchestrators && ctx.orchestrators[planningFaculty]) {
    orchestrator = ctx.orchestrators[planningFaculty];
  } else if (!orchestrator && ctx.orchestrators) {
    // No ctx.orchestrator and no class/planning match — use any available.
    const names = Object.keys(ctx.orchestrators);
    if (names.length) orchestrator = ctx.orchestrators[names[0]];
  }

  if (!orchestrator) {
    return {
      decision:  'no_orchestrator',
      reasoning: 'ctx.orchestrator (or ctx.orchestrators map) required for execute path',
      goal_class: goalClass
    };
  }
  // Surface which faculty was picked so the briefing can show it.
  const facultyPicked = preferredFaculty && ctx.orchestrators && ctx.orchestrators[preferredFaculty]
    ? preferredFaculty
    : 'default';

  // implementation step2.3 recovery loop: when step-engine returns a failure with
  // a classified recovery.action, the coordinator can re-attempt per
  // policy. Strict caps to avoid runaway:
  //   retry_with_backoff      — up to MAX_TRANSIENT_RETRIES (2), sleeps
  //                             per recovery.backoff_ms between attempts
  //   replan_with_feedback    — up to MAX_REPLANS (1) by default
  //                             (Shinn 2303.11366 §4.3: 1-2 iterations
  //                             give most of the lift); injects critic
  //                             concerns + classifier reason into goal
  //                             text as Reflexion verbal reinforcement
  //   escalate_operator_request — no re-attempt; loop exits, caller
  //                             handles via existing operator_request
  // Opt-in via opts.allow_recovery !== false (default ON for coord
  // callers; OFF when ctx.disable_recovery is truthy — used by tests +
  // operator-driven 'one-shot' invocations).
  const MAX_TRANSIENT_RETRIES = (opts.max_transient_retries != null) ? opts.max_transient_retries : 2;
  const MAX_REPLANS           = (opts.max_replans          != null) ? opts.max_replans           : 1;
  const recoveryAllowed = opts.allow_recovery !== false && !ctx.disable_recovery;
  let transientRetries = 0;
  let replanCount      = 0;
  let augmentedGoalText = goalText;

  // D1 — mark this goal in-progress before dispatch so a crash differs from
  // never-started and the next tick's topGoal keeps returning to it (continuity)
  // instead of re-selecting a fresh goal. Satisfied/abandoned (below) supersede
  // it; D5 backoff ages out a stuck one. Autonomous-only.
  if (opts.goal_id && ctx && ctx.from_idle_pursuit) {
    try {
      goalStatus.markInProgress({
        goal_id:  opts.goal_id,
        agent_id: ctx.agent_id || null,
        cwd:      ctx.cwd || null,
        step_index: 0,
        briefing: goalText.slice(0, 200)
      });
    } catch (_) { /* in-progress marker is best-effort */ }
  }

  let execResult;
  while (true) {
    try {
      execResult = await stepEngine.runGoalSteps({
        goal_text:      augmentedGoalText,
        goal_class:     goalClass,
        goal_id:        opts.goal_id || null,
        budget_tracker: tracker,
        ctx
      });
    } catch (e) {
      calibrator.recordAttempt(goalClass, { success: false });
      return {
        decision:  'execution_failed',
        reasoning: 'step_engine_threw: ' + String(e && e.message || e),
        goal_class: goalClass,
        snapshot:   tracker.snapshot()
      };
    }

    // #49 — engine exhaustion is INFRASTRUCTURE, not a goal failure. If every
    // provider was exhausted (rate-limit / credit / auth, and the in-chain local
    // backend too), do NOT spend retries, record a failed attempt, or abandon the
    // goal. Record a resumable pause and bail EARLY (before the D5 failed-attempt
    // path below): the goal stays open and is retried on a later tick once engines
    // recover (auto-backoff) or the operator resumes.
    {
      const _exStep = (execResult && execResult.steps && execResult.steps.length)
        ? execResult.steps[execResult.steps.length - 1] : null;
      const _exReason = String((_exStep && _exStep.reason) || (execResult && execResult.abort_reason) || '');
      if (execResult && !execResult.ok && _exReason.indexOf('providers_exhausted') !== -1) {
        let info = { errorClass: 'exhausted', resumeInMin: 5, resumeAt: 0 };
        try {
          info = require('./autonomous-pause.js').pauseForExhaustion({
            goal_id: opts.goal_id || null, goal_class: goalClass,
            agent_id: ctx && ctx.agent_id, cwd: ctx && ctx.cwd
          });
        } catch (_) { /* pause persistence best-effort */ }
        // D6 — fold this tick's spend into the run-level wallet BEFORE bailing,
        // so the monotonic cross-tick budget backstop still sees it (the early
        // return would otherwise skip the post-loop D6 charge).
        if (ctx && ctx.run_tracker) {
          try {
            const _snap = tracker.snapshot();
            if (_snap && _snap.spent_usd > 0) ctx.run_tracker.charge({ usd: _snap.spent_usd });
          } catch (_) { /* backstop charge best-effort */ }
        }
        return {
          decision:    'autonomous_paused',
          reasoning:   'All engines exhausted (' + info.errorClass + '). Paused; auto-retries in ~' +
                       info.resumeInMin + 'min, or resume/refill in Settings.',
          goal_class:  goalClass,
          goal_id:     opts.goal_id || null,
          paused_reason: info.errorClass,
          resume_at:   info.resumeAt,
          just_paused: true,
          snapshot:    tracker.snapshot()
        };
      }
    }

    if (!recoveryAllowed) break;
    if (execResult && execResult.ok) break;

    // Find the failed step's classification (the aborted step is the
    // last one in execResult.steps).
    const lastStep = (execResult && execResult.steps && execResult.steps.length)
      ? execResult.steps[execResult.steps.length - 1] : null;
    const rec = lastStep && lastStep.failure_classification && lastStep.failure_classification.recovery;
    if (!rec || !rec.action) break;

    // implementation step wire — append to failure ledger so decomposer can
    // observe threshold (>=2 failures of same class+category in 1h).
    // Best-effort; never blocks the loop.
    try {
      const state = require('./state.js');
      if (state && typeof state.recordFailureEvent === 'function') {
        state.recordFailureEvent({
          goal_id:          opts.goal_id || null,
          goal_class:       goalClass,
          failure_category: lastStep.failure_classification.category,
          failure_reason:   lastStep.failure_classification.reason,
          recovery_action:  rec.action,
          step_name:        lastStep.name,
          worker_role:      (lastStep && lastStep.worker_role) || null
        });
      }
    } catch (_) { /* ledger write is best-effort */ }

    if (rec.action === 'retry_with_backoff' && transientRetries < MAX_TRANSIENT_RETRIES) {
      transientRetries++;
      const sleepMs = Math.max(0, Math.min(30000, rec.backoff_ms || 1000));
      await new Promise(r => setTimeout(r, sleepMs));
      continue;
    }

    if (rec.action === 'replan_with_feedback' && replanCount < MAX_REPLANS) {
      replanCount++;
      const hintParts = [];
      const cv = lastStep.critic_verdict;
      if (cv && cv.replan_hint) hintParts.push(cv.replan_hint);
      else if (cv && Array.isArray(cv.concerns) && cv.concerns.length) {
        hintParts.push('Previous attempt issues: ' + cv.concerns.join(' | '));
      }
      if (lastStep.failure_classification.reason) {
        hintParts.push('Classifier reason: ' + lastStep.failure_classification.reason);
      }
      if (lastStep.reason) hintParts.push('Step reason: ' + String(lastStep.reason).slice(0, 200));
      const hint = hintParts.length ? hintParts.join(' || ').slice(0, 1500) : null;
      if (hint) {
        augmentedGoalText = '[REPLAN HINT — verbal reinforcement per Shinn 2303.11366 §3.2]\n' +
                            hint + '\n\n[ORIGINAL GOAL]\n' + goalText;
        continue;
      }
      // No hint to add — replan would be identical; stop.
      break;
    }

    // escalate_operator_request OR caps exhausted — loop exits, caller
    // handles via existing operator_request mechanism + briefing.
    break;
  }

  // D6: fold THIS goal's spend into the run-level wallet so the next tick's
  // precheck sees cumulative run spend (the per-goal tracker resets each goal).
  if (ctx && ctx.run_tracker) {
    try {
      const _snap = tracker.snapshot();
      if (_snap && _snap.spent_usd > 0) ctx.run_tracker.charge({ usd: _snap.spent_usd });
    } catch (_) { /* backstop charge is best-effort */ }
  }

  // BUG3 / Wall-4 cross-family — "a model judging its OWN work hallucinates"
  // (reflection.js header; step-critic.js enforces the same for steps). The
  // worker faculty just ran; reflect with a DIFFERENT, stronger faculty when the
  // operator has one, so a weak local model's self-review can't fabricate a
  // verdict. Observed live: a local 7B reflecting on its OWN correct file-write
  // invented "the agent waited for approval" (there is no approval gate) and
  // returned not_achieved — flipping a genuinely-successful run to failure.
  // Falls back to same-faculty for local-only operators (one faculty in the
  // map). Kill-switch: TROTH_REFLECT_CROSS_FAMILY=0.
  let reflectionOrch = orchestrator;
  let reflectCrossFamily = false;
  let reflectionFacultyName = null;
  if (process.env.TROTH_REFLECT_CROSS_FAMILY !== '0' && ctx.orchestrators && Object.keys(ctx.orchestrators).length > 1) {
    // Resolve the worker's faculty name (exact per-class match, else by
    // reference identity).
    let workerName = (preferredFaculty && ctx.orchestrators[preferredFaculty] === orchestrator) ? preferredFaculty : null;
    if (!workerName) { for (const [k, v] of Object.entries(ctx.orchestrators)) { if (v === orchestrator) { workerName = k; break; } } }
    // Judge-quality ranking: strongest reasoning faculties first. Subscription
    // claude (claude_cli) ahead of API anthropic per operator policy; the linked
    // Kimi Code membership (kimi_sub) ranks with the subs, ahead of the raw
    // anthropic key lane, so a wired Kimi can serve as the cross-family judge.
    // We route
    // reflection to the GLOBALLY STRONGEST available faculty — NOT merely "a
    // different one": cross-routing a strong worker's output to a weaker judge
    // would re-introduce the very fabrication BUG3 fixes. Independence is a
    // bonus that comes for free WHEN the strongest happens to differ from the
    // worker; when the worker already IS the strongest, same-faculty is correct
    // (a weaker judge would be worse than self-review).
    const JUDGE_RANK = ['claude_cli', 'codex_oauth', 'codex', 'kimi_sub', 'anthropic', 'gemini_cli', 'router', 'ollama', 'llamacpp', 'local', 'local_inprocess'];
    const rankOf = (k) => { const i = JUDGE_RANK.indexOf(k); return i < 0 ? 99 : i; };
    const strongest = Object.keys(ctx.orchestrators).sort((a, b) => rankOf(a) - rankOf(b))[0];
    if (strongest && ctx.orchestrators[strongest]) {
      reflectionFacultyName = strongest;
      reflectionOrch = ctx.orchestrators[strongest];
      reflectCrossFamily = !!(workerName && strongest !== workerName);
    } else {
      reflectionFacultyName = workerName;
    }
  }

  // Reflection runs ONLY when execution actually happened (steps ran).
  // No reflection on a no-step or instantly-aborted run — wastes a faculty
  // call without trace to review.
  let reflection = null;
  if (execResult && execResult.steps && execResult.steps.length > 0) {
    reflection = await reflectMod.reflect({
      orchestrator: reflectionOrch,
      goal_text:    goalText,
      goal_class:   goalClass,
      step_results: execResult.steps,
      cross_family: reflectCrossFamily,
      ctx
    });
    if (reflection) reflection.reflection_faculty = reflectionFacultyName;
  }

  // Calibrator update: success = step-engine ok AND reflection has no
  // critical concerns (we count any concerns as a soft failure for stats;
  // exact concern weighting is tunable in v2).
  // Success = the work executed AND the reviewer did not judge the goal unmet.
  // Concern COUNT is advisory (a goal can be genuinely achieved and still carry a
  // non-fatal process note — the old `concerns.length === 0` gate wrongly failed
  // those, re-firing idle-pursuit + poisoning the calibrator). Only an explicit
  // "not_achieved" verdict OR a CRITICAL concern (non-completion / hallucination /
  // drift) fails it. A reflection-CALL error (ok=false) does not penalise an
  // otherwise-successful run.
  // An explicit "achieved" verdict from the reviewer WINS over the critical-text
  // heuristic (the reviewer confirmed the real artifacts). The critical heuristic
  // only fails the run as a BACKSTOP when no explicit verdict was given — so a
  // process/redundancy concern can't flip a verified-achieved goal to failure.
  const reflectionUnmet = !!(reflection && reflection.ok && (
    reflection.achieved === false ||
    (reflection.achieved !== true && reflection.critical)
  ));
  const overallSuccess = !!(execResult && execResult.ok) && !reflectionUnmet;
  calibrator.recordAttempt(goalClass, { success: overallSuccess });

  // D.1 — Mark goal satisfied so idle-pursuit stops re-firing on it.
  // Without this the partner re-pursues every heartbeat tick until the
  // operator runs /forget. Satisfaction is conservative: requires BOTH
  // step-engine success AND reflection clean. Anything else stays open
  // (the partner might want to retry or escalate).
  if (overallSuccess && opts.goal_id) {
    try {
      goalStatus.markSatisfied({
        goal_id:   opts.goal_id,
        agent_id:  ctx.agent_id || null,
        cwd:       ctx.cwd || null,
        briefing:  (execResult && execResult.briefing) || null,
        summary:   goalText.slice(0, 200)
      });
    } catch (_) { /* satisfaction marker is best-effort */ }
  }

  // D5 — on a NON-success autonomous pursuit, record a failed attempt; at the
  // cap, ABANDON the goal so it stops re-firing every heartbeat (filterOpen then
  // excludes it). Below the cap it stays open but enters exponential backoff
  // (idle-pursuit skips it for the window). Autonomous-only.
  // A pause is the OPERATOR's stop, not a failure — it must not burn an
  // attempt or push the goal toward abandonment. Same for the global
  // kill-switch. NOTE: step-engine returns abort_reason (snake_case) —
  // this read used execResult.abortReason (always undefined), so a
  // mid-run pause silently burned an attempt anyway (found 2026-07-03).
  const _pausedMidRun = !!(execResult && (
    execResult.abort_reason === 'paused_by_operator' ||
    execResult.abort_reason === 'globally_paused'
  ));
  if (!overallSuccess && opts.goal_id && ctx && ctx.from_idle_pursuit && !_pausedMidRun) {
    try {
      goalStatus.recordFailedAttempt({
        goal_id:  opts.goal_id,
        agent_id: ctx.agent_id || null,
        cwd:      ctx.cwd || null,
        reason:   (execResult && execResult.abort_reason) ||
                  (reflectionUnmet ? 'reflection_unmet' : 'pursuit_unsuccessful')
      });
      if (goalStatus.shouldAbandon(opts.goal_id)) {
        goalStatus.markAbandoned({
          goal_id:  opts.goal_id,
          agent_id: ctx.agent_id || null,
          cwd:      ctx.cwd || null,
          reason:   'max_attempts (' + goalStatus.MAX_GOAL_ATTEMPTS + ') exhausted'
        });
      }
    } catch (_) { /* backoff / abandon markers are best-effort */ }
  }

  // D4 — runtime decomposition (DEFAULT OFF via ctx.allow_decomposer; ADaPT,
  // arXiv 2311.05772). On a repeatedly-failing goal (same class+category >= 2 in
  // 1h) the substrate may LLM-propose 2-3 NARROWER sub-goals, written as NEW
  // scope='goal' engrams (parent_id=this goal) for a future tick to pick up
  // (D1/D5 continuity+backoff then manage them). No inline execution, no new
  // approval gate beyond the decomposer's own risk policy. Opt-in + needs an
  // injected ctx.decomposer_llm_call; fully inert otherwise (lowest leverage,
  // deferred last per the Dimension-D plan).
  if (ctx && ctx.allow_decomposer && !overallSuccess && opts.goal_id &&
      ctx.from_idle_pursuit && typeof ctx.decomposer_llm_call === 'function') {
    try {
      const decomposer = require('./decomposer.js');
      const st  = require('./state.js');
      const eng = require('./engram.js');
      const rawFails = st.listRecentFailures
        ? st.listRecentFailures({ goal_class: goalClass, since_ms: decomposer.FAILURE_WINDOW_MS })
        : [];
      // field-name adapter: l4_failure_events stores failure_reason; the
      // decomposer reads .reason.
      const failureHistory = rawFails.map(f => ({
        ts: f.ts, goal_class: f.goal_class, failure_category: f.failure_category,
        recovery_action: f.recovery_action, reason: f.failure_reason
      }));
      const dec = await decomposer.decompose({
        llmCall:       ctx.decomposer_llm_call,
        currentGoal:   { id: opts.goal_id, statement: goalText, goal_class: goalClass,
                         parent_chain_depth: (ctx.parent_chain_depth || 0) },
        failureHistory,
        parentChain:   [],
        max_proposals: 3
      });
      // Auto-write only sub-goals the decomposer's own risk policy auto-approves
      // (all-low-risk); medium/high surface via its operator_request instead.
      if (dec && dec.decompose && dec.approval && dec.approval.auto_approve && Array.isArray(dec.proposals)) {
        for (const p of dec.proposals) {
          try {
            eng.recordEngram({
              agent_id:     ctx.agent_id || 'l4-coordinator',
              cwd:          ctx.cwd || null,
              statement:    p.text,
              scope:        'goal',
              parent_id:    opts.goal_id,
              source:       'l4:decomposer:subgoal',
              audience:     'substrate_internal',
              memory_class: 'operational',
              extra_output: { class_hint: p.class_hint || null, why: p.why || null, decomposed_from: opts.goal_id }
            });
          } catch (_) { /* per-proposal write best-effort */ }
        }
      }
    } catch (_) { /* decomposer best-effort; never blocks the briefing */ }
  }

  // implementation step wire — skill self-extraction. After a success, the
  // substrate inspects its OWN trace and decides whether to absorb a
  // reusable pattern as a procedural-memory skill. Opt-in via
  // ctx.skill_extractor_enabled (default off — cost gating).
  // Cross-family enforced structurally inside skill-extractor.js.
  // Best-effort; never blocks return.
  if (overallSuccess && ctx.skill_extractor_enabled) {
    try {
      const skillExtractor = require('./skill-extractor.js');
      await skillExtractor.extractSkillFromSuccess({
        goal_text:        goalText,
        goal_class:       goalClass,
        goal_id:          opts.goal_id || null,
        step_results:     execResult.steps,
        briefing:         (execResult && execResult.briefing) || null,
        worker_model:     ctx.model || ctx.worker_model || '',
        extractor_model:  ctx.extractor_model || '',
        extractor_host:   ctx.extractor_host  || '',
        llmCall:          ctx.extractor_llm_call,
        family_constraint: ctx.extractor_family_constraint || 'different_from_worker',
        timeout_ms:       ctx.extractor_timeout_ms,
        agent_id:         ctx.agent_id || null,
        cwd:              ctx.cwd || null
      });
    } catch (_) { /* extractor failure never blocks success path */ }
  }

  const briefing = _composeBriefing(execResult, reflection, transparency);
  const decision = (execResult && execResult.ok) ? 'executed' : 'execution_failed';

  // briefing subsystem — persist the briefing so dashboard RECENT BRIEFINGS shows
  // the partner's reasoning across restart, not just satisfactions.
  // Best-effort; never blocks the return.
  try {
    const state = require('./state.js');
    if (state && typeof state.recordBriefing === 'function') {
      state.recordBriefing({
        goal_id:    opts.goal_id || null,
        goal_class: goalClass,
        decision,
        faculty:    facultyPicked,
        briefing,
        success:    overallSuccess,
        spent_usd:  (tracker.snapshot() || {}).spent_usd || 0,
        reflection_text:      reflection && reflection.raw_text || null,
        classification_text:  classification
          ? (classification.class + ':' + (classification.confidence || 0))
          : null
      });
    }
  } catch (_) { /* persistence best-effort */ }

  return {
    decision,
    reasoning:    execResult && execResult.abort_reason ? execResult.abort_reason : 'completed',
    goal_class:   goalClass,
    classification,
    transparency,
    faculty:      facultyPicked,
    briefing,
    reflection,
    step_results: execResult.steps,
    snapshot:     tracker.snapshot(),
    success:      overallSuccess
  };
}

module.exports = {
  coordinate,
  _resolveTransparency,
  _buildPlan,
  _composeBriefing,
  AUTO_PROMOTE_CONFIDENCE,
  AUTO_PROMOTE_MIN_ATTEMPTS
};
