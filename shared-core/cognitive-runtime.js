// SPDX-License-Identifier: AGPL-3.0-only
// Cognitive Runtime — C1 of Substrate-as-Entity v0.1.
//
// The substrate's own event loop. Long-running. The substrate IS the entity
// here; this module is what makes it actively cognize between LLM calls
// instead of being a passive store that gets queried.
//
// Contract:
//   start(opts) returns a Runtime handle with
//       submit(event)    — push an inbound event into the loop
//       state()          — read the current substrate-derived view (no LLM)
//       stop()           — graceful shutdown (drains queue, flushes state)
//   The loop is self-driven: it pulls events, calls the decision engine,
//     dispatches actions (deterministic OR llm OR tool), records outcomes
//     to L1, recomputes shape, repeats.
//   LLM is one of several action kinds, not the heart. Most decisions
//     happen without one.
//
// Persistence model:
//   All inbound events are recorded as action_records (type derived from
//     event kind). Causal chain preserved via parent_id.
//   All decisions and their outcomes are recorded as 'decision' /
//     'tool_call' / 'edit' / 'lesson' records as appropriate.
//   Mind snapshots get recomputed on a debounced schedule, not per tick.
//
// Pure plumbing — no LLM coupling here. The orchestrator (C4) handles
// the language faculty. The decision engine (C2) handles policy. This
// module is the runtime the two live inside.

const state    = require('./state.js');
const actionRec = require('./action-record.js');
const mindState = require('./mind-state.js');
const prwf      = require('./predictive-write-filter.js');

const DEFAULT_TICK_MS         = 25;
const DEFAULT_IDLE_TICK_MS    = 250;
const DEFAULT_MIND_DEBOUNCE   = 1500;
// One mind, parallel hands: how many inbound events may be
// dispatched at once. The operator runs multiple panels against the one
// daemon; a minutes-long turn must not starve the other panels' turns.
// 1 reproduces the historical strictly-serial loop exactly.
const DEFAULT_MAX_CONCURRENT_TURNS = 3;

function start(opts) {
  opts = opts || {};
  const decideFn = opts.decide;
  if (typeof decideFn !== 'function') {
    throw new Error('cognitive-runtime: opts.decide(state, event) is required');
  }
  const dispatchFn = opts.dispatch;
  if (typeof dispatchFn !== 'function') {
    throw new Error('cognitive-runtime: opts.dispatch(action, ctx) is required');
  }
  // Optional: (action, errorMessage) => void. Called when dispatch THROWS, so the
  // host can surface a terminal failure frame. Without it a thrown turn is recorded
  // to the substrate (recordOutcome) but never reaches the GUI/Rust side → the idle
  // watchdog reports a phantom "stalled — no activity" instead of the real error.
  const onErrorFn = opts.on_error;
  const agentId = opts.agent_id || 'entity';
  const cwd     = opts.cwd      || process.cwd();
  const userId  = opts.user_id  || 'default';

  // Concurrency cap. Env is the operator surface; opts.max_concurrent_turns
  // is the host/test override. Floor of 1 keeps the loop always defined.
  const _capRaw = parseInt(
    (opts.max_concurrent_turns != null ? String(opts.max_concurrent_turns) : '') ||
    process.env.TROTH_ENTITY_MAX_CONCURRENT_TURNS || '', 10);
  const maxConcurrent = (!isNaN(_capRaw) && _capRaw >= 1) ? _capRaw : DEFAULT_MAX_CONCURRENT_TURNS;

  // Loop state
  const queue   = [];        // inbound events awaiting processing
  const pending = new Set(); // in-flight action ids (dispatch phase; so we don't double-fire)
  // Launched-but-unsettled processOne promises - the WHOLE turn lifetime
  // (decide + dispatch), unlike `pending` which only covers the dispatch
  // window keyed by action id. The concurrency cap and drainAndStop key off
  // this set so a turn in its decide phase still counts as in flight.
  const inFlight = new Set();
  // Serialization lanes: turns on the SAME conversation stay strictly
  // ordered (turn 2's context must include turn 1), while different
  // conversations overlap freely. Events without a conversation (null
  // lane: autonomous/background/CLI) are unserialized - they share the
  // pool and cap but never block each other.
  const activeLanes = new Set();
  function laneOf(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.options && event.options.conversation_id != null) return event.options.conversation_id;
    if (event.conversation_id != null) return event.conversation_id;
    return null;
  }
  let running   = true;
  let mindDirty = false;
  let lastMindFlush = 0;
  const handles = { tick: null };

  // In-memory derived view. Recomputed lazily, kept here so tests can
  // observe without touching SQLite.
  let derived = computeDerived(userId, cwd, agentId);

  // PRWF. Singleton per runtime so the
  // n-gram model is shared across this process's writes. Bootstraps from
  // the agent's recent action history so the predictor doesn't have to
  // re-learn routine sequences from scratch on every entity boot.
  // Default-ON since  — opt-out via TROTH_PRWF=0. When off,
  // recordActionFiltered passes through unchanged but still observes
  // (so the model warms up against real traffic for later re-enable).
  const writeFilter = prwf.makePredictor({});
  try {
    const recent = state.queryActions({
      agent_id: agentId, cwd, limit: 200, order: 'desc'
    }) || [];
    const sigs = recent
      .reverse()  // chronological
      .map((row) => prwf.actionSignature(actionRec.fromRow(row)))
      .filter(Boolean);
    writeFilter.bootstrap({ agent_id: agentId, cwd }, sigs);
  } catch (_) { /* bootstrap is best-effort */ }

  // L1's type registry enforces required fields per record type. We use
  // tool_call (input.tool_name, output.status) for inbound traffic and
  // decision (input.kind, output.decision) for the runtime's own choices.
  // Anything that fails validation is dropped silently — better to lose
  // a debug breadcrumb than to throw inside the loop.
  function recordInbound(event) {
    const id = actionRec.uuidv7();
    const baseInput = (event && event.input && typeof event.input === 'object') ? event.input : {};
    const baseOutput = (event && event.output && typeof event.output === 'object') ? event.output : {};
    const rec = {
      id,
      timestamp: Date.now(),
      type: 'tool_call',
      agent_id: agentId,
      cwd,
      user_id: userId,
      parent_id: event && event.parent_id || null,
      input:  Object.assign({ tool_name: 'cognitive_runtime.inbound', args: event && event.input || null }, baseInput, { tool_name: baseInput.tool_name || 'cognitive_runtime.inbound' }),
      output: Object.assign({ status: 'received' }, baseOutput)
    };
    const v = actionRec.validate(rec);
    // The write can fail too, not just the validation. A busy SQLite file
    // under concurrent turns is the usual one. Same rule applies: the throw
    // would escape processOne, tick's no-op rejection handler would swallow
    // it, and the turn would vanish with no response and no error.
    if (v.ok) { try { prwf.recordActionFiltered(state, writeFilter, rec, actionRec.toSearchText(rec)); } catch (_) { /* breadcrumb lost, turn survives */ } }
    return rec;
  }

  function recordOutcome(action, outcome, parentId) {
    const id = actionRec.uuidv7();
    const safeOutcome = (outcome && typeof outcome === 'object') ? outcome : {};
    const rec = {
      id,
      timestamp: Date.now(),
      type: 'decision',
      agent_id: agentId,
      cwd,
      user_id: userId,
      parent_id: parentId || null,
      input:  { kind: action.kind || 'unknown', signals: { rule: action._rule || null, name: action.name || action.tool || null } },
      output: Object.assign({ decision: action.kind || 'noop' }, safeOutcome)
    };
    const v = actionRec.validate(rec);
    if (v.ok) { try { prwf.recordActionFiltered(state, writeFilter, rec, actionRec.toSearchText(rec)); } catch (_) { /* breadcrumb lost, turn survives */ } }
    return rec;
  }

  async function processOne(event) {
    const inbound = recordInbound(event);
    let action;
    try {
      action = await decideFn(derived, { ...event, _record_id: inbound.id });
    } catch (e) {
      recordOutcome({ kind: 'decision', name: 'decide_threw' },
                    { status: 'fail', error: String(e && e.message || e) },
                    inbound.id);
      return null;
    }
    if (!action || action.kind === 'noop') return null;
    if (action.kind === 'wait') return null;

    pending.add(inbound.id);
    let outcome;
    try {
      outcome = await dispatchFn(action, {
        event,
        record_id: inbound.id,
        agent_id: agentId,
        cwd,
        user_id: userId
      });
    } catch (e) {
      outcome = { status: 'fail', error: String(e && e.message || e) };
      // Surface the failure to the host BEFORE it's only recorded to substrate.
      // This is what stops a thrown turn from becoming a silent 1800s "stall".
      // The originating event rides along so the host can tag the error frame
      // to the right conversation.
      if (typeof onErrorFn === 'function') {
        try { onErrorFn(action, outcome.error, event); } catch (_) { /* never let the surfacer mask the original */ }
      }
    } finally {
      pending.delete(inbound.id);
    }
    recordOutcome(action, outcome, inbound.id);
    mindDirty = true;
    return outcome;
  }

  async function tick() {
    if (!running) return;
    // One mind, parallel hands: launch queued events WITHOUT awaiting them,
    // up to the concurrency cap; excess stays queued for later ticks. Same-
    // lane events (see laneOf) are skipped while their lane is busy - they
    // keep their queue position, so per-conversation order is preserved and
    // one pane's backlog never blocks another pane (no head-of-line). A cap
    // of 1 reproduces the historical serial loop exactly (one launch, next
    // only after the prior settles, strict FIFO). processOne handles its own
    // decide/dispatch failures internally; the no-op rejection handler below
    // exists so a throw in its bookkeeping (substrate write) can never kill
    // the tick loop the way an awaited throw could.
    for (let i = 0; i < queue.length && inFlight.size < maxConcurrent; ) {
      const lane = laneOf(queue[i]);
      if (lane != null && activeLanes.has(lane)) { i++; continue; }
      const event = queue.splice(i, 1)[0];
      if (lane != null) activeLanes.add(lane);
      const turn = processOne(event).then(() => {}, () => {});
      inFlight.add(turn);
      turn.then(() => {
        inFlight.delete(turn);
        if (lane != null) activeLanes.delete(lane);
        // A settled turn frees a slot (and possibly a lane) - kick the loop
        // when work is waiting so a queued event does not sit out the idle
        // delay.
        if (running && queue.length > 0 && handles.tick) {
          clearTimeout(handles.tick);
          handles.tick = setTimeout(tick, 0);
        }
      });
    }
    // Debounced mind recomputation. Avoids hammering snapshot writes
    // when a burst of events arrives. Under concurrent turns `derived` is
    // read-mostly shared state: in-flight turns keep reading whichever
    // view was current when they looked, and the recompute is
    // last-writer-wins - acceptable because the view is a lagging summary
    // of L1, not a correctness input to any single turn.
    if (mindDirty && Date.now() - lastMindFlush > DEFAULT_MIND_DEBOUNCE) {
      derived = computeDerived(userId, cwd, agentId);
      lastMindFlush = Date.now();
      mindDirty = false;
    }
    if (!running) return;
    const nextDelay = queue.length > 0 ? DEFAULT_TICK_MS : DEFAULT_IDLE_TICK_MS;
    handles.tick = setTimeout(tick, nextDelay);
  }

  function submit(event) {
    if (!running) throw new Error('cognitive-runtime: stopped');
    queue.push(event);
    // Eager kick if we are idling so latency stays sub-tick on first event.
    if (handles.tick && queue.length === 1) {
      clearTimeout(handles.tick);
      handles.tick = setTimeout(tick, 0);
    }
  }

  function snapshot() {
    return {
      running,
      pending: pending.size,
      in_flight: inFlight.size,
      queued:  queue.length,
      derived: derived
    };
  }

  function stop() {
    running = false;
    if (handles.tick) {
      clearTimeout(handles.tick);
      handles.tick = null;
    }
    return { drained: queue.length, pending: pending.size };
  }

  // Async variant: drain queue + await any in-flight dispatches before
  // returning. Useful when callers (entity binary, MCP adapter) need to
  // make sure responses for already-submitted events have been emitted
  // before the process exits.
  async function drainAndStop(opts) {
    opts = opts || {};
    const deadline = Date.now() + (opts.timeout_ms || 5000);
    // inFlight covers the whole turn (decide + dispatch); pending only the
    // dispatch window. Wait on both so a turn caught mid-decide still drains.
    while ((queue.length > 0 || inFlight.size > 0 || pending.size > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return stop();
  }

  // Boot the loop.
  handles.tick = setTimeout(tick, 0);

  return { submit, state: snapshot, stop, drainAndStop };
}

// Computes the substrate-derived view. Pure read of L1/L2. No LLM. This is
// what the decision engine sees — current commitments, recent events,
// mind shape, scope.
function computeDerived(userId, cwd, agentId) {
  let mindRow = null;
  try {
    const rows = state.queryActions({
      type: 'mind_snapshot',
      cwd,
      agent_id: agentId,
      limit: 1,
      order: 'desc'
    }) || [];
    mindRow = rows[0] || null;
  } catch (_) { /* substrate empty / unavailable */ }
  let mind = mindState.emptyMindState(userId);
  if (mindRow) {
    const rec = actionRec.fromRow(mindRow);
    if (rec && rec.output && rec.output.mind_state) mind = rec.output.mind_state;
  }
  let recent = [];
  try {
    recent = state.queryActions({
      cwd, agent_id: agentId, limit: 20, order: 'desc'
    }) || [];
  } catch (_) { /* ignore */ }
  return { mind, recent_events: recent };
}

module.exports = { start, computeDerived };
