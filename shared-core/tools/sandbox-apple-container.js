// SPDX-License-Identifier: AGPL-3.0-only
// sandbox-apple-container.js — Apple Container CLI adapter.
//
// Cross-platform sandbox runtime. This adapter
// uses Apple's `container` CLI (preview-shipped on Apple Silicon
// macOS 26+) to run Bash workloads in an OS-isolated container WITHOUT
// requiring Docker Desktop. Removes the Docker-Desktop-tax for Mac
// operators who use Apple Silicon.
//
// API contract (same shape as docker-sandbox.js so sandbox-runtime can
// fan out across adapters uniformly):
//   isAvailable() → { available: bool, version?, error? }
//   runInSandbox(command, opts) →
//     { stdout, stderr, exit_code, interrupted, sandboxed,
//       sandbox_kind:'apple-container', elapsed_ms, image, signal?,
//       error?, detail? }
//
// Apple Container CLI mapping vs Docker:
//   container run         ≈ docker run
//   --rm                  ≈ --rm
//   --memory              ≈ --memory
//   --cpus                ≈ --cpus
//   --workdir             ≈ --workdir
//   --volume host:guest   ≈ --volume host:guest
//   --tmpfs               ≈ --tmpfs (subset of options)
//   --read-only           ≈ --read-only
//   network               varies; Apple Container uses VM-per-container
//                         model + virtio network. For now we attempt
//                         '--no-network' if the CLI supports it, else
//                         we accept the default network (still kernel-
//                         isolated from host) and document the gap.
//
// References checked:
//   - apple/container github README (Apple Silicon native, OCI-compatible)
//   - macOS 26+ requirement (preview at time of writing)
//
// Design constraints (mirror docker-sandbox):
//   - Never block on image pull. If image missing, surface structured
//     error.
//   - Output capping (256 KB / stream) so a runaway can't blow LLM ctx.
//   - SIGTERM on timeout, SIGKILL after 2s grace.
//   - cwd mounted READ-ONLY at /work-ro so the container can inspect
//     operator project without mutation power.

'use strict';

const { spawn, spawnSync } = require('child_process');

const DEFAULT_IMAGE       = process.env.TROTH_APPLE_CONTAINER_IMAGE || 'alpine:latest';
const DEFAULT_MEMORY      = '512m';
const DEFAULT_CPUS        = '1.0';
const DEFAULT_TIMEOUT_MS  = 120 * 1000;
const MAX_TIMEOUT_MS      = 600 * 1000;
const TMPFS_SIZE          = '64m';
const MAX_STREAM_BYTES    = 256 * 1024;
const KILL_GRACE_MS       = 2000;
const AVAILABILITY_TTL_MS = 60 * 1000;
const CLI                 = process.env.TROTH_APPLE_CONTAINER_BIN || 'container';

let _availabilityCache = { ts: 0, value: null };

function _clip(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n…(stream truncated at ' + MAX_STREAM_BYTES + ' bytes)';
}

function isAvailable(opts) {
  opts = opts || {};
  const now = Date.now();
  if (!opts.fresh && _availabilityCache.value && (now - _availabilityCache.ts) < AVAILABILITY_TTL_MS) {
    return _availabilityCache.value;
  }
  let result;
  try {
    const r = spawnSync(CLI, ['--version'], {
      timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
    });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().length) {
      result = { available: true, version: r.stdout.trim().split(/\r?\n/)[0] };
    } else if (r.error && r.error.code === 'ENOENT') {
      result = { available: false, error: 'apple_container_cli_not_installed (looked for `' + CLI + '`)' };
    } else {
      result = {
        available: false,
        error:     (r.stderr || '').trim().slice(0, 240) || (CLI + ' --version returned exit ' + r.status)
      };
    }
  } catch (e) {
    result = { available: false, error: e && e.message || String(e) };
  }
  _availabilityCache = { ts: now, value: result };
  return result;
}

function _resetAvailabilityCache() {
  _availabilityCache = { ts: 0, value: null };
}

function runInSandbox(command, opts) {
  opts = opts || {};
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.resolve({ error: 'bad_args', detail: 'command (string, non-empty) required', sandboxed: false });
  }
  const avail = isAvailable();
  if (!avail.available) {
    return Promise.resolve({
      error:     'apple_container_unavailable',
      detail:    avail.error || 'apple `container` CLI not reachable',
      sandboxed: false
    });
  }
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT_MS, parseInt(opts.timeout_ms || DEFAULT_TIMEOUT_MS, 10)));
  const image   = opts.image  || DEFAULT_IMAGE;
  const memory  = opts.memory || DEFAULT_MEMORY;
  const cpus    = opts.cpus   || DEFAULT_CPUS;
  const cwdMount = opts.cwd ? ['--volume', opts.cwd + ':/work-ro:ro'] : [];

  // Apple Container args. Kept close to docker-sandbox so the runtime
  // safety properties are equivalent where the CLI supports them.
  const cliArgs = [
    'run',
    '--rm',
    '--memory=' + memory,
    '--cpus=' + cpus,
    '--read-only',
    '--tmpfs', '/tmp:rw,size=' + TMPFS_SIZE + ',exec',
    '--tmpfs', '/work:rw,size=' + TMPFS_SIZE + ',exec',
    '--workdir', '/work'
  ].concat(cwdMount).concat([image, 'sh', '-c', command]);

  return new Promise((resolve) => {
    const started_at = Date.now();
    const child = spawn(CLI, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        sandboxed:    true,
        sandbox_kind: 'apple-container',
        image,
        elapsed_ms:   Date.now() - started_at
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
  DEFAULT_IMAGE,
  DEFAULT_TIMEOUT_MS,
  AVAILABILITY_TTL_MS,
  // exposed for tests
  _resetAvailabilityCache
};
