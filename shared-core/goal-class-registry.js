// SPDX-License-Identifier: AGPL-3.0-only
// goal-class-registry.js — registry over step_definitions per goal_class.
//
// design (Behavioral Determinism Layer): each goal class has an
// ordered list of canonical steps; substrate decides step transitions; LLM
// is creative WITHIN each step. This module is the CRUD + seed layer over
// the step_definitions table (shipped in initial milestone schema v2).
//
// API:
//   listClasses()                          → [string]  (distinct goal_class values)
//   getClassSteps(goalClass)               → [step]    in step_order
//   getStep(goalClass, stepName)           → step | null
//   upsertStep({...})                      → ok        idempotent
//   seedClass(goalClass, steps[])          → number of inserts
//   SEED_CLASSES                           → readonly  config-as-code seed set
//
// step shape:
//   { goal_class, step_name, step_order, entry_criteria, exit_criteria,
//     allowed_tools, forbidden_tools, worker_role, max_iterations, timeout_ms }
//
// entry_criteria / exit_criteria are JSON predicate lists (the design schema).
// For v1 the autonomy executor doesn't run these predicates yet —
// they're stored as configuration for the closed overlay's executor.
// Schema is in place so seeded classes can drive future enforcement
// without a migration.

const path     = require('path');
const os       = require('os');
const Database = require('better-sqlite3');

const DEFAULT_MAX_ITER = 5;
// 5 minutes. One step = a full agentic loop (spawn transport, think, tool
// calls, iterate). The original 60s killed every real pursuit at the
// synthesize step - a
// timeout that fires on EVERY healthy run is not a guard, it is a bug.
// Runaway protection stays with the budget tracker + kill-switch + the
// per-pursuit stuck guard in the daemon.
const DEFAULT_TIMEOUT_MS = 300000;

// Config-as-code seed set. v1 covers the built-in goal classes that account
// for the vast majority of troth cli traffic per substrate log analysis:
//
//   chat       — general thinking partnership, no canonical step sequence
//                beyond "respond". Worker role: planner.
//   code       — write/modify code. Steps: understand → plan → edit →
//                verify. Each is a deterministic gate the substrate
//                enforces; LLM creativity lives inside each step.
//   research  — gather information from substrate + external sources →
//                synthesize → present. Splits fetcher (capability-scoped,
//                read-only external) from synthesizer (model_visible
//                output). Web tools land in slice C.
//
// Adding a class: append to SEED_CLASSES, restart entity (migrate re-runs
// idempotently). Operator can also runtime-register via the registry API.
const SEED_CLASSES = Object.freeze({
  chat: [
    {
      step_name:       'respond',
      step_order:      1,
      entry_criteria:  { predicates: [] }, // chat has no precondition
      exit_criteria:   { predicates: [{ kind: 'response_emitted' }] },
      allowed_tools:   null, // any
      forbidden_tools: null,
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  code: [
    {
      step_name:       'understand',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'read_at_least_n_files', n: 1 }] },
      allowed_tools:   ['Read', 'Grep', 'Glob', 'engram_search'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'plan',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'understand' }] },
      exit_criteria:   { predicates: [{ kind: 'plan_documented' }] },
      allowed_tools:   ['engram_record', 'engram_search'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'edit',
      step_order:      3,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'plan' }] },
      exit_criteria:   { predicates: [{ kind: 'edit_applied' }] },
      allowed_tools:   ['Read', 'Edit', 'Write'],
      forbidden_tools: ['Bash'], // exec gated separately (capability tier)
      worker_role:     'synthesizer',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'verify',
      step_order:      4,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'edit' }] },
      exit_criteria:   { predicates: [{ kind: 'verification_passed' }] },
      allowed_tools:   ['Read', 'Grep', 'Bash'],
      forbidden_tools: ['Write', 'Edit'], // verify is read-only
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  research: [
    {
      step_name:       'fetch',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'sources_gathered', n: 3 }] },
      // subsystem: web_fetch + web_allowlist_list join the
      // fetcher toolset. Allowlist gate inside web_fetch makes it safe to
      // expose — substrate refuses off-allowlist hosts and surfaces a
      // refusal envelope rather than executing the call.
      allowed_tools:   ['engram_search', 'chameleon_query', 'Read', 'Grep', 'web_fetch', 'web_allowlist_list'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'fetcher',
      max_iterations:  DEFAULT_MAX_ITER * 2, // research benefits from a wider window
      timeout_ms:      DEFAULT_TIMEOUT_MS * 2
    },
    {
      step_name:       'synthesize',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'fetch' }] },
      exit_criteria:   { predicates: [{ kind: 'synthesis_produced' }] },
      allowed_tools:   ['engram_record'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'synthesizer',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  // E.1 — 5 additional goal classes to broaden classifier coverage.
  // Each is concrete enough for the step-engine to walk; predicates stay
  // declarative (real evaluator lands with B.4). Worker roles match the
  // four canonical archetypes: fetcher / planner / synthesizer / verifier.
  debug: [
    {
      step_name:       'reproduce',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'reproduction_confirmed' }] },
      allowed_tools:   ['Read', 'Grep', 'Bash', 'engram_search'],
      forbidden_tools: ['Write', 'Edit'],
      worker_role:     'fetcher',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'isolate',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'reproduce' }] },
      exit_criteria:   { predicates: [{ kind: 'root_cause_identified' }] },
      allowed_tools:   ['Read', 'Grep', 'Glob'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'fix',
      step_order:      3,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'isolate' }] },
      exit_criteria:   { predicates: [{ kind: 'edit_applied' }] },
      allowed_tools:   ['Read', 'Edit', 'Write'],
      forbidden_tools: ['Bash'],
      worker_role:     'synthesizer',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'verify_fix',
      step_order:      4,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'fix' }] },
      exit_criteria:   { predicates: [{ kind: 'reproduction_no_longer_fires' }] },
      allowed_tools:   ['Read', 'Grep', 'Bash'],
      forbidden_tools: ['Write', 'Edit'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  writing: [
    {
      step_name:       'gather_context',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'context_gathered' }] },
      allowed_tools:   ['engram_search', 'chameleon_query', 'Read'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'fetcher',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'outline',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'gather_context' }] },
      exit_criteria:   { predicates: [{ kind: 'outline_produced' }] },
      allowed_tools:   ['engram_record'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'draft',
      step_order:      3,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'outline' }] },
      exit_criteria:   { predicates: [{ kind: 'draft_produced' }] },
      allowed_tools:   ['Read', 'Write', 'Edit', 'engram_record'],
      forbidden_tools: ['Bash'],
      worker_role:     'synthesizer',
      max_iterations:  DEFAULT_MAX_ITER * 2,
      timeout_ms:      DEFAULT_TIMEOUT_MS * 2
    },
    {
      step_name:       'review',
      step_order:      4,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'draft' }] },
      exit_criteria:   { predicates: [{ kind: 'review_complete' }] },
      allowed_tools:   ['Read'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  email: [
    {
      step_name:       'classify',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'classified' }] },
      allowed_tools:   ['Read', 'engram_search'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'draft_reply',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'classify' }] },
      exit_criteria:   { predicates: [{ kind: 'reply_drafted' }] },
      allowed_tools:   ['engram_record', 'engram_search'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'synthesizer',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  planning: [
    {
      step_name:       'gather_state',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'state_gathered' }] },
      allowed_tools:   ['engram_search', 'chameleon_query', 'Read', 'Grep'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'fetcher',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'decompose',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'gather_state' }] },
      exit_criteria:   { predicates: [{ kind: 'subgoals_emitted' }] },
      allowed_tools:   ['engram_record'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    },
    {
      step_name:       'sequence',
      step_order:      3,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'decompose' }] },
      exit_criteria:   { predicates: [{ kind: 'plan_documented' }] },
      allowed_tools:   ['engram_record'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'planner',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ],
  learning: [
    {
      step_name:       'survey',
      step_order:      1,
      entry_criteria:  { predicates: [] },
      exit_criteria:   { predicates: [{ kind: 'survey_done', n: 5 }] },
      allowed_tools:   ['engram_search', 'chameleon_query', 'Read', 'Grep', 'web_fetch', 'web_allowlist_list'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'fetcher',
      max_iterations:  DEFAULT_MAX_ITER * 2,
      timeout_ms:      DEFAULT_TIMEOUT_MS * 2
    },
    {
      step_name:       'distill',
      step_order:      2,
      entry_criteria:  { predicates: [{ kind: 'preceding_step_complete', step: 'survey' }] },
      exit_criteria:   { predicates: [{ kind: 'distillation_recorded' }] },
      allowed_tools:   ['engram_record'],
      forbidden_tools: ['Write', 'Edit', 'Bash'],
      worker_role:     'synthesizer',
      max_iterations:  DEFAULT_MAX_ITER,
      timeout_ms:      DEFAULT_TIMEOUT_MS
    }
  ]
});

function openDb(readonly) {
  const DB_PATH = process.env.STATE_DB_PATH ||
    path.join(os.homedir(), '.troth', 'state.db');
  return new Database(DB_PATH, readonly ? { readonly: true } : {});
}

function listClasses() {
  try {
    const db = openDb(true);
    const rows = db.prepare(`
      SELECT goal_class, COUNT(*) AS step_count
      FROM step_definitions
      GROUP BY goal_class
      ORDER BY goal_class
    `).all();
    db.close();
    return rows.map(r => r.goal_class);
  } catch (_) { return []; }
}

function getClassSteps(goalClass) {
  if (!goalClass) return [];
  try {
    const db = openDb(true);
    const rows = db.prepare(`
      SELECT goal_class, step_name, step_order, entry_criteria, exit_criteria,
             allowed_tools, forbidden_tools, worker_role, max_iterations,
             timeout_ms, created_ts
      FROM step_definitions
      WHERE goal_class = ?
      ORDER BY step_order ASC
    `).all(goalClass);
    db.close();
    return rows.map(_hydrate);
  } catch (_) { return []; }
}

function getStep(goalClass, stepName) {
  if (!goalClass || !stepName) return null;
  try {
    const db = openDb(true);
    const row = db.prepare(`
      SELECT goal_class, step_name, step_order, entry_criteria, exit_criteria,
             allowed_tools, forbidden_tools, worker_role, max_iterations,
             timeout_ms, created_ts
      FROM step_definitions
      WHERE goal_class = ? AND step_name = ?
    `).get(goalClass, stepName);
    db.close();
    return row ? _hydrate(row) : null;
  } catch (_) { return null; }
}

function _hydrate(row) {
  // JSON-string columns → JS objects/arrays. Failures fall through to null
  // so a malformed seed never crashes a downstream reader.
  function tryJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }
  return Object.assign({}, row, {
    entry_criteria:  tryJson(row.entry_criteria),
    exit_criteria:   tryJson(row.exit_criteria),
    allowed_tools:   row.allowed_tools   ? tryJson(row.allowed_tools)   : null,
    forbidden_tools: row.forbidden_tools ? tryJson(row.forbidden_tools) : null
  });
}

function upsertStep(opts) {
  opts = opts || {};
  if (!opts.goal_class || !opts.step_name) {
    throw new Error('goal-class-registry.upsertStep: goal_class + step_name required');
  }
  try {
    const db = openDb(false);
    db.prepare(`
      INSERT OR REPLACE INTO step_definitions
      (goal_class, step_name, step_order, entry_criteria, exit_criteria,
       allowed_tools, forbidden_tools, worker_role, max_iterations, timeout_ms,
       created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.goal_class,
      opts.step_name,
      opts.step_order || 1,
      JSON.stringify(opts.entry_criteria || { predicates: [] }),
      JSON.stringify(opts.exit_criteria  || { predicates: [] }),
      opts.allowed_tools   ? JSON.stringify(opts.allowed_tools)   : null,
      opts.forbidden_tools ? JSON.stringify(opts.forbidden_tools) : null,
      opts.worker_role     || null,
      opts.max_iterations  || DEFAULT_MAX_ITER,
      opts.timeout_ms      || DEFAULT_TIMEOUT_MS,
      Date.now()
    );
    db.close();
    return true;
  } catch (_) { return false; }
}

function seedClass(goalClass, steps) {
  if (!goalClass || !Array.isArray(steps) || !steps.length) return 0;
  let inserted = 0;
  for (const step of steps) {
    const ok = upsertStep(Object.assign({}, step, { goal_class: goalClass }));
    if (ok) inserted++;
  }
  return inserted;
}

// Idempotent seed of all SEED_CLASSES. Called from state.migrate() so a
// fresh substrate boots with the v1 goal-class set. Returns total inserts
// (mostly relevant for first-run accounting).
//
//  opens ONE connection for the entire seed (was: one per
// step, which on first-boot WAL init pushed past MCP test rpc timeout
// when seed grew from 3 to 8 classes / ~24 inserts).
// subsystem — universal escalation. Every step needs the ability to
// surface an operator_request when it hits a ceiling (missing credential,
// money, approval, allowlist gap). Without this the partner is silent at
// hard limits. We inject operator_request into allowed_tools of every
// step that has a non-null allow list. Steps with allowed_tools=null
// already have everything available, so no injection needed.
//
// multi-class subsystem — submit_goal extends the same idea to multi-class chaining.
// Synthesizer / verify-style terminal steps get it so a research
// synthesis can queue the follow-up code goal, a code verify can queue
// the deploy goal, etc. Non-terminal fetcher/planner steps don't get it
// (they shouldn't queue follow-ups before the current step is done).
function _injectUniversalEscalation(allowed, workerRole) {
  if (!Array.isArray(allowed)) return allowed; // null = anything → leave alone
  let out = allowed;
  if (out.indexOf('operator_request') < 0) out = out.concat(['operator_request']);
  // credential subsystem — credential_list (metadata only, never values) is universally
  // safe: read-only, scope-filtered, returns names not bytes. Steps that
  // need to USE a credential have their own tool args (web_fetch
  // auth_header_credential) for the actual injection.
  if (out.indexOf('credential_list') < 0) out = out.concat(['credential_list']);
  // recall subsystem — dialogue_search lets every step surface past
  // conversation context across time/topic, not just the last 5 turns.
  if (out.indexOf('dialogue_search') < 0) out = out.concat(['dialogue_search']);
  // submit_goal is partner-volitional chaining. Limit to synthesizer-shaped
  // steps so we don't encourage fetchers/planners to spawn goals mid-pursuit.
  if (workerRole === 'synthesizer' && out.indexOf('submit_goal') < 0) {
    out = out.concat(['submit_goal']);
  }
  return out;
}

function seedAll() {
  let total = 0;
  let db;
  try {
    db = openDb(false);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO step_definitions
      (goal_class, step_name, step_order, entry_criteria, exit_criteria,
       allowed_tools, forbidden_tools, worker_role, max_iterations, timeout_ms,
       created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [goalClass, steps] of Object.entries(SEED_CLASSES)) {
      for (const step of steps) {
        try {
          const allowed = _injectUniversalEscalation(step.allowed_tools, step.worker_role);
          stmt.run(
            goalClass,
            step.step_name,
            step.step_order || 1,
            JSON.stringify(step.entry_criteria || { predicates: [] }),
            JSON.stringify(step.exit_criteria  || { predicates: [] }),
            allowed ? JSON.stringify(allowed) : null,
            step.forbidden_tools ? JSON.stringify(step.forbidden_tools) : null,
            step.worker_role     || null,
            step.max_iterations  || DEFAULT_MAX_ITER,
            step.timeout_ms      || DEFAULT_TIMEOUT_MS,
            Date.now()
          );
          total++;
        } catch (_) { /* skip individual step on error */ }
      }
    }
  } catch (_) { /* seed failure → step_definitions table missing or schema race; safe to skip */ }
  finally { if (db) try { db.close(); } catch (_) {} }
  return total;
}

module.exports = {
  listClasses,
  getClassSteps,
  getStep,
  upsertStep,
  seedClass,
  seedAll,
  SEED_CLASSES,
  DEFAULT_MAX_ITER,
  DEFAULT_TIMEOUT_MS
};
