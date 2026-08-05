// SPDX-License-Identifier: AGPL-3.0-only
// Orchestrator CLI — `troth orchestrate "<task>" --roles backend,frontend,qa`.
//
// Spawns one worker per role per the role registry. Each worker is
// pinned to its role's transport_hint (so different roles can run on
// different LLMs) and writes engrams scoped to `role:<name>:group:<id>`
// so the orchestrator can read cross-role results without message-passing.
//
// Implementation lives here (not in bin/runner.js) to keep the runner
// focused on race semantics. Both surfaces share spawnWorker.

const path = require('path');
const fs = require('fs');

const HOME = process.env.HOME || require('os').homedir();
const supervisor = require(path.join(__dirname, '..', 'shared-core', 'agent-supervisor.js'));
const rolesMod   = require(path.join(__dirname, '..', 'shared-core', 'roles.js'));
const planner    = require(path.join(__dirname, '..', 'shared-core', 'planner.js'));

const COLOR_RESET  = '\x1b[0m';
const COLOR_DIM    = '\x1b[2m';
const COLOR_GREEN  = '\x1b[32m';
const COLOR_RED    = '\x1b[31m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_CYAN   = '\x1b[36m';

function cmdOrchestrate(task, opts) {
  opts = opts || {};
  if (!task || !task.trim()) {
    console.error(COLOR_RED + 'Provide a task description.' + COLOR_RESET);
    console.error('  Usage: troth orchestrate "<task>" --roles backend,frontend,qa [--tenant <name>] [--no-plan]');
    return 1;
  }
  const roles = Array.isArray(opts.roles) && opts.roles.length
    ? opts.roles
    : ['backend', 'frontend', 'qa'];

  const known = new Set(rolesMod.listRoles(process.cwd()));
  const unknown = roles.filter(function(r) { return !known.has(r); });
  if (unknown.length) {
    console.error(COLOR_RED + 'Unknown role(s): ' + unknown.join(', ') + COLOR_RESET);
    console.error('  Known roles: ' + Array.from(known).join(', '));
    console.error('  Define new roles in .troth/roles.json (project) or ~/.troth/roles.json (global).');
    return 1;
  }

  const groupId = 'orch-' + Date.now().toString(36) + '-' +
                  Math.random().toString(36).slice(2, 6);

  console.log(COLOR_CYAN + '∴ Orchestrating ' + roles.length + ' roles' + COLOR_RESET +
              ' on: "' + task.slice(0, 60) + (task.length > 60 ? '…' : '') + '"');
  console.log(COLOR_DIM + '  group: ' + groupId + COLOR_RESET);
  if (opts.tenant) console.log(COLOR_DIM + '  tenant: ' + opts.tenant + COLOR_RESET);

  // Plan first — fallback mode runs offline (no LLM required) and gives
  // each role a structured per-role subtask + an empty deps list. With
  // --no-plan callers fall through to "raw task to every role" v0 behavior.
  // The plan engram persists so a crashed orchestration can be reconstructed.
  let plan = null, dag = null;
  if (!opts.noPlan) {
    const planRes = planner.planFallback(task, roles, { cwd: process.cwd() });
    plan = planRes.plan;
    dag  = planRes.dag;
    // Persist the plan so substrate consumers (dashboard, future resume
    // logic, audit) can see what was decomposed.
    try {
      const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
      engram.recordEngram({
        agent_id: 'orchestrator-cli',
        cwd:      process.cwd(),
        statement: 'PLAN(' + groupId + ') ' + JSON.stringify(plan),
        scope:    'plan:' + groupId,
        source:   'cmdOrchestrate.fallback_plan',
        salience: 1.5,
        source_module: 'orchestrator.js'
      });
    } catch (e) {}
    console.log(COLOR_DIM + '  plan: deterministic fallback (use MCP troth_orchestrate_run for LLM-driven planning)' + COLOR_RESET);
  }
  console.log('');

  // SAFETY. The entity's
  // autonomous path goes through supervisor.runDAG which already caps
  // parallel workers to what the machine can carry — but THIS direct CLI
  // path fired every role at once. Five roles on a laptop running a local
  // model = five concurrent LLM streams = cooked machine (same incident
  // class runDAG's cap was built for). Fail-closed to 1 when detection
  // fails; opts.maxParallel (--max-parallel) overrides explicitly.
  let maxW = 1;
  try { maxW = require(path.join(__dirname, '..', 'shared-core', 'device-capabilities.js')).detectCapabilities().maxWorkerParallel || 1; } catch (e) { maxW = 1; }
  if (opts.maxParallel && opts.maxParallel > 0) maxW = opts.maxParallel;
  const admitted = roles.slice(0, maxW);
  const refused  = roles.slice(maxW);

  const spawned = [];
  for (const roleName of admitted) {
    const role = rolesMod.getRole(roleName, process.cwd());
    const transport = (role && role.transport_hint) || 'router';
    const subtask = (plan && plan[roleName] && plan[roleName].subtask) || task;
    const result = supervisor.spawnRoleWorker(roleName, subtask, {
      group_id: groupId,
      tenant:   opts.tenant
    });
    if (!result.ok) {
      console.error(COLOR_RED + '  ✗ ' + roleName + ': ' + result.error + COLOR_RESET);
      continue;
    }
    console.log(COLOR_GREEN + '  ✓' + COLOR_RESET + ' ' + roleName +
                COLOR_DIM + ' [' + transport + ' / ' + (result.model || 'default') + '] → ' + result.runId + COLOR_RESET);
    spawned.push(result);
  }

  if (refused.length) {
    console.log('');
    console.log(COLOR_YELLOW + '⚠ ' + refused.length + ' role(s) NOT started — this machine safely runs ' + maxW +
                ' worker(s) at once: ' + refused.join(', ') + COLOR_RESET);
    console.log(COLOR_DIM + '  Run them when these finish:  troth orchestrate "' + task.replace(/"/g, '\\"') +
                '" --roles ' + refused.join(',') + COLOR_RESET);
    console.log(COLOR_DIM + '  Or override at your own risk: --max-parallel ' + roles.length + COLOR_RESET);
  }

  if (!spawned.length) {
    console.error(COLOR_RED + 'No role workers spawned successfully.' + COLOR_RESET);
    return 1;
  }

  console.log('');
  console.log(COLOR_DIM + 'Workers running. Follow up with:' + COLOR_RESET);
  console.log('  troth orchestrate-status ' + groupId + '   # poll progress');
  for (const r of spawned) {
    console.log('  troth logs ' + r.runId + ' -f          # tail ' + r.role + ' worker');
  }

  return 0;
}

// `troth orchestrate-status <group_id>` is a convenience for polling.
// Reads engrams per role + runs supervisor.mergeResults() for conflict
// detection. Substrate is the source of truth; this is just rendering.
function cmdOrchestrateStatus(groupId) {
  if (!groupId) {
    console.error(COLOR_RED + 'Provide a group id.' + COLOR_RESET);
    return 1;
  }
  const merged = supervisor.mergeResults(groupId);
  console.log(COLOR_CYAN + 'Orchestration ' + groupId + ' — ' + merged.status + COLOR_RESET);
  if (merged.role_count === 0) {
    console.log(COLOR_DIM + '  (no engrams yet — workers may still be starting)' + COLOR_RESET);
    return 0;
  }
  for (const roleName of Object.keys(merged.by_role)) {
    const r = merged.by_role[roleName];
    console.log('  ' + roleName + ': ' + r.engram_count + ' engram(s)');
    if (r.latest_statement) {
      console.log(COLOR_DIM + '    ↳ ' + r.latest_statement.replace(/\s+/g, ' ').slice(0, 140) + COLOR_RESET);
    }
  }
  if (merged.conflicts.length) {
    console.log('');
    console.log(COLOR_YELLOW + '⚠ ' + merged.conflicts.length + ' cross-role conflict(s):' + COLOR_RESET);
    for (const c of merged.conflicts) {
      console.log('  ' + c.a + ' ↔ ' + c.b);
      console.log(COLOR_DIM + '    ' + c.a + ': ' + c.a_claim.slice(0, 120) + COLOR_RESET);
      console.log(COLOR_DIM + '    ' + c.b + ': ' + c.b_claim.slice(0, 120) + COLOR_RESET);
    }
  }
  return 0;
}

module.exports = {
  cmdOrchestrate,
  cmdOrchestrateStatus
};
