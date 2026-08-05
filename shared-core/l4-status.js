// l4-status.js — single-source snapshot for L4 autonomous mode state.
//
// One read surface that the CLI (`gemclaw status l4`), proxy HTTP
// endpoint (`/api/l4/status`), Tauri app, and voice surface all consume.
// Same data shape everywhere so UI doesn't need surface-specific code.
//
// API:
//   getSnapshot({ goal_limit?, briefing_limit? }) → snapshot object
//
// Snapshot shape:
//   {
//     enabled:        boolean,
//     config:         { ...full l4 config },
//     providers:      { configured:[...], usable: N, verify: {ok, reason?} },
//     goals: {
//       open:       [{id, statement, ts}],
//       satisfied:  [{marker_id, goal_id, ts, statement}],
//       abandoned:  [{marker_id, goal_id, ts, statement}]
//     },
//     recent_briefings:  [{goal_class, briefing, decision, ts, elapsed_ms}],
//     cost_24h:          { total_usd, by_class: {...} },
//     walls: {
//       stvc_rejections_24h: N,
//       loop_detections_24h: N,
//       active_invariants:   N,
//       seeded_invariants:   N
//     },
//     goal_classes:      [{name, attempts, confidence, last_run_ts}],
//     ts: epoch_ms
//   }

const l4cfg     = require('./l4-config.js');
const engram    = require('./engram.js');
const state     = require('./state.js');
const goalStatus = require('./goal-status.js');
const stateMachine = require('./state-machine.js');
const registry  = require('./goal-class-registry.js');
const calibrator = require('./confidence-calibrator.js');

function _safeListEngrams(opts) {
  try { return engram.listEngrams(opts) || []; }
  catch (_) { return []; }
}

function _queryRecent(type, sinceMs, limit) {
  try {
    return state.queryActions({ type, since: sinceMs, limit: limit || 200 }) || [];
  } catch (_) { return []; }
}

function _configuredProviders() {
  // Read raw config (not via l4-config which only exposes the l4 block).
  try {
    const path = require('path');
    const os   = require('os');
    const fs   = require('fs');
    const CFG = process.env.TROTH_CONFIG_PATH ||
                path.join((process.env.HOME || os.homedir()), '.troth', 'config.json');
    const raw = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    const out = [];
    if (raw && raw.providers) {
      for (const [name, p] of Object.entries(raw.providers)) {
        if (p && p.enabled) out.push({ name, model: p.model || null });
      }
    }
    if (raw && raw.backendHost && raw.backendPort) {
      out.push({ name: 'local', host: raw.backendHost, port: raw.backendPort, model: raw.model || null });
    }
    return out;
  } catch (_) { return []; }
}

function getSnapshot(opts) {
  opts = opts || {};
  const goalLimit = parseInt(opts.goal_limit || 25);
  const briefingLimit = parseInt(opts.briefing_limit || 10);
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;

  const cfg = l4cfg.getL4Config();
  const verify = l4cfg.verifyCanEnable();
  const providersConfigured = _configuredProviders();

  // Goals — open vs satisfied vs abandoned. listEngrams scope='goal' gives
  // candidates; goal-status splits them.
  const goalRows = _safeListEngrams({ scope: 'goal', limit: goalLimit * 3 });
  const open = [];
  const satisfied = [];
  const abandoned = [];
  for (const g of goalRows) {
    const entry = { id: g.id, statement: g.statement, ts: g.ts };
    if (goalStatus.isSatisfied(g.id)) satisfied.push(entry);
    else if (goalStatus.isAbandoned(g.id)) abandoned.push(entry);
    else open.push(entry);
  }
  open.length = Math.min(open.length, goalLimit);
  satisfied.length = Math.min(satisfied.length, goalLimit);
  abandoned.length = Math.min(abandoned.length, goalLimit);

  // Recent briefings — pull rejected_transition + L4-stamped step rows.
  // Slice H — read the persistent briefing log written by coordinator.
  // Falls back to satisfactions list when the briefing table is empty
  // (fresh substrate before coordinator has fired), preserving the
  // pre-Slice-H surface for any caller that read the old shape.
  let recent_briefings = [];
  if (typeof state.listL4Briefings === 'function') {
    recent_briefings = state.listL4Briefings({ limit: briefingLimit }).map(b => ({
      goal_id:    b.goal_id,
      statement:  b.briefing || ('(' + b.decision + ')'),
      ts:         b.ts,
      decision:   b.decision,
      goal_class: b.goal_class,
      faculty:    b.faculty,
      success:    !!b.success,
      spent_usd:  b.spent_usd
    }));
  }
  if (!recent_briefings.length) {
    recent_briefings = goalStatus.listSatisfactions({ limit: briefingLimit }).map(s => ({
      goal_id:   s.goal_id,
      statement: s.statement,
      ts:        s.ts,
      decision:  'executed'
    }));
  }

  // Cost over last 24h: aggregate from the persistent ledger written by
  // budget-warden.charge() (Slice G). state.sumL4Cost is best-effort —
  // a query failure returns zeros rather than crashing the snapshot.
  const cost_24h = (typeof state.sumL4Cost === 'function')
    ? state.sumL4Cost({ since_ms: 24 * 60 * 60 * 1000 })
    : { total_usd: 0, by_class: {}, rows: 0 };

  // Walls — count from substrate.
  const stvcRejections = _queryRecent('rejected_transition', sinceMs, 200).length;
  // Loop detections: count action_records with output.loop_detected key
  // (a soft signal until loop-detector writes a dedicated marker).
  const loopDetections = 0; // v1: loop-detector is in-memory only inside composeAgentic
  const invariants = stateMachine.listInvariants({});
  const seeded = invariants.filter(i => /^seed:/.test(i.id)).length;

  // Goal class roster + stats.
  const classes = registry.listClasses();
  const class_stats = classes.map(name => {
    const s = calibrator.getStats(name);
    return {
      name,
      attempts:       s ? s.attempt_count : 0,
      confidence:     s ? s.confidence    : 0,
      last_run_ts:    s ? s.last_run_ts   : null,
      provider_routing: cfg.providers_per_class[name] || cfg.providers_per_class._default || 'default'
    };
  });

  return {
    enabled:           cfg.enabled,
    config:            cfg,
    providers: {
      configured:      providersConfigured,
      usable:          verify.usable_providers || 0,
      verify
    },
    goals: { open, satisfied, abandoned },
    recent_briefings,
    cost_24h,
    walls: {
      stvc_rejections_24h: stvcRejections,
      loop_detections_24h: loopDetections,
      active_invariants:   invariants.length,
      seeded_invariants:   seeded
    },
    goal_classes:      class_stats,
    ts:                Date.now()
  };
}

module.exports = {
  getSnapshot
};
