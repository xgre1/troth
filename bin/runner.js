// SPDX-License-Identifier: AGPL-3.0-only
// troth runner — v6.0
//
// Implements `troth run "task"` and the lifecycle commands around
// it (`status`, `logs`, `diff`, `merge`, `kill`, `clean`). Each run
// is an isolated Docker container running Claude Code in autonomous
// (`--dangerously-skip-permissions -p`) mode against a fresh git
// worktree of the user's current branch.
//
// State layout on disk:
//
//   ~/.troth/runs/
//       <run-id>/
//           meta.json         — run metadata (task, branch, container,...)
//           workspace/        — the git worktree the worker operates on
//           container-id      — current Docker container id (if any)
//           log.txt           — captured docker logs output
//           exit-code         — final container exit code (when done)
//
// A run is in one of these states:
//   pending    — meta.json exists, container not yet started
//   running    — container exists and `docker inspect` says running
//   done       — container exited with status 0
//   failed     — container exited with non-zero status
//   killed     — container was explicitly killed by `troth kill`
//
// State is derived on-demand from the filesystem and Docker, not
// stored as a third source of truth. That keeps everything consistent
// even if troth or Docker is restarted between commands.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn, spawnSync } = require('child_process');

const HOME = process.env.HOME || require('os').homedir();
// TROTH_RUNS_DIR: hermetic override for the suite — a test can point the
// runner at a temp dir without touching a live install's ~/.troth/runs.
const RUNS_DIR = process.env.TROTH_RUNS_DIR || path.join(HOME, '.troth', 'runs');
const CONFIG_FILE = path.join(HOME, '.troth', 'config.json');
const IMAGE_TAG = 'troth-worker:latest';

const COLOR_RESET = '\x1b[0m';
const COLOR_DIM = '\x1b[2m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_RED = '\x1b[31m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_CYAN = '\x1b[36m';

// ────────────────────────────────────────────────────────────────────
// Pre-flight checks
// ────────────────────────────────────────────────────────────────────

function isDockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

// provider → model resolution. Earlier code hardcoded
// `--model gemini-3.1-pro` in the subprocess fallback regardless of the
// `--providers` flag, so `troth race --providers qwen,opus,deepseek`
// silently ran every worker on the same model. Resolve here so the
// provider name actually flows through. Layer 4 dispatch (which lives
// inside the proxy) translates the model alias further if needed; this
// is just the surface mapping the worker sees.
const PROVIDER_MODEL = {
  opus:        'claude-opus-4-7',
  sonnet:      'claude-sonnet-4-6',
  haiku:       'claude-haiku-4-5',
  qwen:        'qwen3-max',
  qwen3:       'qwen3-max',
  qwenmax:     'qwen3-max',
  deepseek:    'deepseek-chat',
  deepseekv3:  'deepseek-chat',
  gemma:       'gemma-4-31b',
  gemini:      'gemini-3.1-pro',
  llama:       'llama-3.3-70b'
};

function resolveProviderModel(provider) {
  if (!provider) return 'gemini-3.1-pro';
  const key = String(provider).toLowerCase();
  return PROVIDER_MODEL[key] || provider;
}

// invoke Layer 4 dispatch to honor role.transport_hint.
// Roles like { transport_hint: 'llamacpp' } expect their workers to
// route through the local llama.cpp transport, not the proxy fallback
// chain. Without this call the env var TROTH_PROVIDER carried only
// hint-level information; the actual selection happened later inside
// the proxy. By picking up front we can both (a) set TROTH_FACULTY
// for the worker to advertise to the proxy, and (b) catch
// transport-not-available errors here instead of mid-conversation.
function resolveFaculty(provider, transportHint) {
  let dispatch;
  try { dispatch = require(path.join(__dirname, '..', 'shared-core', 'dispatch.js')); }
  catch (_) { return null; }

  // The set of available transports the worker's proxy can route to.
  // We can't introspect the proxy from here, so pass a permissive
  // default — the proxy will gracefully fall back if a faculty isn't
  // actually wired. This still pulls the rule machinery into the loop.
  const available = ['llamacpp', 'router', 'ollama', 'anthropic', 'echo', 'noop'];
  let dispatcher;
  try { dispatcher = dispatch.makeDispatcher({ available }); }
  catch (_) { return null; }

  const action = {
    options: {
      transport_hint: transportHint || provider || null
    }
  };
  try {
    const choice = dispatcher.pick(action, { mind: { active_projects: [] } });
    return choice && choice.faculty;
  } catch (_) { return null; }
}

// Spawn a worker — Docker if available, subprocess fallback if not.
// Returns { ok, containerId?, pid?, mode } or { ok: false, error }.
//
// Recognized opts:
//   provider      — passed to substrate dispatch + worker --model
//   role          — agent_id label (e.g. 'backend', 'frontend')
//   tenant        — tenant scope; sets STATE_DB_PATH for substrate isolation
//   capabilities  — array of strings; gates Docker hardening
//                   (e.g. ['network'] enables --network, ['write'] keeps rw)
//   noDocker      — force subprocess fallback
function spawnWorker(task, worktreePath, runDir, opts) {
  opts = opts || {};
  const logFile = path.join(runDir, 'log.txt');
  const exitFile = path.join(runDir, 'exit-code');
  const useDocker = isDockerAvailable() && !opts.noDocker;

  // A1+A2: provider + role + tenant flow into the worker so:
  //   the proxy can dispatch to the correct LLM via Layer 4
  //   substrate engrams written by the worker carry agent_id=role
  //   state.js opens the tenant-scoped DB instead of the global one
  const provider = opts.provider || null;
  const model    = resolveProviderModel(provider);
  // TROTH_FACULTY = the Layer 4 dispatch result. The proxy's faculty
  // router (when present) can route to that transport directly instead
  // of running its own dispatch a second time.
  const faculty  = resolveFaculty(provider, opts.transport_hint || provider) || null;
  const agentId  = opts.role || opts.agent_id || ('worker-' + path.basename(runDir));
  const tenant   = opts.tenant || process.env.TROTH_TENANT || null;
  const tenantDb = tenant ? path.join(HOME, '.troth', 'tenants', tenant, 'state.db') : null;

  // A6: capability allowlist. Default closed: read-only rootfs, no caps,
  // no network. Roles that need write to /workspace get it via the bind
  // mount (always rw). Roles that need network must declare it.
  const caps = Array.isArray(opts.capabilities) ? opts.capabilities : [];
  const wantNetwork = caps.indexOf('network') !== -1;

  if (useDocker) {
    const imageTag = ensureImage();
    if (!imageTag) return { ok: false, error: 'failed to build worker image' };

    const containerName = 'troth-' + path.basename(runDir);
    const dockerArgs = [
      'run', '-d',
      '--name', containerName,
      '--memory=4g', '--cpus=2',
      '--workdir', '/workspace',
      // A6: read-only rootfs, no caps, scoped network. Bind-mounted
      // /workspace stays writable; tmp gets a small tmpfs for scratch.
      '--read-only',
      '--tmpfs', '/tmp:rw,size=128m',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network', wantNetwork ? 'bridge' : 'none',
      '-v', worktreePath + ':/workspace',
    ];
    if (tenantDb) {
      // A3: per-tenant substrate DB mounted into the container so
      // substrate writes from the worker land in the tenant file.
      try { fs.mkdirSync(path.dirname(tenantDb), { recursive: true }); } catch (e) {}
      dockerArgs.push('-v', path.dirname(tenantDb) + ':/tenant');
      dockerArgs.push('-e', 'STATE_DB_PATH=/tenant/state.db');
      // Co-locate the CAS blob store with the tenant DB so content-addressed
      // bodies (cas.js) stay with their CIDs (engram rows). Without this, cas.js
      // ignores STATE_DB_PATH and blobs fall back to the SHARED ~/.troth/cas —
      // splitting tenant artifacts + leaving dangling CIDs if the DB is moved.
      dockerArgs.push('-e', 'TROTH_CAS_DIR=/tenant/cas');
    }
    // A2: provider/role/tenant env so the worker side knows who it is.
    dockerArgs.push('-e', 'TROTH_AGENT_ID=' + agentId);
    if (provider) dockerArgs.push('-e', 'TROTH_PROVIDER=' + provider);
    if (faculty)  dockerArgs.push('-e', 'TROTH_FACULTY=' + faculty);
    if (tenant)   dockerArgs.push('-e', 'TROTH_TENANT=' + tenant);
    dockerArgs.push('-e', 'TROTH_MODEL=' + model);

    const gitconfig = path.join(HOME, '.gitconfig');
    if (fs.existsSync(gitconfig)) {
      dockerArgs.push('-v', gitconfig + ':/etc/gitconfig:ro');
    }
    dockerArgs.push(imageTag, task);

    let containerId;
    try {
      containerId = execFileSync('docker', dockerArgs, { stdio: 'pipe' }).toString().trim();
    } catch (e) {
      return { ok: false, error: 'docker run failed: ' + (e.stderr || e.message || '').toString().trim() };
    }

    fs.writeFileSync(path.join(runDir, 'container-id'), containerId + '\n');

    const logTail = spawn('docker', ['logs', '-f', containerId], {
      stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
      detached: true,
    });
    logTail.unref();

    return { ok: true, containerId: containerId, mode: 'docker', model: model, agent_id: agentId };
  }

  // Subprocess fallback — no Docker, runs claude directly on the host.
  // A1+A2+A3: env carries provider, role, tenant + STATE_DB_PATH.
  // The worker's LLM traffic goes to THIS instance's proxy, read from
  // configuration — never a hardcoded 127.0.0.1:8000. A literal port would
  // send a second troth's worker turns (and their cost) to whichever
  // instance happens to own 8000, completing answers on someone else's
  // account.
  const workerPort = (function () {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return parseInt(cfg.port || process.env.GF_PORT || '8000', 10);
    } catch (_) { return parseInt(process.env.GF_PORT || '8000', 10); }
  })();
  const baseEnv = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + workerPort,
    ANTHROPIC_API_KEY: 'troth-worker',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
    TROTH_AGENT_ID: agentId,
    TROTH_MODEL: model
  };
  if (provider) baseEnv.TROTH_PROVIDER = provider;
  if (faculty)  baseEnv.TROTH_FACULTY  = faculty;
  if (tenant)   baseEnv.TROTH_TENANT   = tenant;
  if (tenantDb) {
    try { fs.mkdirSync(path.dirname(tenantDb), { recursive: true }); } catch (e) {}
    baseEnv.STATE_DB_PATH = tenantDb;
    // Co-locate CAS blob bodies with the tenant DB (see Docker path) so content-
    // addressed artifacts don't split from their CIDs into the shared ~/.troth/cas.
    baseEnv.TROTH_CAS_DIR = path.join(path.dirname(tenantDb), 'cas');
  }
  const env = Object.assign({}, process.env, baseEnv);

  const wrapperScript = `
    var s = require('child_process').spawnSync;
    var fs = require('fs');
    var r = s('claude', [
      '--dangerously-skip-permissions',
      '--model', ${JSON.stringify(model)},
      '-p', ${JSON.stringify(task)},
    ], {
      cwd: ${JSON.stringify(worktreePath)},
      env: JSON.parse(${JSON.stringify(JSON.stringify(env))}),
      stdio: ['ignore', 1, 2],
      timeout: 30 * 60 * 1000,
    });
    fs.writeFileSync(${JSON.stringify(exitFile)}, String(r.status == null ? 1 : r.status) + '\\n');
  `;

  const logFd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, ['-e', wrapperScript], {
    cwd: worktreePath,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  try { fs.closeSync(logFd); } catch (e) {}

  fs.writeFileSync(path.join(runDir, 'pid'), String(child.pid) + '\n');

  return { ok: true, pid: child.pid, mode: 'subprocess', model: model, agent_id: agentId };
}

function checkInGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(COLOR_RED + 'Not inside a git repository.' + COLOR_RESET);
    console.error('  troth run uses git worktrees for workspace isolation.');
    console.error('  Run from inside a project that has been initialized with `git init`.');
    return false;
  }
}

function gitRepoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: 'pipe' }).toString().trim();
}

function gitCurrentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' }).toString().trim();
  } catch (e) {
    return 'HEAD';
  }
}

// ────────────────────────────────────────────────────────────────────
// Image management
// ────────────────────────────────────────────────────────────────────

function imageExists(tag) {
  try {
    const out = execFileSync('docker', ['images', '-q', tag], { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch (e) {
    return false;
  }
}

// Build the worker image from the troth repo root.
//
// We deliberately use a fixed tag (`troth-worker:latest`) instead
// of pinning to the troth version. The worker container only needs
// claude-code + an in-container troth doing Gemini routing — none
// of the host-side features (vision, MCP server, runner, CodeLens
// tree-sitter) actually run inside the worker. So the worker image
// is essentially version-independent and rebuilding it on every
// `npm install -g.` is wasted work that also exposes us to
// occasional transitive-dep build failures.
//
// To force a rebuild (e.g., to pick up a new claude-code version),
// the user runs `docker rmi troth-worker:latest` and the next
// `troth run` will rebuild.
function ensureImage() {
  if (imageExists(IMAGE_TAG)) return IMAGE_TAG;

  // Build from the troth install root. When troth is installed
  // globally via `npm install -g`, __dirname is something like
  // /opt/homebrew/lib/node_modules/troth/bin, so the build context
  // is __dirname/../  (the troth package root). The Dockerfile and
  // worker-entrypoint.sh are shipped in the npm package via the
  // "files" field in package.json — verify they're present before
  // attempting to build.
  const repoRoot = path.join(__dirname, '..');
  const dockerfile = path.join(repoRoot, 'docker', 'Dockerfile');
  if (!fs.existsSync(dockerfile)) {
    console.error(COLOR_RED + 'docker/Dockerfile not found in troth install at ' + repoRoot + COLOR_RESET);
    console.error('  This is a packaging bug — the docker/ directory should be shipped in the npm package.');
    console.error('  Try: cd ' + repoRoot + ' && npm install -g .');
    return null;
  }

  console.log(COLOR_CYAN + 'Building troth worker image (first run, ~2 minutes)...' + COLOR_RESET);
  console.log(COLOR_DIM + '  context: ' + repoRoot + COLOR_RESET);
  console.log(COLOR_DIM + '  dockerfile: ' + dockerfile + COLOR_RESET);

  const result = spawnSync('docker', [
    'build',
    '-f', dockerfile,
    '-t', IMAGE_TAG,
    repoRoot,
  ], { stdio: 'inherit' });

  if (result.status !== 0) {
    console.error(COLOR_RED + 'Image build failed.' + COLOR_RESET);
    return null;
  }

  console.log(COLOR_GREEN + '✓ Image built: ' + IMAGE_TAG + COLOR_RESET);
  return IMAGE_TAG;
}

// ────────────────────────────────────────────────────────────────────
// Run lifecycle
// ────────────────────────────────────────────────────────────────────

function generateRunId(task) {
  const slug = task.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return ts + '-' + (slug || 'task') + '-' + rand;
}

function loadMeta(runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runId, 'meta.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveMeta(runId, meta) {
  fs.mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });
  fs.writeFileSync(
    path.join(RUNS_DIR, runId, 'meta.json'),
    JSON.stringify(meta, null, 2) + '\n'
  );
}

function listRuns() {
  try {
    return fs.readdirSync(RUNS_DIR)
      .filter(f => fs.statSync(path.join(RUNS_DIR, f)).isDirectory())
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
}

// Derive the current state of a run from disk + Docker/PID.
// Returns: 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'unknown'
function runState(runId) {
  const meta = loadMeta(runId);
  if (!meta) return 'unknown';

  const exitFile = path.join(RUNS_DIR, runId, 'exit-code');
  if (fs.existsSync(exitFile)) {
    const code = parseInt(fs.readFileSync(exitFile, 'utf8').trim(), 10);
    if (code === 0) return 'done';
    if (code === 137 || code === 143) return 'killed';
    return 'failed';
  }

  // Check for subprocess-mode run (PID file)
  const pidFile = path.join(RUNS_DIR, runId, 'pid');
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid) {
      try {
        process.kill(pid, 0); // 0 = existence check, doesn't kill
        return 'running';
      } catch (e) {
        // Process is gone. exit-code file should exist if wrapper finished normally.
        // If it doesn't, the wrapper crashed before writing it.
        return 'unknown';
      }
    }
  }

  // Check for Docker-mode run (container-id file)
  const containerIdFile = path.join(RUNS_DIR, runId, 'container-id');
  if (fs.existsSync(containerIdFile)) {
    const containerId = fs.readFileSync(containerIdFile, 'utf8').trim();
    if (containerId) {
      try {
        const inspect = execFileSync('docker', ['inspect', '--format', '{{.State.Status}}', containerId], { stdio: 'pipe' }).toString().trim();
        if (inspect === 'running') return 'running';
        if (inspect === 'exited') {
          try {
            const code = execFileSync('docker', ['inspect', '--format', '{{.State.ExitCode}}', containerId], { stdio: 'pipe' }).toString().trim();
            fs.writeFileSync(exitFile, code + '\n');
            return code === '0' ? 'done' : 'failed';
          } catch (e) {
            return 'failed';
          }
        }
        return 'pending';
      } catch (e) {
        return 'unknown';
      }
    }
  }

  return 'pending';
}

// Container metadata recovery: pull number of tool calls and last
// activity from the captured log file. Best-effort, used by `status`.
function logSummary(runId) {
  const logFile = path.join(RUNS_DIR, runId, 'log.txt');
  if (!fs.existsSync(logFile)) return { lines: 0, lastLine: '' };
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(l => l.length > 0);
    const lastLine = lines[lines.length - 1] || '';
    return { lines: lines.length, lastLine: lastLine.slice(0, 100) };
  } catch (e) {
    return { lines: 0, lastLine: '' };
  }
}

// Real multi-line tail for the jobs_status entity tool: reads only the
// last `maxBytes` of the log (run logs grow to megabytes; the tool needs
// the live end, not the transcript) and returns the last `maxLines`
// complete lines. logSummary stays as the CLI's one-line digest.
function logTail(runId, opts) {
  opts = opts || {};
  const maxLines = Math.max(1, Math.min(200, opts.maxLines || 40));
  const maxBytes = Math.max(1024, opts.maxBytes || 16384);
  const logFile = path.join(RUNS_DIR, runId, 'log.txt');
  if (!fs.existsSync(logFile)) return { tail: '', tail_lines: 0, total_bytes: 0, truncated: false };
  try {
    const size = fs.statSync(logFile).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logFile, 'r');
    let chunk;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A mid-file read almost certainly lands mid-line: drop up to the
    // first newline so every returned line is complete.
    if (start > 0) chunk = chunk.slice(chunk.indexOf('\n') + 1);
    let lines = chunk.split('\n').filter(l => l.length > 0);
    const truncated = start > 0 || lines.length > maxLines;
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return { tail: lines.join('\n'), tail_lines: lines.length, total_bytes: size, truncated };
  } catch (e) {
    return { tail: '', tail_lines: 0, total_bytes: 0, truncated: false, error: (e && e.message) || String(e) };
  }
}

// ────────────────────────────────────────────────────────────────────
// `troth run "task"` — the main command
// ────────────────────────────────────────────────────────────────────

function cmdRun(task, opts) {
  opts = opts || {};
  if (!task || !task.trim()) {
    console.error(COLOR_RED + 'Provide a task description.' + COLOR_RESET);
    console.error('  Usage: troth run "implement the Stripe checkout"');
    console.error('         troth run "fix the failing tests" --fg');
    return 1;
  }

  if (!checkInGitRepo()) return 1;

  const repoRoot = gitRepoRoot();
  const parentBranch = gitCurrentBranch();
  const runId = generateRunId(task);
  const runDir = path.join(RUNS_DIR, runId);
  const worktreePath = path.join(runDir, 'workspace');
  const branchName = 'troth/' + runId;

  fs.mkdirSync(runDir, { recursive: true });

  try {
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: repoRoot, stdio: 'pipe' });
  } catch (e) {
    console.error(COLOR_RED + 'Failed to create git worktree:' + COLOR_RESET, (e.stderr || e.message || '').toString());
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (ee) {}
    return 1;
  }

  const meta = {
    id: runId,
    task: task,
    branch: branchName,
    parent_branch: parentBranch,
    repo_root: repoRoot,
    worktree: worktreePath,
    started_at: new Date().toISOString(),
    foreground: !!opts.foreground,
  };
  saveMeta(runId, meta);

  const result = spawnWorker(task, worktreePath, runDir, opts);
  if (!result.ok) {
    console.error(COLOR_RED + 'Failed to start worker:' + COLOR_RESET, result.error);
    return 1;
  }

  console.log(COLOR_GREEN + '✓' + COLOR_RESET + ' Run started: ' + COLOR_CYAN + runId + COLOR_RESET);
  console.log('  task:      ' + task);
  console.log('  mode:      ' + result.mode + (result.mode === 'subprocess' ? ' (no Docker)' : ''));
  console.log('  branch:    ' + branchName + ' (off ' + parentBranch + ')');
  console.log('  worktree:  ' + worktreePath);
  console.log('');
  console.log('  ' + COLOR_DIM + 'troth logs ' + runId + ' -f' + COLOR_RESET + '   follow live');
  console.log('  ' + COLOR_DIM + 'troth status ' + runId + COLOR_RESET + '       check progress');
  console.log('  ' + COLOR_DIM + 'troth diff ' + runId + COLOR_RESET + '         see changes');
  console.log('  ' + COLOR_DIM + 'troth merge ' + runId + COLOR_RESET + '        cherry-pick to ' + parentBranch);
  console.log('  ' + COLOR_DIM + 'troth kill ' + runId + COLOR_RESET + '         stop the run');

  // Foreground: tail the log live
  if (opts.foreground) {
    var logFile = path.join(runDir, 'log.txt');
    console.log('');
    console.log(COLOR_DIM + '── live output ──────────────────────────────────────────' + COLOR_RESET);
    var logTail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    logTail.on('exit', function() {
      var state = runState(runId);
      console.log('');
      console.log(COLOR_DIM + '── run ' + state + ' ──────────────────────────────────' + COLOR_RESET);
    });
  }

  return 0;
}

// ────────────────────────────────────────────────────────────────────
// `troth status [id]`
// ────────────────────────────────────────────────────────────────────

function colorState(state) {
  if (state === 'running') return COLOR_CYAN + state + COLOR_RESET;
  if (state === 'done') return COLOR_GREEN + state + COLOR_RESET;
  if (state === 'failed') return COLOR_RED + state + COLOR_RESET;
  if (state === 'killed') return COLOR_YELLOW + state + COLOR_RESET;
  return COLOR_DIM + state + COLOR_RESET;
}

function cmdStatus(runId) {
  if (runId) {
    const meta = loadMeta(runId);
    if (!meta) {
      console.error(COLOR_RED + 'Run not found: ' + runId + COLOR_RESET);
      return 1;
    }
    const state = runState(runId);
    const summary = logSummary(runId);
    console.log(COLOR_CYAN + meta.id + COLOR_RESET);
    console.log('  state:     ' + colorState(state));
    console.log('  task:      ' + meta.task);
    console.log('  branch:    ' + meta.branch + ' (off ' + meta.parent_branch + ')');
    console.log('  worktree:  ' + meta.worktree);
    console.log('  started:   ' + meta.started_at);
    console.log('  log lines: ' + summary.lines);
    if (summary.lastLine) console.log('  last:      ' + summary.lastLine);
    return 0;
  }

  const runs = listRuns();
  if (runs.length === 0) {
    console.log(COLOR_DIM + 'No runs yet. Start one with: troth run "<task>"' + COLOR_RESET);
    return 0;
  }
  for (const id of runs) {
    const meta = loadMeta(id);
    if (!meta) continue;
    const state = runState(id);
    const stateStr = colorState(state).padEnd(20);
    console.log('  ' + stateStr + COLOR_DIM + ' ' + id + COLOR_RESET);
    console.log('    ' + COLOR_DIM + meta.task.slice(0, 80) + COLOR_RESET);
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────
// `troth logs <id>` and `troth logs <id> -f`
// ────────────────────────────────────────────────────────────────────

function cmdLogs(runId, follow) {
  const meta = loadMeta(runId);
  if (!meta) {
    console.error(COLOR_RED + 'Run not found: ' + runId + COLOR_RESET);
    return 1;
  }

  const containerIdFile = path.join(RUNS_DIR, runId, 'container-id');
  if (fs.existsSync(containerIdFile)) {
    const containerId = fs.readFileSync(containerIdFile, 'utf8').trim();
    const args = follow ? ['logs', '-f', containerId] : ['logs', containerId];
    const result = spawnSync('docker', args, { stdio: 'inherit' });
    return result.status || 0;
  }

  // Fallback: just dump the captured log file
  const logFile = path.join(RUNS_DIR, runId, 'log.txt');
  if (fs.existsSync(logFile)) {
    process.stdout.write(fs.readFileSync(logFile, 'utf8'));
  } else {
    console.log(COLOR_DIM + '(no logs captured for ' + runId + ')' + COLOR_RESET);
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────
// `troth diff <id>`
// ────────────────────────────────────────────────────────────────────

function cmdDiff(runId) {
  const meta = loadMeta(runId);
  if (!meta) {
    console.error(COLOR_RED + 'Run not found: ' + runId + COLOR_RESET);
    return 1;
  }
  const result = spawnSync('git', [
    '-C', meta.worktree,
    'diff', meta.parent_branch + '...HEAD',
  ], { stdio: 'inherit' });
  return result.status || 0;
}

// ────────────────────────────────────────────────────────────────────
// `troth merge <id>`
// ────────────────────────────────────────────────────────────────────

function cmdMerge(runId) {
  const meta = loadMeta(runId);
  if (!meta) {
    console.error(COLOR_RED + 'Run not found: ' + runId + COLOR_RESET);
    return 1;
  }

  // Find the commits the worker added on top of parent_branch.
  let revs;
  try {
    revs = execFileSync('git', [
      '-C', meta.worktree,
      'rev-list', '--reverse', meta.parent_branch + '..HEAD',
    ], { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
  } catch (e) {
    console.error(COLOR_RED + 'Failed to read worktree commits:' + COLOR_RESET, (e.stderr || e.message || '').toString());
    return 1;
  }

  if (revs.length === 0) {
    console.log(COLOR_YELLOW + 'No new commits in ' + meta.branch + ' to merge.' + COLOR_RESET);
    return 0;
  }

  console.log('Cherry-picking ' + revs.length + ' commit(s) from ' + meta.branch + '...');
  for (const rev of revs) {
    const result = spawnSync('git', ['cherry-pick', rev], { cwd: meta.repo_root, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(COLOR_RED + 'Cherry-pick failed at ' + rev.slice(0, 7) + '. Resolve conflicts manually then `git cherry-pick --continue`.' + COLOR_RESET);
      return 1;
    }
  }
  console.log(COLOR_GREEN + '✓ Merged ' + revs.length + ' commit(s) into ' + gitCurrentBranch() + COLOR_RESET);
  return 0;
}

// ────────────────────────────────────────────────────────────────────
// `troth kill <id>`
// ────────────────────────────────────────────────────────────────────

function killWorker(runId) {
  var killed = false;
  // Try PID kill (subprocess mode)
  var pidFile = path.join(RUNS_DIR, runId, 'pid');
  if (fs.existsSync(pidFile)) {
    var pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); killed = true; } // negative = process group
      catch (e) {
        try { process.kill(pid, 'SIGTERM'); killed = true; }
        catch (e2) { /* already dead */ }
      }
    }
  }
  // Try Docker kill (container mode)
  var containerIdFile = path.join(RUNS_DIR, runId, 'container-id');
  if (fs.existsSync(containerIdFile)) {
    var containerId = fs.readFileSync(containerIdFile, 'utf8').trim();
    if (containerId) {
      try { execFileSync('docker', ['kill', containerId], { stdio: 'pipe' }); killed = true; }
      catch (e) { /* already stopped */ }
    }
  }
  if (killed) {
    fs.writeFileSync(path.join(RUNS_DIR, runId, 'exit-code'), '137\n');
  }
  return killed;
}

function cmdKill(runId) {
  const meta = loadMeta(runId);
  if (!meta) {
    console.error(COLOR_RED + 'Run not found: ' + runId + COLOR_RESET);
    return 1;
  }
  if (killWorker(runId)) {
    console.log(COLOR_YELLOW + '✓ Killed ' + runId + COLOR_RESET);
  } else {
    console.log(COLOR_DIM + 'Worker was already stopped.' + COLOR_RESET);
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────
// `troth clean <id>` and `troth clean --all`
// ────────────────────────────────────────────────────────────────────

function cleanOne(runId) {
  const meta = loadMeta(runId);
  if (!meta) return false;

  // Kill the worker FIRST, in BOTH modes: the container
  // teardown below only covers docker mode — a subprocess-mode worker survived
  // its pid file being deleted and kept running against a worktree we're
  // about to yank. killWorker SIGTERMs the process group; we escalate to
  // SIGKILL because clean destroys the run's world anyway.
  try { killWorker(runId); } catch (e) {}
  try {
    const pidFileK = path.join(RUNS_DIR, runId, 'pid');
    if (fs.existsSync(pidFileK)) {
      const pidK = parseInt(fs.readFileSync(pidFileK, 'utf8').trim(), 10);
      if (pidK) {
        try { process.kill(-pidK, 'SIGKILL'); } catch (e) { try { process.kill(pidK, 'SIGKILL'); } catch (e2) {} }
      }
    }
  } catch (e) {}

  // Stop and remove container if it exists.
  const containerIdFile = path.join(RUNS_DIR, runId, 'container-id');
  if (fs.existsSync(containerIdFile)) {
    const containerId = fs.readFileSync(containerIdFile, 'utf8').trim();
    try { execFileSync('docker', ['rm', '-f', containerId], { stdio: 'pipe' }); } catch (e) {}
  }

  // Remove the git worktree (which also deletes the on-disk dir).
  if (meta.worktree && fs.existsSync(meta.worktree)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', meta.worktree], { cwd: meta.repo_root, stdio: 'pipe' });
    } catch (e) {
      // Worktree might already be unregistered; just rmdir directly
      try { fs.rmSync(meta.worktree, { recursive: true, force: true }); } catch (e2) {}
    }
  }

  // Delete the troth branch (it lived only inside the worktree).
  try {
    execFileSync('git', ['branch', '-D', meta.branch], { cwd: meta.repo_root, stdio: 'pipe' });
  } catch (e) {}

  // Remove the metadata directory.
  const runDir = path.join(RUNS_DIR, runId);
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (e) {}

  return true;
}

// `troth clean --stuck` — scan for troth-proxy-* processes, keep
// the primary (configured port or 8000), list siblings, and optionally
// SIGKILL any that look stuck (>30% CPU and >10min wall-clock uptime).
// Added after a forgotten test instance pinned a laptop at 100% CPU
// for six hours. Dry-run by default; pass kill=true to actually kill.
function cmdCleanStuck(kill) {
  const primaryPort = (function () {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return parseInt(cfg.port || process.env.GF_PORT || '8000');
    } catch (e) { return parseInt(process.env.GF_PORT || '8000'); }
  })();

  let psOut;
  try {
    psOut = execFileSync('ps', ['-eo', 'pid,pcpu,etime,comm,args'], { encoding: 'utf8' });
  } catch (e) {
    console.error(COLOR_RED + 'Could not list processes: ' + e.message + COLOR_RESET);
    return 1;
  }

  const lines = psOut.split('\n').slice(1);
  const candidates = [];
  for (const line of lines) {
    if (!/troth-proxy-|proxy\/server\.js/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pid = parseInt(parts[0]);
    const cpu = parseFloat(parts[1]);
    const etime = parts[2]; // dd-hh:mm:ss or hh:mm:ss or mm:ss
    const comm = parts[3] || '';
    if (pid === process.pid || !pid) continue;

    // Extract port from process title. `ps` truncates the `comm` column
    // to 16 chars (yielding "troth-proxy-80"), but the `args` column
    // carries the full name. Grab all matches and take the longest — the
    // truncated 2-digit form always loses to the real 4+ digit port.
    const portMatches = [...line.matchAll(/troth-proxy-(\d+)/g)].map(m => m[1]);
    const bestPort = portMatches.sort((a, b) => b.length - a.length)[0];
    const port = bestPort ? parseInt(bestPort) : null;

    // Parse etime → seconds for uptime gating
    const uptimeSec = (function (s) {
      const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
      if (!m) return 0;
      const d = parseInt(m[1] || '0');
      const h = parseInt(m[2] || '0');
      const mm = parseInt(m[3] || '0');
      const ss = parseInt(m[4] || '0');
      return d * 86400 + h * 3600 + mm * 60 + ss;
    })(etime);

    candidates.push({ pid, cpu, uptimeSec, etime, port, line: trimmed });
  }

  if (!candidates.length) {
    console.log(COLOR_GREEN + '✓ No troth proxy processes found' + COLOR_RESET);
    return 0;
  }

  console.log('Primary port: ' + primaryPort);
  console.log('Found ' + candidates.length + ' troth proxy process(es):');
  console.log('');

  const stuck = [];
  for (const c of candidates) {
    const isPrimary = c.port === primaryPort;
    const isStuck = c.cpu > 30 && c.uptimeSec > 600;
    const tag = isPrimary ? COLOR_GREEN + 'PRIMARY' + COLOR_RESET
             : isStuck    ? COLOR_RED   + 'STUCK  ' + COLOR_RESET
                          : COLOR_YELLOW + 'sibling' + COLOR_RESET;
    console.log('  ' + tag + '  pid=' + c.pid + '  port=' + (c.port || '?') + '  cpu=' + c.cpu.toFixed(1) + '%  up=' + c.etime);
    if (isStuck && !isPrimary) stuck.push(c);
  }
  console.log('');

  if (!stuck.length) {
    console.log(COLOR_GREEN + '✓ Nothing stuck (>30% CPU and >10min uptime)' + COLOR_RESET);
    return 0;
  }

  if (!kill) {
    console.log(COLOR_YELLOW + stuck.length + ' stuck instance(s) detected. Run `troth clean --stuck --kill` to terminate.' + COLOR_RESET);
    return 0;
  }

  let killed = 0;
  for (const c of stuck) {
    try {
      process.kill(c.pid, 'SIGKILL');
      console.log(COLOR_GREEN + '✓ Killed pid ' + c.pid + COLOR_RESET);
      killed++;
    } catch (e) {
      console.error(COLOR_RED + '✗ Could not kill pid ' + c.pid + ': ' + e.message + COLOR_RESET);
    }
  }
  console.log('');
  console.log(COLOR_GREEN + '✓ Killed ' + killed + ' stuck proxy process(es)' + COLOR_RESET);
  return 0;
}

function cmdClean(runId, all) {
  if (all) {
    const runs = listRuns();
    let cleaned = 0;
    for (const id of runs) {
      const state = runState(id);
      if (state === 'running' || state === 'pending') continue; // skip live runs
      if (cleanOne(id)) cleaned++;
    }
    console.log(COLOR_GREEN + '✓ Cleaned ' + cleaned + ' finished run(s)' + COLOR_RESET);
    return 0;
  }
  if (!runId) {
    console.error(COLOR_RED + 'Provide a run id or --all' + COLOR_RESET);
    return 1;
  }
  if (cleanOne(runId)) {
    console.log(COLOR_GREEN + '✓ Cleaned ' + runId + COLOR_RESET);
    return 0;
  }
  console.error(COLOR_RED + 'Run not found: ' + runId + COLOR_RESET);
  return 1;
}

// ────────────────────────────────────────────────────────────────────
// v6.2 — Remote daemon HTTP client
// ────────────────────────────────────────────────────────────────────
//
// When the user passes --remote=<host>:<port> to a `troth run` /
// `status` / `logs` / `diff` / `kill` / `clean` command, the local
// CLI bypasses Docker entirely and HTTP-talks to the remote troth
// daemon (typically on a remote server over Tailscale). The daemon
// spawns the worker container on its own host. This is what makes
// "give task, close laptop, come back tomorrow" possible.
//
// The remote target can be specified two ways:
//   1. CLI flag:   troth run "task" --remote=your-server.local:8000
//   2. Config:     ~/.troth/config.json { "remoteHost": "your-server.local:8000" }
//
// Auth is a shared bearer token in ~/.troth/config.json (`remoteToken`).
// The CLI sends it; the daemon checks it. The token is generated on
// the daemon side at first startup and the user copies it to their
// laptop config once.

function loadRemoteConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      host: cfg.remoteHost || null,    // e.g. "your-server.local:8000" or "your-server.local:8000"
      token: cfg.remoteToken || null,
    };
  } catch (e) {
    return { host: null, token: null };
  }
}

// Parse a --remote=<host>:<port> string. Accepts bare host (defaults
// to port 8000), full host:port, or http://host:port.
function parseRemoteTarget(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const colonIdx = s.lastIndexOf(':');
  if (colonIdx === -1) return { host: s, port: 8000 };
  const host = s.slice(0, colonIdx);
  const port = parseInt(s.slice(colonIdx + 1), 10) || 8000;
  return { host: host, port: port };
}

// Generic HTTP request to a remote daemon. Returns a promise resolving
// to { status, body } or rejecting on network failure.
function remoteRequest(target, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': 'Bearer ' + (token || ''),
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: target.host,
      port: target.port,
      path: urlPath,
      method: method,
      headers: headers,
      timeout: 60000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Resolve which remote target to use given the user's --remote flag and
// their config. CLI flag overrides config. Returns the parsed target +
// the auth token, or null if no remote is configured.
function resolveRemote(opts) {
  opts = opts || {};
  const cfg = loadRemoteConfig();
  let target = null;
  if (opts.remote) {
    target = parseRemoteTarget(opts.remote);
  } else if (cfg.host) {
    target = parseRemoteTarget(cfg.host);
  }
  if (!target) return null;
  return { target: target, token: cfg.token };
}

// ────────────────────────────────────────────────────────────────────
// Remote-mode wrappers — each cmd*Remote function makes the equivalent
// HTTP call to a remote daemon and pretty-prints the result locally
// using the same color scheme as the local cmd* functions.
// ────────────────────────────────────────────────────────────────────

async function cmdRunRemote(task, opts) {
  const r = resolveRemote(opts);
  if (!r) {
    console.error(COLOR_RED + '--remote requires either --remote=<host>:<port> or remoteHost in config' + COLOR_RESET);
    return 1;
  }
  if (!r.token) {
    console.error(COLOR_RED + 'no remoteToken in config — copy it from the daemon machine\'s ~/.troth/config.json' + COLOR_RESET);
    return 1;
  }
  console.log(COLOR_DIM + 'dispatching to ' + r.target.host + ':' + r.target.port + '...' + COLOR_RESET);
  try {
    const resp = await remoteRequest(r.target, 'POST', '/api/runs', { task: task, options: {} }, r.token);
    if (resp.status === 201 && resp.body && resp.body.ok) {
      const m = resp.body.meta;
      console.log(COLOR_GREEN + '✓' + COLOR_RESET + ' Run started on remote: ' + COLOR_CYAN + m.id + COLOR_RESET);
      console.log('  task:    ' + m.task);
      console.log('  branch:  ' + m.branch);
      console.log('  remote:  ' + r.target.host + ':' + r.target.port);
      console.log('');
      console.log('  ' + COLOR_DIM + 'troth status ' + m.id + ' --remote=' + r.target.host + ':' + r.target.port + COLOR_RESET);
      console.log('  ' + COLOR_DIM + 'troth logs ' + m.id + ' --remote=' + r.target.host + ':' + r.target.port + COLOR_RESET);
      console.log('  ' + COLOR_DIM + 'troth diff ' + m.id + ' --remote=' + r.target.host + ':' + r.target.port + COLOR_RESET);
      return 0;
    }
    console.error(COLOR_RED + 'remote run failed (' + resp.status + '):' + COLOR_RESET, (resp.body && resp.body.error) || resp.raw);
    return 1;
  } catch (e) {
    console.error(COLOR_RED + 'connection to ' + r.target.host + ':' + r.target.port + ' failed:' + COLOR_RESET, e.message);
    return 1;
  }
}

async function cmdStatusRemote(runId, opts) {
  const r = resolveRemote(opts);
  if (!r || !r.token) { console.error('remote not configured'); return 1; }
  try {
    if (runId) {
      const resp = await remoteRequest(r.target, 'GET', '/api/runs/' + encodeURIComponent(runId), null, r.token);
      if (resp.status === 200 && resp.body && resp.body.ok) {
        const meta = resp.body.meta;
        console.log(COLOR_CYAN + meta.id + COLOR_RESET);
        console.log('  state:    ' + colorState(resp.body.state));
        console.log('  task:     ' + meta.task);
        console.log('  branch:   ' + meta.branch);
        console.log('  remote:   ' + r.target.host + ':' + r.target.port);
        console.log('  started:  ' + meta.started_at);
        if (resp.body.summary) {
          console.log('  log lines: ' + resp.body.summary.lines);
          if (resp.body.summary.lastLine) console.log('  last:      ' + resp.body.summary.lastLine);
        }
        return 0;
      }
      console.error('not found');
      return 1;
    }
    const resp = await remoteRequest(r.target, 'GET', '/api/runs', null, r.token);
    if (resp.status === 200 && resp.body && resp.body.ok) {
      if (resp.body.runs.length === 0) {
        console.log(COLOR_DIM + 'no runs on ' + r.target.host + COLOR_RESET);
        return 0;
      }
      for (const run of resp.body.runs) {
        const stateStr = colorState(run.state).padEnd(20);
        console.log('  ' + stateStr + COLOR_DIM + ' ' + run.id + COLOR_RESET);
        console.log('    ' + COLOR_DIM + (run.task || '').slice(0, 80) + COLOR_RESET);
      }
      return 0;
    }
    console.error('list failed:', resp.status);
    return 1;
  } catch (e) {
    console.error(COLOR_RED + 'remote error:' + COLOR_RESET, e.message);
    return 1;
  }
}

async function cmdLogsRemote(runId, follow, opts) {
  const r = resolveRemote(opts);
  if (!r || !r.token) { console.error('remote not configured'); return 1; }
  // Follow mode polls the remote /logs endpoint every 2s. Not as
  // smooth as docker logs -f locally but works over HTTP.
  let lastLen = 0;
  do {
    try {
      const resp = await remoteRequest(r.target, 'GET', '/api/runs/' + encodeURIComponent(runId) + '/logs', null, r.token);
      if (resp.status === 200 && resp.body && resp.body.ok) {
        const logs = resp.body.logs || '';
        if (logs.length > lastLen) {
          process.stdout.write(logs.slice(lastLen));
          lastLen = logs.length;
        }
        if (!follow) return 0;
      } else {
        console.error('logs failed:', resp.status);
        return 1;
      }
    } catch (e) {
      console.error('remote error:', e.message);
      return 1;
    }
    if (follow) await new Promise(r => setTimeout(r, 2000));
  } while (follow);
  return 0;
}

async function cmdDiffRemote(runId, opts) {
  const r = resolveRemote(opts);
  if (!r || !r.token) { console.error('remote not configured'); return 1; }
  try {
    const resp = await remoteRequest(r.target, 'GET', '/api/runs/' + encodeURIComponent(runId) + '/diff', null, r.token);
    if (resp.status === 200 && resp.body && resp.body.ok) {
      process.stdout.write(resp.body.diff || '');
      return 0;
    }
    console.error('diff failed:', resp.status, (resp.body && resp.body.error) || '');
    return 1;
  } catch (e) {
    console.error('remote error:', e.message);
    return 1;
  }
}

async function cmdKillRemote(runId, opts) {
  const r = resolveRemote(opts);
  if (!r || !r.token) { console.error('remote not configured'); return 1; }
  try {
    const resp = await remoteRequest(r.target, 'POST', '/api/runs/' + encodeURIComponent(runId) + '/kill', null, r.token);
    if (resp.status === 200) {
      console.log(COLOR_YELLOW + '✓ Killed ' + runId + ' on ' + r.target.host + COLOR_RESET);
      return 0;
    }
    console.error('kill failed:', resp.status);
    return 1;
  } catch (e) {
    console.error('remote error:', e.message);
    return 1;
  }
}

async function cmdCleanRemote(runId, opts) {
  const r = resolveRemote(opts);
  if (!r || !r.token) { console.error('remote not configured'); return 1; }
  try {
    const resp = await remoteRequest(r.target, 'DELETE', '/api/runs/' + encodeURIComponent(runId), null, r.token);
    if (resp.status === 200) {
      console.log(COLOR_GREEN + '✓ Cleaned ' + runId + ' on ' + r.target.host + COLOR_RESET);
      return 0;
    }
    console.error('clean failed:', resp.status);
    return 1;
  } catch (e) {
    console.error('remote error:', e.message);
    return 1;
  }
}

// ────────────────────────────────────────────────────────────────────
// v6.2 — Programmatic API for remote daemon dispatch
// ────────────────────────────────────────────────────────────────────
//
// These functions return data instead of printing + exit codes. The
// HTTP server in proxy/server.js wraps them as REST endpoints so a
// laptop can send "run this task" to a remote server daemon over
// Tailscale and get back a run id without ever touching local Docker.
//
// They share all the underlying primitives (loadMeta, runState,
// generateRunId, ensureImage, git worktree creation, docker spawn)
// with the cmd* functions above. The only difference is that these
// don't print to stdout — they return objects.
//
// Each function is best-effort: failures return { ok: false, error }
// rather than throwing, because a remote API caller can't handle
// uncaught exceptions cleanly.

function apiCreateRun(task, opts) {
  opts = opts || {};
  if (!task || typeof task !== 'string' || !task.trim()) {
    return { ok: false, error: 'task must be a non-empty string' };
  }

  const cwd = opts.cwd || process.cwd();
  var repoRoot;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cwd, stdio: 'pipe' }).toString().trim();
  } catch (e) {
    return { ok: false, error: 'cwd is not inside a git repository: ' + cwd };
  }

  var parentBranch;
  try {
    parentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
  } catch (e) {
    parentBranch = 'HEAD';
  }

  const runId = generateRunId(task);
  const runDir = path.join(RUNS_DIR, runId);
  const worktreePath = path.join(runDir, 'workspace');
  const branchName = 'troth/' + runId;

  fs.mkdirSync(runDir, { recursive: true });

  try {
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: repoRoot, stdio: 'pipe' });
  } catch (e) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (ee) {}
    return { ok: false, error: 'git worktree add failed: ' + (e.stderr || e.message || '').toString().trim() };
  }

  const meta = {
    id: runId,
    task: task,
    branch: branchName,
    parent_branch: parentBranch,
    repo_root: repoRoot,
    worktree: worktreePath,
    started_at: new Date().toISOString(),
    foreground: false,
    source: 'api',
  };
  saveMeta(runId, meta);

  const result = spawnWorker(task, worktreePath, runDir, opts);
  if (!result.ok) return result;

  return { ok: true, runId: runId, meta: meta, mode: result.mode };
}

function apiListRuns() {
  const ids = listRuns();
  return ids.map(function(id) {
    const meta = loadMeta(id);
    if (!meta) return null;
    const state = runState(id);
    var project = meta.repo_root ? path.basename(meta.repo_root) : '';
    return { id: id, state: state, task: meta.task, started_at: meta.started_at, project: project };
  }).filter(Boolean);
}

function apiGetRun(runId) {
  const meta = loadMeta(runId);
  if (!meta) return { ok: false, error: 'run not found' };
  const state = runState(runId);
  const summary = logSummary(runId);
  return { ok: true, meta: meta, state: state, summary: summary };
}

function apiGetRunLogs(runId, tailBytes) {
  const meta = loadMeta(runId);
  if (!meta) return { ok: false, error: 'run not found' };
  const logFile = path.join(RUNS_DIR, runId, 'log.txt');
  if (!fs.existsSync(logFile)) return { ok: true, logs: '' };
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    if (tailBytes && content.length > tailBytes) {
      return { ok: true, logs: content.slice(-tailBytes), truncated: true };
    }
    return { ok: true, logs: content };
  } catch (e) {
    return { ok: false, error: 'failed to read logs: ' + e.message };
  }
}

function apiGetRunDiff(runId) {
  const meta = loadMeta(runId);
  if (!meta) return { ok: false, error: 'run not found' };
  try {
    const out = execFileSync('git', [
      '-C', meta.worktree,
      'diff', meta.parent_branch + '...HEAD',
    ], { stdio: 'pipe' }).toString();
    return { ok: true, diff: out };
  } catch (e) {
    return { ok: false, error: 'git diff failed: ' + (e.stderr || e.message || '').toString().trim() };
  }
}

function apiKillRun(runId) {
  const meta = loadMeta(runId);
  if (!meta) return { ok: false, error: 'run not found' };
  killWorker(runId);
  return { ok: true };
}

function apiRemoveRun(runId) {
  if (cleanOne(runId)) return { ok: true };
  return { ok: false, error: 'run not found' };
}

// ────────────────────────────────────────────────────────────────────
// `troth race "task" --providers qwen,opus,deepseek` — AgentMarket
// integration. Spawns one run per provider in parallel, each in its
// own worktree, each with its own provider env. When all finish (or
// timeout), collects their exit codes + outputs and uses Market.race
// to pick the winner by verification score.
//
// Each run's outcome becomes an ActionRecord; the group becomes a
// market_run + market_winner pair on the substrate. Product gap 3.
// ────────────────────────────────────────────────────────────────────
function cmdRace(task, opts) {
  opts = opts || {};
  if (!task || !task.trim()) {
    console.error(COLOR_RED + 'Provide a task description.' + COLOR_RESET);
    console.error('  Usage: troth race "fix the failing tests" --providers qwen,opus,deepseek');
    return 1;
  }
  const providers = Array.isArray(opts.providers) && opts.providers.length
    ? opts.providers
    : ['qwen', 'opus', 'deepseek'];

  if (!checkInGitRepo()) return 1;

  const repoRoot = gitRepoRoot();
  const parentBranch = gitCurrentBranch();

  console.log(COLOR_CYAN + '∴ Racing ' + providers.length + ' providers' + COLOR_RESET +
              ' on: "' + task.slice(0, 60) + (task.length > 60 ? '…' : '') + '"');
  console.log('');

  // Launch each run. We reuse cmdRun's guts by spawning directly here
  // with a provider-annotated runId + meta so downstream tracking
  // works.
  const runs = [];
  for (const provider of providers) {
    const providerTask = '[' + provider + '] ' + task;
    const runId = generateRunId(providerTask);
    const runDir = path.join(RUNS_DIR, runId);
    const worktreePath = path.join(runDir, 'workspace');
    const branchName = 'troth/race-' + provider + '-' + path.basename(runId).slice(-8);

    try { fs.mkdirSync(runDir, { recursive: true }); } catch {}
    try {
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath],
                   { cwd: repoRoot, stdio: 'pipe' });
    } catch (e) {
      console.error(COLOR_RED + '  ✗ ' + provider + ': worktree failed — ' + (e.stderr || e.message || '').toString().slice(0, 100) + COLOR_RESET);
      continue;
    }

    const meta = {
      id: runId,
      task: providerTask,
      branch: branchName,
      parent_branch: parentBranch,
      repo_root: repoRoot,
      worktree: worktreePath,
      started_at: new Date().toISOString(),
      foreground: false,
      race_group: opts.group_id || ('race-' + Date.now()),
      provider: provider
    };
    saveMeta(runId, meta);

    const result = spawnWorker(task, worktreePath, runDir, {
      provider,
      role:   provider,                              // race uses provider name as role label
      tenant: opts.tenant || process.env.TROTH_TENANT
    });
    if (!result.ok) {
      console.error(COLOR_RED + '  ✗ ' + provider + ': ' + result.error + COLOR_RESET);
      continue;
    }
    console.log(COLOR_GREEN + '  ✓' + COLOR_RESET + ' ' + provider +
                COLOR_DIM + ' [' + result.model + '] → ' + runId + COLOR_RESET);
    runs.push({ provider, runId, mode: result.mode, model: result.model });
  }

  if (!runs.length) {
    console.error(COLOR_RED + 'No runs started successfully.' + COLOR_RESET);
    return 1;
  }

  // A4: write market_run ActionRecord. Substrate now records the race
  // start so cmdRaceResult can rebuild the group from substrate alone
  // and the dashboard can surface in-progress races.
  const groupId = opts.group_id || 'race-' + Date.now();
  try {
    const state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
    const ar    = require(path.join(__dirname, '..', 'shared-core', 'action-record.js'));
    state.recordAction({
      id: ar.uuidv7(), timestamp: Date.now(),
      type: 'decision', agent_id: 'race-supervisor',
      input:  { kind: 'market_run', group_id: groupId, providers: runs.map(r => r.provider), task: task.slice(0, 500) },
      output: { runs: runs.map(r => ({ provider: r.provider, runId: r.runId, model: r.model, mode: r.mode })) }
    }, 'market_run:' + groupId);
  } catch (e) {}

  console.log('');
  console.log(COLOR_DIM + 'Race in progress. Check:' + COLOR_RESET);
  for (const r of runs) console.log('  troth logs ' + r.runId + ' -f');
  console.log('');
  console.log(COLOR_DIM + 'When all done: troth race-result ' + groupId + COLOR_RESET);

  return 0;
}

// `troth race-result <group_id>` — wait-and-score helper. Checks each
// run in the group, when all terminal, computes scores and prints the
// winner. For v0 we accept that scoring is coarse (exit code 0 vs not +
// wall clock). Future: plug in substrate verification fields.
function cmdRaceResult(groupId) {
  if (!groupId) {
    console.error(COLOR_RED + 'Provide a race group id.' + COLOR_RESET);
    return 1;
  }
  const allRuns = listRuns();
  const groupRuns = allRuns
    .map(r => ({ meta: loadMeta(r), state: runState(r) }))
    .filter(x => x.meta && x.meta.race_group === groupId);
  if (!groupRuns.length) {
    console.error(COLOR_RED + 'No runs matched race group: ' + groupId + COLOR_RESET);
    return 1;
  }

  const pending = groupRuns.filter(x => x.state === 'pending' || x.state === 'running');
  if (pending.length) {
    console.log(COLOR_YELLOW + 'Race still in progress:' + COLOR_RESET);
    for (const r of pending) console.log('  · ' + r.meta.provider + ' — ' + r.state);
    return 0;
  }

  // A5: real verification. For each run, query substrate for type='edit'
  // ActionRecords whose agent_id matches the worker. Read each edit's
  // verification.ast field — if AST passed, score boost; if AST failed
  // or no edits at all, the worker either ran but produced nothing or
  // produced broken output. Falls back to lifecycle state when substrate
  // has no data (e.g. worker died before any edit).
  let _state = null, _edits = {};
  try {
    _state = require(path.join(__dirname, '..', 'shared-core', 'state.js'));
    for (const r of groupRuns) {
      const edits = _state.queryActions({
        type: 'edit',
        agent_id: r.meta.provider,
        limit: 50
      }) || [];
      _edits[r.meta.id] = edits;
    }
  } catch (e) {}

  function scoreFromEdits(meta, lifecycleState) {
    const e = _edits[meta.id] || [];
    if (!e.length) {
      // Fallback to lifecycle state when no substrate edits surfaced
      // (worker may have crashed pre-edit, or hooks weren't wired).
      if (lifecycleState === 'done') return 60;
      if (lifecycleState === 'failed') return 0;
      return -10;
    }
    let astPass = 0, astFail = 0, astSkip = 0;
    for (const row of e) {
      const v = row && row.verification && row.verification.ast;
      if (v && v.ok === true)  astPass++;
      else if (v && v.ok === false) astFail++;
      else astSkip++;
    }
    // Higher reward for AST-verified edits, hard penalty for AST-broken
    // ones. Skipped (unsupported language) counts as half-credit so
    // language-agnostic tasks don't get unfairly downranked.
    const base = (astPass * 100) - (astFail * 50) + (astSkip * 30);
    const lifeBonus = lifecycleState === 'done' ? 20 : 0;
    return base + lifeBonus;
  }

  const attempts = groupRuns.map(x => ({
    agent_id: x.meta.provider,
    state:    x.state,
    runId:    x.meta.id,
    edits:    (_edits[x.meta.id] || []).length,
    score:    scoreFromEdits(x.meta, x.state)
  }));
  attempts.sort((a, b) => b.score - a.score);

  console.log(COLOR_CYAN + 'Race result — group ' + groupId + ':' + COLOR_RESET);
  for (const a of attempts) {
    const marker = a === attempts[0] ? '★' : ' ';
    console.log('  ' + marker + ' ' + a.agent_id + ': ' + a.state +
                ' edits=' + a.edits + ' (score=' + a.score + ')');
  }
  const winner = attempts[0];
  if (winner.score > 0) {
    console.log('');
    console.log(COLOR_GREEN + '✓ Winner: ' + winner.agent_id + COLOR_RESET);
    console.log('  troth diff ' + winner.runId + '  # see the winner changes');
    console.log('  troth merge ' + winner.runId + ' # cherry-pick to your branch');
    // A4 part 2: write market_winner ActionRecord pointing at the chosen attempt.
    try {
      const ar = require(path.join(__dirname, '..', 'shared-core', 'action-record.js'));
      _state && _state.recordAction({
        id: ar.uuidv7(), timestamp: Date.now(),
        type: 'decision', agent_id: 'race-supervisor',
        input:  { kind: 'market_winner', group_id: groupId, winner_runId: winner.runId, winner_provider: winner.agent_id },
        output: { score: winner.score, edits: winner.edits, attempts }
      }, 'market_winner:' + groupId);
    } catch (e) {}
  } else {
    console.log('');
    console.log(COLOR_RED + '✗ No successful winner. Review logs of the highest-scored run.' + COLOR_RESET);
  }
  return 0;
}

module.exports = {
  // Read-only run inspection for the jobs_status entity tool (any
  // conversation can answer "how is job X going" without the CLI).
  listRuns,
  loadMeta,
  runState,
  logSummary,
  logTail,
  cmdRun,
  cmdStatus,
  cmdLogs,
  cmdDiff,
  cmdMerge,
  cmdKill,
  cmdClean,
  cmdCleanStuck,
  cmdRace,
  cmdRaceResult,
  // spawnWorker exposed for shared-core/agent-supervisor.js
  // so the orchestrator path reuses the exact same hardening (Docker
  // sandbox flags, env wiring, faculty/provider/tenant resolution) as
  // `troth race`. Without this export the orchestrator could not
  // spawn workers; live smoke surfaced the missing symbol immediately.
  spawnWorker,
  //  killWorker exposed so the MCP server's
  // troth_orchestrate_kill tool can stop a runaway team without
  // shelling out to `troth kill <runId>` per worker.
  killWorker,
  resolveProviderModel,
  resolveFaculty,
  // v6.2 programmatic API for the remote-dispatch HTTP server.
  apiCreateRun,
  apiListRuns,
  apiGetRun,
  apiGetRunLogs,
  apiGetRunDiff,
  apiKillRun,
  apiRemoveRun,
};
