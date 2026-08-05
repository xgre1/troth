// SPDX-License-Identifier: AGPL-3.0-only
// docker-sandbox.js — L4 Wall 7: OS-level Bash isolation perimeter.
//
// Slices J (bash-safety patterns) and O (path policy) are deterministic
// pre-filters: cheap, no infrastructure, catch the canonical destructive
// shapes. They are NOT a sandbox. A sufficiently novel attacker payload
// that doesn't match any pattern still executes in the operator process.
// This module wraps Bash in a Docker container so the worst-case payload
// can mutate files inside the container and nothing else.
//
// Container shape (alpine:latest by default, overridable via config):
//   docker run \
//     --rm                              # no leftover container after exit
//     --network=none                    # no exfiltration over network
//     --memory=512m --cpus=1.0          # bounded blast radius for fork bombs
//     --pids-limit=128                  # bounded process explosion
//     --read-only                       # root fs read-only
//     --tmpfs /tmp:rw,size=64m,exec    # scratch space for build artifacts
//     --tmpfs /work:rw,size=64m,exec   # work dir mirror
//     --workdir /work
//     --volume <cwd>:/work-ro:ro       # read-only mount of operator cwd
//                                        for code-class commands that need
//                                        to inspect (run tests etc) — they
//                                        can READ project files but cannot
//                                        mutate the operator filesystem.
//     <image> sh -c '<command>'
//
// API:
//   isAvailable() → { available: bool, version?, error? }
//     Cached for 60s so we don't fork docker once per Bash call.
//
//   runInSandbox(command, opts) →
//     { stdout, stderr, exit_code, interrupted, sandboxed:true,
//       sandbox_kind:'docker', elapsed_ms }
//     | { error, detail, sandboxed:false }
//
//   opts: { timeout_ms, cwd, image, memory, cpus }
//
// Design constraints:
//   - Never block the agentic loop on Docker pull. We assume the image is
//     already local; if not, we surface a structured error and the caller
//     decides whether to bail or fall through.
//   - Output capping mirrors bash.js (256 KB per stream) so a runaway
//     container can't blow the LLM context.
//   - SIGTERM on timeout, SIGKILL after 2s grace. --stop-signal=SIGTERM
//     on the docker run side so the container exit chain works.

const { spawn, spawnSync } = require('child_process');

const DEFAULT_IMAGE       = process.env.TROTH_DOCKER_SANDBOX_IMAGE || 'alpine:latest';
const DEFAULT_MEMORY      = '512m';
const DEFAULT_CPUS        = '1.0';
const DEFAULT_PIDS_LIMIT  = 128;
const DEFAULT_TIMEOUT_MS  = 120 * 1000;
const MAX_TIMEOUT_MS      = 600 * 1000;
const TMPFS_SIZE          = '64m';
const MAX_STREAM_BYTES    = 256 * 1024;
const KILL_GRACE_MS       = 2000;
const AVAILABILITY_TTL_MS = 60 * 1000;

let _availabilityCache = { ts: 0, value: null };

function _clip(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n…(stream truncated at ' + MAX_STREAM_BYTES + ' bytes)';
}

// Lightweight availability probe. `docker version --format` is cheap +
// requires the daemon to actually respond (catches the case where the
// CLI is installed but Docker Desktop isn't running). Cached so a hot
// path of Bash calls doesn't fork docker on every invocation.
function isAvailable(opts) {
  opts = opts || {};
  const now = Date.now();
  if (!opts.fresh && _availabilityCache.value && (now - _availabilityCache.ts) < AVAILABILITY_TTL_MS) {
    return _availabilityCache.value;
  }
  let result;
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
    });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().length) {
      result = { available: true, version: r.stdout.trim() };
    } else {
      result = {
        available: false,
        error:     (r.stderr || '').trim().slice(0, 240) || 'docker version returned exit ' + r.status
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
  // Go through module.exports so tests that stub isAvailable see their
  // override take effect (a direct reference would capture the local
  // function and skip the stub).
  const avail = module.exports.isAvailable();
  if (!avail.available) {
    return Promise.resolve({
      error:     'docker_unavailable',
      detail:    avail.error || 'docker CLI or daemon not reachable',
      sandboxed: false
    });
  }
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT_MS, parseInt(opts.timeout_ms || DEFAULT_TIMEOUT_MS, 10)));
  const image   = opts.image  || DEFAULT_IMAGE;
  const memory  = opts.memory || DEFAULT_MEMORY;
  const cpus    = opts.cpus   || DEFAULT_CPUS;
  // cwd is mounted read-only at /work-ro so the partner can inspect the
  // operator project (run tests, grep, etc) without mutating it. /work is
  // a tmpfs the container may freely write to for build artifacts.
  const cwdMount = opts.cwd ? ['--volume', opts.cwd + ':/work-ro:ro'] : [];

  const dockerArgs = [
    'run',
    '--rm',
    '--network=none',
    '--memory=' + memory,
    '--cpus=' + cpus,
    '--pids-limit=' + DEFAULT_PIDS_LIMIT,
    '--read-only',
    '--tmpfs', '/tmp:rw,size=' + TMPFS_SIZE + ',exec',
    '--tmpfs', '/work:rw,size=' + TMPFS_SIZE + ',exec',
    '--workdir', '/work',
    '--stop-signal=SIGTERM'
  ].concat(cwdMount).concat([image, 'sh', '-c', command]);

  return new Promise((resolve) => {
    const started_at = Date.now();
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        sandbox_kind: 'docker',
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
