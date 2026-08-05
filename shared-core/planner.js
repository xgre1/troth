// SPDX-License-Identifier: AGPL-3.0-only
// Planner — decomposes a user task into role-specific subtasks + a DAG.
//
// Without this, `troth orchestrate "build feature X"` pushes the same
// task string into every role worker. They each interpret it ad-hoc; the
// backend may end up writing UI, the QA may rebuild the migration, work
// gets duplicated or skipped. The planner is the missing intelligence
// step between user intent and parallel execution.
//
// Two paths:
//
//   plan(task, roles, opts)       — fast structured-LLM call. Returns
//                                    {role: {subtask, depends_on}} per
//                                    requested role. Stored as engram
//                                    so a crashed orchestration can
//                                    resume from substrate.
//
//   planFallback(task, roles)     — deterministic split for when no LLM
//                                    is reachable (offline, no keys).
//                                    Same shape, role-specific scaffolds
//                                    derived from the role's system_prompt
//                                    and the raw task. Conservative; will
//                                    not invent dependencies.
//
// Output schema (canonical — supervisor and tests depend on this):
//   {
//     ok:          true | false,
//     group_id:    string,
//     plan: {
//       <role>: {
//         subtask:     string,        // role-specific instructions
//         depends_on:  string[]       // names of OTHER roles this one waits for
//       },
//       ...
//     },
//     dag: [
//       { role, depends_on: [...] }   // topologically valid order
//     ],
//     planner_used: 'llm' | 'fallback'
//   }
//
// Failure modes the supervisor must handle:
//   - circular dependency in plan → reject with `circular_dependency`
//   - role in plan that wasn't requested → ignore that entry
//   - role requested but missing from plan → fall through to raw task

const path = require('path');

const _engramLazy = () => require('./engram.js');
const _stateLazy  = () => require('./state.js');
const _arLazy     = () => require('./action-record.js');
const _rolesLazy  = () => require('./roles.js');
const _dispatchLazy = () => require('./dispatch.js');

const PLAN_PROMPT_TEMPLATE = [
  'You are the orchestration planner for a multi-agent build system.',
  'A user wants to accomplish a single high-level task; multiple specialist',
  'agents will each handle their role in parallel where possible, and',
  'sequentially where one agent\'s output feeds another.',
  '',
  'TASK: {{task}}',
  '',
  'AVAILABLE ROLES (each one will be spawned as a separate worker):',
  '{{roles_block}}',
  '',
  'For each role you list, produce:',
  '  - subtask:    a focused instruction for THAT role only. Refer to other',
  '                roles\' outputs by name when needed (e.g. "use the API',
  '                contract from backend"). Be concrete and bounded.',
  '  - depends_on: names of OTHER roles whose output is required before this',
  '                one can start. Empty list if independent.',
  '',
  'Output STRICTLY this JSON, no commentary, no code fences:',
  '{',
  '  "plan": {',
  '    "<role-name>": { "subtask": "...", "depends_on": [...] },',
  '    ...',
  '  }',
  '}',
  '',
  'Constraints:',
  '  - Only emit roles from the AVAILABLE list above.',
  '  - depends_on must reference roles that exist in your plan.',
  '  - No cycles. Independent roles get empty depends_on.',
  '  - Keep each subtask under 800 characters.'
].join('\n');

function _renderPlanPrompt(task, roles, cwd) {
  const rolesMod = _rolesLazy();
  const rolesBlock = roles.map(function (name) {
    const r = rolesMod.getRole(name, cwd) || {};
    const sys = (r.system_prompt || '').replace(/\s+/g, ' ').slice(0, 200);
    return '  - ' + name + ' [' + (r.transport_hint || 'router') + ']: ' + (sys || '(no description)');
  }).join('\n');
  return PLAN_PROMPT_TEMPLATE
    .replace('{{task}}', task)
    .replace('{{roles_block}}', rolesBlock);
}

// Topological sort. Returns ordered array of {role, depends_on} OR
// throws with kind='circular_dependency' on cycles.
function _topoSort(plan) {
  const nodes = Object.keys(plan);
  const indeg = {};
  const adj   = {};
  for (const n of nodes) { indeg[n] = 0; adj[n] = []; }
  for (const n of nodes) {
    const deps = (plan[n] && plan[n].depends_on) || [];
    for (const d of deps) {
      if (!nodes.indexOf(d) === -1) continue; // ignore deps on unrequested roles
      if (!(d in indeg)) continue;
      adj[d].push(n);
      indeg[n]++;
    }
  }
  const queue = nodes.filter(function (n) { return indeg[n] === 0; });
  const out = [];
  while (queue.length) {
    const n = queue.shift();
    out.push({ role: n, depends_on: ((plan[n] && plan[n].depends_on) || []).filter(function (d) { return d in indeg; }) });
    for (const m of adj[n]) {
      indeg[m]--;
      if (indeg[m] === 0) queue.push(m);
    }
  }
  if (out.length !== nodes.length) {
    const err = new Error('circular dependency detected');
    err.kind = 'circular_dependency';
    throw err;
  }
  return out;
}

// Deterministic fallback: each role gets a scaffolded prompt of
// "your role context + the user task". No dependencies inferred.
// Used when LLM call fails or no provider is reachable.
function planFallback(task, roles, opts) {
  opts = opts || {};
  const rolesMod = _rolesLazy();
  const plan = {};
  for (const name of roles) {
    const r = rolesMod.getRole(name, opts.cwd) || {};
    plan[name] = {
      subtask: 'Role: ' + name + '. ' +
               (r.system_prompt ? 'Mandate: ' + r.system_prompt + '\n\n' : '') +
               'Shared user task: ' + task,
      depends_on: []
    };
  }
  return {
    ok: true,
    plan,
    dag: roles.map(function (n) { return { role: n, depends_on: [] }; }),
    planner_used: 'fallback'
  };
}

// Main entry. opts:
//   cwd, group_id, callLlm, agent_id (engram owner)
// callLlm is a function (prompt, opts) => Promise<{text}>, injected by
// the caller so the planner can use whichever transport is configured
// (proxy fallback chain, MCP host, etc.) without binding to one.
async function plan(task, roles, opts) {
  opts = opts || {};
  if (!task || !roles || !roles.length) {
    return { ok: false, error: 'task and roles required', planner_used: 'none' };
  }

  let result;
  if (typeof opts.callLlm === 'function') {
    try {
      const prompt = _renderPlanPrompt(task, roles, opts.cwd);
      const resp = await opts.callLlm(prompt, { intent: 'planner', json_mode: true });
      const text = (resp && (resp.text || resp.content || resp.output)) || '';
      // Tolerant JSON extraction. Try direct parse first (works when
      // the model honored the no-code-fence instruction). Fall through
      // to balanced-brace extraction for fenced or chatty responses.
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (_) {
        const first = text.indexOf('{');
        const last  = text.lastIndexOf('}');
        if (first === -1 || last === -1 || last < first) throw new Error('no JSON object found');
        parsed = JSON.parse(text.slice(first, last + 1));
      }
      if (!parsed || !parsed.plan) throw new Error('plan field missing');
      // Filter to requested roles only.
      const filtered = {};
      for (const name of roles) {
        if (parsed.plan[name]) filtered[name] = {
          subtask:    String(parsed.plan[name].subtask || '').slice(0, 1500),
          depends_on: Array.isArray(parsed.plan[name].depends_on)
            ? parsed.plan[name].depends_on.filter(function (d) { return roles.indexOf(d) !== -1 && d !== name; })
            : []
        };
      }
      // Any requested role missing from plan → fall through to raw task.
      for (const name of roles) {
        if (!filtered[name]) filtered[name] = { subtask: task, depends_on: [] };
      }
      let dag;
      try { dag = _topoSort(filtered); }
      catch (e) {
        if (e.kind === 'circular_dependency') {
          // Strip all dependencies and retry — better degraded plan than no plan.
          for (const k of Object.keys(filtered)) filtered[k].depends_on = [];
          dag = _topoSort(filtered);
        } else { throw e; }
      }
      result = { ok: true, plan: filtered, dag, planner_used: 'llm' };
    } catch (e) {
      // LLM path failed — degrade to fallback rather than refuse.
      result = planFallback(task, roles, opts);
      result.llm_error = String(e && e.message || e).slice(0, 200);
    }
  } else {
    result = planFallback(task, roles, opts);
  }

  // Persist plan as engram so a crashed/resumed orchestration can rebuild.
  if (opts.group_id && opts.agent_id) {
    try {
      const engram = _engramLazy();
      engram.recordEngram({
        agent_id: opts.agent_id,
        cwd:      opts.cwd,
        statement: 'PLAN(' + opts.group_id + ') ' + JSON.stringify(result.plan),
        scope:    'plan:' + opts.group_id,
        source:   'planner.plan',
        salience: 1.5,
        source_module: 'planner.js'
      });
    } catch (e) {}
  }

  result.group_id = opts.group_id || null;
  return result;
}

module.exports = { plan, planFallback };
