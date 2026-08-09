// SPDX-License-Identifier: AGPL-3.0-only
// sandbox-seatbelt.js — macOS Seatbelt (sandbox-exec) adapter: the sandbox
// that exists on EVERY Mac with zero installs.
//
// Why this adapter exists: the selector's first two choices (apple-container,
// docker) are real container runtimes, but a fresh Mac has neither, so in
// practice the selector always landed on bare-exec's refusal and no operator
// ever had a working sandbox. Seatbelt ships inside macOS itself. It is
// weaker than a container (shared kernel, no memory/pid caps) which is why it
// sits BELOW docker in the priority order, but it turns "no isolation on any
// stock Mac" into "deny-default isolation on every stock Mac".
//
// The jail model (deny default, allowances carved in — never a deny-list):
//   * the WORK dir (opts.cwd) is the project: the only writable place, and
//     where downloaded packages land, execute, and stay.
//   * the toolchain (node's own install tree) and the OS runtime dirs are
//     readable/executable so real work (node, npm, git, cc) functions.
//   * everything else — ~/.troth, ~/.ssh, Keychains, Documents — is not
//     denied by name; it simply was never allowed. New secrets are protected
//     by default instead of each needing its own rule.
//   * network is OFF unless the caller asks ('full'), because SBPL cannot
//     scope network per-host; per-destination policy is the egress filter's
//     job one layer up, not this file's.
//
// The child's environment is BUILT, not inherited: whatever secrets ride in
// the parent's process.env stay in the parent. HOME and TMPDIR point inside
// the jail so dotfile-writers and tmp-writers work without touching the real
// home.
//
// API (mirrors docker-sandbox.js for drop-in selector compatibility):
//   isAvailable(opts?)      → { available, version, error? }   (cached 60s)
//   runInSandbox(cmd, opts) → { stdout, stderr, exit_code, interrupted,
//                               sandboxed:true, sandbox_kind:'seatbelt',
//                               elapsed_ms, signal? } | { error, detail, … }
//   opts: { cwd, network: 'none'|'full', timeout_ms, env }
//
// sandbox-exec is marked deprecated in its man page but is what Chromium,
// Bazel and Apple's own daemons ride on; it is exercised (not gone) on every
// current macOS. Availability is probed, never assumed.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS  = 120 * 1000;
const MAX_TIMEOUT_MS      = 600 * 1000;
const MAX_STREAM_BYTES    = 256 * 1024;
const KILL_GRACE_MS       = 2000;
const AVAILABILITY_TTL_MS = 60 * 1000;
const SANDBOX_EXEC        = '/usr/bin/sandbox-exec';
// The policy file lives OUTSIDE every jail, under ~/.troth (which no profile
// ever allows). It used to sit inside WORK, where the jailed process could
// rewrite it: harmless for the run in progress, but a long-lived jailed
// process (dev server, watcher, an MCP bridge) could swap it in the window
// between our write and sandbox-exec's read and hand the NEXT command a
// wide-open policy. Unreachable ground removes the race entirely.
const PROFILE_DIR = path.join((process.env.HOME || os.homedir()), '.troth', 'sandbox-profiles');
// The jail's scratch home and tmp. These used to live in the project as
// .troth-sandbox/, which put npm's cache in the operator's repo: one install
// staged 632 files and 3 MB into their next commit, and even a read-only
// command created the directory. Scratch belongs to the jail, not the work.
const JAIL_SCRATCH_ROOT = path.join((process.env.HOME || os.homedir()), '.troth', 'jails');
function _scratchDirFor(work) {
  // Name for a human reading ~/.troth/jails, hash for uniqueness: two
  // projects called "api" in different trees must not share a home.
  const tag = path.basename(work).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'jail';
  const sum = crypto.createHash('sha256').update(work).digest('hex').slice(0, 12);
  return path.join(JAIL_SCRATCH_ROOT, tag + '-' + sum);
}

let _availabilityCache = { ts: 0, value: null };

function _clip(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n…(stream truncated at ' + MAX_STREAM_BYTES + ' bytes)';
}

// The profile is a constant with -D parameters, never string-concatenated
// paths: a path with a quote in it must not be able to rewrite the policy.
//   WORK     — the jail (read+write+exec)
//   TOOLROOT — node's install tree (read+exec): /opt/homebrew, an nvm
//              version dir, or /usr/local — wherever the running node lives.
function _profile(network) {
  const lines = [
    '(version 1)',
    '(deny default)',
    // Apple's base profile: device nodes, bootstrap lookups, sysctl basics
    // every process needs before main() even runs.
    '(import "system.sb")',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow signal (target same-sandbox))',
    // OS runtime + toolchain: readable and executable, never writable.
    '(allow file-read* process-exec*',
    '  (subpath "/bin") (subpath "/sbin") (subpath "/usr") (subpath "/System")',
    '  (subpath "/Library/Frameworks") (subpath "/Library/Apple")',
    // Apple CLT: /usr/bin/git and friends are shims that exec the real
    // binaries out of /Library/Developer/CommandLineTools.
    '  (subpath "/Library/Developer")',
    '  (subpath (param "TOOLROOT"))',
    // The public software prefixes, always — a jail launched under one node
    // (the app ships its own) still has to reach tools installed under
    // another, and /Applications carries the CLI shims that GUI apps symlink
    // into /usr/local/bin. Read and execute only; they hold no user data.
    '  (subpath "/opt/homebrew") (subpath "/opt/local") (subpath "/usr/local")',
    '  (subpath "/Applications")',
    '  (subpath (param "WORK")) (subpath (param "SCRATCH")))',
    // Config the runtime legitimately reads: TLS roots, resolv, timezone,
    // locale. Read-only; nothing under a user home.
    '(allow file-read*',
    '  (subpath "/private/etc") (subpath "/private/var/db")',
    '  (subpath "/private/var/select") (subpath "/Library/Preferences")',
    '  (subpath "/dev"))',
    // Stat-only metadata everywhere: realpath() walks every ancestor of
    // the toolchain and the jail (npm dies on lstat("/opt") without it).
    // Contents and directory listings outside the allowances stay denied;
    // what this leaks is existence/size/mtime of paths a process names.
    // Chromium's and Safari's hardened profiles accept the same tradeoff.
    // The suite pins that listing a home directory still refuses.
    '(allow file-read-metadata)',
    // The jail is the only writable ground, plus the terminal devices.
    '(allow file-write* (subpath (param "WORK")) (subpath (param "SCRATCH")))',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))'
  ];
  if (network === 'full') {
    // SBPL cannot express "these hosts only", so outbound is all-or-nothing
    // for the public internet. Loopback is the exception that matters and it
    // IS expressible: the operator's own machine runs privileged local
    // services — troth's proxy holds the vault and the engine keys, and a
    // model server, a database or an SSH agent may be listening too. A
    // package the partner installed reaching those would undo the jail
    // without ever touching a file, so loopback is denied after the allow
    // (later rules win in SBPL). Per-destination policy for the public
    // internet remains the egress layer's job, one level up.
    lines.push('(allow network*)');
    lines.push('(allow system-socket)');
    lines.push('(deny network* (remote ip "localhost:*"))');
  }
  return lines.join('\n') + '\n';
}

// Cheap real probe: run /usr/bin/true under a minimal profile. Catches the
// platform, the binary, AND an OS build where sandbox-exec stopped working —
// availability is proven, not inferred from existsSync.
function isAvailable(opts) {
  opts = opts || {};
  const now = Date.now();
  if (!opts.fresh && _availabilityCache.value && (now - _availabilityCache.ts) < AVAILABILITY_TTL_MS) {
    return _availabilityCache.value;
  }
  let result;
  if (process.platform !== 'darwin') {
    result = { available: false, error: 'seatbelt is macOS-only (platform: ' + process.platform + ')' };
  } else if (!fs.existsSync(SANDBOX_EXEC)) {
    result = { available: false, error: SANDBOX_EXEC + ' not present' };
  } else {
    try {
      const r = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
        timeout: 3000, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8'
      });
      result = (r.status === 0)
        ? { available: true, version: 'macos-' + os.release() }
        : { available: false, error: 'probe exit ' + r.status + ': ' + String(r.stderr || '').trim().slice(0, 240) };
    } catch (e) {
      result = { available: false, error: e && e.message || String(e) };
    }
  }
  _availabilityCache = { ts: now, value: result };
  return result;
}

function _resetAvailabilityCache() {
  _availabilityCache = { ts: 0, value: null };
}

// The toolchain tree the jail may read and execute. A package-manager node
// (Homebrew, MacPorts) links dylibs across its whole prefix (node in
// Cellar/node/…/bin, libuv in opt/libuv/…), so the prefix is the unit, not
// the Cellar slice two levels above the binary. Self-contained trees (nvm,
// volta, fnm, the app bundle) really are their own two-levels-up root.
// Read+exec only, never writable; deny-default still hides everything else,
// and a public software prefix holds no secrets.
const TOOL_PREFIXES = ['/opt/homebrew', '/opt/local', '/usr/local'];
function _toolRoot() {
  const real = fs.realpathSync(process.execPath);
  for (const p of TOOL_PREFIXES) {
    if (real === p || real.startsWith(p + '/')) return p;
  }
  return fs.realpathSync(path.dirname(path.dirname(real)));
}

// Environment built from scratch. The parent proxy's env can carry keys and
// tokens; none of that crosses the boundary. HOME/TMPDIR live inside the
// jail so npm caches, dotfile writers and tmp files all land in the project.
// The operator's committing identity, read ONCE from their real git config
// by the parent (the jail cannot see it — HOME is redirected). Without this
// git silently invents one from the hostname and stamps the machine's LAN
// address into every commit made in a workspace project.
let _gitIdent = null;
function _gitIdentity() {
  if (_gitIdent) return _gitIdent;
  _gitIdent = {};
  for (const [key, envName] of [['user.name', 'NAME'], ['user.email', 'EMAIL']]) {
    try {
      const r = spawnSync('git', ['config', '--global', '--get', key],
                          { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const v = (r.status === 0 && typeof r.stdout === 'string') ? r.stdout.trim() : '';
      if (v) { _gitIdent['GIT_AUTHOR_' + envName] = v; _gitIdent['GIT_COMMITTER_' + envName] = v; }
    } catch (_) { /* no git, or no global config: leave it to git */ }
  }
  return _gitIdent;
}

// Variables that carry REACHABILITY, not identity: without them a corporate
// operator behind a TLS-inspecting proxy cannot resolve a single package.
// They are copied from the parent because there is nowhere else to learn
// them; nothing here is a credential. File-valued CA settings are handled
// separately (the named file is copied INTO the jail, since the original
// path is outside the walls).
const PASSTHROUGH_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'npm_config_registry', 'npm_config_strict_ssl', 'TZ'
];
const CA_FILE_ENV = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];

function _buildEnv(jailHome, jailTmp, toolBin, extra) {
  // The interpreter actually running us goes on PATH by its own directory:
  // deriving it from TOOLROOT + '/bin' is wrong for self-contained trees
  // (troth's packaged app keeps node in Contents/Resources/core, and has no
  // bin/ at all, so the jail found neither node nor npm).
  let ownBin = '';
  try { ownBin = path.dirname(fs.realpathSync(process.execPath)); } catch (_) {}
  const pathParts = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // ownBin and toolBin first (the interpreter that launched us), then the
  // public prefixes the profile already allows — otherwise a jail running
  // under troth's bundled node finds no npm at all.
  const candidates = [ownBin, toolBin, '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  for (const p of candidates) {
    if (!p || pathParts.indexOf(p) !== -1) continue;
    try { if (fs.existsSync(p)) pathParts.push(p); } catch (_) {}
  }
  const env = {
    PATH:    pathParts.join(':'),
    HOME:    jailHome,
    TMPDIR:  jailTmp,
    LANG:    process.env.LANG || 'en_US.UTF-8',
    TERM:    'dumb',
    npm_config_cache: path.join(jailHome, '.npm'),
    npm_config_update_notifier: 'false'
  };
  for (const k of PASSTHROUGH_ENV) {
    if (typeof process.env[k] === 'string' && process.env[k]) env[k] = process.env[k];
  }
  // A CA bundle named by the parent sits outside the walls, so the file is
  // copied into the jail home and the variable repointed at the copy.
  for (const k of CA_FILE_ENV) {
    const src = process.env[k];
    if (!src || !path.isAbsolute(src)) continue;
    try {
      const dst = path.join(jailHome, 'ca-' + k.toLowerCase() + '.pem');
      fs.copyFileSync(src, dst);
      env[k] = dst;
    } catch (_) { /* unreadable or gone: better no CA var than a dangling one */ }
  }
  // git needs more than the variables: with HOME redirected it falls back to
  // inventing an author from the hostname, which stamps the machine's LAN
  // address into every commit. A jail-local global config carries the real
  // identity when there is one and sets useConfigOnly, so the no-identity
  // case REFUSES with a clear message instead of fabricating one.
  const ident = _gitIdentity();
  Object.assign(env, ident);
  try {
    const oneLine = (v) => String(v || '').replace(/[\r\n]/g, ' ').trim();
    const gitconfig = path.join(jailHome, 'gitconfig');
    fs.writeFileSync(gitconfig,
      '[user]\n'
      + (ident.GIT_AUTHOR_NAME  ? '\tname = '  + oneLine(ident.GIT_AUTHOR_NAME)  + '\n' : '')
      + (ident.GIT_AUTHOR_EMAIL ? '\temail = ' + oneLine(ident.GIT_AUTHOR_EMAIL) + '\n' : '')
      + '\tuseConfigOnly = true\n',
      { mode: 0o600 });
    env.GIT_CONFIG_GLOBAL = gitconfig;
  } catch (_) { /* no scratch home yet: the env vars alone still apply */ }
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (typeof extra[k] === 'string' || typeof extra[k] === 'number') env[k] = String(extra[k]);
    }
  }
  return env;
}

// The jail as a reusable spawn recipe, for callers that keep the child
// ALIVE — an MCP bridge holds a stdio conversation for the whole session,
// so it cannot go through runInSandbox's run-to-exit capture. The caller
// spawns exec + args.concat([its command, ...its args]) with its own pipe
// and lifetime discipline; the walls and the built env are identical.
// jailSpawnSpec({ cwd, network, env }) →
//   { ok:true, exec, args, env, work } | { ok:false, error }
function jailSpawnSpec(opts) {
  opts = opts || {};
  const avail = module.exports.isAvailable();
  if (!avail.available) return { ok: false, error: avail.error || 'sandbox-exec not usable' };
  const network = opts.network === 'full' ? 'full' : 'none';
  let work;
  try {
    work = fs.realpathSync(opts.cwd);   // symlink-resolved: subpath match is on real paths
  } catch (e) {
    return { ok: false, error: 'cwd unusable: ' + (e && e.message || e) };
  }
  // Jail-internal scratch: fake home + fake tmp, OUTSIDE the project so a
  // 3 MB npm cache never lands in the operator's repo. The policy lives
  // somewhere neither the jail nor the project can reach.
  let scratch    = _scratchDirFor(work);
  let jailHome   = path.join(scratch, 'home');
  let jailTmp    = path.join(scratch, 'tmp');
  const profilePath = path.join(PROFILE_DIR, 'profile-' + network + '.sb');
  let toolRoot;
  try {
    fs.mkdirSync(jailHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(jailTmp,  { recursive: true, mode: 0o700 });
    fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
    // realpath AFTER creation: on macOS /Users and the temp root are
    // symlinked, and an unresolved SCRATCH would not match its own subpath.
    scratch = fs.realpathSync(scratch);
    jailHome = path.join(scratch, 'home');
    jailTmp  = path.join(scratch, 'tmp');
    // Written fresh each time (idempotent, same bytes) so an edited troth
    // ships its new policy immediately instead of reusing a stale file.
    fs.writeFileSync(profilePath, _profile(network), { mode: 0o600 });
    // Homebrew/MacPorts prefix, an nvm version dir, or wherever the running
    // node actually lives — see _toolRoot.
    toolRoot = _toolRoot();
  } catch (e) {
    return { ok: false, error: 'jail_setup_failed: ' + (e && e.message || e) };
  }
  return {
    ok:   true,
    exec: SANDBOX_EXEC,
    args: ['-f', profilePath, '-D', 'WORK=' + work,
           '-D', 'TOOLROOT=' + toolRoot, '-D', 'SCRATCH=' + scratch],
    env:  _buildEnv(jailHome, jailTmp, path.join(toolRoot, 'bin'), opts.env),
    work
  };
}

function runInSandbox(command, opts) {
  opts = opts || {};
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.resolve({ error: 'bad_args', detail: 'command (string, non-empty) required', sandboxed: false });
  }
  // Through module.exports so a test stub on isAvailable takes effect.
  const avail = module.exports.isAvailable();
  if (!avail.available) {
    return Promise.resolve({
      error: 'seatbelt_unavailable',
      detail: avail.error || 'sandbox-exec not usable',
      sandboxed: false
    });
  }

  const network = opts.network === 'full' ? 'full' : 'none';
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT_MS, parseInt(opts.timeout_ms || DEFAULT_TIMEOUT_MS, 10)));

  // The jail: the caller's project dir, or a throwaway scratch jail when no
  // cwd was given (bash.js passes null on non-project calls) — a command
  // with nowhere declared to work still gets somewhere safe to write.
  let work;
  try {
    work = opts.cwd
      ? fs.realpathSync(opts.cwd)                     // symlink-resolved: subpath match is on real paths
      : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'troth-jail-'));
  } catch (e) {
    return Promise.resolve({ error: 'bad_args', detail: 'cwd unusable: ' + (e && e.message || e), sandboxed: false });
  }

  const jspec = jailSpawnSpec({ cwd: work, network, env: opts.env });
  if (!jspec.ok) {
    return Promise.resolve({ error: 'jail_setup_failed', detail: jspec.error, sandboxed: false });
  }
  const argv = jspec.args.concat(['/bin/bash', '-c', command]);

  return new Promise((resolve) => {
    const started_at = Date.now();
    const child = spawn(jspec.exec, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd:   work,
      env:   jspec.env
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
        sandboxed:    true,
        sandbox_kind: 'seatbelt',
        work_dir:     work,
        network,
        elapsed_ms:   Date.now() - started_at
      }, payload));
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({
      error: 'spawn_failed',
      detail: e && e.message || String(e),
      stdout: _clip(stdout), stderr: _clip(stderr),
      exit_code: null, interrupted
    }));
    child.on('exit', (code, signal) => finish({
      stdout: _clip(stdout), stderr: _clip(stderr),
      exit_code: code, signal: signal || null, interrupted
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
  jailSpawnSpec,
  DEFAULT_TIMEOUT_MS,
  AVAILABILITY_TTL_MS,
  // exposed for tests
  _resetAvailabilityCache,
  _profile,
  _scratchDirFor,
  PROFILE_DIR,
  JAIL_SCRATCH_ROOT,
  _buildEnv
};
