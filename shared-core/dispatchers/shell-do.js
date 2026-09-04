// SPDX-License-Identifier: AGPL-3.0-only
// Universal shell executor (walled).
//
// Partner runs shell commands for software-development-style autonomy:
// install CLIs, run migrations, build artifacts, scaffold projects. Every
// dispatch runs behind a wall:
//
//   1. Declared sandbox — a capability whose extra_output names one
//      (docker image, network, memory). Kept as-is where operators
//      declared it.
//   2. In-place ground walls (the DEFAULT on the operator's machine):
//      the command's ground is classified, the spawn wrapped in that
//      ground's kernel profile, and the ground photographed for undo
//      before anything runs. Same walls, photos and semantics as the
//      interactive shell road.
//   3. Bare host only by explicit operator opt-in (allow_no_sandbox) or
//      where no wall runtime exists — and the result SAYS so.
//
// The older shape (docker-or-refuse) predated the in-place walls and left
// this road refusing everything on hosts without docker.
//
// Capability scope:
//   capability:shell:do:<sandbox-class>
//   Examples:
//     capability:shell:do:docker:node20      (Docker, image alias 'node20')
//     capability:shell:do:docker:supabase-cli (Docker, image alias 'supabase-cli')
//   The sandbox-class is operator-defined in capability extra_output:
//     extra_output: { sandbox: 'docker', image: 'node:20-alpine',
//                     network: 'none', memory_mb: 512, timeout_s: 120 }
//
// Cost reporting: per-second wall-clock × per-image cost rate (operator
// configures via capability extra_output.cost_per_second_usd). Spent
// time observed for budget_remaining_in_scope.

'use strict';

const { spawn } = require('child_process');

const ADAPTER_SCOPE = 'intent:shell:do:*';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function _validate(payload) {
  if (!payload || typeof payload !== 'object') return 'payload required';
  if (!payload.command) return 'payload.command required';
  if (typeof payload.command !== 'string' && !Array.isArray(payload.command)) {
    return 'payload.command must be string or string[]';
  }
  if (payload.stdin !== undefined && payload.stdin !== null && typeof payload.stdin !== 'string') {
    return 'payload.stdin must be a string when present';
  }
  return null;
}

// In-place ground walls: the product default on the operator's machine. The
// default now matches the rest of the product: classify the ground, wrap the
// spawn in the ground's own kernel profile, photograph before running. Docker
// stays where a capability declares it; the sealed-VM execute() is untouched.
function _inplaceSpec(payload) {
  const fs = require('fs');
  const ground = (payload.cwd && String(payload.cwd)) || process.env.GF_WATCH_DIR || null;
  if (!ground || !fs.existsSync(ground)) {
    return { ok: false, error: 'no_ground_for_inplace_run',
             detail: 'pass payload.cwd (or set GF_WATCH_DIR) so the command runs on classified ground' };
  }
  const cmd = Array.isArray(payload.command)
    ? payload.command
    : ['/bin/bash', '-lc', String(payload.command)];
  const timeout_ms = (payload.timeout_s ? payload.timeout_s * 1000 : DEFAULT_TIMEOUT_MS);
  let spec = null, kind = 'none', note = null, root = ground;
  try {
    const gp = require('../tools/ground-policy.js');
    const sbelt = require('../tools/sandbox-seatbelt.js');
    const c = gp.classifyGround(ground, {});
    if (c.ground === 'escape') {
      return { ok: false, error: 'ground_escape', detail: c.reason };
    }
    const jailed = (c.ground === 'workspace' || c.ground === 'project');
    root = jailed ? c.jail : (c.root || ground);
    const s = jailed
      ? sbelt.jailSpawnSpec({ cwd: root, network: 'full' })
      : sbelt.groundSpawnSpec({
          kind: c.ground === 'opened' ? 'thin' : (c.ground === 'home' ? 'home' : 'confine'),
          cwd: root, alsoWritable: c.alsoWritable
        });
    if (s && s.ok) { spec = s; kind = jailed ? 'jail' : (s.kind || c.ground); }
    else { note = (s && s.error) || 'no wall runtime on this host'; }
  } catch (e) { note = 'wall resolve failed: ' + (e && e.message || e); }
  // A photograph before the command, whichever wall applied. The net
  // never gates: its failures are recorded by the module itself.
  try { require('../tools/undo-shadow.js').snapshot(root, 'shell-do', { allowShallow: true }); } catch (e) {}
  if (spec) {
    return { ok: true, argv: [spec.exec].concat(spec.args, cmd),
             sandbox: 'seatbelt:' + kind, env: spec.env || process.env,
             cwd: ground, timeout_ms };
  }
  // No wall available on this host: run in place and SAY SO in the
  // result. A promise quietly not kept is worse than one never made.
  return { ok: true, argv: cmd, sandbox: 'none' + (note ? ' (' + note + ')' : ''),
           env: process.env, cwd: ground, timeout_ms };
}

function _runProcess(argv, opts) {
  return new Promise((resolve) => {
    const maxBytes = opts.max_bytes || DEFAULT_MAX_OUTPUT_BYTES;
    const timeoutMs = opts.timeout_ms || DEFAULT_TIMEOUT_MS;
    const t0 = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncatedOut = false, truncatedErr = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: opts.env || {},
        ...(opts.cwd ? { cwd: opts.cwd } : {})
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn_failed: ' + (e && e.message || e) });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      if (truncatedOut) return;
      if (stdout.length + c.length > maxBytes) {
        truncatedOut = true;
        try { child.kill('SIGKILL'); } catch (_) {}
        return;
      }
      stdout = Buffer.concat([stdout, c]);
    });
    child.stderr.on('data', (c) => {
      if (truncatedErr) return;
      if (stderr.length + c.length > maxBytes) {
        truncatedErr = true;
        return;
      }
      stderr = Buffer.concat([stderr, c]);
    });
    if (opts.stdin) {
      try { child.stdin.write(String(opts.stdin)); child.stdin.end(); } catch (_) {}
    } else {
      try { child.stdin.end(); } catch (_) {}
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'process_error: ' + (e && e.message || e) });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - t0;
      resolve({
        ok: true,
        exit_code: typeof code === 'number' ? code : null,
        signal:    signal || null,
        stdout:    stdout.toString('utf8'),
        stderr:    stderr.toString('utf8'),
        elapsed_ms: elapsedMs,
        truncated_stdout: truncatedOut,
        truncated_stderr: truncatedErr
      });
    });
  });
}

// Resolve which sandbox + concrete argv to run based on capability spec.
function _resolveSandbox(payload, capability) {
  // Capability's extra_output (raw) describes the sandbox. Projection
  // doesn't surface it; pull from raw via state.getAction.
  let sandboxSpec = null;
  try {
    const state = require('../state.js');
    if (state.getAction && capability && capability.id) {
      const raw = state.getAction(capability.id);
      if (raw) {
        const out = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
        if (out) sandboxSpec = {
          sandbox:           out.sandbox || null,
          image:             out.image || null,
          network:           out.network || 'none',
          memory_mb:         out.memory_mb || 512,
          cpus:              out.cpus || 1,
          timeout_s:         out.timeout_s || 120,
          allow_no_sandbox:  !!out.allow_no_sandbox,
          extra_docker_args: Array.isArray(out.extra_docker_args) ? out.extra_docker_args : [],
          env:               (out.env && typeof out.env === 'object') ? out.env : {}
        };
      }
    }
  } catch (_) {}

  // HARD REFUSE: no sandbox spec → refuse to run shell at all unless
  // capability explicitly allow_no_sandbox=true (operator opt-in for
  // dev only).
  if (!sandboxSpec) {
    return { ok: false, error: 'capability_missing_sandbox_spec',
             detail: 'capability extra_output must declare sandbox + image (or allow_no_sandbox=true for opted-in unsandboxed runs)' };
  }
  if (!sandboxSpec.sandbox) {
    if (sandboxSpec.allow_no_sandbox) {
      // Bare host process. Strongly discouraged.
      const cmd = Array.isArray(payload.command) ? payload.command : ['sh', '-c', String(payload.command)];
      return { ok: true, argv: cmd, sandbox: 'host', env: sandboxSpec.env, timeout_ms: sandboxSpec.timeout_s * 1000 };
    }
    return { ok: false, error: 'capability_sandbox_unset',
             detail: 'capability.sandbox must be "docker" (or "host" with allow_no_sandbox=true)' };
  }
  if (sandboxSpec.sandbox === 'docker') {
    if (!sandboxSpec.image) return { ok: false, error: 'capability_docker_image_unset' };
    const cmd = Array.isArray(payload.command) ? payload.command : ['sh', '-c', String(payload.command)];
    const argv = [
      'docker', 'run', '--rm', '-i',
      '--network=' + sandboxSpec.network,
      '--memory=' + sandboxSpec.memory_mb + 'm',
      '--cpus=' + sandboxSpec.cpus
    ];
    for (const k of Object.keys(sandboxSpec.env)) {
      argv.push('-e', k + '=' + sandboxSpec.env[k]);
    }
    argv.push.apply(argv, sandboxSpec.extra_docker_args);
    argv.push(sandboxSpec.image);
    argv.push.apply(argv, cmd);
    return { ok: true, argv, sandbox: 'docker', env: {}, timeout_ms: sandboxSpec.timeout_s * 1000 };
  }
  return { ok: false, error: 'unsupported_sandbox: ' + sandboxSpec.sandbox };
}

async function dispatch(intent, capability, ctx) {
  ctx = ctx || {};
  const payload = (intent && intent.payload) || {};
  const invalid = _validate(payload);
  if (invalid) return { ok: false, error: 'shell_invalid: ' + invalid };
  if (!capability) return { ok: false, error: 'shell_capability_required' };

  // Test injection.
  if (typeof ctx._shell_mock === 'function') {
    try {
      const r = await Promise.resolve(ctx._shell_mock({ intent, capability, payload }));
      return {
        ok: r.ok !== false,
        result: { exit_code: r.exit_code === undefined ? 0 : r.exit_code,
                  stdout: r.stdout || '', stderr: r.stderr || '',
                  elapsed_ms: r.elapsed_ms || 0,
                  sandbox: r.sandbox || 'mock' },
        cost_usd: typeof r.cost_usd === 'number' ? r.cost_usd : 0,
        error: r.ok === false ? (r.error || 'mock_reported_failure') : null
      };
    } catch (e) { return { ok: false, error: 'shell_mock_threw: ' + (e && e.message || e) }; }
  }

  // Declared sandbox first (docker etc.); an absent spec falls through to
  // the in-place ground walls instead of refusing the machine it ships on.
  let sb = _resolveSandbox(payload, capability);
  if (!sb.ok) {
    if (sb.error === 'capability_missing_sandbox_spec' || sb.error === 'capability_sandbox_unset') {
      sb = _inplaceSpec(payload);
    }
    if (!sb.ok) return { ok: false, error: sb.error, detail: sb.detail || null };
  }

  const out = await _runProcess(sb.argv, {
    timeout_ms: sb.timeout_ms,
    max_bytes: payload.max_output_bytes,
    stdin: payload.stdin,
    env: sb.env,
    cwd: sb.cwd
  });
  if (!out.ok) return { ok: false, error: out.error };
  // Cost: per-second × capability cost_per_second_usd if set.
  let cost_usd = 0;
  try {
    const state = require('../state.js');
    if (state.getAction && capability && capability.id) {
      const raw = state.getAction(capability.id);
      if (raw) {
        const o = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
        if (o && typeof o.cost_per_second_usd === 'number') {
          cost_usd = (out.elapsed_ms / 1000) * o.cost_per_second_usd;
        }
      }
    }
  } catch (_) {}
  return {
    ok: out.exit_code === 0,
    result: {
      exit_code: out.exit_code, signal: out.signal,
      stdout: out.stdout, stderr: out.stderr,
      elapsed_ms: out.elapsed_ms,
      truncated_stdout: out.truncated_stdout,
      truncated_stderr: out.truncated_stderr,
      sandbox: sb.sandbox
    },
    cost_usd,
    error: out.exit_code === 0 ? null : 'shell_nonzero_exit: ' + out.exit_code
  };
}

// Bare execution core, closed tier only. Runs the command DIRECTLY with no
// sandbox resolution and no capability/state.db lookup, which is correct only
// where the caller is itself the sandbox boundary and the action was already
// authorized upstream. The host path keeps using dispatch() (capability-gated,
// host sandbox). Never call execute() on the host.
async function execute(payload, opts) {
  opts = opts || {};
  const invalid = _validate(payload);
  if (invalid) return { ok: false, error: 'shell_invalid: ' + invalid };
  // Default to a real environment (PATH etc.) — _runProcess defaults env to {}
  // which would break almost every command in the body.
  const cmd = Array.isArray(payload.command)
    ? payload.command
    : ['sh', '-c', String(payload.command)];
  const out = await _runProcess(cmd, {
    timeout_ms: payload.timeout_ms,
    max_bytes:  payload.max_output_bytes,
    stdin:      payload.stdin,
    env:        opts.env || process.env
  });
  if (!out.ok) return { ok: false, error: out.error };
  return {
    ok: out.exit_code === 0,
    result: {
      exit_code: out.exit_code, signal: out.signal,
      stdout: out.stdout, stderr: out.stderr,
      elapsed_ms: out.elapsed_ms,
      truncated_stdout: out.truncated_stdout,
      truncated_stderr: out.truncated_stderr,
      sandbox: 'vm'
    },
    error: out.exit_code === 0 ? null : 'shell_nonzero_exit: ' + out.exit_code
  };
}

module.exports = {
  scope_match: ADAPTER_SCOPE,
  param_schema: { command: 'string|string[]', cwd: 'string?', stdin: 'string?', max_output_bytes: 'number?', timeout_s: 'number?' },
  irreversibility_class: 'high',   // shell is high by default; capability lowers ceiling
  dispatch,
  execute,           // bare runner — closed tier only (see note above)
  _validate,
  _resolveSandbox,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES
};
