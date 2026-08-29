// SPDX-License-Identifier: AGPL-3.0-only
// Bash — shell command executor, canonical Claude Code shape.
//
// Input  (BashInput from sdk-tools.d.ts):
//   { command, timeout?, description?, run_in_background?,
//     dangerouslyDisableSandbox? }
//
// Output (BashOutput):
//   { stdout, stderr, interrupted, isImage?, backgroundTaskId?, ... }
//
// V1 scope:
//   - Foreground execution with timeout (default 120s, max 600s per
//     Claude spec).
//   - SIGTERM on timeout, SIGKILL fallback after 2s grace. interrupted
//     flag set when timeout triggered.
//   - stdout / stderr captured separately, each truncated to a
//     soft cap so a runaway command can't blow context budget. The
//     full transcripts are still on the agent's terminal — this is a
//     model-facing surface, not a shell replacement.
//   - run_in_background and dangerouslyDisableSandbox return
//     not_implemented for now; both warrant their own design pass
//     (background needs a task-id registry; sandbox needs a real
//     isolation strategy, not a toggle).
//
// Sandboxing: troth runs as the user, no sandbox by default. The
// LLM-side risk gate lives one layer up (substrate's
// orchestrate_triage / drift-detector); this tool is the bare metal
// underneath. Bash's surface area is intentionally minimal.

const { spawn } = require('child_process');
const CANCEL_POLL_MS = 100;

const DEFAULT_TIMEOUT_MS = 120 * 1000;
const MAX_TIMEOUT_MS     = 600 * 1000;
const MAX_STREAM_BYTES   = 256 * 1024;  // 256 KB per stream cap (soft)
const KILL_GRACE_MS      = 2000;

const schema = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Run a shell command via bash. Output is captured to stdout/stderr fields; the call returns when the command exits or the timeout fires (default 120 s, max 600 s). interrupted=true when killed by timeout. run_in_background and dangerouslyDisableSandbox are not implemented in this release.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute via bash -c.' },
        timeout: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000).', minimum: 1, maximum: 600000 },
        description: { type: 'string', description: 'Active-voice description of what the command does (5-10 words for simple commands).' },
        run_in_background: { type: 'boolean', description: 'Not implemented in v1.' },
        dangerouslyDisableSandbox: { type: 'boolean', description: 'Not implemented in v1.' }
      },
      required: ['command']
    }
  }
};

function clip(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n…(stream truncated at ' + MAX_STREAM_BYTES + ' bytes)';
}

async function run(args, ctx) {
  args = args || {};
  ctx  = ctx  || {};
  const command = args.command;
  if (typeof command !== 'string' || !command.trim()) {
    return { error: 'bad_args', detail: 'command (string, non-empty) is required' };
  }
  if (args.run_in_background) {
    return { error: 'not_implemented', detail: 'background mode is not available in this Bash tool revision' };
  }
  if (args.dangerouslyDisableSandbox) {
    return { error: 'not_implemented', detail: 'sandbox override is not available' };
  }
  const requested = parseInt(args.timeout || DEFAULT_TIMEOUT_MS, 10);
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT_MS, isNaN(requested) ? DEFAULT_TIMEOUT_MS : requested));

  // subsystem — Docker sandbox routing.
  //
  // When ctx.l4_step is true (step-engine sets it on every step dispatch)
  // AND the operator's l4.sandbox.mode is 'auto' or 'required', Bash is
  // routed through a Docker container with no network, capped memory/cpu,
  // read-only root fs, tmpfs scratch, and the cwd mounted read-only at
  // /work-ro. The container is the OS-level perimeter that the pattern
  // refusal (J) and path policy (O) are pre-filters for — together they
  // give defense-in-depth against prompt-injection RCE.
  //
  // mode='auto'     → sandbox when docker available, fall through with
  //                   sandbox_kind:'none' + a warning when not.
  // mode='required' → refuse when docker unavailable.
  // mode='off'      → never sandbox (direct exec; preserves the original
  //                   behavior for operators on bare metal who explicitly
  //                   opt out).
  if (ctx.l4_step === true) {
    // Sandbox mode: ctx override beats config. Tests use the ctx path so
    // they don't have to monkey-patch global config (which leaks across
    // tests because the patch happens at registration time, before
    // flushAsyncTests resolves the finally block).
    let sandboxMode = 'auto';
    if (typeof ctx.l4_sandbox_mode === 'string') {
      sandboxMode = ctx.l4_sandbox_mode;
    } else {
      try {
        const l4cfg = require('../l4-config.js');
        const cfg = l4cfg.getL4Config();
        if (cfg && cfg.sandbox && typeof cfg.sandbox.mode === 'string') sandboxMode = cfg.sandbox.mode;
      } catch (_) { /* config read failure → keep auto */ }
    }
    if (sandboxMode === 'required' || sandboxMode === 'auto') {
      // sandbox-runtime selects best available adapter (apple-container
      // first on Apple Silicon, docker second, bare-exec refuse-by-default
      // last). Operator override via ~/.troth/config.json l4.sandbox.runtime.
      const sandbox = require('./sandbox-runtime.js');
      const avail = sandbox.isAvailable();
      if (avail.available && avail.kind !== 'bare') {
        const r = await sandbox.runInSandbox(command, { timeout_ms: timeout, cwd: ctx.cwd || null });
        // Re-shape to the BashOutput contract callers expect.
        return {
          stdout:      r.stdout || '',
          stderr:      r.stderr || '',
          interrupted: !!r.interrupted,
          exitCode:    typeof r.exit_code === 'number' ? r.exit_code : null,
          signal:      r.signal || null,
          sandboxed:   !!r.sandboxed,
          sandbox_kind: r.sandbox_kind || null,
          sandbox_image: r.image || null,
          elapsed_ms:  r.elapsed_ms || null,
          error:       r.error || null,
          detail:      r.detail || null
        };
      }
      if (sandboxMode === 'required') {
        return {
          error:    'sandbox_unavailable',
          detail:   'l4.sandbox.mode=required but Docker is not reachable: ' + (avail.error || 'unknown'),
          stdout:   '', stderr: '',
          interrupted: false,
          exitCode:    null,
          sandboxed:   false
        };
      }
      // auto + unavailable → fall through to direct exec, with a marker
      // so the caller can surface that the run was UN-sandboxed.
    }
  }

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let interrupted = false;
    let killTimer = null;
    let graceTimer = null;
    let done = false;

    let cancelPoll = null;

    function finish(payload) {
      if (done) return;
      done = true;
      if (killTimer)   clearTimeout(killTimer);
      if (graceTimer)  clearTimeout(graceTimer);
      if (cancelPoll)  clearInterval(cancelPoll);
      resolve(payload);
    }

    function killNow() {
      if (done) return;
      interrupted = true;
      if (cancelPoll) { clearInterval(cancelPoll); cancelPoll = null; }
      try { child.kill('SIGTERM'); } catch (_) {}
      graceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, KILL_GRACE_MS);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (e) => {
      finish({
        error: 'spawn_failed',
        detail: e && e.message || String(e),
        command
      });
    });

    child.on('close', (code, signal) => {
      finish({
        stdout:      clip(stdout),
        stderr:      clip(stderr),
        interrupted,
        exitCode:    typeof code === 'number' ? code : null,
        signal:      signal || null
      });
    });

    killTimer = setTimeout(killNow, timeout);

    if (typeof ctx.shouldCancel === 'function') {
      let asked = false;
      try { asked = !!ctx.shouldCancel(); } catch (_) { asked = false; }
      if (asked) killNow();
      else {
        cancelPoll = setInterval(() => {
          let hit = false;
          try { hit = !!ctx.shouldCancel(); } catch (_) { hit = false; }
          if (hit) killNow();
        }, CANCEL_POLL_MS);
        if (cancelPoll.unref) cancelPoll.unref();
      }
    }
  });
}

module.exports = { schema, run };
