// SPDX-License-Identifier: AGPL-3.0-only
// Agent Supervisor — process supervisor for role-specialist workers.
//
// Spawns one worker per role per orchestration. Each worker:
//   runs in its own git worktree (Docker container or subprocess)
//   is pinned to the role's transport_hint via env (the proxy honors it)
//   writes engrams scoped to `role:<name>:group:<id>` so siblings can
//     read each other's progress without message-passing
//   runs in tenant-scoped substrate (STATE_DB_PATH) when --tenant set
//
// The supervisor itself is stateless: spawn → poll substrate → merge.
// All state lives in substrate engrams + the runner's `~/.troth/runs/`
// dirs for log/exit-code/container-id triples. Restart-safe.
//
// API:
//   spawnRoleWorker(role, task, opts) → { ok, runId, agent_id, scope }
//   pollResults(group_id) → array of { role, runId, state, latest_engrams }
//   mergeResults(group_id) → {
//     group_id, status, by_role: { roleName: { state, summary, engram_count } },
//     consensus: ?,            // present when all roles report compatible findings
//     conflicts: [...]         // when multi-agent.classify detects disagreement
//   }
//
// Wraps bin/runner.js spawnWorker. Does NOT bypass it; the orchestrator
// CLI also goes through this single surface so race + orchestrate share
// hardening (sandbox, env, tenant pinning).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || require('os').homedir();
const RUNS_DIR = path.join(HOME, '.troth', 'runs');

const roles = require('./roles.js');

// Lazy require so this module doesn't pull SQLite into pure-CLI paths.
function _engram()  { return require('./engram.js'); }
function _state()   { return require('./state.js'); }
function _ar()      { return require('./action-record.js'); }
function _runner()  { return require(path.join(__dirname, '..', 'bin', 'runner.js')); }
function _multi()   { return require('./multi-agent.js'); }

function _genGroupId() {
  return 'orch-' + Date.now().toString(36) + '-' +
         Math.random().toString(36).slice(2, 8);
}

function _genRunId(roleName, groupId) {
  return groupId + '-' + roleName + '-' + Math.random().toString(36).slice(2, 6);
}

// Spawn one role-specialist worker. Returns the metadata the orchestrator
// needs to track the run; substrate carries the actual outputs.
//
// opts.depends_on (string[]) — names of OTHER roles whose
// completion engrams must exist before this worker spawns. Caller
// (orchestrator's runDAG) is responsible for honoring this; spawnRoleWorker
// itself fires synchronously. The DAG check happens upstream.
function spawnRoleWorker(roleName, task, opts) {
  opts = opts || {};
  const groupId = opts.group_id || _genGroupId();
  const tenant  = opts.tenant   || (
    fs.existsSync(path.join(HOME, '.troth', '.active-tenant'))
      ? fs.readFileSync(path.join(HOME, '.troth', '.active-tenant'), 'utf8').trim()
      : null
  );
  const cwd = opts.cwd || process.cwd();

  const role = roles.getRole(roleName, cwd);
  if (!role) return { ok: false, error: 'unknown role: ' + roleName };

  const runId = _genRunId(roleName, groupId);
  const runDir = path.join(RUNS_DIR, runId);
  const worktreePath = path.join(runDir, 'workspace');
  try { fs.mkdirSync(runDir, { recursive: true }); } catch (e) {}

  // Add a git worktree if cwd is a git repo. Worker isolation comes from
  // the worktree + its own branch so workers don't trample each other.
  let inGit = true;
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: 'pipe' });
  } catch (_) { inGit = false; }
  if (inGit) {
    const branchName = 'troth/orch-' + groupId + '-' + roleName;
    try {
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath],
        { cwd, stdio: 'pipe' });
    } catch (e) {
      return { ok: false, error: 'git worktree failed: ' + (e.stderr || e.message || '').toString().slice(0, 200) };
    }
  } else {
    // Non-git path: just give the worker a scratch dir.
    fs.mkdirSync(worktreePath, { recursive: true });
  }

  const scope         = 'role:'     + roleName + ':group:' + groupId;
  const progressScope = 'progress:role:' + roleName + ':group:' + groupId;
  const completeScope = 'complete:role:' + roleName + ':group:' + groupId;

  // workers must follow this contract so the orchestrator
  // can (a) gate dependent roles on completion, (b) stream progress to
  // the user. Three engram conventions:
  //   · scope=role:<role>:group:<id>      — main findings
  //   · scope=progress:role:<role>:group:<id>  — pivotal progress beats
  //   · scope=complete:role:<role>:group:<id>  — ONE final sentinel
  // Without the completion sentinel, dependent roles never spawn.
  const augmentedTask =
    (role.system_prompt || '') +
    (role.system_prompt ? '\n\n---\n\n' : '') +
    'ORCHESTRATION CONTRACT (mandatory)\n' +
    '  Group: '      + groupId + '\n' +
    '  Role:  '      + roleName + '\n' +
    '\n' +
    'You are one specialist in a multi-role orchestration. Other roles\n' +
    'are running in parallel and may need your output to start. You MUST\n' +
    'use the troth_engram_record MCP tool with these scopes:\n' +
    '\n' +
    '  1. progress:  scope="' + progressScope + '"\n' +
    '     Write a short progress engram (1-2 sentences) at each pivotal\n' +
    '     moment: starting work, blocked on something, decision made.\n' +
    '     The orchestrator streams these to the user in real time.\n' +
    '\n' +
    '  2. findings:  scope="' + scope + '"\n' +
    '     Write your substantive output here — API contract, component\n' +
    '     design, test plan, whatever your role produced. Other roles\n' +
    '     can read this via troth_engram_search to coordinate.\n' +
    '\n' +
    '  3. completion: scope="' + completeScope + '"  (ONE engram, at the END)\n' +
    '     This is the COMPLETION SENTINEL. Write it ONLY when your role\n' +
    '     is fully done. Body should summarize what you accomplished.\n' +
    '     Without this engram, dependent roles never start.\n' +
    '\n' +
    'TASK FOR YOUR ROLE:\n' + task;

  // when opts.sub_brain_id is supplied, worker
  // inherits that REGISTERED sub-brain's substrate slice instead of the
  // role-synthesized agent_id. The orchestration scope (role:.../group:...)
  // still tags worker engrams for cross-role coordination — that's how
  // mergeResults pulls per-role progress — but the worker's primary
  // agent_id is now the sub-brain's, so its writes land in that sub-
  // brain's pool AND its prefix-provider auto-mounts the sub-brain's
  // accumulated engrams (specialized context). The role label here can
  // be the sub-brain's tag/name — it's just a coordination tag at this
  // point, not an identity.
  let workerAgentId = 'role-' + roleName + '-' + groupId;
  if (opts.sub_brain_id) {
    const reg = require('./agent-registry.js');
    const sb = reg.getAgent(opts.sub_brain_id) || reg.getAgentByName(opts.sub_brain_id);
    if (sb) {
      workerAgentId = sb.id;
      try { reg.touchActive(sb.id); } catch (_) {}
    }
    // If the sub-brain is unknown we fall through to the synthesized
    // role-agent_id rather than failing — caller (e.g. /team) decides
    // whether to surface the missing-sub-brain error upstream.
  }
  // O-1 fix: runner.spawnWorker treats `opts.provider` as the
  // model name passed to `claude --model …`. Earlier we passed
  // `role.transport_hint` here ('router', 'anthropic', 'llamacpp', etc.),
  // none of which are real model names — claude rejected them. The lane
  // (transport_hint) is a separate concern resolved via opts.transport_hint
  // in runner.js for Layer 4 dispatch / faculty selection. Now the worker
  // gets the right `--model role.model_pref` AND keeps the transport-side
  // routing intact.
  // Phase 5: resolve transport against AVAILABLE providers so autonomy never pins
  // every worker to the one local box. model_pref is a PREFERENCE; under frontier-
  // first a local-only role is re-routed to distributed cloud via the proxy router.
  const _wt = require('./worker-dispatch.js').resolveWorkerTransport(role, opts.dispatch_ctx);
  const result = _runner().spawnWorker(augmentedTask, worktreePath, runDir, {
    provider:       _wt.model,
    transport_hint: _wt.transport_hint,
    role:           roleName,
    tenant:         tenant,
    capabilities:   role.capabilities || [],
    agent_id:       workerAgentId
  });

  if (!result.ok) return { ok: false, error: result.error, role: roleName };

  // Write a `decision` ActionRecord recording the spawn so the supervisor
  // can rebuild orchestration state from substrate alone.
  try {
    const ar = _ar();
    _state().recordAction({
      id: ar.uuidv7(), timestamp: Date.now(),
      type: 'decision', agent_id: 'orchestrator',
      input:  { kind: 'role_worker_spawned', group_id: groupId, role: roleName },
      // record the actual worker_agent_id (which may be a sub-brain
      // id when opts.sub_brain_id was supplied) so pollResults can find
      // engrams written under the sub-brain's pool, not just the
      // synthesized role-agent_id.
      output: { runId, mode: result.mode, model: result.model, scope,
                worker_agent_id: workerAgentId,
                sub_brain_id:    opts.sub_brain_id || null }
    }, 'role_worker_spawned');
  } catch (_) {}

  return {
    ok: true,
    group_id: groupId,
    runId,
    role: roleName,
    agent_id: result.agent_id,
    model: result.model,
    scope,
    worktree: worktreePath,
    mode: result.mode
  };
}

// Read all engrams written by workers in this group. Returns by-role.
//
// Two passes for sub-brain support:
//   1. Legacy role-synthesized agent_ids (role:<name>-<groupId>) — what
//      pre-L4 spawns used.
//   2. Substrate-discovered worker agent_ids — pulled from the
//      role_worker_spawned decision records, which now carry the real
//      worker_agent_id (sub-brain id when /team spawned the worker).
// Pass 2 is what surfaces engrams that a sub-brain worker wrote under
// its own pool; without it pollResults would return empty for sub-brain
// teams even though the writes happened.
function pollResults(groupId, opts) {
  opts = opts || {};
  const eng = _engram();
  const out = {};
  function shapeEngrams(list) {
    return list.map(function (e) {
      return {
        id: e.id,
        ts: e.ts,
        statement: (e.statement || '').slice(0, 500),
        scope: e.scope,
        salience: e.salience
      };
    });
  }
  // Pass 1 — legacy role-synthesized agent_ids.
  const knownRoles = roles.listRoles(opts.cwd);
  for (const roleName of knownRoles) {
    const agentId = 'role-' + roleName + '-' + groupId;
    const list = eng.listEngrams({ agent_id: agentId, limit: 50 }) || [];
    if (list.length) out[roleName] = shapeEngrams(list);
  }
  // Pass 2 — substrate-discovered workers (covers sub-brain teams from
  // /team where the worker_agent_id is a registered sub-brain id, not
  // the synthesized one).
  try {
    const spawns = _state().queryActions({
      type: 'decision', agent_id: 'orchestrator', limit: 200, order: 'desc'
    }) || [];
    const seen = new Set();
    for (const row of spawns) {
      let inp; try { inp = JSON.parse(row.input);  } catch (_) { continue; }
      let outp;try { outp = JSON.parse(row.output); } catch (_) { continue; }
      if (!inp || inp.kind !== 'role_worker_spawned' || inp.group_id !== groupId) continue;
      const role = inp.role;
      const workerAgentId = (outp && outp.worker_agent_id) || ('role-' + role + '-' + groupId);
      const dedupKey = role + '|' + workerAgentId;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      // Skip when this is the legacy synthesized agent — Pass 1 covered it.
      if (workerAgentId === ('role-' + role + '-' + groupId)) continue;
      const list = eng.listEngrams({ agent_id: workerAgentId, limit: 50 }) || [];
      if (!list.length) continue;
      const shaped = shapeEngrams(list);
      out[role] = (out[role] || []).concat(shaped);
    }
  } catch (_) { /* substrate read failure → return what Pass 1 found */ }
  return out;
}

// Merge per-role outputs into a single summary. Detects cross-role
// disagreement by running multi-agent.classify on the latest claim from
// each pair of roles. Conflicts surface as first-class entries (not
// "supervisor picks one") — substrate's disagreement-as-data principle.
function mergeResults(groupId, opts) {
  opts = opts || {};
  const polled = pollResults(groupId, opts);
  const ma = _multi();
  const byRole = {};
  const flatLatest = [];
  for (const roleName of Object.keys(polled)) {
    const list = polled[roleName];
    const latest = list[0];
    byRole[roleName] = {
      engram_count: list.length,
      latest_statement: latest && latest.statement,
      latest_ts: latest && latest.ts
    };
    if (latest && latest.statement) flatLatest.push({ role: roleName, stmt: latest.statement });
  }

  const conflicts = [];
  for (let i = 0; i < flatLatest.length; i++) {
    for (let j = i + 1; j < flatLatest.length; j++) {
      const verdict = ma.classify(flatLatest[i].stmt, flatLatest[j].stmt);
      if (verdict === 'conflict') {
        conflicts.push({
          a: flatLatest[i].role, b: flatLatest[j].role,
          a_claim: flatLatest[i].stmt.slice(0, 200),
          b_claim: flatLatest[j].stmt.slice(0, 200)
        });
      }
    }
  }

  return {
    group_id: groupId,
    role_count: Object.keys(byRole).length,
    by_role: byRole,
    conflicts: conflicts,
    status: Object.keys(byRole).length === 0 ? 'empty' :
            conflicts.length ? 'conflicts_detected' : 'consensus_or_orthogonal'
  };
}

// Check whether the completion sentinel engram for `role` in `group_id`
// has landed. Workers signal completion by writing an engram with
// scope `complete:role:<role>:group:<group_id>`. Used by runDAG to gate
// dependent roles.
function _isRoleComplete(role, groupId, opts) {
  opts = opts || {};
  const eng = _engram();
  const list = eng.listEngrams({
    agent_id: 'role-' + role + '-' + groupId,
    scope:    'complete:role:' + role + ':group:' + groupId,
    limit:    1
  }) || [];
  return list.length > 0;
}

// runDAG — execute a planned multi-role orchestration honoring
// dependencies. Polls every poll_ms (default 3000) for completion
// sentinel engrams and spawns dependent roles when their prerequisites
// are met. Returns when every role either completed or hit timeout.
//
// opts:
//   group_id       — required
//   plan           — { role: { subtask, depends_on } } from planner
//   dag            — topologically-sorted [{role, depends_on},...]
//   tenant         — optional tenant scope
//   cwd            — project root
//   poll_ms        — default 3000
//   timeout_ms     — default 600000 (10 min global)
//   onProgress     — optional callback (event) for live updates
async function runDAG(opts) {
  opts = opts || {};
  if (!opts.group_id || !opts.plan || !opts.dag) {
    return { ok: false, error: 'group_id, plan, dag required' };
  }
  const pollMs    = opts.poll_ms    || 3000;
  const timeoutMs = opts.timeout_ms || 10 * 60 * 1000;
  const start     = Date.now();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

  const spawned = {};   // role → spawn result
  const failed  = {};   // role → error string
  const pending = new Set(opts.dag.map(function (n) { return n.role; }));
  // SAFETY (device-capability concurrency cap): NEVER fire more workers at once
  // than the machine can handle. The incident: runDAG spawned every dep-ready role
  // in one pass with no cap and cooked the box. opts.max_worker_parallel overrides
  // (tests/callers inject a known value); else derive from the device, fail-closed to 1.
  var maxW = (opts.max_worker_parallel && opts.max_worker_parallel > 0)
    ? opts.max_worker_parallel
    : (function () { try { return require('./device-capabilities.js').detectCapabilities().maxWorkerParallel || 1; } catch (_) { return 1; } })();
  var inflight = 0;
  // Injectable seams so the cap can be load-tested WITHOUT spawning real workers.
  var _spawn = (typeof opts._spawnFn === 'function') ? opts._spawnFn : spawnRoleWorker;
  var _complete = (typeof opts._isCompleteFn === 'function')
    ? opts._isCompleteFn
    : function (role) { return _isRoleComplete(role, opts.group_id, opts); };

  function depsSatisfied(role) {
    const deps = (opts.plan[role] && opts.plan[role].depends_on) || [];
    for (const d of deps) {
      if (!_complete(d)) return false;
    }
    return true;
  }

  while (pending.size > 0) {
    if (Date.now() - start > timeoutMs) {
      return {
        ok: false,
        error: 'orchestration timeout',
        spawned, failed,
        pending: Array.from(pending)
      };
    }

    // SAFETY (audit gap): operator kill-switch. If global_pause goes active
    // mid-squad, STOP spawning new workers (already-spawned out-of-process
    // workers finish or are killed manually via `troth kill`). Fail-CLOSED: a
    // read error halts spawning. Checked once per poll (~3s) — cheap.
    var _gp = false;
    try { _gp = require('./global-pause.js').isPaused(); } catch (_) { _gp = true; }
    if (_gp) {
      return { ok: false, error: 'globally_paused', spawned, failed, pending: Array.from(pending) };
    }

    let progressed = false;
    for (const role of Array.from(pending)) {
      if (spawned[role] || failed[role]) continue;
      if (!depsSatisfied(role)) continue;
      if (inflight >= maxW) break;   // cap: stop this pass, queued roles retry next loop

      const subtask = (opts.plan[role] && opts.plan[role].subtask) || '';
      const r = _spawn(role, subtask, {
        group_id: opts.group_id,
        tenant:   opts.tenant,
        cwd:      opts.cwd
      });
      if (r.ok) {
        spawned[role] = r;
        inflight++;
        onProgress({ kind: 'spawned', role, runId: r.runId, model: r.model });
      } else {
        failed[role] = r.error || 'unknown';
        onProgress({ kind: 'spawn_failed', role, error: failed[role] });
        pending.delete(role);   // can't retry — give up on this role
      }
      progressed = true;
    }

    // Mark spawned roles as removed from pending once their completion
    // engram lands. Polling, not push, because workers are out-of-process.
    for (const role of Array.from(pending)) {
      if (spawned[role] && _complete(role)) {
        onProgress({ kind: 'completed', role });
        pending.delete(role);
        inflight--;
        progressed = true;
      }
    }

    if (pending.size === 0) break;

    if (!progressed) {
      await new Promise(function (resolve) { setTimeout(resolve, pollMs); });
    }
  }

  return {
    ok: Object.keys(failed).length === 0,
    spawned, failed,
    elapsed_ms: Date.now() - start
  };
}

// summarize — read every role engram for the group and synthesize a
// single user-facing reply. callLlm is injected (same shape as planner)
// so the caller can pick the transport. Falls back to a deterministic
// concatenation if no LLM is reachable.
//
// opts:
//   group_id, callLlm, cwd
async function summarize(groupId, opts) {
  opts = opts || {};
  const polled = pollResults(groupId, { cwd: opts.cwd });
  const roleNames = Object.keys(polled);
  if (!roleNames.length) {
    return { ok: true, group_id: groupId, summary: 'No role outputs recorded yet for ' + groupId + '.', planner_used: 'none' };
  }

  // Build deterministic baseline: per-role bullets with the latest
  // engram statement. The LLM call is best-effort polish on top.
  const lines = ['## Orchestration ' + groupId + ' — results', ''];
  for (const role of roleNames) {
    const list = polled[role];
    const latest = list[0];
    lines.push('### ' + role);
    lines.push('  · engrams: ' + list.length);
    if (latest && latest.statement) lines.push('  · latest: ' + String(latest.statement).replace(/\s+/g, ' ').slice(0, 280));
    lines.push('');
  }
  const merged = mergeResults(groupId, { cwd: opts.cwd });
  if (merged.conflicts && merged.conflicts.length) {
    lines.push('### ⚠ Conflicts');
    for (const c of merged.conflicts) {
      lines.push('  · ' + c.a + ' vs ' + c.b + ': diverged on positions');
    }
    lines.push('');
  }
  const baseline = lines.join('\n');

  if (typeof opts.callLlm !== 'function') {
    return { ok: true, group_id: groupId, summary: baseline, planner_used: 'fallback' };
  }

  try {
    const prompt =
      'You are summarizing the results of a multi-agent orchestration to ' +
      'present back to the human user in one coherent paragraph followed ' +
      'by short next-step suggestions. Do NOT invent facts — only synthesize ' +
      'what the role outputs actually say.\n\n' +
      'Per-role outputs:\n\n' + baseline +
      '\n\nWrite the user-facing summary now. Lead with what was accomplished ' +
      'across roles. Flag conflicts explicitly. End with 1-3 next steps the ' +
      'human can take.';
    const resp = await opts.callLlm(prompt, { intent: 'summarizer' });
    const text = (resp && (resp.text || resp.content || resp.output)) || '';
    if (text && text.length > 30) {
      return { ok: true, group_id: groupId, summary: text, planner_used: 'llm', baseline };
    }
    return { ok: true, group_id: groupId, summary: baseline, planner_used: 'fallback_after_llm_empty' };
  } catch (e) {
    return { ok: true, group_id: groupId, summary: baseline, planner_used: 'fallback_after_llm_error', llm_error: String(e && e.message || e).slice(0, 200) };
  }
}

module.exports = {
  spawnRoleWorker,
  pollResults,
  mergeResults,
  runDAG,
  summarize
};
