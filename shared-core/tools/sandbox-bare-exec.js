// SPDX-License-Identifier: AGPL-3.0-only
// sandbox-bare-exec.js — fallback adapter when no container runtime is
// available on the host.
//
// Design note:
//   bareExec (refuse non-A regime + non-none network,
//             loud SANDBOX_UNAVAILABLE log)
//
// Substrate-thesis posture: when there's no isolation, the partner
// should NOT silently run risky things on the operator's host. This
// adapter is the loud, refuse-by-default last resort.
//
// API (same shape as docker-sandbox / sandbox-apple-container so the
// sandbox-runtime selector can fan out uniformly):
//   isAvailable() → { available: true, version: 'host-process',
//                     kind:'bare', warning: 'NO_ISOLATION' }
//                   (always available because it's just exec)
//   runInSandbox(command, opts) →
//     - REFUSES by default with sandbox_unavailable
//     - When opts.allow_unsandboxed === true (explicit operator opt-in)
//       OR opts.regime === 'A' + opts.network === 'none' (sandbox regime step
//       safe-regime), runs `bash -c '<command>'` directly with the
//       same timeout/output-cap discipline as the real sandbox.
//       Result is tagged sandboxed:false, sandbox_kind:'bare' so the
//       caller can surface "this was UN-sandboxed" to the operator.
//
// sandbox regime step will define the regime field on goals. Until then, opt-in
// requires the explicit opts.allow_unsandboxed flag.

'use strict';

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120 * 1000;
const MAX_TIMEOUT_MS     = 600 * 1000;
const MAX_STREAM_BYTES   = 256 * 1024;
const KILL_GRACE_MS      = 2000;

function _clip(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n…(stream truncated at ' + MAX_STREAM_BYTES + ' bytes)';
}

function isAvailable() {
  // bare-exec is always "available" but always carries the NO_ISOLATION
  // warning so the runtime selector can prefer real adapters first.
  return {
    available: true,
    version:   'host-process',
    kind:      'bare',
    warning:   'NO_ISOLATION — runs directly on operator host'
  };
}

// Design note:
//   "refuse non-A regime + non-none network, loud SANDBOX_UNAVAILABLE log"
// sandbox regime step regime field not yet defined; for now use:
//   - opts.allow_unsandboxed === true   → explicit operator opt-in
//   - opts.regime === 'A' + opts.network === 'none' → sandbox regime step safe-regime
// Either gate permits the bare exec; anything else REFUSES.
function _isExecutionPermitted(opts) {
  if (opts.allow_unsandboxed === true) return true;
  if (opts.regime === 'A' && opts.network === 'none') return true;
  return false;
}

function runInSandbox(command, opts) {
  opts = opts || {};
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.resolve({ error: 'bad_args', detail: 'command (string, non-empty) required', sandboxed: false });
  }

  // Loud warning surface on every call — even permitted ones — so the
  // operator's audit log records that bare exec happened.
  // eslint-disable-next-line no-console
  console.warn('SANDBOX_UNAVAILABLE: no container runtime; bare-exec ' + (
    _isExecutionPermitted(opts) ? 'permitted (operator-opt-in or safe-regime)' : 'REFUSED'
  ));

  if (!_isExecutionPermitted(opts)) {
    return Promise.resolve({
      error:     'sandbox_unavailable',
      detail:    'no container runtime available; bare-exec refuses without opts.allow_unsandboxed or {regime:A, network:none}',
      sandboxed: false,
      sandbox_kind: 'bare',
      stdout:    '', stderr: '',
      exit_code: null,
      interrupted: false
    });
  }

  const timeout = Math.max(1, Math.min(MAX_TIMEOUT_MS, parseInt(opts.timeout_ms || DEFAULT_TIMEOUT_MS, 10)));

  return new Promise((resolve) => {
    const started_at = Date.now();
    const child = spawn('bash', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd || undefined
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    let done = false;
    let killTimer = null;
    let graceTimer = null;

    function finish(payload) {
      if (done) return;
      done = true;
      if (killTimer)  clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(Object.assign({
        sandboxed:    false,
        sandbox_kind: 'bare',
        elapsed_ms:   Date.now() - started_at,
        warning:      'NO_ISOLATION'
      }, payload));
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({
      error:    'spawn_failed',
      detail:   e && e.message || String(e),
      stdout:   _clip(stdout),
      stderr:   _clip(stderr),
      exit_code: null,
      interrupted
    }));
    child.on('exit', (code, signal) => finish({
      stdout:    _clip(stdout),
      stderr:    _clip(stderr),
      exit_code: code,
      signal:    signal || null,
      interrupted
    }));

    killTimer = setTimeout(() => {
      interrupted = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      graceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, KILL_GRACE_MS);
    }, timeout);
  });
}

module.exports = {
  isAvailable,
  runInSandbox,
  // exposed for tests
  _isExecutionPermitted
};
